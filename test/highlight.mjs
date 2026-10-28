// Harness: pull highlightSnippet out of index.js and check its rules.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
const start = src.indexOf('function highlightSnippet(')
const end = src.indexOf('/** A window of the document centered')
if (start < 0 || end < 0) throw new Error('markers not found')
const fnSrc = src.slice(start, end)
const highlight = new Function(`${fnSrc}; return highlightSnippet`)()

const results = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n   got ${JSON.stringify(actual)}\n   want ${JSON.stringify(expected)}`}`)
}

// 1) Phrase then term, both marked, original casing kept.
{
  const text = '工具调用 read：{"file_path":"src/auth/session.ts"}'
  const out = highlight(text, { phrases: ['src/auth'], terms: ['session'] })
  check('phrase and term both marked', out, '工具调用 read：{"file_path":"«src/auth»/«session».ts"}')
}

// 2) Case-insensitive match, casing preserved in the output.
{
  const out = highlight('the README.md file', { phrases: [], terms: ['readme'] })
  check('case-insensitive', out, 'the «README».md file')
}

// 3) A needle that does not appear is left alone.
{
  const out = highlight('nothing here', { phrases: [], terms: ['absent'] })
  check('miss is a no-op', out, 'nothing here')
}

// 4) Budget: at most five markers even when everything matches.
{
  const out = highlight('a b c d e f g h i j', { phrases: [], terms: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
  check('marker count', (out.match(/«/g) ?? []).length, 5)
}

// 5) Repeated needles are marked once.
{
  const out = highlight('temp temp temp', { phrases: [], terms: ['temp', 'temp'] })
  check('dedupe by needle', (out.match(/«/g) ?? []).length, 1)
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
