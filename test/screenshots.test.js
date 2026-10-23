/**
 * Screenshots on their way to disk: written off the event loop, all of a batch or none of
 * it, and refused before they are decoded when they are too big.
 *
 * Two bridges. The first is an ordinary one. The second runs with a umask that leaves
 * every directory it makes unwritable, so the batch directory is created and the first
 * PNG inside it fails: the write path breaks halfway, which is the case that matters.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { freePort } from './port.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server', 'pinpoint.js')
/** The smallest real PNG, so the write path is exercised without carrying an image around. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const MiB = 1024 * 1024
/** A data URL of this many decoded bytes. The bridge checks the prefix, not the pixels. */
const big = bytes => `data:image/png;base64,${randomBytes(bytes).toString('base64')}`

const bridges = {}

async function start(name, { umask } = {}) {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), `pinpoint-shots-${name}-`))
  const b = {
    url: `http://127.0.0.1:${port}`, dir,
    projectDir: join(dir, 'project'), queueDir: join(dir, 'queue'), heard: [],
  }
  mkdirSync(b.projectDir, { recursive: true })
  mkdirSync(b.queueDir, { recursive: true })

  b.client = new Client({ name: `test-${name}`, version: '0' }, { capabilities: {} })
  b.client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') b.heard.push(n.params.meta.batch_id)
  }
  const args = umask === undefined
    ? [SERVER]
    : ['--input-type=module', '-e', `process.umask(${umask}); await import(${JSON.stringify(pathToFileURL(SERVER).href)})`]
  await b.client.connect(new StdioClientTransport({
    command: process.execPath,
    args,
    env: {
      ...process.env,
      PINPOINT_PORT: String(port),
      PINPOINT_QUEUE: b.queueDir,
      PINPOINT_PROJECT_DIR: b.projectDir,
      PINPOINT_PEER_KEY: join(dir, 'peer.key'),
      PINPOINT_LSOF: '/usr/bin/false',
      HOME: dir,
    },
    stderr: 'ignore',
  }))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${b.url}/health`)).ok) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  bridges[name] = b
  return b
}

const dispatch = (b, body) => fetch(`${b.url}/dispatch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
  // Encoded up front, so a big body costs the test process nothing while it is timed.
  body: Buffer.from(JSON.stringify({ origin: 'http://localhost:3000', url: 'http://localhost:3000/', ...body })),
})

const history = b => {
  const file = join(b.projectDir, '.pinpoint', 'history.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

before(async () => {
  await start('main')
  // 0o277 leaves new directories at 0500: mkdir succeeds, a file inside it does not.
  await start('broken', { umask: 0o277 })
})

after(async () => {
  for (const b of Object.values(bridges)) {
    try { await b.client.close() } catch { /* already gone */ }
    rmSync(b.dir, { recursive: true, force: true })
  }
})

test('every PNG and batch.json are on disk when the dispatch answers, and the history line with them', async () => {
  const b = bridges.main
  const res = await dispatch(b, {
    pageShot: PNG,
    comments: [1, 2, 3].map(n => ({ note: `crop ${n}`, rect: { x: 0, y: 0, w: 10, h: 10 }, shot: PNG })),
  })
  assert.equal(res.status, 200)
  const out = await res.json()
  const dir = join(b.queueDir, out.batch)
  for (const name of ['shot-01.png', 'shot-02.png', 'shot-03.png', 'page.png']) {
    assert.deepEqual(readFileSync(join(dir, name)), Buffer.from(PNG.split(',')[1], 'base64'), name)
  }
  const batch = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'))
  assert.equal(batch.pageShot, 'page.png')
  assert.deepEqual(batch.comments.map(c => c.shot), ['shot-01.png', 'shot-02.png', 'shot-03.png'])
  // Nothing staged is left beside it.
  assert.deepEqual(readdirSync(dir).filter(n => n.includes('.tmp-')), [])
  assert.match(history(b), new RegExp(out.batch))
  assert.ok(b.heard.includes(out.batch))
})

test('an image past the cap is refused before anything is written', async () => {
  const b = bridges.main
  const before = readdirSync(b.queueDir)
  const log = history(b)
  const res = await dispatch(b, {
    comments: [{ note: 'huge', shot: `data:image/png;base64,${'A'.repeat(Math.ceil(12 * MiB * 4 / 3) + 8)}` }],
  })
  assert.equal(res.status, 413)
  assert.match(await res.text(), /larger than 12 MiB/)
  assert.deepEqual(readdirSync(b.queueDir), before)
  assert.equal(history(b), log)
})

test('a screenshot that is not base64 is refused the same way', async () => {
  const b = bridges.main
  const before = readdirSync(b.queueDir)
  const res = await dispatch(b, { comments: [{ note: 'bad', shot: 'data:image/png;base64,not*base64!' }] })
  assert.equal(res.status, 400)
  assert.deepEqual(readdirSync(b.queueDir), before)
})

test('a write that fails halfway leaves no batch, no history line and no notification', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async () => {
  const b = bridges.broken
  const before = readdirSync(b.queueDir)
  const res = await dispatch(b, {
    pageShot: PNG,
    comments: [{ note: 'one', shot: PNG }, { note: 'two', shot: PNG }],
  })
  assert.equal(res.status, 503)
  assert.match(await res.text(), /screenshots could not be written, try again/)
  assert.deepEqual(readdirSync(b.queueDir), before)
  assert.equal(history(b), '')
  // A notification would have gone out before the reply, so none is coming.
  assert.deepEqual(b.heard, [])
})

test('the bridge answers /health promptly while it writes a large batch', async t => {
  const b = bridges.main
  // About 33 MiB of images, 44 MiB on the wire: under every cap, near the body limit.
  const body = {
    pageShot: big(11 * MiB),
    comments: [{ note: 'large one', shot: big(11 * MiB) }, { note: 'large two', shot: big(11 * MiB) }],
  }
  for (let round = 0; round < 3; round++) {
    let done = false
    const sent = dispatch(b, body).then(r => { done = true; return r })
    let worst = 0
    let waves = 0
    // Waves of 20 at once until the dispatch has answered, and always at least one.
    while (!done || waves === 0) {
      const times = await Promise.all(Array.from({ length: 20 }, async () => {
        const t = performance.now()
        const r = await fetch(`${b.url}/health`)
        await r.arrayBuffer()
        assert.equal(r.status, 200)
        return performance.now() - t
      }))
      worst = Math.max(worst, ...times)
      waves++
    }
    const res = await sent
    assert.equal(res.status, 200)
    await res.arrayBuffer()
    t.diagnostic(`round ${round + 1}: ${waves} waves, slowest /health ${Math.round(worst)} ms`)
    assert.ok(worst < 500, `slowest /health took ${Math.round(worst)} ms in round ${round + 1}`)
  }
})

test('no screenshot is written with a synchronous call any more', () => {
  const src = readFileSync(SERVER, 'utf8')
  // A sync write of decoded base64, on one line or split across a few.
  assert.doesNotMatch(src, /writeFileSync\([^;]*?Buffer\.from\([^;]*?'base64'\)/)
  assert.doesNotMatch(src, /writeFileSync\([^;]*?decodePng\(/)
})
