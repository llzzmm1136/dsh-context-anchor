/**
 * Second process for test/carried-memory.mjs.
 *
 * Run with the same DSH_HOME as the parent. It must see memories written by a
 * different process — proving they are read back from disk rather than merely
 * surviving in the parent's module state.
 */

const text = (value) => [{ type: 'text', text: value }]

const { apply } = await import('../index.js')

const session = { id: 'child-session', events: [], surface: { nodes: [] } }
Object.defineProperty(session, 'seq', { get() { return session.events.length } })
session.eventAt = (index) => session.events[index]
session.push = (type, data) => {
  session.events.push({ type, seq: session.events.length, time: 1_700_000_000_000, data })
}
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('开始新的工作。') })

const contexts = new Map()
const tools = new Map()
apply({
  logger: { info() {}, warn() {} },
  systemPrompt: { context: (definition) => { contexts.set(definition.name, definition); return () => {} } },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  effect: (factory) => factory(),
  on: () => () => {},
  inject() {},
})

const anchor = [...contexts.values()][0].text({ agent: { session } })
const memory = tools.get('context_memory').execute({}, { agent: { session } })

if (anchor.includes('UTF-8') && memory.text.includes('UTF-8')) {
  console.log('CARRIED OK')
  process.exit(0)
}
console.error('anchor/memory did not carry the rule')
console.error(anchor)
console.error(memory.text)
process.exit(1)
