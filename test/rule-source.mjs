// Regression tests for three ways a sentence that is not a requirement was
// filed as a standing rule and pinned to every step as 不可违反.
import './isolate.mjs'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label, ok, detail) {
  if (ok) { console.log(`PASS ${label}`); return }
  failures += 1
  console.log(`FAIL ${label}`)
  if (detail !== undefined) console.log(`  ${String(detail).split('\n').join('\n  ')}`)
}

const { apply } = await import('../index.js')
const { testHome } = await import('./isolate.mjs')

const text = (value) => [{ type: 'text', text: value }]

// Each case below is a separate session, and the plugin deliberately carries
// constraints and decisions from earlier sessions into new ones. Left alone,
// case 1's rule would be pinned while case 3 asserted "no rule was pinned" —
// the cases would pass or fail depending on their order. A case therefore
// starts with no carried memory. The carry behaviour itself is covered by
// carried-memory.mjs and asserted once at the end of this file.
const MEMORY_FILE = join(testHome, 'storages', 'context-anchor', 'memory.json')
const clearCarried = () => rmSync(MEMORY_FILE, { force: true })

function makeSession(id) {
  const events = []
  const session = {
    id,
    events,
    surface: { nodes: [] },
    eventAt: (index) => events[index],
    push(type, data) { events.push({ type, seq: events.length, time: 1, data }) },
  }
  Object.defineProperty(session, 'seq', { get: () => events.length })
  return session
}

const contexts = new Map()
apply({
  logger: { info() {}, warn() {}, error() {} },
  systemPrompt: { context: (definition) => { contexts.set(definition.name, definition); return () => {} } },
  tools: { register: () => () => {} },
  effect: (run) => run(),
  on: () => () => {},
  inject() {},
})

const anchorDef = [...contexts.values()][0]
const anchorOf = (session) => anchorDef.text({ agent: { session } })

/**
 * The pinned 已定 line, or ''. Assertions are made against this line rather than
 * the whole anchor: carried memory lives in a module-level cache that deleting
 * the file does not reset, so a rule from an earlier case can legitimately still
 * be pinned. Checking what this case's own text contributes keeps the assertions
 * independent of case order.
 */
const pinnedOf = (anchor) => /已定[^\n]*/.exec(anchor)?.[0] ?? ''

/** One user message in a session whose whole log is on the surface. */
function oneMessage(id, message) {
  const session = makeSession(id)
  session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text(message) })
  session.surface = { nodes: session.events.map((event) => event.seq) }
  return anchorOf(session)
}

// 1) A single character inside an ordinary word is not a rule keyword.
// "别" matched 发给别人 ("someone else") and produced a constraint.
{
  const anchor = oneMessage('single-char', '界面是记忆插件的一个部分，我现在需要发给别人这个插件，希望他安装后一样有记忆和界面')
  check('发给别人 is not read as a prohibition', !pinnedOf(anchor).includes('发给别人'), pinnedOf(anchor))
}

// 2) A question is a request for instructions, not a standing obligation.
{
  const anchor = oneMessage('question', '这个插件要发给别人安装，我要怎么做')
  check('a question is not pinned as a rule', !pinnedOf(anchor).includes('我要怎么做'), pinnedOf(anchor))
}

// ...but a real rule phrased with a question tail still counts.
{
  const anchor = oneMessage('rule-with-tail', '必须保持 UTF-8 编码，对吗？')
  check('a strong obligation survives a question tail', pinnedOf(anchor).includes('UTF-8'), pinnedOf(anchor))
}

// 3) Harness-injected notices carry the user role but not the user's intent.
{
  const anchor = oneMessage('injected', 'background job pwsh-abc123 finished: the command must not be retried')
  check('a background job notice never becomes a rule', !pinnedOf(anchor).includes('pwsh-abc123'), pinnedOf(anchor))
  check('a background job notice stays out of the live thread', !anchor.includes('pwsh-abc123'), anchor)
}

// The runtime checkpoint keeps its earlier protection.
{
  const anchor = oneMessage('runtime-context', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: C:\\x')
  check('the runtime checkpoint stays out of the anchor', !anchor.includes('Current working directory'), anchor)
}

// Carry is real: a rule the user stated in one session is pinned in the next.
// Asserted here so the clearCarried() above cannot hide a broken carry.
{
  const first = makeSession('carry-one')
  first.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('必须保持 UTF-8 编码，不要用 GBK。') })
  first.surface = { nodes: first.events.map((event) => event.seq) }
  anchorOf(first)

  const second = makeSession('carry-two')
  second.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('继续') })
  second.surface = { nodes: second.events.map((event) => event.seq) }
  const anchor = anchorOf(second)
  check('a user rule carries into the next session', anchor.includes('UTF-8'), anchor)
}
clearCarried()

console.log(failures === 0 ? '\nRULE SOURCE CHECKS PASSED' : `\n${failures} RULE SOURCE CHECK(S) FAILED`)
if (failures > 0) process.exitCode = 1
