// Harness: pull the REAL cut-region + preview functions out of index.js and
// exercise them against fake sessions, so the math is verified, not assumed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`missing start: ${startMarker}`)
  const end = src.indexOf(endMarker, start)
  if (end < 0) throw new Error(`missing end: ${endMarker}`)
  return src.slice(start, end)
}

const regionSrc = slice('function shrinkForProtection(', 'async function compactEarly(')
const previewSrc = slice('function archivePreviewOf(', '/** Resolve the live session behind an id')

const factory = new Function('eventText', 'occupancyOf', `
${regionSrc}
${previewSrc}
return { archiveRegionOf, archivePreviewOf }
`)

const fakeEventText = (event) => {
  if (!event) return ''
  if (event.type === 'user/message') return `用户：${event.data.text}`
  if (event.type === 'assistant/message') return `助手：${event.data.text}`
  return ''
}
const fakeOccupancy = () => ({ used: 120000, window: 200000 })

const { archiveRegionOf, archivePreviewOf } = factory(fakeEventText, fakeOccupancy)

/** Build a session: node 0 is a system message, then a fixed pattern. */
function makeSession(count, opts = {}) {
  const events = new Map()
  const nodes = []
  for (let i = 0; i < count; i += 1) {
    let type = 'assistant/message'
    if (i === 0) type = opts.systemFirst === false ? 'user/message' : 'system/message'
    else if (i % 4 === 1) type = 'user/message'
    events.set(i, { seq: i, type, data: { text: `msg ${i}` } })
    nodes.push(i)
  }
  return { surface: { nodes }, eventAt: (seq) => events.get(seq) }
}

const results = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n   got ${JSON.stringify(actual)}\n   want ${JSON.stringify(expected)}`}`)
}

// 1) Normal 20-node session: system(0) + users at 1,5,9,13,17.
{
  const region = archiveRegionOf(makeSession(20))
  check('cut indices', [region.startIndex, region.endIndex], [1, 12])
  check('cut node count', region.nodes.length, 20)
}

// 2) Too few nodes to bother compacting.
check('few-nodes guard', archiveRegionOf(makeSession(5)).skip, 'few-nodes')

// 3) No surface at all.
check('no-surface guard', archiveRegionOf({}).skip, 'no-surface')

// 4) Preview of the normal session: range, count and endpoints.
{
  const preview = archivePreviewOf({ get: () => undefined }, makeSession(20))
  check('preview available', preview.available, true)
  check('preview count', preview.count, 12)
  check('preview range', [preview.from, preview.to], [1, 12])
  check('preview total', preview.total, 20)
  check('preview percent', preview.percent, 60)
  // The first node is already a user message, so the first-user pick collapses
  // into it; the panel then shows exactly two excerpts: the ends of the range.
  check('preview samples', preview.samples.map((s) => s.seq), [1, 12])
  check('preview sample text', preview.samples[0].text, '用户：msg 1')
}

// 5) Preview degrades cleanly instead of throwing.
{
  const preview = archivePreviewOf({ get: () => undefined }, makeSession(4))
  check('preview unavailable', [preview.available, preview.reason], [false, 'few-nodes'])
}

// 6) The newest instruction in flight is never folded: the last user message
//    must sit outside the archived range.
{
  const session = makeSession(20)
  const region = archiveRegionOf(session)
  const archived = new Set(region.nodes.slice(region.startIndex, region.endIndex + 1))
  const lastUser = [...region.nodes].reverse().find((seq) => session.eventAt(seq).type === 'user/message')
  check('in-flight instruction survives', archived.has(lastUser), false)
}

// 7) When the range opens on assistant output, the middle pick lands on the
//    first instruction inside the range rather than on an adjacent duplicate.
{
  const types = Array.from({ length: 20 }, (_, i) => {
    if (i === 0) return 'system/message'
    return [3, 7, 11, 15, 19].includes(i) ? 'user/message' : 'assistant/message'
  })
  const events = new Map(types.map((type, i) => [i, { seq: i, type, data: { text: `msg ${i}` } }]))
  const session = { surface: { nodes: types.map((_, i) => i) }, eventAt: (seq) => events.get(seq) }
  const region = archiveRegionOf(session)
  check('shifted cut indices', [region.startIndex, region.endIndex], [1, 10])
  const preview = archivePreviewOf({ get: () => undefined }, session)
  check('shifted samples', preview.samples.map((s) => s.seq), [1, 3, 10])
}

// 8) Protection pulls the cut back to the turn before the first match.
//    Base cut was [1..12]; "msg 9" first appears at seq 9, so the new cut must
//    end before it, at the nearest turn start with a user message after it.
{
  const session = makeSession(20)
  const region = archiveRegionOf(session, ['msg 9'])
  check('protected end moves back', region.endIndex < 12, true)
  const archived = new Set(region.nodes.slice(region.startIndex, region.endIndex + 1))
  check('protected event survives', archived.has(9), false)
  check('protected flag', region.protected, true)
  check('protected keeps turn boundary', session.eventAt(region.nodes[region.endIndex + 1]).type, 'user/message')
}

// 9) A needle that matches nothing leaves the cut untouched.
{
  const session = makeSession(20)
  const region = archiveRegionOf(session, ['nothing-matches-this'])
  check('unmatched needle is a no-op', [region.endIndex, region.protected], [12, false])
}

// 10) A needle matching right at the start must not paralyze compaction: the
//     floor keeps the base cut instead of archiving nothing.
{
  const session = makeSession(20)
  const region = archiveRegionOf(session, ['msg 2'])
  check('floor keeps base cut', [region.endIndex, region.protected], [12, false])
}

// 11) Needles are case-insensitive and substring-based, like a path fragment.
{
  const events = new Map()
  const nodes = []
  for (let i = 0; i < 20; i += 1) {
    const type = i === 0 ? 'system/message' : i % 4 === 1 ? 'user/message' : 'assistant/message'
    const text = i === 9 ? 'edited SRC/Auth/session.ts' : `msg ${i}`
    events.set(i, { seq: i, type, data: { text } })
    nodes.push(i)
  }
  const session = { surface: { nodes }, eventAt: (seq) => events.get(seq) }
  const region = archiveRegionOf(session, ['src/auth/'])
  check('path needle matches case-insensitively', region.protected, true)
  check('path needle excludes the file', region.endIndex < 9, true)
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
