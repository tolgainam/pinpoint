/**
 * The npm command line: help says what there is, and an unknown command fails with a
 * code a script can see. `install` is not run here, since it would change Claude Code.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, USAGE } from '../scripts/cli.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('help names every command and the channels flag', () => {
  for (const word of ['install', 'setup', 'doctor', '--firefox', '--dangerously-load-development-channels']) {
    assert.ok(USAGE.includes(word), `usage does not mention ${word}`)
  }
})

test('help exits 0 and an unknown command exits 2', () => {
  const log = console.log
  const error = console.error
  console.log = console.error = () => {}
  try {
    assert.equal(main(['help']), 0)
    assert.equal(main([]), 0)
    assert.equal(main(['nope']), 2)
  } finally {
    console.log = log
    console.error = error
  }
})

test('the package ships the bin and every file the commands need', () => {
  assert.equal(pkg.bin['pinpoint-dev'], 'scripts/cli.js')
  assert.ok(existsSync(join(ROOT, pkg.bin['pinpoint-dev'])))
  // setup.js and doctor.js import these, so a files list that drops one breaks `npx`.
  for (const f of ['scripts/setup.js', 'scripts/doctor.js', 'scripts/firefox.js', 'server/paths.js', 'server/version.js', '.claude-plugin/plugin.json', 'extension/manifest.json']) {
    const top = f.split('/')[0]
    assert.ok(pkg.files.includes(f) || pkg.files.includes(top), `${f} is not in "files"`)
  }
})
