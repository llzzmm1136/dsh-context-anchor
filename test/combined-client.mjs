import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Render every registered Client entry with stub hooks: a component that
// references an out-of-scope helper only fails at render time, and that failure
// takes the whole page down (DSH then offers to disable third-party plugins).
let definition
const entries = []
let hooks = []
let cursor = 0
const React = {
  Component: class {},
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], (value) => { hooks[i] = value }] },
  useRef(initial) { const i = cursor++; return (hooks[i] ??= { current: initial }) },
  useEffect(fn) { fn() },
}
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: (d) => { assert.equal(definition, undefined); definition = d } }, fetch: async () => ({ ok: false }), localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 },
  console, React, fetch: async () => ({ ok: false, json: async () => ({}) }), setInterval: () => 1, clearInterval() {},
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
  URL: { createObjectURL: () => '', revokeObjectURL() {} },
})
definition.factory((name) => { assert.equal(name, 'react'); return React })
  .apply({ effect: (fn) => fn(), slots: { inject: (_, fn) => fn(), register: (options, component) => entries.push({ options, component }) } })

// The loader gives a plugin ONE injection channel per slot: a second inject
// into the same slot is dropped. Mirror that here so a regression that splits
// one slot across two injects fails instead of silently losing entries.
const injected = []
const perSlot = []
definition.factory((name) => { assert.equal(name, 'react'); return React })
  .apply({ slots: {
    inject: (slot, fn) => { if (injected.includes(slot)) return; injected.push(slot); fn() },
    register: (options, component) => perSlot.push({ options, component }),
  } })
for (const id of ['balance', 'balance-panel', 'turn-cost', 'context-anchor-cache', 'context-anchor-panel']) {
  assert.equal(perSlot.filter((entry) => entry.options.id === id).length, 1, `${id} survives one-inject-per-slot`)
}
assert.equal(injected.filter((slot) => slot === 'shell.overlay').length, 1, 'shell.overlay injected once')

// A dynamic Client context without `effect`/`get` must still activate: throwing
// here is exactly what DSH reports as "entry did not activate" and blocks boot.
const bare = []
definition.factory((name) => { assert.equal(name, 'react'); return React })
  .apply({ slots: { inject: (_, fn) => fn(), register: (options, component) => bare.push({ options, component }) } })
assert.deepEqual(bare.map((entry) => entry.options.id).sort(), entries.map((entry) => entry.options.id).sort())

for (const id of ['balance', 'balance-panel', 'turn-cost', 'context-anchor-cache', 'context-anchor-panel']) {
  assert.equal(entries.filter((entry) => entry.options.id === id).length, 1, id)
}
assert.equal(definition.id, '@local/dsh-context-anchor')
assert.ok(!source.includes("require('react-dom')"))
assert.ok(source.includes('24 小时合计'))

const props = {
  useProjection: () => ({ closed: [{ turn: 1, tokens: 250000 }], tokens: 1, turn: 1 }),
  turn: 1, seq: 3,
}
for (const entry of entries) {
  if (typeof entry.component !== 'function' || entry.component.prototype?.render) continue
  cursor = 0
  hooks = []
  assert.doesNotThrow(() => entry.component(props), `${entry.options.id} renders without throwing`)
}
const action = entries.find(entry => entry.options.id === 'turn-cost')
assert.equal(action.options.name, 'conversation.chat.assistant-actions')
assert.ok(!entries.some(entry => entry.options.name === 'conversation.chat.turnTail'))
const snapshot = { nodes: new Map([
  ['one', { kind: 'turn-tail', data: { turn: 1, closing: { finalNode: { messageId: 'first' } }, tokenUsage: { totalTokens: 100 } } }],
  ['two', { kind: 'turn-tail', data: { turn: 2, closing: { finalNode: { messageId: 'second' } }, tokenUsage: { totalTokens: 200 } } }],
]) }
cursor = 0; hooks = []
const button = action.component({ messageId: 'first', useChat: selector => selector(snapshot) })
assert.equal(button.type, 'button')
assert.equal(button.props['aria-haspopup'], 'dialog')
button.props.onClick()
cursor = 0; hooks = []
const details = entries.find(entry => entry.options.id === 'turn-cost-panel').component()
assert.ok(JSON.stringify(details).includes('100 tokens'), 'clicked historical turn keeps its own usage')
assert.ok(!JSON.stringify(details).includes('200 tokens'), 'latest turn is not substituted')
cursor = 0; hooks = []
assert.equal(action.component({ messageId: 'missing', useChat: selector => selector(snapshot) }), null)
console.log('PASS compact same-row cost action opens matching turn details; all entries render without throwing')
