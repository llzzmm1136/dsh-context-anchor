/**
 * Offline render probe for the Client half.
 *
 * Runs both slot entries against a minimal React stand-in: the dock badge, its
 * click that publishes the anchor rect, and the overlay panel built from that
 * store. Proves the module loads, registers into both slots, and renders the
 * closed/open trees without throwing — the parts a restart cannot tell us.
 *
 * Usage: node probe-client.mjs
 */
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__definition = definition } },
  innerWidth: 1280,
  innerHeight: 900,
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

await import('./client.js')

const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
class FakeComponent {
  constructor(props) { this.props = props; this.state = null; }
}
let pendingEffects = []
const React = {
  createElement: el,
  Component: FakeComponent,
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  // Effects are COLLECTED and executed by runEffects() — a no-op here is how
  // the window.addEventListener crash hid from this probe for two releases.
  useEffect: (fn) => { pendingEffects.push(fn) },
}

/** Mount semantics: effects run after render, as React would. */
function runEffects() {
  const list = pendingEffects
  pendingEffects = []
  const cleanups = []
  for (const effect of list) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

// The panel's read effect fires a same-origin POST; stub it so the probe never
// reaches the network.
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })

const definition = globalThis.__definition
if (definition.id !== '@local/dsh-context-anchor') throw new Error(`unexpected id ${definition.id}`)

const mod = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

const registrations = new Map()
const ctx = {
  get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, component) => { registrations.set(options.name, { options, component }) },
  },
}
mod.apply(ctx)

const badge = registrations.get('conversation.composer.dock')
const panel = registrations.get('shell.overlay')

// A cache WITH history: the trend-chart branch must actually execute, otherwise
// a broken reference inside it stays hidden (a real failure: the panel silently
// vanished because that branch shortened under a fixture without history).
const cache = {
  tokens: 208851, chars: 822592, events: 376, activity: 'recall', recalls: 3, at: 638, lastAt: Date.now(),
  history: [{ time: Date.now() - 3000, percent: 22 }, { time: Date.now() - 1000, percent: 37 }],
}
const pressure = { projectedTokens: 45000, contextWindow: 900000 }
const props = { useProjection: (key) => (key === 'contextAnchorCache' ? cache : pressure) }

const badgeTree = badge.component(props)
const badgeText = JSON.stringify(badgeTree)
runEffects()

// Click the badge: it must publish the anchor and open the panel.
const button = badgeTree.children[0]
button.props.onClick({
  currentTarget: { getBoundingClientRect: () => ({ left: 400, top: 820, width: 140, height: 22 }) },
})

// The panel is registered as an error-boundary class. Mount it the way React
// would (instantiate, then render), then resolve the inner CachePanel element.
const mountPanel = (props = {}) => {
  const instance = new panel.component(props)
  return instance.render()
}
pendingEffects = []
const panelEl = mountPanel({})
const panelTree = panelEl.type(panelEl.props ?? {})
const panelText = JSON.stringify(panelTree)

// Effects must run clean — this is where the Esc shortcut crashed the real
// panel (the loader's window shim has no addEventListener).
let effectsError = null
try {
  runEffects()
} catch (error) {
  effectsError = error
}

const checks = [
  ['registers the dock badge', badge?.options.id === 'context-anchor-cache'],
  ['registers the overlay panel', panel?.options.id === 'context-anchor-panel'],
  ['badge shows the cached size', badgeText.includes('本地缓存') && badgeText.includes('208.9K')],
  ['badge listens for clicks', typeof button.props.onClick === 'function'],
  ['click opens the panel', panelTree !== null],
  ['panel keeps the badge anchor', panelText.includes('"left":400') && panelText.includes('"bottom":88')],
  ['panel shows the title and figures', panelText.includes('记忆与上下文') && panelText.includes('208.9K')],
  ['panel shows the searching state', panelText.includes('正在检索记忆')],
  ['panel shows the search count', panelText.includes('3 次')],
  ['panel shows the hot context', panelText.includes('45K') && panelText.includes('900K')],
  ['panel shows the degradation tier', panelText.includes('降智水平') && panelText.includes('5%')],
  ['panel renders a click-away backdrop', panelText.includes('"background":"transparent"')],
  ['panel keeps its footer note without settings', panelText.includes('缓存不进上下文窗口')],
  ['panel draws the trend chart', panelText.includes('历史趋势') && panelText.includes('"svg"')],
  ['panel carries the version marker', /v1\.6\.\d+/.test(panelText)],
  ['panel effects run clean', effectsError === null,
    effectsError === null ? '' : `${effectsError && effectsError.message}`],
]

// The boundary must turn a crash into visible text, not a deactivated slot.
const boundaryInstance = new panel.component({})
boundaryInstance.state = panel.component.getDerivedStateFromError(new Error('probe-crash'))
const boundaryTree = JSON.stringify(boundaryInstance.render())
checks.push(['boundary renders the crash as text', boundaryTree.includes('面板渲染失败') && boundaryTree.includes('probe-crash')])

let failures = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures += 1
}

// Without the projection the badge renders nothing (capability absence, not an error).
const empty = badge.component({ useProjection: () => undefined })
console.log(`${empty === null ? 'PASS' : 'FAIL'} badge renders nothing without the projection`)
if (empty !== null) failures += 1

console.log(failures === 0 ? '\nCLIENT PROBE PASSED' : `\n${failures} PROBE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
