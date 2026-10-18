/**
 * The doctor's judging, and setup's stable extension copy. Each check is a pure function
 * over what was gathered (a /health answer, a port owner, a few files), so these feed it
 * shapes instead of starting a bridge or a Chrome.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../server/version.js'
import {
  checkNode, checkBridge, checkSessions, findDuplicates, checkDuplicates, checkChannels,
  stableVersion, checkExtension, stopCommand, pluginVersion, format,
} from '../scripts/doctor.js'
import { installStable } from '../scripts/setup.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const temp = () => mkdtempSync(join(tmpdir(), 'pinpoint-doctor-'))

test('versions compare as numbers, and junk reads as oldest', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.2.0', '0.3.0') < 0)
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
  assert.ok(compareVersions(undefined, '0.0.1') < 0)
  assert.ok(compareVersions('nonsense', '0.0.1') < 0)
})

test('every place the version lives says the same thing', () => {
  const json = f => JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
  const v = json('package.json').version
  assert.equal(json('.claude-plugin/plugin.json').version, v)
  assert.equal(json('.claude-plugin/marketplace.json').plugins[0].version, v)
  assert.equal(json('extension/manifest.json').version, v)
  assert.match(readFileSync(join(ROOT, 'server/pinpoint.js'), 'utf8'), new RegExp(`const VERSION = .*'${v.replace(/\./g, '\\.')}'`))
  assert.equal(pluginVersion(), v)
})

test('node: 20 and up pass, older fails with a fix', () => {
  assert.equal(checkNode('20.0.0').ok, true)
  assert.equal(checkNode('22.18.0').ok, true)
  const r = checkNode('18.19.1')
  assert.equal(r.ok, false)
  assert.match(r.fix, /Node 20/)
})

test('bridge: nothing on the port, or something that is not Pinpoint', () => {
  const none = checkBridge({ health: null, owner: null, version: '0.3.0', port: 8788 })
  assert.equal(none.ok, false)
  assert.match(none.fix, /\/mcp/)
  const other = checkBridge({ health: null, owner: { pid: 42, command: 'python -m http.server 8788' }, version: '0.3.0', port: 8788 })
  assert.equal(other.ok, false)
  assert.match(other.detail, /not Pinpoint \(pid 42\)/)
})

test('bridge: same version passes, older or newer fails with the right fix', () => {
  const owner = { pid: 7, command: 'node /Users/k/.claude/plugins/cache/pinpoint-marketplace/pinpoint/0.2.0/server/pinpoint.js' }
  assert.equal(checkBridge({ health: { version: '0.3.0' }, owner, version: '0.3.0' }).ok, true)

  // Too old to be asked: the exact pkill, matched on that version's folder only.
  const old = checkBridge({ health: { version: '0.2.0' }, owner, version: '0.3.0' })
  assert.equal(old.ok, false)
  assert.match(old.fix, /pkill -f "\/Users\/k\/\.claude\/plugins\/cache\/pinpoint-marketplace\/pinpoint\/0\.2\.0\/server\/pinpoint\.js"/)

  // New enough to hand over on its own: reconnecting this session is the fix, no pkill.
  const yields = checkBridge({ health: { version: '0.3.0' }, owner, version: '0.3.1' })
  assert.equal(yields.ok, false)
  assert.doesNotMatch(yields.fix, /pkill/)
  assert.match(yields.fix, /Reconnect/)

  const newer = checkBridge({ health: { version: '0.4.0' }, owner, version: '0.3.0' })
  assert.equal(newer.ok, false)
  assert.match(newer.fix, /Update/)
})

test('stop command: pkill on an absolute script path, kill on anything vaguer', () => {
  assert.match(stopCommand({ pid: 9, command: 'node /opt/p/0.2.0/server/pinpoint.js' }), /pkill -f "\/opt\/p\/0\.2\.0\/server\/pinpoint\.js"/)
  assert.match(stopCommand({ pid: 9, command: 'node ./server/pinpoint.js' }), /kill 9$/)
  assert.doesNotMatch(stopCommand(null), /kill/)
})

test('sessions: this folder, or one inside it, counts as joined', () => {
  const dir = temp()
  try {
    mkdirSync(join(dir, 'web'))
    const health = { sessions: [{ name: 'app', projectDir: dir }] }
    assert.equal(checkSessions({ health, projectDir: dir }).ok, true)
    assert.equal(checkSessions({ health, projectDir: join(dir, 'web') }).ok, true)
    const missing = checkSessions({ health, projectDir: tmpdir() })
    assert.equal(missing.ok, false)
    assert.match(missing.fix, /Reconnect/)
    assert.equal(checkSessions({ health: { version: '0.1.0' }, projectDir: dir }).ok, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicates: a project .mcp.json "pinpoint" is flagged unless turned off', () => {
  const dir = temp()
  const claudeJson = join(dir, 'claude.json')
  try {
    assert.deepEqual(findDuplicates({ projectDir: dir, claudeJson }), [])
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { pinpoint: { command: 'node' } } }))
    const found = findDuplicates({ projectDir: dir, claudeJson })
    assert.deepEqual(found.map(f => f.scope), ['project'])
    const r = checkDuplicates(found)
    assert.equal(r.ok, false)
    assert.match(r.fix, /pinpoint-dev/)

    // Renamed for development: no clash.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'pinpoint-dev': { command: 'node' } } }))
    assert.deepEqual(findDuplicates({ projectDir: dir, claudeJson }), [])

    // Turned off in the project's local settings: no clash either.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { pinpoint: { command: 'node' } } }))
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['pinpoint'] }))
    assert.deepEqual(findDuplicates({ projectDir: dir, claudeJson }), [])

    // A user scope entry from a manual install is one too.
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { pinpoint: {} } }))
    const user = findDuplicates({ projectDir: dir, claudeJson })
    assert.deepEqual(user.map(f => f.scope), ['user'])
    assert.match(checkDuplicates(user).fix, /claude mcp remove pinpoint -s user/)
    assert.equal(checkDuplicates([]).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('channels: read off the claude command line, never a failure', () => {
  const on = checkChannels({ ancestors: ['/bin/zsh -c x', 'claude --dangerously-load-development-channels plugin:pinpoint@pinpoint-marketplace'], plugin: true })
  assert.equal(on.ok, true)
  const off = checkChannels({ ancestors: ['/bin/zsh -c x', 'claude --resume'], plugin: true })
  assert.equal(off.ok, null)
  assert.match(off.detail, /^off/)
  assert.match(off.detail, /\/pinpoint:comments/)
  assert.match(off.detail, /plugin:pinpoint@pinpoint-marketplace/)
  const other = checkChannels({ ancestors: ['claude --channels plugin:telegram@x'], plugin: true })
  assert.match(other.detail, /not for Pinpoint/)
  assert.match(checkChannels({ ancestors: ['bash'], plugin: false }).detail, /could not tell.*server:pinpoint/)
})

test('stable copy: installed whole with a VERSION file, refreshed in place, checked against the plugin', () => {
  const dir = temp()
  const src = join(dir, 'src')
  const dest = join(dir, 'home', '.claude', 'pinpoint', 'extension')
  try {
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ version: '0.2.0' }))
    writeFileSync(join(src, 'content.js'), 'one')

    assert.equal(stableVersion(dest), null)
    assert.equal(checkExtension({ stable: null, version: '0.3.0', dir: dest }).ok, false)

    installStable(src, dest, '0.2.0')
    assert.equal(stableVersion(dest), '0.2.0')
    const stale = checkExtension({ stable: stableVersion(dest), version: '0.3.0', dir: dest })
    assert.equal(stale.ok, false)
    assert.match(stale.fix, /Reload/)

    // A file dropped from the new version must not linger in the copy.
    writeFileSync(join(dest, 'leftover.js'), 'old')
    writeFileSync(join(src, 'content.js'), 'two')
    installStable(src, dest, '0.3.0')
    assert.equal(stableVersion(dest), '0.3.0')
    assert.equal(readFileSync(join(dest, 'content.js'), 'utf8'), 'two')
    assert.equal(existsSync(join(dest, 'leftover.js')), false)
    assert.equal(checkExtension({ stable: '0.3.0', version: '0.3.0', dir: dest }).ok, true)
    // No temp or old folders left beside it.
    assert.deepEqual(readdirSync(dirname(dest)), ['extension'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('format: one line per check, a fix under each failure, and the count', () => {
  const out = format({ version: '0.3.0', results: [checkNode('22.0.0'), checkNode('18.0.0')] })
  assert.match(out, /ok {4}Node: 22\.0\.0/)
  assert.match(out, /FAIL {2}Node: 18\.0\.0/)
  assert.match(out, /Fix: Install Node 20/)
  assert.match(out, /1 to fix/)
  assert.doesNotMatch(out, /\u2014/)
})
