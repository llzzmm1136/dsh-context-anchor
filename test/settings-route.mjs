/**
 * Settings route: drives the real HTTP handler that the panel calls.
 *
 * The panel is the only consumer of this route, and a host-side throw here is
 * invisible to offline rendering probes — it returns 500 and the panel silently
 * falls back to "settings unavailable". This test calls the registered handler
 * directly, so a scope error (for example a `config` that is not in scope) fails
 * here instead of in the live UI.
 */

import { apply } from '../index.js'

class FakeSession {
  constructor(id) {
    this.id = id
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
const session = new FakeSession('session-a')
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('必须使用 UTF-8 编码，不要用 GBK。') })
session.push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: text('结论是：改用 SQLite。') }, stream: [] })
// Two successful compactions and one failed one: only the successes count.
session.push('compaction/end', { summary: 'first', checkpoint: 1 })
session.push('compaction/end', { error: 'backend unavailable' })
session.push('compaction/end', { summary: 'second', checkpoint: 2 })

/** One registered webServer route, so the handler can be invoked for real. */
let route = null
const tools = new Map()
const ctx = {
  logger: { info() {}, warn(message) { console.error('WARN', message) } },
  systemPrompt: { context: () => () => {} },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  effect(factory) { return factory() },
  on() { return () => {} },
  get(name) {
    if (name === 'agents') return { list: () => [{ ctx: { get: () => undefined }, session }] }
    return undefined
  },
  inject(names, callback) {
    if (!names.includes('webServer')) return
    const scope = Object.create(ctx)
    scope.webServer = {
      register(definition) {
        route = definition
        return () => { route = null }
      },
    }
    scope.connection = { requestRejection: () => undefined }
    callback(scope)
  },
}

apply(ctx, { maxAnchorChars: 1200 })

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

check('the settings route is registered', route !== null)

/** Minimal req/res pair: only what the handler touches. */
function call(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* iterator() {
      if (payload.length > 0) yield Buffer.from(payload, 'utf8')
    },
  }
  const captured = { status: 0, json: undefined }
  const res = {
    writeHead: (status) => { captured.status = status },
    end: (chunk) => {
      try {
        captured.json = JSON.parse(String(chunk))
      } catch {
        captured.json = String(chunk)
      }
    },
    setHeader: () => {},
    getHeader: () => undefined,
  }
  return route.handler(req, res).then(() => captured)
}

const read = await call('POST', '/api/dsh-context-anchor/settings', { action: 'read', session: 'session-a' })
check('read returns 200', read.status === 200, JSON.stringify(read))
check('read carries the policy', typeof read.json?.settings === 'object', JSON.stringify(read.json))
check('read carries the categorized memory counts', typeof read.json?.memory === 'object', JSON.stringify(read.json))
check('memory counted the constraint', read.json?.memory?.constraint === 1, JSON.stringify(read.json?.memory))
check('memory counted the decision', read.json?.memory?.decision === 1, JSON.stringify(read.json?.memory))
check('compaction count excludes the failed one', read.json?.compactions?.count === 2, JSON.stringify(read.json?.compactions))
check('compaction stats point at the latest success', read.json?.compactions?.lastSeq === 4, JSON.stringify(read.json?.compactions))

const getRead = await call('GET', '/api/dsh-context-anchor/settings?session=session-a')
check('GET read also returns 200', getRead.status === 200, JSON.stringify(getRead))

const saved = await call('POST', '/api/dsh-context-anchor/settings', {
  action: 'save', session: 'session-a', mode: 'custom', percent: 55, autoRecall: true, protect: [],
})
check('save returns 200', saved.status === 200, JSON.stringify(saved))
check('save echoes the saved percent', saved.json?.settings?.percent === 55, JSON.stringify(saved.json?.settings))

const reread = await call('POST', '/api/dsh-context-anchor/settings', { action: 'read', session: 'session-a' })
check('the saved override persists', reread.json?.settings?.percent === 55, JSON.stringify(reread.json?.settings))

const other = await call('POST', '/api/dsh-context-anchor/settings', { action: 'read', session: 'session-b' })
check('another session keeps the global default', other.json?.settings?.percent === 70, JSON.stringify(other.json?.settings))

const cleared = await call('POST', '/api/dsh-context-anchor/settings', { action: 'clear-sessions', session: 'session-a' })
check('clear-sessions returns 200', cleared.status === 200, JSON.stringify(cleared))
check('per-session overrides are gone', cleared.json?.sessionCount === 0, JSON.stringify(cleared.json))

const deleted = await call('POST', '/api/dsh-context-anchor/settings', { action: 'delete', session: 'session-a' })
check('delete without an override is not an error', deleted.status === 200, JSON.stringify(deleted))

const exported = await call('POST', '/api/dsh-context-anchor/settings', { action: 'export' })
check('export returns both layers', typeof exported.json?.settings === 'object' && typeof exported.json?.sessions === 'object', JSON.stringify(exported.json))

const bad = await call('POST', '/api/dsh-context-anchor/settings', { action: 'nope' })
check('an unknown action still answers', bad.status === 200, JSON.stringify(bad))

console.log(failures === 0 ? '\nSETTINGS ROUTE CHECKS PASSED' : `\n${failures} SETTINGS ROUTE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
