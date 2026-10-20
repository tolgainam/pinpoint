/**
 * The toolbar's key screens against the reference PNGs in test/screens.
 *
 * Those PNGs are the agreed look. A mismatch fails, and the fix is either the code or,
 * with the owner's sign-off, `npm run screens:update`. Never edit a baseline to make
 * this pass.
 *
 * Skips, saying why, when Playwright's Chromium is not installed or this platform has
 * no baselines yet; text renders differently per OS, so each keeps its own set.
 * A failing screen leaves `<name>.actual.png` and `<name>.diff.png` in test/screens/.out.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { available, shootAll, compare, baselinePath, NAMES, SCREENS_DIR } from './screens/shoot.js'

const browser = await available()
const missing = NAMES.filter(n => !existsSync(baselinePath(n)))
const skip = !browser.ok ? browser.why
  : missing.length ? `no ${process.platform} baselines yet (${missing.join(', ')}); the owner signs them off via npm run screens:update`
    : false

if (skip) console.log(`screens skipped: ${skip}`)

test('reference screenshots match', { skip, timeout: 120000 }, async () => {
  const shots = await shootAll(browser.chromium)
  const out = join(SCREENS_DIR, '.out')
  const failures = []
  for (const name of NAMES) {
    const result = await compare(shots[name], await readFile(baselinePath(name)))
    if (result.same) continue
    failures.push(`${name}: ${result.why}`)
    await mkdir(out, { recursive: true })
    await writeFile(join(out, `${name}.actual.png`), shots[name])
    if (result.diff) await writeFile(join(out, `${name}.diff.png`), result.diff)
  }
  assert.deepEqual(failures, [], `screens changed, see test/screens/.out:\n  ${failures.join('\n  ')}`)
})
