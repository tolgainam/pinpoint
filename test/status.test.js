/**
 * The toolbar pill's label and state logic, from /health answers shaped like the
 * bridge's. extension/status.js is a classic script that also loads as a module, so it
 * is imported for its side effect and read back off the global.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../extension/status.js'
import { compareVersions as serverCompare } from '../server/version.js'

const { view, portOf, displayNames, eventFor, dispatchPick, versionNote, bridgeSummary, tipLine, compareVersions } = globalThis.PinpointStatus

const MYAPP = '/Users/k/Projects/myapp'
const PINPOINT = '/Users/k/Projects/pinpoint'
const WEBSHOP = '/Users/k/Projects/webshop'

const s = dir => ({ name: dir.split('/').pop(), projectDir: dir })
const health = (sessions, route) => ({ connected: true, sessions: sessions.map(s), route })

test('offline: dot off, no list, last used path, Retry', () => {
  const v = view({ connected: false }, null, '5173', MYAPP)
  assert.equal(v.label, 'Offline')
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
  assert.equal(v.rows, null)
  assert.equal(v.retry, true)
  assert.deepEqual(v.lines, ['Start Claude Code in your project folder, then retry.', 'Last used: ~/Projects/myapp'])
})

test('auto matched: dot on, project name, Auto row selected with its match', () => {
  const v = view(health([MYAPP, PINPOINT], { how: 'auto', projectDir: MYAPP, detected: `${MYAPP}/web` }), null, '5173')
  assert.equal(v.label, 'myapp')
  assert.equal(v.dot, true)
  assert.equal(v.pin, false)
  assert.equal(v.canDispatch, true)
  assert.equal(v.heading, 'Sending to Claude Code in')
  assert.deepEqual(v.lines, ['~/Projects/myapp'])
  assert.equal(v.rows[0].name, 'Auto: myapp')
  assert.equal(v.rows[0].selected, true)
  assert.deepEqual(v.rows.slice(1).map(r => [r.name, r.path]), [['myapp', '~/Projects/myapp'], ['pinpoint', '~/Projects/pinpoint']])
})

test('manual pick: pin mark, "(your pick)", Auto row still names what Auto would do', () => {
  const v = view(health([MYAPP, PINPOINT], { how: 'manual', projectDir: PINPOINT, detected: MYAPP }), { projectDir: PINPOINT, name: 'pinpoint' }, '5173')
  assert.equal(v.label, 'pinpoint')
  assert.equal(v.pin, true)
  assert.equal(v.dot, true)
  assert.equal(v.canDispatch, true)
  assert.deepEqual(v.lines, ['~/Projects/pinpoint (your pick)'])
  assert.equal(v.rows[0].name, 'Auto: myapp')
  assert.equal(v.rows[0].selected, false)
  assert.equal(v.rows.find(r => r.selected).dir, PINPOINT)
})

test('manual pick not running: dot off, pin mark, Dispatch disabled, no fallback', () => {
  const v = view(health([MYAPP], { how: 'manual', projectDir: PINPOINT, detected: null, error: 'gone' }), { projectDir: PINPOINT, name: 'pinpoint' }, '5173')
  assert.equal(v.label, 'pinpoint')
  assert.equal(v.pin, true)
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
  assert.equal(v.sendsTo, null)
})

test('no session for the detected project: its name, dot off, Park still allowed there', () => {
  const v = view(health([MYAPP, PINPOINT], { how: 'none', projectDir: null, detected: WEBSHOP }), null, '5173')
  assert.equal(v.label, 'webshop')
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
  assert.equal(v.canPark, true)
  assert.equal(v.project, WEBSHOP)
  assert.equal(v.projectPick, null, 'no pick is invented for it')
  assert.equal(v.heading, 'No Claude Code in webshop')
  assert.equal(v.rows[0].name, 'Auto: none for webshop')
})

test('strict: one other session running is still "no session for this project"', () => {
  const v = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: WEBSHOP }), null, '5173')
  assert.equal(v.state, 'none')
  assert.equal(v.label, 'webshop')
  assert.equal(v.canDispatch, false)
  // Park and the chips use the detected project, not the one session.
  assert.equal(v.project, WEBSHOP)
})

test('nothing detected, one session: treated as Auto matched', () => {
  const v = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: null }), null, '5173')
  assert.equal(v.state, 'auto')
  assert.equal(v.label, 'myapp')
  assert.equal(v.canDispatch, true)
  assert.equal(v.rows[0].name, 'Auto: myapp')
  assert.equal(v.rows.length, 2)
})

test('a root or home cwd (Docker, a proxy) is not a detected project', () => {
  const v = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: '/' }), null, '5173')
  assert.equal(v.state, 'auto')
})

test('nothing detected, several sessions: Choose, kept-for-port line', () => {
  const v = view(health([MYAPP, PINPOINT], { how: 'none', projectDir: null, detected: null }), null, '5173')
  assert.equal(v.label, 'Choose')
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
  assert.equal(v.canPark, false)
  assert.deepEqual(v.lines, ['Pick one; it is kept for :5173.'])
  assert.equal(v.rows[0].name, 'Auto')
})

test('reconnecting: neutral waiting state, Dispatch disabled', () => {
  const v = view(health([MYAPP], { how: 'reconnecting', projectDir: null, detected: null }), null, '5173')
  assert.equal(v.label, 'Reconnecting')
  assert.equal(v.heading, 'Reconnecting to Claude Code')
  assert.deepEqual(v.lines, ['A Claude Code session just closed. Try again in a few seconds.'])
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
})

test('a worktree reads as its repo in the pill and the list, with its full path kept', () => {
  const WT = '/Users/k/Projects/rigboard/.claude/worktrees/agent-a9c963b0e4f734fe4'
  // Bridge-sent names win; the path rule is the fallback for a bridge that sends none.
  const none = view(health([PINPOINT], { how: 'none', projectDir: null, detected: WT }), null, '5173')
  assert.equal(none.label, 'rigboard worktree')
  assert.equal(none.heading, 'No Claude Code in rigboard worktree')
  assert.deepEqual(none.lines, ['Start one in ~/Projects/rigboard/.claude/worktrees/agent-a9c963b0e4f734fe4, or send to another project:'])

  const sent = view({ connected: true, sessions: [{ name: 'rigboard worktree', projectDir: WT }], route: { how: 'auto', projectDir: WT, detected: WT } }, null, '5173')
  assert.equal(sent.label, 'rigboard worktree')
  assert.deepEqual(sent.lines, ['~/Projects/rigboard/.claude/worktrees/agent-a9c963b0e4f734fe4'])
  assert.equal(sent.rows[1].name, 'rigboard worktree')
})

test('name clashes show the parent folder', () => {
  const names = displayNames([s('/Users/k/work/app'), s('/Users/k/play/app'), s(MYAPP)])
  assert.equal(names.get('/Users/k/work/app'), 'work/app')
  assert.equal(names.get('/Users/k/play/app'), 'play/app')
  assert.equal(names.get(MYAPP), 'myapp')
})

test('localhost and 127.0.0.1 on one port share a key', () => {
  assert.equal(portOf({ port: '5173', protocol: 'http:' }), '5173')
  assert.equal(portOf({ port: '', protocol: 'http:' }), '80')
})

test('the pill and popover styles use --pp-* tokens, never raw colours', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../extension/overlay.css', import.meta.url), 'utf8')
  const rules = css.match(/[^}]*\{[^}]*\}/g).filter(r => /\.(dot|pill|pop)\b|\.blocked/.test(r.split('{')[0]))
  assert.ok(rules.length >= 5, 'expected the status rules to be found')
  for (const r of rules) assert.doesNotMatch(r.split('{')[1], /#[0-9a-f]{3,8}\b|rgb\((?!0 0 0)/i, r)
})

test('Park follows the pick, running or not, and never swaps it for the detected project', () => {
  const pick = { projectDir: PINPOINT, name: 'pinpoint' }
  const gone = view(health([MYAPP], { how: 'manual', projectDir: PINPOINT, detected: MYAPP, error: 'gone' }), pick, '5173')
  assert.equal(gone.canPark, true)
  assert.equal(gone.projectPick, PINPOINT)
  assert.equal(gone.project, PINPOINT)

  // A pick with nothing detected still parks: the pick is the project.
  const blind = view(health([MYAPP], { how: 'manual', projectDir: PINPOINT, detected: null, error: 'gone' }), pick, '5173')
  assert.equal(blind.canPark, true)

  const live = view(health([MYAPP, PINPOINT], { how: 'manual', projectDir: PINPOINT, detected: null }), pick, '5173')
  assert.equal(live.canPark, true)
  assert.equal(live.project, PINPOINT)
})

test('a pick matches its session with or without a trailing slash', () => {
  const v = view(health([PINPOINT], { how: 'manual', projectDir: PINPOINT, detected: null }), { projectDir: `${PINPOINT}/`, name: 'pinpoint' }, '5173')
  assert.equal(v.state, 'manual')
  assert.equal(v.rows.find(r => r.selected).dir, PINPOINT)
})

test('dispatch names its target, so a session that just left is refused rather than replaced', () => {
  const auto = view(health([MYAPP, PINPOINT], { how: 'auto', projectDir: MYAPP, detected: MYAPP }), null, '5173')
  assert.equal(dispatchPick(auto), MYAPP)
  const only = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: null }), null, '5173')
  assert.equal(dispatchPick(only), MYAPP)
  const manual = view(health([MYAPP, PINPOINT], { how: 'manual', projectDir: PINPOINT, detected: null }), { projectDir: PINPOINT }, '5173')
  assert.equal(dispatchPick(manual), PINPOINT)
})

test('a bridge from before routing still reads as connected and can dispatch', () => {
  const v = view({ connected: true, ok: true, projectDir: MYAPP }, null, '5173')
  assert.equal(v.state, 'legacy')
  assert.equal(v.label, 'myapp')
  assert.equal(v.dot, true)
  assert.equal(v.canDispatch, true)
  assert.equal(v.rows, null)
  assert.equal(dispatchPick(v), undefined)
})

test('bridge events: only the project this page sends to, none in a no-target state', () => {
  const auto = view(health([MYAPP, PINPOINT], { how: 'auto', projectDir: MYAPP, detected: MYAPP }), null, '5173')
  assert.equal(eventFor(auto, MYAPP), true)
  assert.equal(eventFor(auto, `${MYAPP}/`), true, 'trailing slash is the same folder')
  assert.equal(eventFor(auto, PINPOINT), false)
  assert.equal(eventFor(auto, undefined), true, 'unstamped events pass as before')

  const none = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: WEBSHOP }), null, '5173')
  assert.equal(eventFor(none, MYAPP), false)
  assert.equal(eventFor(none, undefined), true)
})

// ---------------------------------------------------------------- versions

const on = version => ({ connected: true, version, sessions: [s(MYAPP)], route: { how: 'auto', projectDir: MYAPP } })

test('version: equal versions say nothing', () => {
  assert.equal(versionNote(on('0.3.0'), '0.3.0'), null)
  assert.equal(versionNote(on('v0.3'), '0.3.0'), null, 'a missing patch reads as 0')
})

test('version: a newer bridge means the extension is older, with the reload line', () => {
  const n = versionNote(on('0.4.0'), '0.3.0')
  assert.equal(n.older, 'extension')
  assert.equal(n.line, 'Extension is older than the plugin. Run /pinpoint:setup, then press Reload on the Pinpoint card in chrome://extensions.')
  assert.equal(versionNote(on('0.3.10'), '0.3.9').older, 'extension', 'compared as numbers, not text')
})

test('version: an older bridge means the plugin is older, with the update line', () => {
  const n = versionNote(on('0.2.9'), '0.3.0')
  assert.equal(n.older, 'plugin')
  assert.equal(n.line, 'Plugin is older than the extension. Run claude plugin update pinpoint@pinpoint-marketplace, then restart Claude Code.')
})

test('version: a bridge with no version, or one that does not parse, counts as plugin older', () => {
  assert.equal(versionNote(on(undefined), '0.3.0').older, 'plugin')
  assert.equal(versionNote({ connected: true, ok: true, projectDir: MYAPP }, '0.3.0').older, 'plugin')
  assert.equal(versionNote(on('stub'), '0.3.0').older, 'plugin')
})

test('version: no check while Offline', () => {
  assert.equal(versionNote({ connected: false }, '0.3.0'), null)
  assert.equal(versionNote(null, '0.3.0'), null)
})

// ---------------------------------------------------------------- welcome page and tip

test('welcome: not connected gives the setup line and no version check', () => {
  assert.deepEqual(bridgeSummary({ connected: false }, '0.3.0'),
    { connected: false, title: 'Not connected', line: 'Run /pinpoint:setup in Claude Code.', version: null })
})

test('welcome: connected names the running projects, and carries the version line', () => {
  const one = bridgeSummary(on('0.3.0'), '0.3.0')
  assert.equal(one.connected, true)
  assert.equal(one.title, 'Connected: myapp')
  assert.equal(one.version, null)
  const two = bridgeSummary({ connected: true, version: '0.4.0', sessions: [s(MYAPP), s(PINPOINT)] }, '0.3.0')
  assert.equal(two.title, 'Connected: myapp, pinpoint')
  assert.equal(two.version.older, 'extension')
})

test('tip: second line is the setup line only while Offline', () => {
  assert.equal(tipLine(view({ connected: false }, null, '5173')), 'Run /pinpoint:setup in Claude Code to connect.')
  assert.equal(tipLine(view(on('0.3.0'), null, '5173')), 'The pill shows where comments go.')
})

test('version: the extension copy of compareVersions agrees with server/version.js', () => {
  // Two copies because the extension cannot import server code; this keeps them one rule.
  const fixtures = ['0.3.0', '0.3', '0.3.1', '0.3.10', '0.4.0', '1.0.0', 'v0.3.0', ' 0.3.0 ', '0.3.0-beta',
    '0.3.0.7', '10', '', 'stub', undefined, null, 'v', '00.03.00']
  for (const a of fixtures) {
    for (const b of fixtures) {
      assert.equal(Math.sign(compareVersions(a, b)), Math.sign(serverCompare(a, b)), `${a} vs ${b}`)
    }
  }
})
