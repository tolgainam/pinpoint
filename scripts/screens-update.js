#!/usr/bin/env node
/**
 * Rewrites the reference screenshots in test/screens for this platform, and lists what
 * changed in test/screens/PENDING.md.
 *
 * Baselines are the agreed look, so this only runs once the owner has signed the change
 * off. PENDING.md is the note that goes with that sign-off: which screens moved and by
 * how much. Delete it once the new baselines are committed.
 *
 *   npm run screens:update
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { available, shootAll, compare, baselinePath, NAMES, SCREENS_DIR } from '../test/screens/shoot.js'

const browser = await available()
if (!browser.ok) {
  console.error(`screens:update: ${browser.why}`)
  process.exit(1)
}

const shots = await shootAll(browser.chromium)
const lines = []
for (const name of NAMES) {
  const path = baselinePath(name)
  let note
  if (!existsSync(path)) note = 'new'
  else {
    const result = await compare(shots[name], await readFile(path))
    note = result.same ? null : `changed: ${result.why}`
  }
  if (!note) continue
  await writeFile(path, shots[name])
  lines.push(`- test/screens/${basename(path)}: ${note}`)
}

if (!lines.length) {
  console.log('screens:update: nothing changed')
  process.exit(0)
}

const pending = join(SCREENS_DIR, 'PENDING.md')
await writeFile(pending, [
  '# Screens waiting for sign-off',
  '',
  `Written by npm run screens:update on ${process.platform}, ${new Date().toISOString().slice(0, 10)}.`,
  'Commit these baselines only with the owner\'s sign-off, then delete this file.',
  '',
  ...lines,
  '',
].join('\n'))
console.log(lines.join('\n'))
console.log(`screens:update: wrote ${lines.length} baseline(s), see test/screens/PENDING.md`)
