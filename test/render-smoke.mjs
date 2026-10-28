/**
 * Smoke test: actually RENDER the panel and the badge.
 *
 * `node --check` only proves the file parses; a reference to an undefined
 * variable (the bug that made the panel silently vanish) is a runtime error.
 * This loads the real module under a fake loader, captures the components the
 * plugin registers, and calls them with scripted hook state, so every branch of
 * the panel body is evaluated for real.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const src = readFileSync(FILE, 'utf8')

// --- Fake React: real createElement trees, scripted hook values ------------
let hookValues = []
let hookIndex = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  Component: class FakeComponent {
    constructor(props) { this.props = props; this.state = null; }
  },
  useState(init) {
    const value = hookIndex < hookValues.length && hookValues[hookIndex] !== undefined
      ? hookValues[hookIndex]
      : (typeof init === 'function' ? init() : init)
    hookIndex += 1
    return [value, () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
}

// --- Load the module the way the harness does -----------------------------
let spec
const globalWindow = {
  __ModuleLoader__: { load(next) { spec = next } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  confirm: () => true,
}
const sandbox = {
  window: globalWindow,
  globalThis: undefined,
  React,
  Date,
  Math,
  JSON,
  console,
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  FileReader: function FileReader() {},
  URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
  Blob: function Blob() {},
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: FILE })

// --- Register the plugin and grab its components --------------------------
const components = {}
const module = spec.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
const ctx = {
  slots: {
    inject(_name, run) { run() },
    register(spec_, Component) {
      components[spec_.name] = Component
      return () => {}
    },
  },
  logger: { warn() {}, info() {} },
  effect() {},
}
module.apply(ctx)

const panel = components['shell.overlay']
const badge = components['conversation.composer.dock']

// --- Fixtures -------------------------------------------------------------
const cache = {
  tokens: 12345,
  chars: 48000,
  events: 42,
  recalls: 3,
  activity: 'idle',
  at: 900,
  lastAt: Date.now() - 5000,
  history: [{ time: 1, percent: 12 }, { time: 2, percent: 28 }, { time: 3, percent: 44 }],
}
const pressure = { projectedTokens: 120000, contextWindow: 200000 }

const openState = { open: true, left: 20, bottom: 90, cache, pressure, sessionId: 'sess-1' }
const policy = {
  mode: 'custom', percent: 70, autoRecall: true, protect: ['src/auth/'],
  limits: { min: 30, max: 80 }, compaction: true,
}
const preview = {
  available: true, count: 12, total: 20, from: 1, to: 12, percent: 60, protected: true,
  samples: [{ seq: 1, type: 'user/message', text: '用户：最早的指令' }, { seq: 12, type: 'assistant/message', text: '助手：中间的回复' }],
}

/** Render one component with the hook state it would see, in order. */
function render(Component, values, props = {}) {
  hookValues = values
  hookIndex = 0
  if (Component.prototype && typeof Component.prototype.render === 'function') {
    const instance = new Component(props)
    return instance.render()
  }
  return Component(props)
}

/**
 * The overlay slot registers an error-boundary class wrapping CachePanel:
 * mount the boundary, then resolve the inner panel element it returns.
 */
function renderPanel(values) {
  const outer = render(panel, values)
  if (outer === null || outer === undefined || typeof outer.type !== 'function') return outer
  return render(outer.type, values, outer.props ?? {})
}

/** Walk a rendered tree, descending into arrays and node children alike. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node !== 'object') {
    visit(node)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every node (not plain string) in the tree. */
function nodesOf(node) {
  const into = []
  walk(node, (item) => { if (typeof item === 'object') into.push(item) })
  return into
}

const typesOf = (node) => nodesOf(node).map((n) => n.type)

/** Does any string in the tree contain this text? */
function hasText(node, needle) {
  let found = false
  walk(node, (item) => { if (typeof item === 'string' && item.includes(needle)) found = true })
  return found
}

