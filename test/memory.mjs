/**
 * Categorized memory: the log is classified once as it arrives and read back on
 * demand through context_memory. These tests exercise the classifier on text
 * that is unambiguous in each category, and assert the failure modes that would
 * make the feature harmful: wrong category, duplicated memory, resume drift.
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
    this.events.push({ type, seq: this.events.length, time: 1700000000000 + this.events.length, data })
    return this
  }
}

const text = (value) => [{ type: 'text', text: value }]
const user = (value) => ({ role: 'user', source: { kind: 'user' }, content: text(value) })
const assistant = (value) => ({ turn: 1, step: 1, message: { role: 'assistant', content: text(value) }, stream: [] })

const session = new FakeSession()
// decision
session.push('assistant/message', assistant('结论是：改用 SQLite 存本地索引，不再用 JSON 文件。'))
// constraint — a hard rule the user stated
session.push('user/message', user('记住：所有日志必须是 UTF-8，不要用 GBK。'))
// problem
session.push('user/message', user('运行 npm test 报错：TypeError: window.addEventListener is not a function'))
// task
session.push('assistant/message', assistant('TODO: 还需要给面板补一个滚动条，接下来做导出。'))
// file
session.push('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/auth/token.ts' }) })
// command
session.push('tool/call', { turn: 1, step: 3, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test -- --reporter=dot' }) })
// fact — an assistant summary with no rule hit
session.push('assistant/message', assistant('项目使用 Cordis 插件模型，宿主与客户端各一半。'))
// duplicate constraint — same sentence again, must not be stored twice
session.push('user/message', user('记住：所有日志必须是 UTF-8，不要用 GBK。'))

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

const exec = { agent: { id: 'memory', session } }
const memory = tools.get('context_memory')
check('context_memory is registered', memory !== undefined)

const all = memory.execute({}, exec)
console.log('\n--- all memories ---\n' + all.text + '\n--- end ---\n')

check('decision captured', all.text.includes('改用 SQLite'), all.text)
check('constraint captured', all.text.includes('UTF-8'), all.text)
check('problem captured', all.text.includes('addEventListener'), all.text)
check('task captured', all.text.includes('滚动条'), all.text)
check('file captured', all.text.includes('token.ts'), all.text)
check('command captured', all.text.includes('npm test'), all.text)
check('fact captured', all.text.includes('Cordis'), all.text)

check('counts cover every category', Object.keys(all.counts).length === 7, JSON.stringify(all.counts))
check('the repeated constraint is stored once', all.counts.constraint === 1, JSON.stringify(all.counts))

const decisions = memory.execute({ kind: 'decision' }, exec)
check('kind narrows to one category', decisions.counts !== undefined
  && decisions.text.includes('改用 SQLite')
  && !decisions.text.includes('UTF-8'), decisions.text)

const filtered = memory.execute({ query: 'addEventListener' }, exec)
check('query filters by term', filtered.total >= 1 && filtered.text.includes('addEventListener'), filtered.text)
check('an unfindable query returns nothing', memory.execute({ query: 'zzz-nothing-here' }, exec).total === 0)

const limited = memory.execute({ kind: 'fact', limit: 1 }, exec)
check('limit bounds the output', limited.text.split('\n').length <= 8, limited.text)

// Resume: a fresh store folded over the same log must classify identically.
const replay = new FakeSession()
for (const event of session.events) replay.events.push({ ...event })
const replayExec = { agent: { id: 'replay', session: replay } }
const replayed = memory.execute({}, replayExec)
check('classification is reproducible after resume', replayed.total === all.total, `${replayed.total} vs ${all.total}`)

// An assistant turn with no rule hit is a fact, but a tool result never is.
const quiet = new FakeSession()
quiet.push('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: text('const x = 1') } })
const quietOut = memory.execute({}, { agent: { id: 'quiet', session: quiet } })
check('a bare tool result is not remembered', quietOut.total === 0, quietOut.text)

console.log(failures === 0 ? '\nMEMORY CHECKS PASSED' : `\n${failures} MEMORY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
