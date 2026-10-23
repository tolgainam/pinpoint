/**
 * The repo gates: each rule passes on good text and fails on bad text, and the whole
 * `npm run check` passes on this repository.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkVersions, checkNoStdout, checkNoSyncBase64Write, checkHandlersCaught, checkScriptLists, checkRepo,
} from '../scripts/check-rules.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const versionFiles = (over = {}) => ({
  server: "const VERSION = process.env.PINPOINT_VERSION ?? '1.2.3'",
  package: '{"version":"1.2.3"}',
  plugin: '{"version":"1.2.3"}',
  marketplace: '{"plugins":[{"version":"1.2.3"}]}',
  manifest: '{"version":"1.2.3"}',
  ...over,
})

test('versions: agree passes, any drift fails and names the file', () => {
  assert.deepEqual(checkVersions(versionFiles()), [])
  const bad = checkVersions(versionFiles({ manifest: '{"version":"1.2.4"}', server: "x ?? 1\nPINPOINT_VERSION ?? '1.0.0'" }))
  assert.deepEqual(bad.map(p => p.file).sort(), ['extension/manifest.json', 'server/pinpoint.js'])
  assert.equal(bad.find(p => p.file === 'server/pinpoint.js').line, 2)
})

test('no-stdout: console.error passes, console.log and stdout.write fail', () => {
  assert.deepEqual(checkNoStdout('s.js', "console.error('ok')"), [])
  const bad = checkNoStdout('s.js', "a()\nconsole.log('x')\nprocess.stdout.write('y')")
  assert.deepEqual(bad.map(p => p.line), [2, 3])
})

test('no-sync-base64-write: async or plain writes pass, a sync base64 write fails', () => {
  assert.deepEqual(checkNoSyncBase64Write('s.js', "writeFileSync(f, 'text')\nconst b = Buffer.from(x, 'base64')"), [])
  const bad = checkNoSyncBase64Write('s.js', "writeFileSync(f, Buffer.from(data, 'base64'))")
  assert.equal(bad.length, 1)
  assert.equal(bad[0].line, 1)
})

test('handlers-caught: a .catch on every async handler call passes, a bare call fails', () => {
  const decl = 'async function handleX(req, res) {}\n'
  assert.deepEqual(checkHandlersCaught('s.js', `${decl}handleX(req, res).catch(e => {})`), [])
  assert.deepEqual(checkHandlersCaught('s.js', `${decl}handleX(a(b), res)\n  .catch(e => {})`), [])
  const bad = checkHandlersCaught('s.js', `${decl}handleX(req, res)`)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].line, 2)
  assert.deepEqual(checkHandlersCaught('s.js', 'function handleY() {}\nhandleY()'), [])
})

test('content-script-lists: matching lists pass, a reordered one fails', () => {
  const manifest = JSON.stringify({ content_scripts: [{ js: ['probe.js'] }, { js: ['status.js', 'content.js'] }] })
  const worker = (a, b) => `
    executeScript({ files: ['probe.js'] })
    executeScript({ files: [${a}] })
    register([{ js: ['probe.js'] }, { js: [${b}] }])`
  assert.deepEqual(checkScriptLists(manifest, worker("'status.js', 'content.js'", "'status.js', 'content.js'")), [])
  const bad = checkScriptLists(manifest, worker("'content.js', 'status.js'", "'status.js', 'content.js'"))
  assert.equal(bad.length, 1)
  assert.match(bad[0].message, /ensureInjected/)
})

test('the real repository passes every rule', () => {
  assert.deepEqual(checkRepo(), [])
})

test('npm run check exits 0 on the real repository', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check.js')], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
