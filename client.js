/**
 * Context Anchor — Client half.
 *
 * Two entries in one module:
 *  - a dock badge beside the composer's context meter, showing how much of this
 *    session's history the plugin still holds locally and can replay;
 *  - a frame-level panel in `shell.overlay` that opens from that badge.
 *
 * The composer clips its own overflow and this runtime offers no `react-dom`
 * (a dynamic Client half sees only ctx/React/host/styles/console), so the panel
 * cannot be portaled from the dock row: it lives in the frame-wide overlay slot
 * and the badge only publishes its anchor rect through this module's store.
 *
 * Numbers come from the Host half's `contextAnchorCache` projection; pressure
 * figures reuse the shipped `contextPressure` projection.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-context-anchor',
  factory(require) {
    function createBalanceModule(require) {
    const React = require('react');

    const h = React.createElement;

    const NS = 'balance';
    const CACHE_MS = 60_000;
    /** A failed read retries sooner than a successful one refreshes. */
    const RETRY_MS = 5_000;
    /** The loopback routes the Host half registers for the API site account. */
    const BALANCE_ROUTE = '/plugins/balance/colink';
    const PANEL_ROUTE = '/plugins/balance/colink/panel';
    /**
     * Payload shape this half understands. A Host half still running an older
     * build answers without it, and its figures cover a different window — so
     * the panel refuses to draw them rather than mislabeling seven days as one.
     */
    const PANEL_VERSION = 2;
    /** The API site that owns the account, usage and key pages. */
    const SITE_URL = 'https://www.colink.site';

    /**
     * Plugin stylesheet for the dock pill and its dialog, following the shipped
     * composer stat-pill metrics; injected once per page.
     */
    const PANEL_CSS = [
      '.dshb-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dshb-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshb-pill svg{flex:none;width:14px;height:14px}',
      'button.dshb-pill{cursor:pointer}',
      'button.dshb-pill:hover,button.dshb-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshb-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(320px,100vw - 24px);max-width:min(560px,100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
      '.dshb-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.dshb-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dshb-titleValue{font-variant-numeric:tabular-nums}',
      '.dshb-sectionTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:12px 0 6px;font-weight:500}',
      '.dshb-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
      '.dshb-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:400;padding:2px 6px 2px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshb-table td{padding:3px 6px 3px 0;vertical-align:top;white-space:nowrap}',
      '.dshb-rows{display:grid;grid-template-columns:auto 1fr;gap:4px 24px;font-variant-numeric:tabular-nums}',
      '.dshb-key{color:var(--dsw-alias-label-tertiary)}',
    ].join('');


    const EN = {
      label: 'Balance',
      pending: '…',
      dash: '—',
      'title.loading': 'Reading the API site account balance…',
      'title.account': 'API site account: {account}',
      'title.available': 'Available balance: {amount}',
      'title.frozen': 'Frozen: {amount}',
      'title.recharged': 'Lifetime top-up: {amount}',
      'title.failed': 'The API site account balance could not be read; it will retry automatically.',
      'title.missing': 'The API site reading service is not running in this app instance.',
      'panel.title': 'API site balance',
      'panel.loading': 'Loading…',
      'panel.refreshing': 'Updating…',
      'panel.failed': 'Could not read the site account; try again later.',
      'panel.stale': 'The reading service in this app instance is out of date. Restart the app to load the current build.',
      'panel.noData': 'No usage in this period.',
      'panel.available': 'Available',
      'panel.frozenRow': 'Frozen',
      'panel.rechargedRow': 'Lifetime top-up',
      'panel.spentRow': 'Spent (24h)',
      'panel.daily': 'Spend by hour (last 24h)',
      'panel.windowCost': '24h total: {amount}',
      'panel.models': 'By model (last 24h)',
      'panel.keys': 'API keys on this account',
      'panel.records': 'Recent requests',
      'panel.thTime': 'Time',
      'panel.thModel': 'Model',
      'panel.thTokens': 'Tokens',
      'panel.thCost': 'Cost',
      'panel.thKey': 'Key',
      'panel.thGroup': 'Group',
      'panel.thKeyStatus': 'Status',
      'panel.accountRow': 'Account',
      'panel.site': 'Open the API site dashboard',
    };

    const ZH = {
      label: '余额',
      pending: '…',
      dash: '—',
      'title.loading': '正在读取 API 站点账户余额…',
      'title.account': 'API 站点账户：{account}',
      'title.available': '可用余额：{amount}',
      'title.frozen': '冻结：{amount}',
      'title.recharged': '累计充值：{amount}',
      'title.failed': '暂时无法读取 API 站点账户余额，稍后会自动重试。',
      'title.missing': '本应用实例未运行 API 站点余额读取服务。',
      'panel.title': 'API 站点余额',
      'panel.loading': '加载中…',
      'panel.refreshing': '正在更新中…',
      'panel.failed': '站点账户读取失败，稍后重试。',
      'panel.stale': '本应用实例里的读取服务还是旧版本，重启应用后才会按新的时间口径显示。',
      'panel.noData': '该时段暂无用量。',
      'panel.available': '可用余额',
      'panel.frozenRow': '冻结',
      'panel.rechargedRow': '累计充值',
      'panel.spentRow': '近 24 小时消费',
      'panel.daily': '近 24 小时逐时消费',
      'panel.windowCost': '24 小时合计：{amount}',
      'panel.models': '模型用量（近 24 小时）',
      'panel.keys': '本账户的 API 密钥',
      'panel.records': '最近请求',
      'panel.thTime': '时间',
      'panel.thModel': '模型',
      'panel.thTokens': 'Tokens',
      'panel.thCost': '消费',
      'panel.thKey': '密钥',
      'panel.thGroup': '分组',
      'panel.thKeyStatus': '状态',
      'panel.accountRow': '账户',
      'panel.site': '打开 API 站点控制台',
    };

    /** Wallet glyph in the reading's own color. */
    const ICON = h('svg', {
      viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true,
      style: { display: 'block', flex: 'none' },
    }, [
      h('ellipse', { key: 'top', cx: 7, cy: 3.9, rx: 4.3, ry: 1.7, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { key: 'wall', d: 'M2.7 3.9v5.5c0 .94 1.92 1.7 4.3 1.7s4.3-.76 4.3-1.7V3.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { key: 'band', d: 'M2.7 6.6c0 .94 1.92 1.7 4.3 1.7s4.3-.76 4.3-1.7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
    ]);

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥';
      if (currency === 'USD') return '$';
      return `${currency} `;
    }

    /**
     * Site-style amount: two decimals, grouped digits, `<¥0.01` under a cent.
     * @param amount - decimal amount as the site reports it.
     * @param currency - currency code, CNY unless stated.
     */
    function formatAmount(amount, currency) {
      const symbol = currencySymbol(currency ?? 'CNY');
      if (!Number.isFinite(amount)) return `${symbol}0.00`;
      const magnitude = Math.abs(amount);
      if (magnitude > 0 && magnitude < 0.01) return `${amount < 0 ? '-' : ''}<${symbol}0.01`;
      const fixed = magnitude.toFixed(2);
      const [whole, fraction] = fixed.split('.');
      return `${amount < 0 ? '-' : ''}${symbol}${Number(whole).toLocaleString('en-US')}.${fraction}`;
    }

    /** Compact token count: 12.3k / 1.25M. */
    function formatTokens(count) {
      if (!Number.isFinite(count) || count <= 0) return '0';
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
      if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
      return String(Math.round(count));
    }

    /** Cost with enough precision for sub-cent relay prices. */
    function formatCost(amount, currency) {
      const value = Number(amount);
      if (!Number.isFinite(value)) return formatAmount(0, currency);
      if (Math.abs(value) > 0 && Math.abs(value) < 0.01) return `${value < 0 ? '-' : ''}<${currencySymbol(currency ?? 'CNY')}0.01`;
      return formatAmount(value, currency);
    }

    /** Short time label for a record's ISO stamp: today shows only the clock. */
    function formatRecordTime(iso) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return '';
      const now = new Date();
      const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
      const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      return sameDay ? clock : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock}`;
    }

    /** The compact reading, fetched through the Host half's loopback route. */
    async function readBalance() {
      let res;
      try {
        res = await window.fetch(BALANCE_ROUTE, { cache: 'no-store' });
      } catch (error) {
        console.error('[balance] reading route unreachable', error);
        return { status: 'failed' };
      }
      if (!res.ok) {
        console.error('[balance] reading route answered HTTP', res.status);
        return { status: res.status === 404 ? 'missing' : 'failed' };
      }
      let json;
      try {
        json = await res.json();
      } catch (_error) {
        return { status: 'failed' };
      }
      if (json === null || typeof json !== 'object') return { status: 'failed' };
      if (json.status !== 'ready') return { status: 'failed' };
      const balance = Number(json.balance);
      if (!Number.isFinite(balance)) return { status: 'failed' };
      const frozen = Number(json.frozen ?? 0);
      const recharged = Number(json.recharged ?? 0);
      return {
        status: 'ready',
        balance,
        frozen: Number.isFinite(frozen) ? frozen : 0,
        recharged: Number.isFinite(recharged) ? recharged : 0,
        currency: typeof json.currency === 'string' && json.currency !== '' ? json.currency : 'CNY',
        account: typeof json.account === 'string' ? json.account : '',
      };
    }

    /** The panel reading, fetched through the Host half's loopback route. */
    async function readPanel() {
      let res;
      try {
        res = await window.fetch(PANEL_ROUTE, { cache: 'no-store' });
      } catch (error) {
        console.error('[balance] panel route unreachable', error);
        return { status: 'failed' };
      }
      if (!res.ok) {
        console.error('[balance] panel route answered HTTP', res.status);
        return { status: 'failed' };
      }
      try {
        const json = await res.json();
        if (json === null || typeof json !== 'object' || json.status !== 'ready') return { status: 'failed' };
        return json.version === PANEL_VERSION ? json : { status: 'stale' };
      } catch (_error) {
        return { status: 'failed' };
      }
    }

    /** One shared balance reading with a stale-after cache and a single in-flight request. */
    function createStore(read) {
      let state = { status: 'idle' };
      let readAt = 0;
      let inFlight = null;
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of listeners) listener();
      };
      return {
        get: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        ensure(force = false) {
          if (inFlight !== null) return inFlight;
          const ttl = state.status === 'failed' || state.status === 'missing' ? RETRY_MS : CACHE_MS;
          const fresh = state.status !== 'idle' && Date.now() - readAt < ttl;
          if (!force && fresh) return Promise.resolve();
          inFlight = (async () => {
            if (state.status === 'idle' || state.status === 'failed') publish({ status: 'loading' });
            try {
              publish(await read());
            } catch (_error) {
              publish({ status: 'failed' });
            }
            readAt = Date.now();
            inFlight = null;
          })();
          return inFlight;
        },
      };
    }

    /** Where the last successful balance-details reading is kept on this device. */
    const PANEL_CACHE_KEY = 'dsh.balance.panel.v3';
    /** A reading older than this is no longer shown while the next one loads. */
    const PANEL_CACHE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
    /** Opening the panel re-reads in the background when the last read is this old. */
    const PANEL_REFRESH_MS = 15_000;

    /** This page's persistent storage, or null when the browser withholds it. */
    function localStore() {
      try {
        return window.localStorage ?? null;
      } catch (_error) {
        return null;
      }
    }

    /** The last balance-details reading saved on this device, when still worth showing. */
    function readPanelCache() {
      const store = localStore();
      if (store === null) return null;
      try {
        const raw = store.getItem(PANEL_CACHE_KEY);
        if (typeof raw !== 'string' || raw === '') return null;
        const saved = JSON.parse(raw);
        const readAt = Number(saved?.readAt);
        const data = saved?.data;
        if (!Number.isFinite(readAt) || Date.now() - readAt > PANEL_CACHE_KEEP_MS) return null;
        if (data === null || typeof data !== 'object' || data.status !== 'ready') return null;
        return { data, readAt };
      } catch (_error) {
        return null;
      }
    }

    /** Keep the latest balance-details reading on this device for the next open. */
    function writePanelCache(data, readAt) {
      const store = localStore();
      if (store === null) return;
      try {
        store.setItem(PANEL_CACHE_KEY, JSON.stringify({ data, readAt }));
      } catch (_error) {
        // Private mode or a full quota: the reading simply stays in memory.
      }
    }

    /**
     * Balance details cached on this device: opening the panel paints the last
     * reading at once and refreshes it in the background, so the panel never
     * waits on the network. A failed refresh keeps the cached numbers.
     */
    function createPanelStore(read) {
      const saved = readPanelCache();
      let state = saved === null ? null : saved.data;
      let readAt = saved === null ? 0 : saved.readAt;
      let failedAt = 0;
      let refreshing = false;
      let inFlight = null;
      const listeners = new Set();
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const publish = (next) => {
        state = next;
        notify();
      };
      return {
        get: () => state,
        isRefreshing: () => refreshing,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        ensure(force = false) {
          if (inFlight !== null) return inFlight;
          if (!force) {
            if (state !== null && Date.now() - readAt < PANEL_REFRESH_MS) return Promise.resolve();
            if (state === null && failedAt !== 0 && Date.now() - failedAt < RETRY_MS) return Promise.resolve();
          }
          refreshing = true;
          notify();
          inFlight = (async () => {
            try {
              const next = await read();
              if (next !== null && typeof next === 'object' && next.status === 'ready') {
                readAt = Date.now();
                failedAt = 0;
                writePanelCache(next, readAt);
                publish(next);
              } else if (state === null) {
                failedAt = Date.now();
                publish(next ?? { status: 'failed' });
              } else {
                failedAt = Date.now();
              }
            } catch (_error) {
              if (state === null) publish({ status: 'failed' });
              else failedAt = Date.now();
            } finally {
              inFlight = null;
              if (refreshing) {
                refreshing = false;
                notify();
              }
            }
          })();
          return inFlight;
        },
      };
    }

    /** Bar-chart palette drawn from the app's brand tones. */
    const BAR_COLOR = 'var(--dsw-alias-brand-primary, #4d6bfe)';
    const BAR_TRACK = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18))';
    /** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /** The dock reading: label plus the API site account balance. */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {

    if (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('style[data-plugin-css="@local/dsh-balance/panel.css"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-balance';
      tag.dataset.pluginCss = '@local/dsh-balance/panel.css';
      tag.textContent = PANEL_CSS;
      ctx.effect(() => {
        document.head.appendChild(tag);
        return () => tag.remove();
      });
    }

        const locale = ctx.get?.('locale') ?? ctx.locale;
        if (typeof locale?.register === 'function') {
          ctx.effect(() => locale.register(NS, { en: EN, zh: ZH }), 'balance: dictionaries');
        }
        const fallback = (key, args={}) => String(ZH[key] ?? key).replace(/\{(\w+)\}/g, (_,name)=>String(args[name]??''));
        const translate = locale?.bind ? locale.bind(NS) : fallback;
        const balanceStore = createStore(readBalance);
        const panelStore = createPanelStore(readPanel);


        let opened = false;
        const listeners = new Set();
        const setOpen = value => { opened=value; for(const fn of listeners) fn(value); };
        function useStore(store) {
          const [state, update] = React.useState(store.get());
          React.useEffect(() => store.subscribe(() => update(store.get())), []);
          return state;
        }
        function useOpen() {
          const [value, update] = React.useState(opened);
          React.useEffect(() => { listeners.add(update); return () => listeners.delete(update); }, []);
          return value;
        }
        function BalanceReading() {
          const state = useStore(balanceStore);
          const open = useOpen();
          React.useEffect(() => {
            balanceStore.ensure();
            const timer=setInterval(() => balanceStore.ensure(),30000);
            return () => { clearInterval(timer); setOpen(false); };
          }, []);
          const t=translate;
          return h('button', { type:'button', className:'dshb-pill', 'aria-expanded':open,
            onClick:()=>setOpen(!opened) }, ICON, '余额 ', state.status==='ready' ? formatAmount(state.balance,state.currency) : '—');
        }
        function BalancePanel() {
          const open=useOpen();
          const data=useStore(panelStore);
          React.useEffect(() => {
            if(!open) return;
            panelStore.ensure();
            const timer=setInterval(()=>panelStore.ensure(),30000);
            const target=typeof globalThis.addEventListener==='function' ? globalThis : null;
            const key=e=>{if(e.key==='Escape')setOpen(false)};
            target?.addEventListener('keydown',key);
            return()=>{clearInterval(timer);target?.removeEventListener('keydown',key)};
          },[open]);
          if(!open)return null;
          const t=translate;
          return h('div', { style:{position:'fixed',inset:0,zIndex:1100,pointerEvents:'auto'},onClick:()=>setOpen(false)},
            h('div',{className:'dshb-panel',role:'dialog','aria-label':t('panel.title'),
              onClick:e=>e.stopPropagation(),style:{left:'max(12px, calc(50vw - 280px))',bottom:80,width:560,maxWidth:'calc(100vw - 24px)',maxHeight:'calc(100vh - 104px)'}},
              h('div',{className:'dshb-title'},t('panel.title'),h('button',{type:'button',onClick:()=>setOpen(false)},'关闭')),
              data?.status==='ready' ? h('div',null,
                h(SummaryRows,{data,t}),h(HourlyChart,{hourly:data.hourly,window:data.window,currency:data.currency,t}),
                h(ModelBreakdown,{models:data.models,currency:data.currency,t}),h(KeyTable,{keys:data.keys,t}),h(RecordTable,{records:data.records,currency:data.currency,t}))
              : h('div',null,data===null?t('panel.loading'):t('panel.failed'))));
        }
        /** The site account's own figures: available, frozen, lifetime top-up, account name. */
        function SummaryRows({ data, t }) {
          const currency = data.currency ?? 'CNY';
          const rows = [];
          if (typeof data.account === 'string' && data.account !== '') {
            rows.push(h('span', { key: 'ak', className: 'dshb-key' }, t('panel.accountRow')));
            rows.push(h('span', { key: 'av' }, data.account));
          }
          rows.push(h('span', { key: 'k1', className: 'dshb-key' }, t('panel.available')));
          rows.push(h('span', { key: 'v1' }, formatAmount(Number(data.balance ?? 0), currency)));
          if (Number(data.frozen ?? 0) > 0) {
            rows.push(h('span', { key: 'k2', className: 'dshb-key' }, t('panel.frozenRow')));
            rows.push(h('span', { key: 'v2' }, formatAmount(Number(data.frozen), currency)));
          }
          if (Number(data.recharged ?? 0) > 0) {
            rows.push(h('span', { key: 'k3', className: 'dshb-key' }, t('panel.rechargedRow')));
            rows.push(h('span', { key: 'v3' }, formatAmount(Number(data.recharged), currency)));
          }
          if (Number.isFinite(Number(data.window?.cost))) {
            rows.push(h('span', { key: 'k4', className: 'dshb-key' }, t('panel.spentRow')));
            rows.push(h('span', { key: 'v4', style: { fontVariantNumeric: 'tabular-nums' } }, formatCost(Number(data.window.cost), currency)));
          }
          return h('div', { className: 'dshb-rows' },
            rows,
            h('span', { key: 'lk', className: 'dshb-key' }, ''),
            h('a', {
              key: 'lk2',
              href: SITE_URL,
              target: '_blank',
              rel: 'noreferrer',
              style: { color: BAR_COLOR, textDecoration: 'none' },
            }, t('panel.site')));
        }

        /** Hour-of-day label for an hourly bucket: `23:00`. */
        function formatHourTick(at) {
          const date = new Date(Number(at));
          if (Number.isNaN(date.getTime())) return '';
          return `${String(date.getHours()).padStart(2, '0')}:00`;
        }

        /**
         * Twenty-four hourly bars covering the rolling window, oldest first.
         * Each bar's tooltip carries the hour, cost and request count.
         */
        function HourlyChart({ hourly, window: windowTotals, currency, t }) {
          const hours = Array.isArray(hourly) ? hourly.slice(-24) : [];
          if (hours.length === 0) return null;
          const width = 520;
          const height = 72;
          const max = Math.max(...hours.map((hour) => hour.cost), 0.000001);
          const barArea = width - 8;
          const slot = barArea / Math.max(hours.length, 1);
          const barWidth = Math.max(3, Math.min(16, slot - 4));
          const total = Number.isFinite(Number(windowTotals?.cost))
            ? Number(windowTotals.cost)
            : hours.reduce((sum, hour) => sum + hour.cost, 0);
          const peak = hours.reduce((best, hour) => (hour.cost > best.cost ? hour : best), hours[0]);
          return h('div', null,
            h('div', { className: 'dshb-sectionTitle', style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
              h('span', null, t('panel.daily')),
              h('span', { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, t('panel.windowCost', { amount: formatCost(total, currency) }))),
            h('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' },
              hours.map((hour, index) => {
                const barHeight = Math.max(hour.cost > 0 ? 2 : 1, Math.round((hour.cost / max) * (height - 24)));
                const x = 4 + index * slot + (slot - barWidth) / 2;
                const y = height - 16 - barHeight;
                const label = `${formatHourTick(hour.at)} · ${formatCost(hour.cost, currency)} · ${hour.requests} req`;
                const labelled = index % 6 === 0;
                return h('g', { key: hour.at },
                  h('rect', { x, y, width: barWidth, height: barHeight, rx: 2, fill: hour.cost > 0 ? BAR_COLOR : BAR_TRACK, opacity: hour === peak ? 1 : 0.85 },
                    h('title', null, label)),
                  labelled
                    ? h('text', { x: x + barWidth / 2, y: height - 4, textAnchor: 'middle', fontSize: 8.5, fill: 'var(--dsw-alias-label-tertiary)' }, formatHourTick(hour.at))
                    : null);
              })));
        }

        /** Per-model spend rows with a proportional bar behind each name. */
        function ModelBreakdown({ models, currency, t }) {
          const rows = Array.isArray(models) ? models.filter((model) => model.cost > 0).slice(0, 6) : [];
          if (rows.length === 0) return null;
          const max = Math.max(...rows.map((row) => row.cost));
          return h('div', null,
            h('div', { className: 'dshb-sectionTitle' }, t('panel.models')),
            rows.map((row) => h('div', { key: row.model, style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '1px 0' } },
              h('span', { key: 'n', style: { position: 'relative', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', padding: '1px 4px', borderRadius: 4 } },
                h('span', { key: 'bar', 'aria-hidden': true, style: { position: 'absolute', inset: 0, width: `${Math.max(4, Math.round((row.cost / max) * 100))}%`, background: BAR_TRACK, borderRadius: 4 } }),
                h('span', { key: 'name', style: { position: 'relative' } }, row.model)),
              h('span', { key: 'c', style: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-tertiary)' } }, formatCost(row.cost, currency)))));
        }

        /** The account's API keys exactly as the site lists them: name, group, status. */
        function KeyTable({ keys, t }) {
          const rows = Array.isArray(keys) ? keys.slice(0, 8) : [];
          if (rows.length === 0) return null;
          return h('div', null,
            h('div', { className: 'dshb-sectionTitle' }, t('panel.keys')),
            h('table', { className: 'dshb-table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'h1' }, t('panel.thKey')),
                h('th', { key: 'h2' }, t('panel.thGroup')),
                h('th', { key: 'h3', style: { textAlign: 'right' } }, t('panel.thKeyStatus')))),
              h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.name}-${index}` },
                h('td', { key: 'c1' }, row.name),
                h('td', { key: 'c2', style: { maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' } }, row.group),
                h('td', { key: 'c3', style: { textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' } }, row.status))))));
        }

        /** The most recent requests: time, model, tokens and the charged cost. */
        function RecordTable({ records, currency, t }) {
          const rows = Array.isArray(records) ? records.slice(0, 10) : [];
          if (rows.length === 0) return null;
          const cell = (value, key, extra) => h('td', { key, style: extra }, value);
          return h('div', null,
            h('div', { className: 'dshb-sectionTitle' }, t('panel.records')),
            h('table', { className: 'dshb-table' },
              h('thead', null, h('tr', null,
                cell(t('panel.thTime'), 'h1'),
                cell(t('panel.thModel'), 'h2'),
                cell(t('panel.thTokens'), 'h3', { textAlign: 'right' }),
                cell(t('panel.thCost'), 'h4', { textAlign: 'right' }))),
              h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.time}-${index}` },
                cell(formatRecordTime(row.time), 'c1'),
                cell(row.model, 'c2', { maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }),
                cell(formatTokens(row.tokens), 'c3', { textAlign: 'right' }),
                cell(formatCost(row.cost, currency), 'c4', { textAlign: 'right' }))))));
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({name:'shell.overlay', id:'balance-panel',order:91}, BalancePanel));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'balance',
          order: 2,
          locale: NS,
        }, BalanceReading));
      },
    };
    }
    const React = require('react');
    const h = React.createElement;

    /** Host projections: ours, and the meter's own occupancy. */
    const CACHE = 'contextAnchorCache';
    const PRESSURE = 'contextPressure';
    /** Same-origin route the Host half authenticates with the page's own credentials. */
    const SETTINGS_API = '/api/dsh-context-anchor/settings';
    /** Shown on the badge tooltip and in the panel header, so a stale page betrays itself. */
    const CLIENT_VERSION = 'v1.16.0';

    /** Panel copy: Chinese only — the interface is part of a Chinese desktop. */
    const COPY = {
      label: '本地缓存',
      panelTitle: '记忆与上下文',
      statusLabel: '状态',
      contentLabel: '可召回内容',
      contentValue: (v) => `${v.chars} 字符 · ${v.events} 条`,
      recallsLabel: '检索次数',
      recallsValue: (n) => (n > 0 ? `${n} 次` : '尚未检索'),
      contextLabel: '热上下文',
      degradeLabel: '上下文压力',
      unknown: '—',
      statusIdle: '记忆就绪',
      statusRecall: '正在检索记忆…',
      statusExpand: '正在回读记忆…',
      wroteJust: '刚刚写入',
      wroteSeconds: (s) => `${s} 秒前写入`,
      wroteMinutes: (m) => `${m} 分钟前写入`,
      tierClear: '清醒',
      tierMild: '轻微',
      tierModerate: '中度',
      tierHeavy: '明显',
      level: '智力水平',
      auto: '自动',
      custom: '自定义',
      autoHint: '本会话跟随系统默认：热上下文接近上限时自动压缩。',
      thresholdHint: (p) => `仅本会话：热上下文达到 ${p}% 时，旧历史自动压缩进记忆；系统默认约 80%。`,
      recallLabel: '自动回忆',
      recallHint: '压缩后按当前指令自动检索被归档的内容。',
      defaultsTitle: '全局默认',
      defaultsAuto: '模式：自动',
      defaultsCustom: (p) => `模式：自定义 ${p}%`,
      defaultsRecallOn: '自动回忆：开启',
      defaultsRecallOff: '自动回忆：关闭',
      resetButton: '重置为全局',
      resetHint: '删除本会话的自定义策略，恢复使用全局默认。',
      exportButton: '导出',
      importButton: '导入',
      importHint: '从 JSON 文件导入设置（包含全局和所有会话策略）。',
      clearSessionsButton: (n) => `清除所有会话策略（${n}）`,
      clearSessionsHint: '只删除每个会话的单独设置，全局默认保留。',
      clearSessionsConfirm: (n) => `确定删除 ${n} 个会话的自定义策略？此操作不可撤销。`,
      trendTitle: '本地缓存趋势（token）',
      trendEmpty: '暂无历史数据。',
      previewTitle: '下次压缩',
      previewRange: (from, to, count, total) => `seq ${from}–${to} · ${count}/${total}`,
      previewAtThreshold: (p) => `占用到 ${p}% 时，上面这些会先归档成检查点。`,
      previewAuto: '自动模式由 harness 决定何时压缩；这是它将会处理的最早一段。',
      previewProtected: '已按保护规则收缩，命中的内容留在表层。',
      protectLabel: '保护内容',
      protectNone: '未设置',
      protectPlaceholder: '如 README.md, src/auth/',
      protectHint: '逗号分隔，最多 8 条。仅自定义压缩模式执行严格保护；自动模式不应用这些规则。',
      indexLabel: '检索索引',
      indexValue: (docs, terms) => `${docs} 篇 · ${terms} 词条`,
      anchorLabel: '本步注入',
      anchorValue: (chars, tokens, recalled, dropped) => {
        const base = `${chars} 字符 · 约 ${tokens} token${recalled ? ' · 含回忆' : ''}`;
        return dropped > 0 ? `${base} · 已裁 ${dropped} 字符` : base;
      },
      anchorNone: '尚未注入：发出下一条消息后显示',
      memoryLabel: '分类记忆',
      memoryValue: (counts) => [
        ['决定', counts.decision], ['约束', counts.constraint], ['问题', counts.problem],
        ['待办', counts.task], ['文件', counts.file], ['命令', counts.command], ['事实', counts.fact],
      ].filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`).join(' · '),
      memoryNone: '还没有分类记忆',
      compactionCountLabel: '压缩次数',
      compactionCountValue: (count, lastSeq) => (count > 0
        ? `${count} 次${typeof lastSeq === 'number' && lastSeq >= 0 ? ` · 最近 seq ${lastSeq}` : ''}`
        : '尚未压缩'),
      adviceTitle: '建议',
      adviceNoCompaction: '启用 @deepseek-ai/dsh-compaction-basic 后，自定义阈值才会生效。',
      adviceAutoHigh: (p) => `占用已到 ${p}%，切到自定义 60% 可提前压缩，降低上下文压力。`,
      adviceCustomLow: (p, t) => `当前 ${p}%，离 ${t}% 还远；这个设置偏保守，会话会一直很满。`,
      adviceNoRecall: '检索索引已建好但还没被用过：问模型一件早先的事就能验证记忆。',
      adviceProtect: '会话已很长：把关键文件路径填进保护内容，压缩时它们会留在表层。',
      renderFailed: (m) => `面板渲染失败：${m}`,
      saveFailed: '保存失败，稍后重试。',
      policyUnavailable: '设置暂不可用：宿主还没有加载这一版，重启 DSH 后再打开面板。',
      noCompaction: '当前环境没有压缩服务，自定义阈值不会生效。',
      note: '缓存不进上下文窗口，压缩后仍可用 context_recall 读取；压力按热上下文占用估算，不代表模型能力测量。',
      tooltip: '点击查看记忆状态与热上下文压力',
    };

    /** Compact count in the meter's own vocabulary (12.3K, 4.5M). */
    function compact(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return `${Math.round(value / 100) / 10}K`;
      return `${Math.round(value / 100000) / 10}M`;
    }

    /**
     * Hover without a stylesheet: a dynamic Client half has no CSS modules and no
     * `:hover` in inline styles, so pointer state has to be React state. Every
     * clickable surface in this plugin goes through it, so the badge and the
     * panel's buttons answer the pointer like the shipped controls do.
     */
    function useHover() {
      const [hovered, setHovered] = React.useState(false);
      return [hovered, {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onFocus: () => setHovered(true),
        onBlur: () => setHovered(false),
      }];
    }

    /** Written-at as a short relative phrase. */
    function wroteAgo(ageMs, copy) {
      if (ageMs < 3000) return copy.wroteJust;
      if (ageMs < 60000) return copy.wroteSeconds(Math.round(ageMs / 1000));
      return copy.wroteMinutes(Math.round(ageMs / 60000));
    }

    /** Occupancy tier — how much hot context is pressing on the model. */
    function tierOf(percent, copy) {
      if (percent < 25) return { label: copy.tierClear, tone: 'var(--dsw-alias-label-tertiary)' };
      if (percent < 50) return { label: copy.tierMild, tone: 'var(--dsw-alias-label-secondary)' };
      if (percent < 75) return { label: copy.tierModerate, tone: '#c08a3e' };
      return { label: copy.tierHeavy, tone: '#c2554d' };
    }

    /** Badge color grading by pressure: <60% green, 60-80% yellow, >80% orange. */
    function badgeColorOf(percent) {
      if (percent < 60) return { base: '#4a9d5f', hover: '#5cb574' }; // green
      if (percent < 80) return { base: '#c08a3e', hover: '#d4a049' }; // yellow
      return { base: '#c2554d', hover: '#d4675d' }; // orange
    }

    /** Render a mini trend chart from history data points. */
    function renderTrendChart(history) {
      if (!Array.isArray(history) || history.length === 0) {
        return h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '12px 0' } }, COPY.trendEmpty)
      }

      const width = 240
      const height = 60
      const padding = { top: 4, right: 4, bottom: 4, left: 4 }
      const chartWidth = width - padding.left - padding.right
      const chartHeight = height - padding.top - padding.bottom

      // Find min/max for Y axis (percent range)
      const percents = history.map(p => Number.isFinite(p.tokens) ? Math.max(0, p.tokens) : Number.isFinite(p.percent) ? Math.max(0, p.percent * 10000) : 0)
      const minPercent = 0
      const maxPercent = Math.max(1, ...percents)
      const rangePercent = maxPercent - minPercent || 1

      // Map data points to SVG coordinates
      const points = history.map((point, i) => {
        const x = padding.left + (i / (history.length - 1 || 1)) * chartWidth
        const y = padding.top + chartHeight - ((percents[i] - minPercent) / rangePercent) * chartHeight
        return { x, y, percent: point.percent }
      })

      // Build polyline path
      const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

      // Color based on latest percent
      const latestPercent = percents[percents.length - 1] || 0
      const color = 'var(--dsw-alias-brand-primary, #4d6bfe)'

      return h('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: { display: 'block', margin: '8px auto 0' },
      },
      h('title', null, `${compact(latestPercent)} token`),
      h('path', {
        d: pathData,
        fill: 'none',
        stroke: color,
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }))
    }

    /** Disk-stack glyph: locally retained history. */
    function icon() {
      return h('svg', {
        viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      },
      h('ellipse', { cx: 7, cy: 3.6, rx: 4.2, ry: 1.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { d: 'M2.8 3.6v6.8c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6V3.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { d: 'M2.8 7c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }));
    }

    const ROW = { display: 'flex', alignItems: 'baseline', gap: 8, minHeight: 20 };
    const ROW_LABEL = { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' };
    const ROW_VALUE = {
      marginLeft: 'auto', color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums', textAlign: 'right',
    };
    const DIVIDER = { height: 1, margin: '10px 0', background: 'var(--dsw-alias-border-l1)' };

    /** Preferred panel width; clamped to the viewport when published. */
    const PANEL_WIDTH = 460;
    /** Two columns above this width, one below it. */
    const TWO_COLUMN_MIN = 400;
    const COLUMNS = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' };

    /**
     * Bridge between the dock badge and the overlay panel: they are separate
     * slot entries with no shared parent, so the badge publishes the anchor
     * rect and the latest projections here and the panel subscribes.
     */
    const store = {
      state: { open: false, left: 12, bottom: 80, cache: undefined, pressure: undefined, sessionId: undefined },
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      publish(patch) {
        store.state = { ...store.state, ...patch };
        for (const listener of [...store.listeners]) listener(store.state);
      },
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        createBalanceModule(require).apply(ctx);
        /** Segmented option that answers the pointer like the shipped menus. */
        function ChoiceButton(props) {
          const [hovered, hoverProps] = useHover();
          return h('button', {
            type: 'button',
            'aria-pressed': props.active,
            onClick: props.onClick,
            ...hoverProps,
            style: {
              border: 'none', borderRadius: 5, padding: '1px 9px', font: 'inherit',
              lineHeight: '18px', cursor: 'pointer',
              background: props.active
                ? 'var(--dsw-alias-bg-layer-1, #ffffff)'
                : hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: props.active || hovered
                ? 'var(--dsw-alias-label-primary)'
                : 'var(--dsw-alias-label-tertiary)',
              boxShadow: props.active ? 'var(--dsw-elevation-stroke)' : 'none',
              transition: 'background .12s, color .12s',
            },
          }, props.label);
        }

        /** The panel's switch, sized to the row's text rather than a form control. */
        function SwitchButton(props) {
          const [hovered, hoverProps] = useHover();
          return h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': props.on,
            'aria-label': props.label,
            onClick: props.onToggle,
            ...hoverProps,
            style: {
              width: 28, height: 16, padding: 0, border: 'none', borderRadius: 999, flex: 'none',
              position: 'relative', cursor: 'pointer',
              transition: 'background .15s, box-shadow .12s',
              background: props.on
                ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
                : 'var(--dsw-alias-fill-tertiary, rgba(0,0,0,.08))',
              boxShadow: hovered ? '0 0 0 3px var(--dsw-alias-interactive-bg-hover)' : 'none',
            },
          }, h('span', {
            style: {
              position: 'absolute', top: 2, left: props.on ? 14 : 2, width: 12, height: 12,
              borderRadius: 999, background: '#fff', transition: 'left .15s',
              boxShadow: '0 1px 2px rgba(0,0,0,.25)',
            },
          }));
        }

        /** Dock entry: the ambient reading that opens the panel. */
        function CacheBadge(props) {
          const useProjection = props.useProjection;
          const read = typeof useProjection === 'function' ? useProjection : () => undefined;
          const cached = read(CACHE);
          const pressure = read(PRESSURE);
          const [hovered, hoverProps] = useHover();
          // The dock is a session-scoped slot: this id is what the panel uses to
          // read and write the policy of the conversation it was opened from.
          const sessionId = props.sessionId;

          // Badge color by pressure tier: <60% green, 60-80% yellow, >80% orange
          const badgeColors = badgeColorOf(pressure?.percent ?? 0);

          // Keep an open panel's figures live without re-opening it.
          React.useEffect(() => {
            if (store.state.open) store.publish({ cache: cached, pressure, sessionId, open: Boolean(sessionId) });
          }, [cached, pressure, sessionId]);

          React.useEffect(() => () => {
            if (store.state.sessionId === sessionId) store.publish({ open: false, sessionId: undefined });
          }, [sessionId]);
          if (cached === undefined || cached === null || !(cached.events > 0)) return null;

          const copy = COPY;
          return h('span', {
            style: { display: 'inline-flex', flex: 'none', position: 'relative' },
          },
          h('button', {
            type: 'button',
            title: copy.tooltip,
            'aria-haspopup': 'dialog',
            'aria-expanded': store.state.open,
            'data-context-anchor-cache': String(cached.tokens),
            title: `上下文锚点 ${CLIENT_VERSION}`,
            ...hoverProps,
            onClick: (event) => {
              if (store.state.open) {
                store.publish({ open: false });
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              // Wide enough for two columns; never wider than the viewport.
              const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
              const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
              const width = Math.max(280, Math.min(PANEL_WIDTH, viewportWidth - 24));
              store.publish({
                open: true,
                cache: cached,
                pressure,
                sessionId,
                width,
                left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)),
                bottom: viewportHeight - rect.top + 8,
              });
            },
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
              padding: '1px 8px', border: 'none',
              background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
              color: hovered ? badgeColors.hover : badgeColors.base,
              fontFamily: 'inherit',
              fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
              lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
              transition: 'background .12s, color .12s',
            },
          },
          icon(),
          h('span', null, `${copy.label} ~${compact(cached.tokens)}`)));
        }

        /** Overlay entry: the panel itself, rendered above every column. */
        function CachePanel() {
          const [state, setState] = React.useState(store.state);
          React.useEffect(() => store.subscribe(setState), []);
          React.useEffect(() => {
            if (!state.open) return undefined;
            const id = setInterval(() => setState({ ...store.state }), 1000);
            return () => clearInterval(id);
          }, [state.open]);

          // Policy is read from the Host half on every open, so a second window
          // and a reloaded page always show what is actually in force.
          const [storedPolicy, setPolicy] = React.useState(null);
          const [defaults, setDefaults] = React.useState(null);
          const [perSession, setPerSession] = React.useState(false);
          const [preview, setPreview] = React.useState(null);
          const [sessionCount, setSessionCount] = React.useState(0);
          const [indexStats, setIndexStats] = React.useState(null);
          const [anchorStats, setAnchorStats] = React.useState(null);
          const [memoryStats, setMemoryStats] = React.useState(null);
          const [compactionStats, setCompactionStats] = React.useState(null);
          const [saveError, setSaveError] = React.useState(false);
          const saveTimer = React.useRef(0);
          const io = React.useRef({ session: state.sessionId, epoch: 0, revision: 0, queue: Promise.resolve(), dirty: false, pending: 0, reading: false, policy: null });
          const policy = io.current.session === state.sessionId ? storedPolicy : null;
          const [runtimeInfo, setRuntimeInfo] = React.useState(null);
          const send = (body) => fetch(SETTINGS_API, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))));
          const paint = (data, includePolicy = true) => {
            if (includePolicy) {
              io.current.policy = typeof data?.settings === 'object' ? { ...data.settings, limits: data.limits, compaction: data.compaction !== false } : false;
              setPolicy(io.current.policy);
              setDefaults(data?.defaults ?? null);
              setPerSession(data?.perSession === true);
              setSessionCount(data?.sessionCount ?? 0);
            }
            setRuntimeInfo(data?.runtime ?? null);
            setPreview(data?.preview ?? null);
            setIndexStats(data?.index ?? null);
            setAnchorStats(data?.anchor ?? null);
            setMemoryStats(data?.memory ?? null);
            setCompactionStats(data?.compactions ?? null);
          };
          const cancelSave = () => { clearTimeout(saveTimer.current); saveTimer.current = 0; io.current.revision += 1; io.current.dirty = false; };
          const mutate = (body) => {
            const token = { session: state.sessionId, epoch: io.current.epoch, revision: io.current.revision };
            const valid = () => io.current.epoch === token.epoch && io.current.session === token.session && io.current.revision === token.revision;
            io.current.pending += 1;
            const result = io.current.queue.then(async () => {
              if (!valid()) return;
              const data = await send({ ...body, session: token.session });
              const payload = body.action === 'import' ? await send({ action: 'read', session: token.session }) : data;
              if (valid()) { io.current.dirty = false; paint(payload); setSaveError(false); }
            }).catch(() => { if (valid()) setSaveError(true); }).finally(() => { io.current.pending -= 1; });
            io.current.queue = result;
            return result;
          };

          React.useEffect(() => {
            const current = io.current;
            current.epoch += 1;
            current.session = state.sessionId;
            current.policy = null;
            current.reading = false;
            cancelSave();
            setPolicy(null); setPreview(null); setIndexStats(null); setAnchorStats(null); setMemoryStats(null); setCompactionStats(null);
            const epoch = current.epoch;
            if (!state.open || !state.sessionId) return undefined;
            let disposed = false;
            const refresh = async () => {
              if (disposed || current.reading || current.pending) return;
              current.reading = true;
              const revision = current.revision;
              try {
                const data = await send({ action: 'read', session: state.sessionId });
                if (!disposed && current.epoch === epoch && current.revision === revision) {
                  paint(data, !current.dirty);
                  if (!current.dirty) setSaveError(false);
                }
              } catch {
                if (!disposed && current.epoch === epoch && current.policy === null) setPolicy(false);
              } finally { if (current.epoch === epoch) current.reading = false; }
            };
            refresh();
            const timer = setInterval(refresh, 1500);
            return () => { disposed = true; clearInterval(timer); cancelSave(); current.epoch += 1; };
          }, [state.open, state.sessionId]);
          // Esc closes the panel. The loader's `window` is a shim WITHOUT
          // addEventListener — a real crash found via the client-error trace —
          // so pick the first event target that actually works and drop the
          // shortcut silently when none does. A missing shortcut must never
          // take the panel down with it.
          React.useEffect(() => {
            if (!state.open) return undefined;
            const target = typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function'
              ? globalThis
              : typeof window !== 'undefined' && typeof window.addEventListener === 'function'
                ? window
                : null;
            if (target === null) return undefined;
            const onKeyDown = (event) => {
              if (event.key === 'Escape') store.publish({ open: false });
            };
            target.addEventListener('keydown', onKeyDown);
            return () => target.removeEventListener('keydown', onKeyDown);
          }, [state.open]);

          const savePolicy = (next) => mutate({ action: 'save', mode: next.mode, percent: next.percent, autoRecall: next.autoRecall, protect: Array.isArray(next.protect) ? next.protect : [] });
          const updatePolicy = (patch) => {
            if (!state.sessionId || !io.current.policy || io.current.session !== state.sessionId) return;
            const next = { ...io.current.policy, ...patch };
            cancelSave(); io.current.dirty = true; io.current.policy = next;
            setPolicy(next); setSaveError(false);
            saveTimer.current = setTimeout(() => { saveTimer.current = 0; savePolicy(next); }, 220);
          };
          const deletePolicy = () => {
            if (!perSession || !state.sessionId) return;
            cancelSave(); mutate({ action: 'delete' });
          };
          const [clearArmed, setClearArmed] = React.useState(false);
          const clearSessions = () => {
            if (!sessionCount) return;
            const confirmHost = typeof globalThis.confirm === 'function' ? globalThis : typeof window !== 'undefined' && typeof window.confirm === 'function' ? window : null;
            if (confirmHost) { if (!confirmHost.confirm(COPY.clearSessionsConfirm(sessionCount))) return; }
            else if (!clearArmed) { setClearArmed(true); return; }
            setClearArmed(false); cancelSave(); mutate({ action: 'clear-sessions' });
          };
          /** Export all settings to a JSON file. */
          const exportSettings = () => {
            // Flush the visible edit before reading the snapshot. A failed save
            // leaves dirty=true, so exporting cannot silently download old data.
            if (io.current.session !== state.sessionId) return;
            if (saveTimer.current || io.current.dirty) {
              clearTimeout(saveTimer.current);
              saveTimer.current = 0;
              savePolicy(io.current.policy);
            }
            const token = { epoch: io.current.epoch, revision: io.current.revision };
            const valid = () => io.current.epoch === token.epoch && io.current.revision === token.revision;
            io.current.pending += 1;
            const result = io.current.queue.then(async () => {
              if (!valid() || io.current.dirty) return;
              const data = await send({ action: 'export' });
              if (!valid()) return;
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `context-anchor-settings-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              })
              .catch(() => { if (valid()) setSaveError(true); })
              .finally(() => { io.current.pending -= 1; });
            io.current.queue = result;
          };

          /** Import settings from a JSON file. */
          const importSettings = () => {
            const importEpoch = io.current.epoch;
            const importSession = state.sessionId;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  if (io.current.epoch !== importEpoch || store.state.sessionId !== importSession) return;
                  const data = JSON.parse(reader.result);
                  cancelSave(); mutate({ action: 'import', data });
                } catch {
                  setSaveError(true);
                }
              };
              reader.readAsText(file);
            };
            input.click();
          };

          const cached = state.cache;
          if (!state.open || cached === undefined || cached === null) return null;

          const copy = COPY;
          const lastAt = typeof cached.lastAt === 'number' && cached.lastAt > 0 ? cached.lastAt : null;
          const age = lastAt === null ? null : Math.max(0, Date.now() - lastAt);
          const status = cached.activity === 'recall'
            ? copy.statusRecall
            : cached.activity === 'expand'
              ? copy.statusExpand
              : age === null
                ? copy.statusIdle
                : `${copy.statusIdle} · ${wroteAgo(age, copy)}`;

          const pressure = state.pressure;
          const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
          const window = pressure?.contextWindow;
          const known = typeof used === 'number' && typeof window === 'number' && window > 0;
          const percent = known ? Math.min(100, Math.round((used / window) * 100)) : 0;
          const tier = tierOf(percent, copy);
          // Two columns only when the panel is actually wide enough for them.
          const wide = (typeof state.width === 'number' ? state.width : PANEL_WIDTH) >= TWO_COLUMN_MIN;

          const row = (key, label, value) => h('div', { key, style: ROW },
            h('span', { style: ROW_LABEL }, label),
            h('span', { style: ROW_VALUE }, value));

          const hint = {
            marginTop: 6, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px',
          };

          /** One option of the inline two-way control, in the menu's own surface. */
          const choice = (value, label) => h(ChoiceButton, {
            key: value,
            active: policy.mode === value,
            label,
            onClick: () => updatePolicy({ mode: value }),
          });

          /** The panel's switch, sized to the row's text rather than a form control. */
          const switchButton = (on, onToggle) => h(SwitchButton, {
            on,
            label: copy.recallLabel,
            onToggle,
          });

          /** One concrete suggestion at a time; saying nothing beats saying "fine". */
          const advice = (() => {
            if (policy === null || policy === false || !known) return null;
            if (policy.compaction === false) return copy.adviceNoCompaction;
            if (policy.mode === 'auto' && percent >= 70) return copy.adviceAutoHigh(percent);
            if (policy.mode === 'custom' && percent < policy.percent - 20) {
              return copy.adviceCustomLow(percent, policy.percent);
            }
            if ((cached.recalls ?? 0) === 0 && (indexStats?.docs ?? 0) > 200) return copy.adviceNoRecall;
            if ((policy.protect?.length ?? 0) === 0 && (indexStats?.docs ?? 0) > 1500) return copy.adviceProtect;
            return null;
          })();

          // A thrown render would unmount the whole panel and look like the click
          // did nothing, which is the worst possible failure mode for a menu. Every
          // h() call evaluates immediately, so one try/catch here covers the body.
          try {
            return h('div', null,
          h('div', {
            key: 'backdrop',
            onClick: () => store.publish({ open: false }),
            style: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 0, background: 'transparent' },
          }),
          h('div', {
            key: 'panel',
            role: 'dialog',
            'aria-label': copy.panelTitle,
            style: {
              position: 'fixed', left: state.left, bottom: state.bottom, zIndex: 1,
              boxSizing: 'border-box',
              width: typeof state.width === 'number' ? state.width : PANEL_WIDTH,
              padding: 12, borderRadius: 'var(--dsw-radius-lg)',
              // The panel grows upward from the badge. With every block it now
              // carries, cap it below the viewport top and scroll inside — an
              // overflowing menu is just a quieter way of not opening.
              maxHeight: `calc(100vh - ${Math.round(typeof state.bottom === 'number' ? state.bottom : 80) + 24}px)`,
              overflowY: 'auto',
              // The menu token is deliberately translucent (#43454a73 in dark) and
              // expects a 40px backdrop blur in native menus. Alone over chat text it
              // reads washed-out, so paint the solid page color underneath and keep
              // only the token's tint on top: opaque, still in the theme's palette.
              backgroundColor: 'var(--dsw-alias-bg-base)',
              backgroundImage: 'linear-gradient(var(--dsw-specific-menu), var(--dsw-specific-menu))',
              boxShadow: 'var(--dsw-elevation-prominent)',
              color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '20px',
              cursor: 'default', whiteSpace: 'normal',
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, `${copy.panelTitle} · ${CLIENT_VERSION}`),
            h('span', {
              style: {
                marginLeft: 'auto', color: 'var(--dsw-alias-label-primary)',
                fontWeight: 500, fontVariantNumeric: 'tabular-nums',
              },
            }, `~${compact(cached.tokens)}`)),
          h('div', { style: DIVIDER }),
          // Two columns keep the panel short: counters on the left, pressure on
          // the right, and the long lines below span both. Narrow windows fall
          // back to one column rather than squeezing the values.
          h('div', { key: 'stats', style: wide ? COLUMNS : { display: 'grid', gap: 8 } },
            h('div', { style: { display: 'grid', gap: 2 } },
              row('status', copy.statusLabel, status),
              row('content', copy.contentLabel, copy.contentValue({ chars: compact(cached.chars), events: cached.events })),
              typeof cached.recalls === 'number'
                ? row('recalls', copy.recallsLabel, copy.recallsValue(cached.recalls))
                : null,
              indexStats && typeof indexStats.docs === 'number'
                ? row('index', copy.indexLabel, copy.indexValue(indexStats.docs, indexStats.terms ?? 0))
                : null),
            h('div', { style: { display: 'grid', gap: 2 } },
              row('context', copy.contextLabel, known ? `~${compact(used)} / ${compact(window)}` : copy.unknown),
              h('div', { key: 'degrade', style: ROW },
                h('span', { style: ROW_LABEL }, copy.degradeLabel),
                h('span', { style: { ...ROW_VALUE, color: known ? tier.tone : ROW_VALUE.color } },
                  known ? `${tier.label} · ${percent}%` : copy.unknown)),
              known && h('div', {
                style: {
                  marginTop: 4, height: 4, borderRadius: 999, overflow: 'hidden',
                  background: 'var(--dsw-alias-interactive-bg-hover)',
                },
              }, h('div', { style: { height: '100%', width: `${percent}%`, background: tier.tone } })))),
          h('div', { style: { display: 'grid', gap: 2, marginTop: 8 } },
            runtimeInfo && row('runtime', '运行版本', 'Host ' + (runtimeInfo.hostVersion ?? '未知') + ' · Client ' + CLIENT_VERSION),
           row('anchor', copy.anchorLabel, anchorStats && typeof anchorStats.chars === 'number'
              ? copy.anchorValue(anchorStats.chars, anchorStats.tokens ?? 0, anchorStats.recalled === true, anchorStats.dropped ?? 0)
              : copy.anchorNone),
            memoryStats && typeof memoryStats === 'object'
              ? row('memory', copy.memoryLabel, copy.memoryValue(memoryStats) || copy.memoryNone)
              : null,
            row('compactions', copy.compactionCountLabel, compactionStats && typeof compactionStats.count === 'number'
              ? copy.compactionCountValue(compactionStats.count, compactionStats.lastSeq)
              : copy.compactionCountValue(0))),
          known && cached.history?.length > 0 && h('div', {
            key: 'trend',
            style: { marginTop: 12 },
          },
          h('div', { style: { fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, copy.trendTitle),
          renderTrendChart(cached.history)),
          policy !== null && policy !== false && h('div', { key: 'policy' },
            h('div', { style: DIVIDER }),
            h('div', { style: ROW },
              h('span', { style: ROW_LABEL }, copy.level),
              h('div', {
                style: {
                  marginLeft: 'auto', display: 'inline-flex', gap: 2, padding: 2,
                  borderRadius: 7, background: 'var(--dsw-alias-fill-tertiary, rgba(0,0,0,.06))',
                },
              }, choice('auto', copy.auto), choice('custom', copy.custom))),
            policy.mode === 'custom' && h('div', {
              key: 'threshold',
              style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
            },
            h('input', {
              type: 'range',
              min: policy.limits?.min ?? 30,
              max: policy.limits?.max ?? 80,
              step: 1,
              value: policy.percent,
              'aria-label': copy.level,
              onChange: (event) => updatePolicy({ percent: Number(event.target.value) }),
              style: {
                flex: 1, minWidth: 0, margin: 0,
                accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)',
              },
            }),
            h('span', { style: { ...ROW_VALUE, marginLeft: 0, minWidth: 30 } }, `${policy.percent}%`)),
            h('div', { style: hint }, policy.compaction === false
              ? copy.noCompaction
              : policy.mode === 'custom'
                ? copy.thresholdHint(policy.percent)
                : copy.autoHint),
            h('div', { style: { ...ROW, marginTop: 10 } },
              h('span', { style: ROW_LABEL }, copy.recallLabel),
              h('div', { style: { marginLeft: 'auto' } },
                switchButton(policy.autoRecall, () => updatePolicy({ autoRecall: !policy.autoRecall })))),
            h('div', { style: hint }, copy.recallHint),
            h('div', { key: 'protect', style: { marginTop: 10 } },
              h('div', { style: ROW },
                h('span', { style: ROW_LABEL }, copy.protectLabel),
                h('span', { style: { ...ROW_VALUE, fontSize: 11 } },
                  (policy.protect?.length ?? 0) === 0
                    ? copy.protectNone
                    : `${policy.protect.length}`)),
              h('input', {
                // Remount when the normalised list changes, so the field always
                // shows what the host actually stored rather than the raw typing.
                key: `protect-${(policy.protect ?? []).join('|')}`,
                type: 'text',
                defaultValue: (policy.protect ?? []).join(', '),
                placeholder: copy.protectPlaceholder,
                'aria-label': copy.protectLabel,
                onBlur: (event) => {
                  const raw = String(event.currentTarget.value ?? '');
                  const next = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
                  if (next.join('|') === (policy.protect ?? []).join('|')) return;
                  updatePolicy({ protect: next });
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                },
                style: {
                  boxSizing: 'border-box', width: '100%', marginTop: 4, padding: '4px 6px',
                  border: '1px solid var(--dsw-alias-stroke-secondary)', borderRadius: 6,
                  background: 'transparent', color: 'inherit', fontFamily: 'inherit',
                  fontSize: 11, lineHeight: '16px',
                },
              }),
              h('div', { style: hint }, copy.protectHint)),
            preview?.available === true && h('div', { key: 'preview', style: { marginTop: 12 } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, copy.previewTitle),
                h('span', {
                  style: {
                    marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                  },
                }, copy.previewRange(preview.from, preview.to, preview.count, preview.total))),
              h('div', { style: hint }, policy.mode === 'custom'
                ? copy.previewAtThreshold(policy.percent)
                : copy.previewAuto),
              preview.protected === true && h('div', {
                style: { ...hint, color: 'var(--dsw-alias-label-secondary)' },
              }, copy.previewProtected),
              Array.isArray(preview.samples) && preview.samples.map((sample) => h('div', {
                key: `preview-${sample.seq}`,
                style: {
                  marginTop: 4, padding: '4px 6px', borderRadius: 6,
                  background: 'var(--dsw-alias-fill-tertiary, rgba(0,0,0,.06))',
                  color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '15px',
                  overflow: 'hidden',
                },
              },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `#${sample.seq} `),
              sample.text))),
            perSession && defaults && h('div', {
              key: 'defaults',
              style: {
                marginTop: 12,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--dsw-alias-fill-tertiary, rgba(0,0,0,.04))',
                fontSize: 11,
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            h('div', { style: { fontWeight: 500, marginBottom: 4 } }, copy.defaultsTitle),
            h('div', null, defaults.mode === 'auto' ? copy.defaultsAuto : copy.defaultsCustom(defaults.percent)),
            h('div', null, defaults.autoRecall ? copy.defaultsRecallOn : copy.defaultsRecallOff)),
            perSession && h('div', { key: 'reset', style: { marginTop: 10 } },
              h('button', {
                type: 'button',
                onClick: deletePolicy,
                style: {
                  width: '100%',
                  padding: '6px 10px',
                  border: '1px solid var(--dsw-alias-stroke-secondary)',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                  cursor: 'pointer',
                  transition: 'background .12s, border-color .12s',
                },
                onMouseEnter: (e) => {
                  e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)';
                  e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-primary)';
                },
                onMouseLeave: (e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-secondary)';
                },
              }, copy.resetButton),
              h('div', { style: hint }, copy.resetHint)),
            saveError && h('div', {
              key: 'error',
              style: { ...hint, color: 'var(--dsw-alias-state-error-primary, #d54941)' },
            }, copy.saveFailed)),
          policy === false && h('div', { key: 'policy-unavailable' },
            h('div', { style: DIVIDER }),
            h('div', { style: hint }, copy.policyUnavailable)),
          h('div', {
            key: 'export-import',
            style: {
              marginTop: 12,
              paddingTop: 10,
              borderTop: '1px solid var(--dsw-alias-stroke-tertiary)',
              display: 'flex',
              gap: 8,
            },
          },
          h('button', {
            type: 'button',
            onClick: exportSettings,
            style: {
              flex: 1,
              padding: '6px 10px',
              border: '1px solid var(--dsw-alias-stroke-secondary)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'background .12s, border-color .12s',
            },
            onMouseEnter: (e) => {
              e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-primary)';
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-secondary)';
            },
          }, copy.exportButton),
          h('button', {
            type: 'button',
            onClick: importSettings,
            style: {
              flex: 1,
              padding: '6px 10px',
              border: '1px solid var(--dsw-alias-stroke-secondary)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'background .12s, border-color .12s',
            },
            onMouseEnter: (e) => {
              e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-primary)';
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-secondary)';
            },
          }, copy.importButton)),
          h('div', { style: hint }, copy.importHint),
          sessionCount > 0 && h('button', {
            key: 'clear-sessions',
            type: 'button',
            onClick: clearSessions,
            style: {
              width: '100%',
              marginTop: 8,
              padding: '6px 10px',
              border: '1px solid var(--dsw-alias-stroke-secondary)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-state-error-primary, #d54941)',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'background .12s, border-color .12s',
            },
            onMouseEnter: (e) => {
              e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-state-error-primary, #d54941)';
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'var(--dsw-alias-stroke-secondary)';
            },
          }, clearArmed ? '再次点击确认清除' : copy.clearSessionsButton(sessionCount)),
          sessionCount > 0 && h('div', { style: hint }, copy.clearSessionsHint),
          advice !== null && h('div', {
            key: 'advice',
            style: {
              marginTop: 12, padding: '6px 8px', borderRadius: 6,
              background: 'var(--dsw-alias-fill-tertiary, rgba(0,0,0,.04))',
              color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px',
            },
          }, `${copy.adviceTitle}：${advice}`),
          h('div', {
            style: {
              marginTop: 12, color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 11, lineHeight: '16px',
            },
          }, copy.note)));
          } catch (error) {
            return h('div', {
              key: 'panel-error',
              role: 'alert',
              style: {
                position: 'fixed', left: state.left, bottom: state.bottom, zIndex: 1,
                boxSizing: 'border-box', maxWidth: 320, padding: 12,
                borderRadius: 'var(--dsw-radius-lg)', boxShadow: 'var(--dsw-elevation-prominent)',
                backgroundColor: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-state-error-primary, #d54941)',
                fontSize: 12, lineHeight: '18px',
              },
            }, copy.renderFailed(error && error.message ? error.message : String(error)));
          }
        }

        /**
         * The slot system deactivates an occupant whose render crashes, and to
         * the user that reads as a dead click. Catch the crash here instead:
         * show the error in place and report it to the Host trace, where the
         * exact message can be read back.
         */
        class PanelBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          componentDidCatch(error) {
            this.report(error);
          }

          report(error) {
            try {
              fetch(SETTINGS_API, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  action: 'client-error',
                  message: error && error.message ? error.message : String(error),
                  stack: error && error.stack ? String(error.stack).slice(0, 1500) : '',
                }),
              }).catch(() => {});
            } catch { /* reporting must never be the crash */ }
          }

          render() {
            if (this.state.error === null) return h(CachePanel);
            const message = this.state.error && this.state.error.message
              ? this.state.error.message
              : String(this.state.error);
            return h('div', {
              role: 'alert',
              style: {
                position: 'fixed', left: 16, bottom: 64, zIndex: 1,
                boxSizing: 'border-box', maxWidth: 340, maxHeight: 'calc(100vh - 88px)',
                overflowY: 'auto', padding: 12,
                borderRadius: 'var(--dsw-radius-lg)', boxShadow: 'var(--dsw-elevation-prominent)',
                backgroundColor: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-state-error-primary, #d54941)',
                fontSize: 12, lineHeight: '18px',
              },
            }, COPY.renderFailed(message));
          }
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'context-anchor-cache',
          order: 3,
        }, CacheBadge));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'context-anchor-panel',
          order: 90,
        }, PanelBoundary));
      },
    };
  },
});
