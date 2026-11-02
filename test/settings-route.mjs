/**
 * Settings route: drives the real HTTP handler that the panel calls.
 *
 * The panel is the only consumer of this route, and a host-side throw here is
 * invisible to offline rendering probes — it returns 500 and the panel silently
 * falls back to "settings unavailable". This test calls the registered handler
 * directly, so a scope error (for example a `config` that is not in scope) fails
 * here instead of in the live UI.
 */

import './isolate.mjs'
import { apply } from '../index.js'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { testHome } from './isolate.mjs'

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
// Stated by the user: only user-stated decisions are filed, so the assistant
// cannot inflate these counts with commentary about its own work.
session.push('user/message', { role: 'user', source: { kind: 'user' }, content: text('结论是：改用 SQLite。') })
// Two successful compactions and one failed one: only the successes count.
session.push('compaction/end', { summary: 'first', checkpoint: 1 })
session.push('compaction/end', { error: 'backend unavailable' })
session.push('compaction/end', { summary: 'second', checkpoint: 2 })

/** One registered webServer route, so the handler can be invoked for real. */
let route = null
let rejection
let preStep
let compactCalls = 0
const selectedScope = { get(name) {
  if (name === 'compaction') return { compactRegion() { compactCalls += 1; throw new Error('test must not compact') } }
  if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 600 }) }
  return undefined
} }
session.requestContext = () => ({ contextWindow: 1000 })
for (let i = 0; i < 16; i += 1) session.push(i % 4 === 0 ? 'user/message' : 'assistant/message', { role: 'user', source: { kind: 'user' }, content: text(`scope sample ${i}`) })
session.surface.nodes = session.events.map((event) => event.seq)
const tools = new Map()
const ctx = {
  logger: { info() {}, warn(message) { console.error('WARN', message) } },
  systemPrompt: { context: () => () => {} },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  effect(factory) { return factory() },
  on(name, callback) { if (name === 'agent/pre-step') preStep = callback; return () => {} },
  get(name) {
    if (name === 'agents') return { list: () => [{ ctx: selectedScope, session }, { ctx: { get: () => undefined }, session: new FakeSession('no-service') }] }
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
    scope.connection = { requestRejection: () => rejection }
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
check('an unknown action is rejected', bad.status === 400, JSON.stringify(bad))
check('runtime metadata comes from loaded Host code', read.json?.runtime?.hostVersion === '1.15.0' && typeof read.json?.runtime?.strategyVersion === 'string')
check('protection scope is explicit', read.json?.protection?.scope === 'custom-only' && read.json?.protection?.strict === true)
check('preview uses selected agent meter', read.json?.preview?.percent === 60, JSON.stringify(read.json?.preview))
const unavailable = await call('POST', '/api/dsh-context-anchor/settings', { action: 'read', session: 'no-service' })
check('other agents cannot grant selected session capability', unavailable.json?.compaction === false)
for (const code of [401, 403]) {
  rejection = code
  check(`authorization ${code} remains enforced`, (await call('POST', '/api/dsh-context-anchor/settings', { action: 'save', percent: 33 })).status === code)
}
rejection = undefined
const unicodePolicies = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`会话${i}`, { mode: 'custom', percent: 50, autoRecall: true, protect: Array.from({ length: 8 }, (_, j) => `${j}${'保护文字'.repeat(15)}`) }]))
const unicodeImport = { action: 'import', data: { settings: { percent: 60 }, sessions: unicodePolicies } }
check('Unicode fixture exceeds old 8KB limit', Buffer.byteLength(JSON.stringify(unicodeImport), 'utf8') > 8192)
check('bounded Unicode import succeeds', (await call('POST', '/api/dsh-context-anchor/settings', unicodeImport)).status === 200)
check('array import is rejected', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'import', data: [] })).status === 400)
await call('POST', '/api/dsh-context-anchor/settings', { action: 'unknown' })
check('unknown action preserves configured global policy', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'read' })).json?.settings?.percent === 60)
const unicodeExport = await call('POST', '/api/dsh-context-anchor/settings', { action: 'export' })
check('exported Unicode settings can be imported', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'import', data: unicodeExport.json })).status === 200)
check('oversized UTF-8 request returns 413', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'import', data: { padding: '字'.repeat(24000) } })).status === 413)
const settingsPath = join(testHome, 'storages', 'context-anchor', 'settings.json')
const beforeDisk = readFileSync(settingsPath, 'utf8')
const beforeExport = (await call('POST', '/api/dsh-context-anchor/settings', { action: 'export' })).json
const blocker = `${settingsPath}.tmp`
mkdirSync(blocker)
for (const body of [
  { action: 'save', mode: 'custom', percent: 35 },
  { action: 'save', session: '会话0', percent: 35 },
  { action: 'delete', session: '会话0' },
  { action: 'clear-sessions' },
  { action: 'import', data: { settings: { percent: 35 }, sessions: {} } },
]) {
  const failed = await call('POST', '/api/dsh-context-anchor/settings', body)
  check(`failed ${body.action} reports failure`, failed.status === 500)
  check(`failed ${body.action} leaves effective settings unchanged`, JSON.stringify((await call('POST', '/api/dsh-context-anchor/settings', { action: 'export' })).json) === JSON.stringify(beforeExport))
  check(`failed ${body.action} leaves disk unchanged`, readFileSync(settingsPath, 'utf8') === beforeDisk)
}
rmSync(blocker, { recursive: true })
check('writes recover after transient failure', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'save', percent: 65 })).status === 200)
check('malformed session policy import rejected', (await call('POST', '/api/dsh-context-anchor/settings', { action: 'import', data: { sessions: { bad: [] } } })).status === 400)
await call('POST', '/api/dsh-context-anchor/settings', { action: 'save', session: 'session-a', mode: 'custom', percent: 30, protect: ['必须使用 UTF-8'] })
let nextCalls = 0
await preStep({ agent: { session, ctx: selectedScope } }, () => { nextCalls += 1 })
check('strict protection prevents service call in actual pre-step path', compactCalls === 0 && nextCalls === 1)

console.log(failures === 0 ? '\nSETTINGS ROUTE CHECKS PASSED' : `\n${failures} SETTINGS ROUTE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
