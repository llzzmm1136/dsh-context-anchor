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
    const React = require('react');
    const h = React.createElement;

    /** Host projections: ours, and the meter's own occupancy. */
    const CACHE = 'contextAnchorCache';
    const PRESSURE = 'contextPressure';
    /** Same-origin route the Host half authenticates with the page's own credentials. */
    const SETTINGS_API = '/api/dsh-context-anchor/settings';

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
      degradeLabel: '降智水平',
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
      saveFailed: '保存失败，稍后重试。',
      policyUnavailable: '设置暂不可用：宿主还没有加载这一版，重启 DSH 后再打开面板。',
      noCompaction: '当前环境没有压缩服务，自定义阈值不会生效。',
      note: '缓存不进上下文窗口，压缩后仍可用 context_recall 读取；降智水平按热上下文占用估算，仅供参考。',
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
            if (store.state.open) store.publish({ cache: cached, pressure, sessionId });
          }, [cached, pressure, sessionId]);

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
            ...hoverProps,
            onClick: (event) => {
              if (store.state.open) {
                store.publish({ open: false });
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              const width = 264;
              const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
              const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
              store.publish({
                open: true,
                cache: cached,
                pressure,
                sessionId,
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
          const [policy, setPolicy] = React.useState(null);
          const [defaults, setDefaults] = React.useState(null);
          const [perSession, setPerSession] = React.useState(false);
          const [saveError, setSaveError] = React.useState(false);
          const saveTimer = React.useRef(0);

          React.useEffect(() => {
            if (!state.open) return undefined;
            let cancelled = false;
            fetch(SETTINGS_API, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'read', session: state.sessionId }),
            })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
              .then((data) => {
                if (cancelled) return;
                setPolicy(typeof data?.settings === 'object'
                  ? { ...data.settings, limits: data.limits, compaction: data.compaction !== false }
                  : false);
                setDefaults(typeof data?.defaults === 'object' ? data.defaults : null);
                setPerSession(data?.perSession === true);
                setSaveError(false);
              })
              .catch(() => {
                if (!cancelled) setPolicy(false);
              });
            return () => {
              cancelled = true;
            };
          }, [state.open]);

          React.useEffect(() => () => clearTimeout(saveTimer.current), []);

          const savePolicy = (next) => {
            fetch(SETTINGS_API, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'save',
                session: state.sessionId,
                mode: next.mode,
                percent: next.percent,
                autoRecall: next.autoRecall,
              }),
            })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
              .then((data) => {
                setPolicy(typeof data?.settings === 'object'
                  ? { ...data.settings, limits: data.limits, compaction: data.compaction !== false }
                  : next);
                setDefaults(typeof data?.defaults === 'object' ? data.defaults : null);
                setPerSession(data?.perSession === true);
                setSaveError(false);
              })
              .catch(() => setSaveError(true));
          };

          /** Paint the change immediately; persist once the control settles. */
          const updatePolicy = (patch) => {
            if (policy === null || policy === false) return;
            const next = { ...policy, ...patch };
            setPolicy(next);
            setSaveError(false);
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => savePolicy(next), 220);
          };

          /** Delete per-session override and revert to global defaults. */
          const deletePolicy = () => {
            if (!perSession || !state.sessionId) return;
            fetch(SETTINGS_API, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'delete', session: state.sessionId }),
            })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
              .then((data) => {
                setPolicy(typeof data?.settings === 'object'
                  ? { ...data.settings, limits: data.limits, compaction: data.compaction !== false }
                  : null);
                setDefaults(typeof data?.defaults === 'object' ? data.defaults : null);
                setPerSession(data?.perSession === true);
                setSaveError(false);
              })
              .catch(() => setSaveError(true));
          };

          /** Export all settings to a JSON file. */
          const exportSettings = () => {
            fetch(SETTINGS_API, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'export' }),
            })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
              .then((data) => {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `context-anchor-settings-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              })
              .catch(() => setSaveError(true));
          };

          /** Import settings from a JSON file. */
          const importSettings = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  const data = JSON.parse(reader.result);
                  fetch(SETTINGS_API, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'import', data }),
                  })
                    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
                    .then(() => {
                      // Reload current policy after import
                      fetch(SETTINGS_API, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ action: 'read', session: state.sessionId }),
                      })
                        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
                        .then((data) => {
                          setPolicy(typeof data?.settings === 'object'
                            ? { ...data.settings, limits: data.limits, compaction: data.compaction !== false }
                            : null);
                          setDefaults(typeof data?.defaults === 'object' ? data.defaults : null);
                          setPerSession(data?.perSession === true);
                          setSaveError(false);
                        })
                        .catch(() => setSaveError(true));
                    })
                    .catch(() => setSaveError(true));
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
              boxSizing: 'border-box', width: 264, padding: 12, borderRadius: 'var(--dsw-radius-lg)',
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
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, copy.panelTitle),
            h('span', {
              style: {
                marginLeft: 'auto', color: 'var(--dsw-alias-label-primary)',
                fontWeight: 500, fontVariantNumeric: 'tabular-nums',
              },
            }, `~${compact(cached.tokens)}`)),
          h('div', { style: DIVIDER }),
          h('div', { style: { display: 'grid', gap: 2 } },
            row('status', copy.statusLabel, status),
            row('content', copy.contentLabel, copy.contentValue({ chars: compact(cached.chars), events: cached.events })),
            typeof cached.recalls === 'number'
              ? row('recalls', copy.recallsLabel, copy.recallsValue(cached.recalls))
              : null),
          h('div', { style: DIVIDER }),
          h('div', { style: { display: 'grid', gap: 2 } },
            row('context', copy.contextLabel, known ? `~${compact(used)} / ${compact(window)}` : copy.unknown),
            h('div', { key: 'degrade', style: ROW },
              h('span', { style: ROW_LABEL }, copy.degradeLabel),
              h('span', { style: { ...ROW_VALUE, color: known ? tier.tone : ROW_VALUE.color } },
                known ? `${tier.label} · ${percent}%` : copy.unknown))),
          known && h('div', {
            style: {
              marginTop: 6, height: 4, borderRadius: 999, overflow: 'hidden',
              background: 'var(--dsw-alias-interactive-bg-hover)',
            },
          }, h('div', { style: { height: '100%', width: `${percent}%`, background: tier.tone } })),
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
              marginTop: 16,
              paddingTop: 12,
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
          h('div', {
            style: {
              marginTop: 12, color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 11, lineHeight: '16px',
            },
          }, copy.note)));
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
        }, CachePanel));
      },
    };
  },
});
