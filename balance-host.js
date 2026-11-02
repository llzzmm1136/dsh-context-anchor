/**
 * Balance — Host half.
 *
 * Serves two loopback routes for the dock badge:
 *
 * - `GET /plugins/balance/colink` — the API site account reading.
 * - `GET /plugins/balance/colink/panel` — the same reading plus the site's own
 *   spend for the last 24 hours, per-model spend, API keys, and recent usage
 *   records.
 *
 * The numbers come from the API site (colink.site) account that pays for the
 * configured provider routes — the same account the site's dashboard shows —
 * not from any harness provider-group name. The panel only answers to a
 * logged-in JWT, so this half signs in with the credentials stored under
 * `COLINK_PANEL_EMAIL` / `COLINK_PANEL_PASSWORD` in the harness credential
 * store, keeps the access token until the panel rejects it, and caches
 * readings. It returns figures only — the API keys and the panel password
 * never cross to the page.
 */

const PANEL_BASE = 'https://www.colink.site';
const EMAIL_REF = 'COLINK_PANEL_EMAIL';
const PASSWORD_REF = 'COLINK_PANEL_PASSWORD';
const BALANCE_PATH = '/plugins/balance/colink';
const PANEL_PATH = '/plugins/balance/colink/panel';
const CACHE_MS = 60_000;
/** Usage details move slowly; keep the aggregate for longer so opening it stays instant. */
const PANEL_CACHE_MS = 60_000;
/** The spend window every figure on the panel covers: one rolling day. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Payload shape the Client half requires; a stale Host half reports nothing. */
const PANEL_VERSION = 2;
/** Hourly buckets the chart draws, oldest first. */
const HOUR_BUCKETS = 24;
const RECORD_COUNT = 12;
/** Pages of 200 records to read when the site's own totals do not cover the window. */
const RECORD_PAGES = 3;

/** `YYYY-MM-DD` in the host's local zone, the form the site's dashboard takes. */
function localDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The start of one local hour, so a bucket boundary matches the site's own stamps. */
function hourFloor(time) {
  const at = new Date(time);
  at.setMinutes(0, 0, 0);
  return at.getTime();
}

/** Attach the optional balance routes without making them required by the anchor. */
export function applyBalance(ctx) {
  ctx.inject(['credentials', 'webServer', 'connection'], (scope) => {
    if (!scope?.credentials || !scope?.webServer || !scope?.connection) return
    applyBalanceScope(scope)
  })
}

