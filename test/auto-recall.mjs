/**
 * Auto-recall under vague instructions.
 *
 * Almost every human follow-up is "继续", "ok", "都要" — words that name no
 * topic. The recall query used to be the latest instruction alone, so those
 * turns produced no query terms and `recallArchived` returned early: auto-recall
 * silently did nothing for exactly the turns the user types most. The only way
 * to get history back was to ask for it by hand, which made the feature look
 * inert.
 *
 * The query is now the standing task: the recent instructions still shown in the
 * anchor, joined. These tests pin that down, plus the budget guard that a
 * recalled excerpt must not repeat a line the anchor already prints.
 */

import './isolate.mjs'
import { apply } from '../index.js'

const text = (value) => [{ type: 'text', text: value }]

function makeSession(id) {
  const session = { id, events: [], surface: { nodes: [] } }
  Object.defineProperty(session, 'seq', { get() { return session.events.length } })
  session.eventAt = (index) => session.events[index]
  session.push = (type, data) => {
    session.events.push({ type, seq: session.events.length, time: 1_000_000 + session.events.length, data })
    return session
  }
  return session
}

const contexts = new Map()
apply({
  logger: { info() {}, warn() {} },
  systemPrompt: { context: (definition) => { contexts.set(definition.name, definition); return () => {} } },
  tools: { register: () => () => {} },
  effect: (factory) => factory(),
  on: () => () => {},
  inject() {},
})
const anchorDef = [...contexts.values()][0]

/** The block header, kept in one place so wording changes touch one line. */
const RECALL_HEADER = '相关旧记录'

/** A long session whose early decisions have fallen off the surface. */
function build(id, finalInstruction) {
  const session = makeSession(id)
  session.push('user/message', {
    role: 'user', source: { kind: 'user' },
    content: text('约束：glasswing 的取数层必须保持 backpressure 保护，不要移除。'),
  })
  session.push('assistant/message', {
    turn: 1, step: 0,
    message: { role: 'assistant', content: text('决定：glasswing 取数层用 p-limit 控制并发，保留 backpressure。') },
    stream: [],
  })
  for (let index = 1; index < 90; index += 1) {
    session.push('assistant/message', {
      turn: 1, step: index,
      message: { role: 'assistant', content: text(`进度 ${index}：处理别的事情。`) },
      stream: [],
    })
  }
  session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text(finalInstruction) })
  // Only the last few events are still on the surface; the rest is archived.
  session.surface = { nodes: session.events.slice(-5).map((event) => event.seq) }
  return session
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

const anchorOf = (instruction, id) => anchorDef.text({ agent: { session: build(id, instruction) } })

// The regression: a bare continuation must still reach archived history.
for (const vague of ['继续', 'ok', '继续 glasswing']) {
  const anchor = anchorOf(vague, `vague-${vague}`)
  check(`auto-recall fires on ${JSON.stringify(vague)}`, anchor.includes(RECALL_HEADER), anchor)
}

// A concrete instruction keeps working.
const concrete = anchorOf('把 glasswing 取数层的并发改成 8，并处理 backpressure', 'concrete')
check('auto-recall fires on a concrete instruction', concrete.includes(RECALL_HEADER), concrete)

// The block must ask to be used, not merely report that something was found.
// "可能相关" plus "详情按 seq 回读" reads as optional, and a model under no
// obligation skips it — which is the whole complaint this change answers.
check('the recall header asks to be acted on', /以此为准/.test(concrete), concrete.split('\n').find((l) => l.includes('旧记录')))
check('the recall header is not hedged as merely possible',
  !/可能相关/.test(concrete), concrete.split('\n').find((l) => l.includes('旧记录')))

// The footer must name a concrete moment to use the tools; "需要原话时" is not
// something a model can notice it has reached.
check('the footer names when to search',
  concrete.includes('不确定早前怎么定的'), concrete.split('\n').at(-1))

// The recalled excerpt must add information, not repeat the live instruction.
const vague = anchorOf('继续 glasswing 取数层', 'dedupe')
const seqs = [...vague.matchAll(/- \[#(\d+)\]/g)].map((match) => match[1])
const duplicates = seqs.filter((seq, index) => seqs.indexOf(seq) !== index)
check('a recalled excerpt never repeats a line already shown', duplicates.length === 0,
  `seqs=${seqs.join(',')}\n${vague}`)

console.log(failures === 0 ? '\nAUTO-RECALL CHECKS PASSED' : `\n${failures} AUTO-RECALL CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
