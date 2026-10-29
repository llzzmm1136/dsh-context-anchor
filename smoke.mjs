/**
 * Offline smoke test for @local/dsh-context-anchor.
 *
 * Runs the plugin's pure logic against a fake Session and a fake Cordis context,
 * so the anchor text and both recall tools are exercised without a live Host.
 * Usage: node smoke.mjs
 */

import './test/isolate.mjs'
import { apply } from './index.js'

/** Minimal Session stand-in exposing only what the plugin reads. */
class FakeSession {
  constructor() {
    this.events = []
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

const session = new FakeSession()
session
  .push('turn/start', { turn: 1 })
  .push('user/message', { role: 'user', source: { kind: 'user' }, content: text('请把温度监控页面做成深色主题，并加上历史曲线。') })
  .push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/Temperature.tsx' }) })
  .push('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: text('export function Temperature() { /* chart */ }') } })
  .push('todo/write', { todos: [
    { content: '深色主题', status: 'completed' },
    { content: '历史曲线', status: 'in_progress' },
  ] })
  .push('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: text('已确认主题方案，接下来接入历史曲线数据源。') }, stream: [] })
  .push('user/message', { role: 'user', source: { kind: 'time-context' }, content: text('Time sampled: 2026-01-01T00:00:00+08:00') })
  .push('turn/end', { turn: 1, reason: { kind: 'completed' } })

const tools = new Map()
const contexts = new Map()
const projections = new Map()
const disposers = []

const sessionProjections = {
  register(definition) {
    projections.set(definition.key, definition)
    return () => projections.delete(definition.key)
  },
}

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
    const dispose = factory()
    disposers.push(dispose)
    return dispose
  },
  on(_name, _listener) {
    return () => {}
  },
  inject(names, callback) {
    if (!names.includes('sessionProjections')) return
    const child = Object.create(ctx)
    child.sessionProjections = sessionProjections
    callback(child)
  },
}

apply(ctx, { recentUserMessages: 3, recentFiles: 5, maxAnchorChars: 1400 })

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n  ${detail}`}`)
  }
}

// 1. Anchor registration and rendering
check('registers one anchor context', contexts.size === 1)
const anchor = [...contexts.values()][0]
const agent = { id: 's1', session }
const anchorText = anchor.text({ agent })
console.log('\n--- anchor ---\n' + anchorText + '\n--- end ---\n')

check('anchor quotes the human instruction', anchorText.includes('温度监控页面'))
check('anchor omits injected time-context notice', !anchorText.includes('Time sampled'))
check('anchor reports the in-progress todo', anchorText.includes('历史曲线'))
check('anchor lists the touched file', anchorText.includes('src/Temperature.tsx'))
check('anchor names the recall tools', anchorText.includes('context_recall') && anchorText.includes('context_expand'))
check('anchor respects maxAnchorChars', anchorText.length <= 1400, `length=${anchorText.length}`)
check('anchor is empty without a session', anchor.text({}) === '')

// 2. Tools
check('registers both recall tools', tools.has('context_recall') && tools.has('context_expand'))

const exec = { agent }
const recall = tools.get('context_recall')
const found = recall.execute({ query: 'chart' }, exec)
check('recall finds text inside a tool result', found.total === 1 && found.text.includes('chart'), found.text)
const missed = recall.execute({ query: 'nonexistent-needle' }, exec)
check('recall reports a clean miss', missed.total === 0 && missed.text.includes('没有找到'))
const regexHit = recall.execute({ query: 'Temperature\\.tsx', regex: true }, exec)
check('recall supports regex mode', regexHit.total >= 1, regexHit.text)

// 3. Local retrieval kernel: ranking, filters, exclusions
const ranked = recall.execute({ query: '温度 监控' }, exec)
check('kernel ranks by relevance', ranked.total >= 1 && ranked.text.includes('检索内核'), ranked.text)
check('the best match is the instruction itself', ranked.text.includes('#1') || ranked.text.includes('#2'), ranked.text)
const typed = recall.execute({ query: 'chart type:tool' }, exec)
check('kernel honors type filters', typed.total === 1 && typed.text.includes('工具结果'), typed.text)
const excluded = recall.execute({ query: 'chart -Temperature' }, exec)
check('kernel honors exclusion terms', excluded.total === 0, excluded.text)
const phrase = recall.execute({ query: '"历史曲线"' }, exec)
check('kernel matches quoted phrases', phrase.total >= 1, phrase.text)

const expand = tools.get('context_expand')
const range = expand.execute({ from: 1, to: 2 }, exec)
check('expand returns the verbatim range', range.events === 2 && range.text.includes('温度监控页面'), range.text)
const budgeted = expand.execute({ from: 0, to: 20, maxChars: 120 }, exec)
check('expand honors its character budget', budgeted.text.length < 400, `length=${budgeted.text.length}`)

// 3. Tool output contract
for (const [name, tool] of tools) {
  const out = tool.output.schema
  check(`${name} declares an object output schema`, out.type === 'object' && out.additionalProperties === false)
  const probe = name === 'context_recall'
    ? tool.execute({ query: 'chart' }, exec)
    : tool.execute({ from: 0, to: 1 }, exec)
  const rendered = tool.output.render({}, probe)
  check(`${name} renders text content`, Array.isArray(rendered) && rendered[0]?.type === 'text')
}

// 4. Cached-content projection (the composer's "local cache" reading)
check('registers the cached-content projection', projections.has('contextAnchorCache'))
const projection = projections.get('contextAnchorCache')
let cacheState = projection.init({}, 0)
for (const event of session.events) cacheState = projection.apply(cacheState, event)
const cache = projection.wire.viewSchema.parse(projection.wire.view(cacheState))
check('prices every recallable event', cache.events === 5, JSON.stringify(cache))
check('counts characters of recallable content', cache.chars > 40, JSON.stringify(cache))
check('prices tokens at the meter density', cache.tokens > 0 && cache.tokens < cache.chars, JSON.stringify(cache))
check('ignores events without content', projection.apply(cacheState, { type: 'turn/end', data: {} }) === cacheState)

const recallCall = {
  type: 'tool/call', seq: 99, time: Date.now(),
  data: { turn: 1, step: 3, callId: 'c2', name: 'context_recall', arguments: JSON.stringify({ query: 'chart' }) },
}
const duringRecall = projection.apply(cacheState, recallCall)
check(
  'a recall call marks the memory as searching',
  duringRecall.activity === 'recall' && duringRecall.recalls === 1,
  JSON.stringify(duringRecall),
)
const afterResult = projection.apply(duringRecall, {
  type: 'tool/result', seq: 100, time: Date.now(),
  data: { turn: 1, step: 3, message: { role: 'tool', content: [{ type: 'text', text: 'found it' }] } },
})
check(
  'the result returns the memory to idle and prices the result',
  afterResult.activity === 'idle' && afterResult.events === duringRecall.events + 1,
  JSON.stringify(afterResult),
)
check(
  'an unrelated event keeps the state reference',
  projection.apply(afterResult, { type: 'turn/end', seq: 101, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }) === afterResult,
)
check(
  'the wire view carries the memory state',
  projection.wire.viewSchema.parse(projection.wire.view(afterResult)).activity === 'idle',
)

// 5. Unload cleanliness
for (const dispose of disposers) dispose()
check('disposer removes both tools', tools.size === 0)
check('disposer removes the anchor', contexts.size === 0)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