/** @param ctx - host context with credential, carrier, and connection services. */
function applyBalanceScope(ctx) {
  const state = { token: null, value: { status: 'idle' }, readAt: 0, inFlight: null };
  const panel = { value: { status: 'idle' }, readAt: 0, inFlight: null };

  /** Sign in to the panel and keep the fresh access token. */
  async function login() {
    const email = (await ctx.credentials.resolve(EMAIL_REF))?.value;
    const password = (await ctx.credentials.resolve(PASSWORD_REF))?.value;
    if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
      throw new Error('colink panel credentials are not configured');
    }
    const res = await fetch(`${PANEL_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`colink login failed: HTTP ${res.status}`);
    const json = await res.json();
    const token = json?.data?.access_token;
    if (json?.code !== 0 || typeof token !== 'string' || token === '') {
      throw new Error(`colink login refused: ${json?.message ?? 'no token'}`);
    }
    state.token = token;
    return token;
  }

  /** One authenticated GET against the panel; one re-login on a rejected token. */
  async function api(path) {
    let token = state.token ?? await login();
    let res = await fetch(`${PANEL_BASE}/api/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      state.token = null;
      token = await login();
      res = await fetch(`${PANEL_BASE}/api/v1${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }
    if (!res.ok) throw new Error(`colink request failed: ${path} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json?.code !== 0) throw new Error(`colink request refused: ${path} -> ${json?.message ?? 'unknown'}`);
    return json.data;
  }

  /** Read the site account through `/auth/me`: wallet, identity, lifetime top-up. */
  async function readBalance() {
    const data = await api('/auth/me');
    const balance = Number(data.balance);
    if (!Number.isFinite(balance)) throw new Error('colink balance unreadable');
    const frozenValue = Number(data.frozen_balance ?? 0);
    const rechargedValue = Number(data.total_recharged ?? 0);
    const email = typeof data.email === 'string' && data.email !== '' ? data.email : '';
    const username = typeof data.username === 'string' && data.username !== '' ? data.username : '';
    return {
      status: 'ready',
      balance,
      frozen: Number.isFinite(frozenValue) ? frozenValue : 0,
      recharged: Number.isFinite(rechargedValue) ? rechargedValue : 0,
      currency: 'CNY',
      source: 'api-site',
    };
  }

  /** One shared balance reading with a stale-after cache and a single in-flight request. */
  function ensure(force = false) {
    if (state.inFlight !== null) return state.inFlight;
    const fresh = state.value.status === 'ready' && Date.now() - state.readAt < CACHE_MS;
    if (!force && fresh) return Promise.resolve();
    state.inFlight = (async () => {
      try {
        state.value = await readBalance();
      } catch (error) {
        console.error('[balance] colink reading failed', error);
        state.value = { status: 'failed' };
      }
      state.readAt = Date.now();
      state.inFlight = null;
    })();
    return state.inFlight;
  }

  /**
   * The site's hourly spend for the last `WINDOW_MS`, zero-filled so the chart
   * always draws `HOUR_BUCKETS` continuous hours even where traffic is absent.
   */
  async function readHourly(now) {
    const start = new Date(now - WINDOW_MS);
    const query = `start_date=${localDate(start)}&end_date=${localDate(new Date(now))}&granularity=hour`;
    const data = await api(`/usage/dashboard/trend?${query}`);
    const cutoff = now - WINDOW_MS;
    const buckets = new Map();
    for (const row of Array.isArray(data?.trend) ? data.trend : []) {
      if (typeof row?.date !== 'string') continue;
      const at = new Date(`${row.date.replace(' ', 'T')}:00+08:00`).getTime();
      if (!Number.isFinite(at) || at < cutoff || at > now) continue;
      const key = hourFloor(at);
      const current = buckets.get(key) ?? { cost: 0, requests: 0, tokens: 0 };
      current.cost += Number(row.actual_cost ?? 0);
      current.requests += Number(row.requests ?? 0);
      current.tokens += Number(row.total_tokens ?? 0);
      buckets.set(key, current);
    }
    const series = [];
    const last = hourFloor(now);
    const first = last - (HOUR_BUCKETS - 1) * 60 * 60 * 1000;
    for (let at = first; at <= last; at += 60 * 60 * 1000) {
      const current = buckets.get(at) ?? { cost: 0, requests: 0, tokens: 0 };
      series.push({ at, ...current });
    }
    return series;
  }

  /**
   * Every usage record inside the last `WINDOW_MS`. The site filters by date
   * only, so the window is applied here; the per-model split and the window
   * total come from these rows because the site's aggregate endpoints only
   * speak in whole days.
   */
  async function readWindowRecords(now) {
    const cutoff = now - WINDOW_MS;
    const start = new Date(cutoff);
    const query = `start_date=${localDate(start)}&end_date=${localDate(new Date(now))}`;
    const rows = [];
    for (let page = 1; page <= RECORD_PAGES; page += 1) {
      const data = await api(`/usage?page=${page}&page_size=200&${query}`);
      const batch = Array.isArray(data?.items) ? data.items : [];
      rows.push(...batch);
      if (batch.length < 200) break;
    }
    return rows
      .map((item) => ({
        time: String(item.created_at ?? ''),
        at: new Date(String(item.created_at ?? '')).getTime(),
        model: String(item.model ?? '?'),
        tokens:
          Number(item.input_tokens ?? 0) +
          Number(item.output_tokens ?? 0) +
          Number(item.cache_read_tokens ?? 0) +
          Number(item.cache_creation_tokens ?? 0),
        cost: Number(item.actual_cost ?? 0),
      }))
      .filter((row) => Number.isFinite(row.at) && row.at >= cutoff && row.at <= now)
      .sort((a, b) => b.at - a.at);
  }

  /** The account's API keys as the site lists them, with the group each key is issued for. */
  async function readKeys() {
    const keys = await api('/keys?page=1&page_size=100');
    return (Array.isArray(keys?.items) ? keys.items : []).map((key) => ({
      name: String(key.name ?? ''),
      group: String(key.group?.name ?? ''),
      status: String(key.status ?? ''),
      lastUsed: key.last_used_at === null || key.last_used_at === undefined ? '' : String(key.last_used_at),
    }));
  }

  /** Aggregate the panel overview: account, last-24h spend, model split, keys, records. */
  async function readPanel() {
    const balance = state.value.status === 'ready' ? state.value : await readBalance();
    const now = Date.now();
    const [hourly, windowRows, keys] = await Promise.all([
      readHourly(now).catch((error) => {
        console.error('[balance] colink hourly trend failed', error);
        return [];
      }),
      readWindowRecords(now).catch((error) => {
        console.error('[balance] colink window records failed', error);
        return [];
      }),
      readKeys().catch((error) => {
        console.error('[balance] colink key list failed', error);
        return [];
      }),
    ]);
    const byModel = new Map();
    for (const row of windowRows) {
      const current = byModel.get(row.model) ?? { model: row.model, cost: 0, requests: 0, tokens: 0 };
      current.cost += row.cost;
      current.requests += 1;
      current.tokens += row.tokens;
      byModel.set(row.model, current);
    }
    const models = [...byModel.values()].sort((a, b) => b.cost - a.cost).slice(0, 6);
    const windowCost = windowRows.reduce((sum, row) => sum + row.cost, 0);
    const windowRequests = windowRows.length;
    const windowTokens = windowRows.reduce((sum, row) => sum + row.tokens, 0);
    return {
      status: 'ready',
      version: PANEL_VERSION,
      balance: balance.balance,
      frozen: balance.frozen,
      recharged: balance.recharged ?? 0,
      currency: balance.currency,
      account: balance.account ?? '',
      // The browser gets figures only; account identifiers stay Host-side.
      source: 'api-site',
      windowHours: HOUR_BUCKETS,
      window: {
        cost: Number(windowCost.toFixed(6)),
        requests: windowRequests,
        tokens: Math.round(windowTokens),
      },
      hourly: hourly.map((hour) => ({
        at: hour.at,
        cost: Number(hour.cost.toFixed(6)),
        requests: Math.round(hour.requests),
        tokens: Math.round(hour.tokens),
      })),
      models: models.map((model) => ({
        model: model.model,
        cost: Number(model.cost.toFixed(6)),
        requests: model.requests,
        tokens: Math.round(model.tokens),
      })),
      keys,
      records: windowRows.slice(0, RECORD_COUNT).map((row) => ({
        time: row.time,
        model: row.model,
        tokens: row.tokens,
        cost: Number(row.cost.toFixed(6)),
      })),
    };
  }

  /** One shared panel reading with the same cache/in-flight discipline. */
  function ensurePanel(force = false) {
    if (panel.inFlight !== null) return panel.inFlight;
    const fresh = panel.value.status === 'ready' && Date.now() - panel.readAt < PANEL_CACHE_MS;
    if (!force && fresh) return Promise.resolve();
    panel.inFlight = (async () => {
      try {
        await ensure();
        panel.value = await readPanel();
      } catch (error) {
        console.error('[balance] colink panel reading failed', error);
        panel.value = { status: 'failed' };
      }
      panel.readAt = Date.now();
      panel.inFlight = null;
    })();
    return panel.inFlight;
  }

  /** Register one GET-only loopback JSON route guarded against cross-origin pages. */
  function route(path, read) {
    return ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ status: 'failed' }));
          return;
        }
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== '' && origin !== ctx.webServer.getOrigin()) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'failed' }));
          return;
        }
        await read();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(path === BALANCE_PATH ? state.value : panel.value));
      },
    });
  }

  ctx.effect(() => {
    const disposers = [route(BALANCE_PATH, () => ensure()), route(PANEL_PATH, () => ensurePanel())];
    ensure();
    return () => {
      for (const disposer of disposers) disposer();
    };
  }, 'balance: colink routes');
}