const results = []
const check = (label, condition, detail) => {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${condition ? '' : `\n   ${detail ?? ''}`}`)
}

const tries = (label, fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    results.push(`FAIL ${label} threw: ${error && error.message ? error.message : String(error)}`)
    return { ok: false }
  }
}

// 1) Full panel: every block present, including the trend chart and preview.
{
  const run = tries('panel (full)', () => renderPanel([
    openState, policy, { mode: 'auto', percent: 60, autoRecall: true, protect: [] },
    true, preview, 3, { docs: 1200, terms: 8000, at: 900 }, false,
  ]))
  if (run.ok) {
    const nodes = nodesOf(run.value)
    const types = typesOf(run.value)
    check('panel renders a tree', run.value !== null && run.value !== undefined)
    check('trend chart is an svg', types.includes('svg'))
    check('threshold slider present', nodes.some((n) => n.type === 'input' && n.props.type === 'range'))
    check('custom segmented controls present', nodes.some((n) => typeof n.type === 'function'),
      `function types: ${[...new Set(types.filter((t) => typeof t === 'function').map((t) => t.name))].join(',')}`)
    check('text input for protection', types.includes('input'))
    check('bulk clear offered when overrides exist',
      JSON.stringify(run.value).includes('清除所有会话策略') || types.filter((t) => t === 'button').length >= 4,
      `buttons: ${types.filter((t) => t === 'button').length}`)
  }
}

// 2) Closed panel renders nothing at all.
{
  const run = tries('panel (closed)', () => renderPanel([{ ...openState, open: false, cache: undefined }]))
  if (run.ok) check('closed panel returns null', run.value === null || run.value === undefined)
}

// 3) Empty history must not throw and must not draw a chart.
{
  const run = tries('panel (no history)', () => renderPanel([
    { ...openState, cache: { ...cache, history: [] }, pressure: undefined },
    policy, null, false, undefined, 0, undefined, false,
  ]))
  if (run.ok) {
    const types = typesOf(run.value)
    check('no svg without history', !types.includes('svg'))
  }
}

// 4) Policy unavailable: the panel still renders with the explanatory line.
{
  const run = tries('panel (policy unavailable)', () => renderPanel([
    openState, false, null, false, undefined, 0, undefined, false,
  ]))
  if (run.ok) check('policy-unavailable still renders', run.value !== null)
}

// 5) Unknown pressure: no chart, no crash.
{
  const run = tries('panel (unknown pressure)', () => renderPanel([
    { ...openState, pressure: undefined }, policy, null, true, undefined, 0, undefined, false,
  ]))
  if (run.ok) check('unknown pressure renders', run.value !== null)
}

// 5b) The boundary turns a crash into visible text instead of a dead slot.
{
  const run = tries('boundary (error path)', () => {
    const instance = new panel({})
    instance.state = panel.getDerivedStateFromError(new Error('boundary-boom'))
    return instance.render()
  })
  if (run.ok) {
    check('boundary shows the crash text', hasText(run.value, '面板渲染失败') && hasText(run.value, 'boundary-boom'))
  }
}

// 6) The dock badge renders its label and cache size.
{
  const run = tries('badge', () => render(badge, [cache], {
    sessionId: 'sess-1',
    useProjection: (key) => (key === 'contextAnchorCache' ? cache : pressure),
  }))
  if (run.ok) {
    const types = typesOf(run.value)
    check('badge is a button', types.includes('button'))
    check('badge is an svg glyph', types.includes('svg'))
  }
}

// 7) A badge with no projection yet must not throw.
{
  const run = tries('badge (empty)', () => render(badge, [undefined], {
    sessionId: 'sess-1',
    useProjection: () => undefined,
  }))
  if (run.ok) check('empty badge returns null', run.value === null || run.value === undefined)
}

// 8) Advice appears when memory has been indexed but never used.
{
  const run = tries('panel (advice)', () => renderPanel([
    { ...openState, cache: { ...cache, recalls: 0 } },
    policy, null, false, preview, 0, { docs: 400, terms: 900, at: 900 }, false,
  ]))
  if (run.ok) {
    check('advice rendered', hasText(run.value, '建议'))
    check('advice names the unused index', hasText(run.value, '还没被用过'))
  }
}

// 9) The protection note shows only when protection actually applied.
{
  const protectedRun = tries('panel (protected)', () => renderPanel([
    openState, policy, null, false, { ...preview, protected: true }, 0, undefined, false,
  ]))
  if (protectedRun.ok) check('protection note rendered', hasText(protectedRun.value, '按保护规则收缩'))

  const plainRun = tries('panel (unprotected)', () => renderPanel([
    openState, policy, null, false, { ...preview, protected: false }, 0, undefined, false,
  ]))
  if (plainRun.ok) check('no protection note otherwise', !hasText(plainRun.value, '按保护规则收缩'))
}

// 10) Preview block carries the seq range and the sampled excerpt.
{
  const run = tries('panel (preview text)', () => renderPanel([
    openState, policy, null, false, preview, 0, undefined, false,
  ]))
  if (run.ok) {
    check('preview range shown', hasText(run.value, 'seq 1–12'))
    check('preview excerpt shown', hasText(run.value, '最早的指令'))
  }
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
