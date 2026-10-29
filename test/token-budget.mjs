/**
 * Regression tests for the input-cost budget: what the anchor may cost per step
 * by default, that runtime checkpoints never enter the anchor or auto-recall,
 * and that context_expand's default output stays small enough to be a lookup
 * rather than a re-read of the archived log.
 *
 * These assert the defaults, so they run the plugin with no configuration.
 */

import { apply } from '../index.js'

class FakeSession {
  constructor() {
    this.events = []
    this.surface = { nodes: [] }
  }
  get seq() {
    return this.events.length
  }
  eventAt(seq) {
    return this.events[seq]
  }
  push(type, data) {
    this.events.push({ type, seq: this.events.length, time: Date.now(), data })
    return this
  }
}

const text = (value) => [{ type: 'text', text: value }]
const RUNTIME_SNAPSHOT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Current working directory: C:\\work.'

const session = new FakeSession()
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('把 zephyr-auth 的令牌过期时间改成 30 分钟。') })
session.push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: text('zephyr-auth 的过期时间在 src/auth/token.ts 里。') }, stream: [] })
session.push('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/auth/token.ts' }) })
session.push('tool/result', { turn: 1, step: 2, message: { role: 'tool', content: text('const TTL_MINUTES = 60') } })
// A compaction archived the first turns; the log still holds them.
session.push('compaction/end', { summary: 'earlier work', checkpoint: 3 })

// Runtime checkpoints arrive as ordinary user messages between turns.
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text(RUNTIME_SNAPSHOT) })

for (let index = 0; index < 40; index += 1) {
  session.push('assistant/message', { turn: 1, step: 3 + index, message: { role: 'assistant', content: text(`进度 ${index}：继续处理 zephyr-auth 的配置。`) }, stream: [] })
}
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('继续 zephyr-auth 的改动。') })

// Only the most recent nodes are still on the hot surface.
session.surface = { nodes: session.events.slice(-10).map((event) => event.seq) }

const contexts = new Map()
const tools = new Map()
const ctx = {
  logger: { info() {}, warn(message) { console.error('WARN', message) } },
  systemPrompt: {
    context(definition) {
      contexts.set(definition.name, definition)
      return () => contexts.delete(definition.name)
    },
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(factory) {
    return factory()
  },
  on() {
    return () => {}
  },
  inject() {},
}

apply(ctx)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

const anchor = [...contexts.values()][0]
const agent = { id: 'budget', session }
const anchorText = anchor.text({ agent })
console.log('\n--- anchor (defaults) ---\n' + anchorText + '\n--- end ---\n')

check('default anchor stays within 1000 characters', anchorText.length <= 1000, `length=${anchorText.length}`)
check('default anchor quotes the current instruction', anchorText.includes('zephyr-auth'), anchorText)
check('anchor no longer repeats session counters', !anchorText.includes('条用户消息'), anchorText)
check('runtime checkpoint stays out of the anchor', !anchorText.includes('This snapshot supersedes'), anchorText)
check('anchor still points at the recall tools', anchorText.includes('context_recall') && anchorText.includes('context_expand'), anchorText)

// Auto-recall runs here (one compaction, most of the log off surface).
check('auto-recall returns the archived match', anchorText.includes('#0') || anchorText.includes('#1'), anchorText)

const expand = tools.get('context_expand')
const unbudgeted = expand.execute({ from: 0, to: 200 }, { agent })
check('expand default budget is 4000 characters', unbudgeted.text.length < 4400, `length=${unbudgeted.text.length}`)

const explicit = expand.execute({ from: 0, to: 200, maxChars: 600 }, { agent })
check('an explicit maxChars still wins', explicit.text.length < 900, `length=${explicit.text.length}`)

console.log(failures === 0 ? '\nTOKEN BUDGET CHECKS PASSED' : `\n${failures} TOKEN BUDGET CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
