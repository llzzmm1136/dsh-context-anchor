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
console.log('PASS one client module registers every entry and all components render without throwing')
