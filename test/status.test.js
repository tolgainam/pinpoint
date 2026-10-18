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

const { view, portOf, displayNames } = globalThis.PinpointStatus

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
  assert.equal(v.projectPick, WEBSHOP)
  assert.equal(v.heading, 'No Claude Code in webshop')
  assert.equal(v.rows[0].name, 'Auto: none for webshop')
})

test('strict: one other session running is still "no session for this project"', () => {
  const v = view(health([MYAPP], { how: 'only', projectDir: MYAPP, detected: WEBSHOP }), null, '5173')
  assert.equal(v.state, 'none')
  assert.equal(v.label, 'webshop')
  assert.equal(v.canDispatch, false)
  // Park is steered to the detected project rather than following the one session.
  assert.equal(v.projectPick, WEBSHOP)
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
  assert.equal(v.label, 'Connecting')
  assert.equal(v.dot, false)
  assert.equal(v.canDispatch, false)
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
