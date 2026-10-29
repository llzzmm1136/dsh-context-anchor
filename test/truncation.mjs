/**
 * Budget pressure: which sections survive when the anchor does not fit.
 *
 * The anchor used to be truncated by cutting its own tail — which is exactly
 * where auto-recall landed. So the one block that took a full ranking pass to
 * produce was the first thing thrown away, while a task counter that any tool
 * call can recover stayed. Sections now carry a priority and the cheapest,
 * most replaceable block goes first.
 *
 * maxAnchorChars is clamped to [400, 20000] by normalizeConfig, so the pressure
 * cases here use 400 — the tightest budget the plugin can actually be given.
 */

import { apply } from '../index.js'

const text = (value) => [{ type: 'text', text: value }]

/**
 * A session with every section present: a standing rule, a decision, a touched
 * file, a task list, and archived history that auto-recall can rank.
 */
function buildSession() {
  const session = {
    events: [],
    surface: { nodes: [] },
    eventAt(index) {
      return this.events[index]
    },
  }
  Object.defineProperty(session, 'seq', { get() { return session.events.length } })
  const push = (type, data) => {
    session.events.push({ type, seq: session.events.length, time: 1_700_000_000_000 + session.events.length, data })
  }

  push('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: text('必须保持 UTF-8 编码；重构 glasswing 的取数层，别动 zephyr-auth 令牌。'),
  })
  push('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', content: text('结论是：glasswing 取数层改用 stream 拼接。') },
    stream: [],
  })
  push('tool/call', {
    turn: 1, step: 2, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/glasswing/load.ts' }),
  })
  push('tool/result', {
    turn: 1, step: 2, message: { role: 'tool', content: text('export const load = () => 1') },
  })
  push('todo/write', {
    todos: [
      { content: '重写 glasswing 取数层', status: 'in_progress' },
      { content: '补充回归测试', status: 'pending' },
      { content: '更新 README', status: 'completed' },
    ],
  })
  // Compaction archived the opening turns; the log still holds them, which is
  // what makes auto-recall both necessary and possible.
  push('compaction/end', { summary: 'earlier glasswing work', checkpoint: 3 })
  for (let index = 0; index < 40; index += 1) {
    push('assistant/message', {
      turn: 1, step: 3 + index,
      message: { role: 'assistant', content: text(`进度 ${index}：继续处理 glasswing 的配置。`) },
      stream: [],
    })
  }
  push('user/message', { role: 'user', source: { kind: 'user' }, content: text('继续 glasswing 取数层。') })
  // Only the tail is still on the hot surface.
  session.surface = { nodes: session.events.slice(-10).map((event) => event.seq) }
  return session
}

/** Render one anchor at a given character budget. */
function anchorAt(maxAnchorChars) {
  const contexts = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt: { context: (definition) => { contexts.set(definition.name, definition); return () => {} } },
    tools: { register: () => () => {} },
    effect: (factory) => factory(),
    on: () => () => {},
    inject() {},
  }
  apply(ctx, { maxAnchorChars })
  return [...contexts.values()][0].text({ agent: { id: 'pressure', session: buildSession() } })
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

const roomy = anchorAt(20000)
console.log('\n--- anchor with room to spare ---\n' + roomy + '\n--- end ---\n')
check('every section is present when there is room',
  roomy.includes('任务列表') && roomy.includes('涉及文件') && roomy.includes('可能相关的旧记录'), roomy)
check('the standing rule is carried', roomy.includes('已定：'), roomy)
check('a roomy anchor stays well under the cap', roomy.length <= 20000, `length=${roomy.length}`)
const roomyLength = roomy.length

// The tightest budget the configuration allows. Something has to go.
const tight = anchorAt(400)
console.log('\n--- anchor at the 400-character floor ---\n' + tight + '\n--- end ---\n')
check('the tight anchor respects its budget', tight.length <= 400, `length=${tight.length}`)
check('the tight anchor is actually shorter', tight.length < roomyLength,
  `tight=${tight.length} roomy=${roomyLength}`)
check('the current instruction survives', tight.includes('glasswing'), tight)
check('the standing rule survives', tight.includes('已定：'), tight)
check('the footer map back to the log survives', tight.includes('context_recall'), tight)

// This is the regression the change exists for: the recalled block used to be
// cut first because it sat at the tail. It must outlive the cheap sections.
check('recalled history outlives the file/step lines',
  tight.includes('可能相关的旧记录') && !tight.includes('上一步'), tight)

console.log(failures === 0 ? '\nTRUNCATION CHECKS PASSED' : `\n${failures} TRUNCATION CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
