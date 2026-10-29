/**
 * Decision supersession: a reversal retires what it reverses.
 *
 * Memory used to key on the whole sentence, so "改用 SQLite" and a later "回到
 * JSON，不用 SQLite 了" were two separate memories. Both were returned, and the
 * model had no way to tell which was current — the exact failure that makes a
 * memory store worse than reading the log.
 *
 * A decision is now keyed by its subject: content words, order-independent, with
 * framing verbs removed. A new decision on the same subject replaces the old one.
 * Decisions on *different* subjects must both survive — merging them would lose
 * a real conclusion.
 */

import './isolate.mjs'
import { apply } from '../index.js'

const text = (value) => [{ type: 'text', text: value }]

function makeSession(id) {
  const session = { id, events: [], surface: { nodes: [] } }
  Object.defineProperty(session, 'seq', { get() { return session.events.length } })
  session.eventAt = (index) => session.events[index]
  session.push = (type, data) => {
    session.events.push({ type, seq: session.events.length, time: 1_700_000_000_000 + session.events.length, data })
    return session
  }
  return session
}

function mount() {
  const tools = new Map()
  apply({
    logger: { info() {}, warn() {} },
    systemPrompt: { context: () => () => {} },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    effect: (factory) => factory(),
    on: () => () => {},
    inject() {},
  })
  return tools.get('context_memory')
}

const memory = mount()

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

// --- A reversal on the same subject replaces the earlier decision.
const reversed = makeSession('reverse')
reversed.push('user/message', {
  role: 'user', source: { kind: 'user' },
  content: text('结论是：缓存改用 SQLite 存储。'),
})
reversed.push('user/message', {
  role: 'user', source: { kind: 'user' },
  content: text('决定：缓存不用 SQLite 了，改回 JSON 文件。'),
})
const afterReverse = memory.execute({ kind: 'decision' }, { agent: { session: reversed } })
console.log('\n--- decisions after a reversal ---\n' + afterReverse.text + '\n--- end ---\n')
check('the reversal is recorded', afterReverse.text.includes('JSON'), afterReverse.text)
check('the reversed decision is retired', !afterReverse.text.includes('SQLite 存储'), afterReverse.text)
check('only one decision remains', afterReverse.counts.decision === 1, JSON.stringify(afterReverse.counts))

// --- Decisions on different subjects must both survive.
const distinct = makeSession('distinct')
distinct.push('user/message', {
  role: 'user', source: { kind: 'user' },
  content: text('结论是：缓存改用 SQLite 存储。'),
})
distinct.push('user/message', {
  role: 'user', source: { kind: 'user' },
  content: text('结论是：日志改用 JSONL 格式。'),
})
const both = memory.execute({ kind: 'decision' }, { agent: { session: distinct } })
console.log('\n--- decisions on different subjects ---\n' + both.text + '\n--- end ---\n')
check('an unrelated decision does not retire the first', both.text.includes('SQLite'), both.text)
check('both subjects are kept', both.counts.decision === 2, JSON.stringify(both.counts))

// --- A repeated decision is still deduplicated rather than stacked.
const repeated = makeSession('repeat')
for (let index = 0; index < 3; index += 1) {
  repeated.push('user/message', {
    role: 'user', source: { kind: 'user' },
    content: text('结论是：缓存改用 SQLite 存储。'),
  })
}
const once = memory.execute({ kind: 'decision' }, { agent: { session: repeated } })
check('the same decision repeated is stored once', once.counts.decision === 1, JSON.stringify(once.counts))

// --- Constraints are not subject-matched: two rules on one topic both apply.
const rules = makeSession('rules')
rules.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('日志必须用 UTF-8 编码。') })
rules.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('日志不要写成单行。') })
const kept = memory.execute({ kind: 'constraint' }, { agent: { session: rules } })
check('rules on one topic are both kept', kept.counts.constraint === 2, JSON.stringify(kept.counts))

console.log(failures === 0 ? '\nSUPERSESSION CHECKS PASSED' : `\n${failures} SUPERSESSION CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
