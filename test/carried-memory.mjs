/**
 * Cross-session memory: what survives when the conversation ends.
 *
 * A session's memory lived in a WeakMap and died with it, so every new
 * conversation started knowing nothing and the user had to restate the same
 * standing rules. Standing rules, settled decisions and durable facts are now
 * written to $DSH_HOME and seeded into the next session.
 *
 * What must NOT carry over is just as important: tasks, files and problems are
 * tied to work in flight, and dragging them into a fresh session is noise.
 * test/isolate.mjs points DSH_HOME at a temp directory, so this never touches
 * the real profile; a second process is spawned to prove the file is re-read
 * rather than merely kept in memory.
 */

import './isolate.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testHome } from './isolate.mjs'
import { apply } from '../index.js'

const text = (value) => [{ type: 'text', text: value }]

/** A session that exposes only what the plugin reads. */
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

/** Register the plugin and hand back its tools plus the anchor definition. */
function mount() {
  const contexts = new Map()
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt: { context: (definition) => { contexts.set(definition.name, definition); return () => {} } },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect: (factory) => factory(),
    on: () => () => {},
    inject() {},
  }
  apply(ctx)
  return { anchor: [...contexts.values()][0], tools }
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

const memoryFile = join(testHome, 'storages', 'context-anchor', 'memory.json')
check('the test home is isolated from the real profile',
  testHome.includes('dsh-context-anchor-test-'), testHome)

// --- Session 1: establishes a rule, a decision, a fact, and some work state.
const first = makeSession('session-one')
first.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('必须保持 UTF-8 编码，绝对不要用 GBK。') })
// A decision counts only when the human stated it. The assistant's own
// "结论是…" about its work must not become a rule for the next session.
first.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('决定：缓存改用 SQLite。') })
first.push('assistant/message', {
  turn: 1, step: 1,
  message: { role: 'assistant', content: text('结论是：我改用 SQLite 存缓存了，稍后再验证。') },
  stream: [],
})
first.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('这个项目用 Cordis 插件模型，宿主与客户端各一半。') })
// Work state that must not follow the user into a new conversation.
first.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('TODO: 待办事项是重写取数层，接下来做。') })
first.push('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/glasswing/load.ts' }) })
first.push('tool/call', { turn: 1, step: 3, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run build' }) })

const mounted = mount()
mounted.anchor.text({ agent: { session: first } })

check('the memory file was written', existsSync(memoryFile), memoryFile)
const raw = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')) : { byKind: {} }
check('standing rules reached the disk', (raw.byKind?.constraint ?? []).some((entry) => String(entry.text).includes('UTF-8')),
  JSON.stringify(raw.byKind?.constraint))
check('decisions reached the disk', (raw.byKind?.decision ?? []).some((entry) => String(entry.text).includes('SQLite')),
  JSON.stringify(raw.byKind?.decision))
check('facts reached the disk', (raw.byKind?.fact ?? []).some((entry) => String(entry.text).includes('Cordis')),
  JSON.stringify(raw.byKind?.fact))
check('work state is not persisted', raw.byKind?.task === undefined && raw.byKind?.file === undefined
  && raw.byKind?.command === undefined && raw.byKind?.problem === undefined, JSON.stringify(Object.keys(raw.byKind ?? {})))

// --- Session 2: a brand new conversation in the same process.
const second = makeSession('session-two')
second.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('开始新的工作。') })
const anchorTwo = mounted.anchor.text({ agent: { session: second } })
console.log('\n--- anchor of the second session ---\n' + anchorTwo + '\n--- end ---\n')
check('a new session inherits the standing rule', anchorTwo.includes('UTF-8'), anchorTwo)
check('a new session does not inherit the work state',
  !anchorTwo.includes('重写取数层') && !anchorTwo.includes('glasswing'), anchorTwo)

const inherited = mounted.tools.get('context_memory').execute({}, { agent: { session: second } })
check('context_memory sees the carried memories', inherited.text.includes('UTF-8'), inherited.text)

// --- Session 3, in a separate process: proves the file is re-read, not cached.
const child = spawnSync(process.execPath, [fileURLToPath(new URL('./carried-child.mjs', import.meta.url))], {
  env: { ...process.env, DSH_HOME: testHome },
  encoding: 'utf8',
})
check('a separate process reads the persisted memories', child.status === 0 && child.stdout.includes('CARRIED OK'),
  `${child.stdout ?? ''}${child.stderr ?? ''}`)

console.log(failures === 0 ? '\nCROSS-SESSION CHECKS PASSED' : `\n${failures} CROSS-SESSION CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
