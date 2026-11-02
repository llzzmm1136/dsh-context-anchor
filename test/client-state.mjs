import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Real components, persistent hook slots, effect cleanups, fake time and deferred HTTP.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let active, spec, now = 0, nextTimer = 1
const timers = new Map(), requests = [], inputs = []
const timeout = (fn, ms, interval = false) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms, ms, interval }); return id }
const React = {
  Component: class { constructor(props) { this.props = props } },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) { const owner = active, i = owner.cursor++; if (!(i in owner.hooks)) owner.hooks[i] = typeof initial === 'function' ? initial() : initial; return [owner.hooks[i], value => { owner.hooks[i] = typeof value === 'function' ? value(owner.hooks[i]) : value; owner.dirty = true }] },
  useRef(initial) { const i = active.cursor++; return active.hooks[i] ??= { current: initial } },
  useEffect(fn, deps) { const owner = active, i = owner.cursor++; const prior = owner.effects[i]; if (!prior || deps.some((d, j) => !Object.is(d, prior.deps[j]))) owner.pending.push(() => { prior?.cleanup?.(); owner.effects[i] = { deps, cleanup: fn() } }) },
}
const sandbox = { console, React, Math, JSON, Promise, Date: class extends Date { static now() { return now } },
  setTimeout: (f, ms) => timeout(f, ms), clearTimeout: id => timers.delete(id), setInterval: (f, ms) => timeout(f, ms, true), clearInterval: id => timers.delete(id),
  fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ body: JSON.parse(options.body), resolve: data => resolve({ ok: true, json: async () => data }), reject })),
  document: { createElement(type) { const node = { click() {}, files: [] }; if (type === 'input') inputs.push(node); return node } },
  FileReader: class { readAsText(file) { this.result = file.text; this.onload() } },
  Blob: class {}, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
  window: { innerWidth: 1000, innerHeight: 800, __ModuleLoader__: { load: value => { spec = value } } },
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox)
const components = {}
spec.factory(() => React).apply({ slots: { inject(_slot, fn) { fn() }, register(def, component) { components[def.name] = component } }, effect() {}, logger: { warn() {} } })
function instance(component) { return { component, hooks: [], effects: [], pending: [], cursor: 0, dirty: true, props: {}, tree: null } }
const badge = instance(components['conversation.composer.dock'])
const Boundary = components['shell.overlay']
const panel = instance(new Boundary({}).render().type)
const instances = [badge, panel]
function render(item) { active = item; item.cursor = 0; item.pending = []; item.dirty = false; item.tree = item.component(item.props); active = null; for (const fn of item.pending) fn() }
function flush() { for (let i = 0; i < 30 && instances.some(x => x.dirty); i++) for (const item of instances) if (item.dirty) render(item) }
async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); flush() } }
async function tick(ms) { const end = now + ms; while (true) { const found = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!found) break; const [id,t] = found; now = t.at; if (t.interval) t.at += t.ms; else timers.delete(id); t.fn(); await settle() } now = end; await settle() }
function all(tree, predicate, result = []) { if (!tree || typeof tree !== 'object') return result; if (predicate(tree)) result.push(tree); for (const child of tree.children ?? []) if (Array.isArray(child)) child.forEach(x=>all(x,predicate,result)); else all(child,predicate,result); return result }
function text(tree) { if (tree == null || tree === false) return ''; if (Array.isArray(tree)) return tree.map(text).join(''); if (typeof tree !== 'object') return String(tree); return (tree.children ?? []).map(text).join('') }
function button(label) { const node = all(panel.tree, n => n.type === 'button' && text(n).includes(label))[0]; assert.ok(node, `button ${label}`); return node }
function range() { const n = all(panel.tree, n => n.type === 'input' && n.props.type === 'range')[0]; assert.ok(n, 'threshold slider'); return n }
const payload = (percent, count = 1) => ({ settings: { mode: 'custom', percent, autoRecall: true, protect: [] }, defaults: { mode: 'auto', percent: 80, autoRecall: true }, perSession: true, sessionCount: count, index: { docs: percent, terms: 1 }, compactions: { count: percent, lastSeq: percent } })
const cache = { events: 5, tokens: 100, chars: 400, at: 1, history: [{ tokens: 3000000 }, { tokens: 4000000 }] }
function session(id) { badge.props = { sessionId: id, useProjection: name => name === 'contextAnchorCache' ? cache : { projectedTokens: 10, contextWindow: 100 } }; badge.dirty = true; flush() }
function take(action, sid) { const i = requests.findIndex(r => r.body.action === action && (sid === undefined || r.body.session === sid)); assert.ok(i >= 0, `request ${action} ${sid}`); return requests.splice(i,1)[0] }
flush(); session('A')
all(badge.tree, n => n.type === 'button')[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500 }) } }); flush()
const oldRead = take('read', 'A')
session('B'); const newRead = take('read','B')
newRead.resolve(payload(60)); await settle(); assert.equal(range().props.value, 60)
oldRead.resolve(payload(30)); await settle(); assert.equal(range().props.value,60, 'late A cannot repaint B')
console.log('PASS session-keyed reads reject old session response')
range().props.onChange({ target: { value: '65' } }); flush(); await tick(100)
button('重置为全局').props.onClick(); await settle(); const reset = take('delete','B'); reset.resolve(payload(80)); await settle(); await tick(250)
assert.equal(requests.filter(r=>r.body.action==='save').length,0,'reset cancels debounce')
console.log('PASS reset cancels pending debounce')
range().props.onChange({ target: { value: '63' } }); flush(); await tick(220); const save = take('save','B')
button('重置为全局').props.onClick(); await settle(); assert.equal(requests.filter(r=>r.body.action==='delete').length,0,'reset waits behind in-flight save')
save.resolve(payload(63)); await settle(); const resetAfterSave = take('delete','B'); resetAfterSave.resolve(payload(80)); await settle(); assert.equal(range().props.value,80)
console.log('PASS writes serialize and old save cannot undo reset')
await tick(1500); const poll = take('read','B')
range().props.onChange({ target: { value: '72' } }); flush(); poll.resolve(payload(40)); await settle(); assert.equal(range().props.value,72,'poll does not overwrite edit')
await tick(220); take('save','B').resolve(payload(72)); await settle()
await tick(1500); const metrics = take('read','B'); const updated = payload(72); updated.compactions.count=99; metrics.resolve(updated); await settle(); assert.ok(text(panel.tree).includes('99 次'))
console.log('PASS polling refreshes metrics without clobbering edits')
button('清除所有会话策略').props.onClick(); flush(); await settle(); assert.equal(requests.filter(r=>r.body.action==='clear-sessions').length,0)
button('再次点击确认清除').props.onClick(); await settle(); take('clear-sessions','B').resolve(payload(80,0)); await settle()
console.log('PASS missing confirm requires explicit second click')
range().props.onChange({ target: { value: '74' } }); flush(); button('导入').props.onClick(); const input=inputs.at(-1); input.files=[{ text:'{"settings":{"mode":"auto"}}' }]; input.onchange(); await settle(); const imported = take('import','B'); imported.resolve({success:true}); await settle(); take('read','B').resolve(payload(70)); await settle(); await tick(220); assert.equal(requests.filter(r=>r.body.action==='save').length,0)
console.log('PASS import serialized and cancels pending save')
range().props.onChange({ target: { value: '75' } }); flush(); session('C'); await tick(220); assert.equal(requests.filter(r=>r.body.action==='save').length,0); take('read','C').resolve(payload(55)); await settle(); assert.equal(range().props.value,55)
console.log('PASS switching identity cancels pending old-session save')
range().props.onChange({ target: { value: '57' } }); flush(); await tick(220); take('save','C').reject(new Error('offline')); await settle(); assert.ok(text(panel.tree).includes('保存失败'))
await tick(1500); take('read','C').resolve(payload(55)); await settle(); assert.equal(range().props.value,57); assert.ok(text(panel.tree).includes('保存失败'), 'polling must not hide failed unsaved edit')
console.log('PASS failed save remains visible through successful metrics poll')
const chart = all(panel.tree, n => n.type === 'svg')[0]; const path = all(chart,n=>n.type==='path')[0].props.d
for (const pair of path.matchAll(/[ML] ([\d.-]+),([\d.-]+)/g)) { assert.ok(Number(pair[1])>=4 && Number(pair[1])<=236); assert.ok(Number(pair[2])>=4 && Number(pair[2])<=56) }
assert.ok(text(panel.tree).includes('本地缓存趋势（token）'))
console.log('PASS multimillion-token chart stays inside its token-scaled viewport')
for (const effect of badge.effects) effect?.cleanup?.(); flush(); assert.equal(panel.tree,null,'badge unmount closes panel')
console.log('PASS badge unmount closes panel')
console.log('CLIENT STATE CHECKS PASSED')
