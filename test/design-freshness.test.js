/**
 * The design-system cache against a real bridge: a project's scale is served from what
 * the bridge already knows, and an edit to its config reaches the next pick without a
 * restart and without anyone waiting for a probe.
 *
 * Three bridges, because the three clocks have to be told apart: one that stats on every
 * request, one whose stat throttle never runs out (so only report_progress can refresh
 * it), and one with a short TTL (so only a full re-probe can find a new file).
 *
 * Probes are counted through PINPOINT_DS_PROBE_LOG, one line per probe, and made to fail
 * through PINPOINT_DS_FAIL_IF. Both are test seams that do nothing unless set.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { freePort } from './port.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A tailwind config whose one colour is `brand`, with its mtime moved on so no edit is missed. */
let bump = 0
function writeConfig(dir, colour) {
  const file = join(dir, 'tailwind.config.js')
  writeFileSync(file, `module.exports = { theme: { colors: { brand: '${colour}' }, spacing: { 4: '16px', 6: '24px', 8: '32px' } } }\n`)
  const at = new Date(Date.now() + ++bump * 1000)
  utimesSync(file, at, at)
}

async function startBridge(env) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const dir = mkdtempSync(join(tmpdir(), 'pinpoint-ds-project-'))
  const queue = mkdtempSync(join(tmpdir(), 'pinpoint-ds-queue-'))
  const scratch = mkdtempSync(join(tmpdir(), 'pinpoint-ds-scratch-'))
  const log = join(scratch, 'probes.log')
  const failIf = join(scratch, 'fail')
  writeConfig(dir, '#111111')

  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'server', 'pinpoint.js')],
    env: {
      ...process.env,
      PINPOINT_PORT: String(port),
      PINPOINT_QUEUE: queue,
      PINPOINT_PROJECT_DIR: dir,
      PINPOINT_LSOF: '/usr/bin/false',
      PINPOINT_DS_PROBE_LOG: log,
      PINPOINT_DS_FAIL_IF: failIf,
      ...env,
    },
  }))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }

  const post = (path, body) => fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  }).then(r => r.json())

  return {
    dir,
    post,
    failIf,
    call: (name, args) => client.callTool({ name, arguments: args }),
    /** The brand colour the bridge offers right now, and the whole answer. */
    ask: async (extra = {}) => {
      const out = await post('/design-system', { designSystem: { vars: {}, fingerprints: [] }, ...extra })
      return { brand: out.color?.find(t => t.name === 'brand')?.hex ?? null, out }
    },
    probes: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
    close: async () => {
      try { await client.close() } catch { /* already gone */ }
      for (const d of [dir, queue, scratch]) rmSync(d, { recursive: true, force: true })
    },
  }
}

/** Ask until the answer says what we are waiting for; the refresh runs after the reply. */
async function until(bridge, predicate, what, ms = 4000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await bridge.ask()
    if (predicate(last)) return last
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify({ brand: last?.brand, stale: last?.out?.stale })}`)
}

let eager, throttled, short

before(async () => {
  ;[eager, throttled, short] = await Promise.all([
    startBridge({ PINPOINT_DS_CHECK_MS: '0', PINPOINT_DS_TTL_MS: '600000' }),
    startBridge({ PINPOINT_DS_CHECK_MS: '600000', PINPOINT_DS_TTL_MS: '600000' }),
    startBridge({ PINPOINT_DS_CHECK_MS: '600000', PINPOINT_DS_TTL_MS: '300' }),
  ])
})

after(async () => {
  await Promise.all([eager, throttled, short].map(b => b?.close()))
})

// ---------------------------------------------------------------- stat-driven refresh

test('an edited config is served old once, without waiting, and new soon after', async () => {
  assert.equal((await eager.ask()).brand, '#111111')
  assert.equal((await eager.ask()).out.stale, false)
  writeConfig(eager.dir, '#222222')
  // The answer that noticed the change is the one that does not wait for it.
  assert.equal((await eager.ask()).brand, '#111111')
  await until(eager, a => a.brand === '#222222', 'the new brand colour')
})

test('many requests during one change cause exactly one re-probe', async () => {
  const before = eager.probes()
  writeConfig(eager.dir, '#333333')
  await Promise.all(Array.from({ length: 20 }, () => eager.ask()))
  await until(eager, a => a.brand === '#333333', 'the new brand colour')
  for (let i = 0; i < 5; i++) await eager.ask()
  assert.equal(eager.probes() - before, 1)
})

test('a refresh that throws keeps the last summary and says it is stale', async () => {
  writeFileSync(eager.failIf, '')
  try {
    writeConfig(eager.dir, '#555555')
    const stale = await until(eager, a => a.out.stale === true, 'stale: true')
    assert.equal(stale.brand, '#333333')
    assert.equal(stale.out.ok, true)
  } finally {
    rmSync(eager.failIf, { force: true })
  }
  const fresh = await until(eager, a => a.out.stale === false, 'stale cleared')
  assert.equal(fresh.brand, '#555555')
})

test('refresh: true waits for its probe and returns the new scale', async () => {
  assert.equal((await throttled.ask()).brand, '#111111')
  writeConfig(throttled.dir, '#444444')
  // The throttle has not run out, so nothing but the manual refresh can see this edit.
  assert.equal((await throttled.ask()).brand, '#111111')
  const { brand, out } = await throttled.ask({ refresh: true })
  assert.equal(brand, '#444444')
  assert.equal(out.refreshed, true)
  assert.equal(out.stale, false)
  assert.equal((await throttled.ask()).brand, '#444444')
})

test('a manual refresh that fails keeps the old scale and says so', async () => {
  writeConfig(throttled.dir, '#666666')
  writeFileSync(throttled.failIf, '')
  try {
    const { brand, out } = await throttled.ask({ refresh: true })
    assert.equal(brand, '#444444')
    assert.equal(out.refreshed, false)
    assert.equal(out.stale, true)
    assert.match(out.error, /not refreshed/)
  } finally {
    rmSync(throttled.failIf, { force: true })
  }
  const { brand, out } = await throttled.ask({ refresh: true })
  assert.equal(brand, '#666666')
  assert.equal(out.stale, false)
})

test('report_progress naming the config refreshes it at once, past the throttle', async () => {
  writeConfig(throttled.dir, '#777777')
  assert.equal((await throttled.ask()).brand, '#666666')
  await new Promise(r => setTimeout(r, 200))
  assert.equal((await throttled.ask()).brand, '#666666', 'nothing but report_progress should refresh this bridge')

  const res = await throttled.post('/dispatch', {
    origin: 'http://localhost:3000',
    url: 'http://localhost:3000/',
    comments: [{ note: 'use the new brand colour', selector: '.cta', rect: { x: 4, y: 4, w: 80, h: 30 } }],
  })
  assert.equal(res.ok, true)
  const out = await throttled.call('report_progress', { id: `${res.batch}#1`, state: 'edited', files: ['tailwind.config.js +1 -1'] })
  assert.notEqual(out.isError, true)
  await until(throttled, a => a.brand === '#777777', 'the colour report_progress announced')
})

// ---------------------------------------------------------------- TTL discovery

test('a new stylesheet is found by the full re-probe once the TTL has passed', async () => {
  const has = a => a.out.color?.some(t => t.name === '--color-fresh')
  assert.equal(has(await short.ask()), false)
  writeFileSync(join(short.dir, 'theme.css'), ':root { --color-fresh: #abcdef; }\n')
  await new Promise(r => setTimeout(r, 400))
  await until(short, has, 'the new stylesheet\'s token')
})
