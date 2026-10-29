/**
 * Isolate tests from the real user profile.
 *
 * The plugin persists settings and cross-session memory under `$DSH_HOME`. A
 * test that imports it without redirecting that variable writes to the live
 * profile — which is how a run once seeded the developer's own memory.json with
 * fixture text. Import this module *before* `../index.js`; it only touches
 * `process.env`, so the plugin reads the temporary home when it resolves paths.
 *
 * Each test process gets its own directory and removes it on exit.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-context-anchor-test-'))
process.env.DSH_HOME = home

const cleanup = () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is harmless; never fail a test over cleanup.
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

export const testHome = home
