/**
 * A newer server asks an older bridge to hand over the port. Sessions keep their server
 * in memory, so after a plugin update the bridge is an old one held by a session opened
 * before it; without the handshake the new code waited for every old session to close.
 *
 * Two real servers from the same file, told apart by PINPOINT_VERSION. Plain processes,
 * like the takeover test: the port and the peer list are what is under test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8814

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    return res.headers.get('content-type')?.includes('json') ? await res.json() : null
  } catch {
    return null
  }
}

async function until(predicate, what, ms = 6000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = await predicate()
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pinpoint-yield-'))
  const procs = []
  const start = (name, version) => {
    const projectDir = mkdtempSync(join(base, `${name}-`))
    const child = spawn(process.execPath, [join(ROOT, 'server', 'pinpoint.js')], {
      env: {
        ...process.env,
        PINPOINT_PORT: String(PORT),
        PINPOINT_QUEUE: join(base, 'queue'),
        PINPOINT_PROJECT_DIR: projectDir,
        PINPOINT_PEER_KEY: join(base, 'peer.key'),
        PINPOINT_RETRY_MS: '150',
        PINPOINT_VERSION: version,
        HOME: base,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const p = { child, projectDir, log: '' }
    child.stderr.on('data', d => { p.log += d })
    procs.push(p)
    return p
  }
  const done = () => {
    for (const p of procs) p.child.kill()
    rmSync(base, { recursive: true, force: true })
  }
  return { start, done, base }
}

test('an older bridge hands the port to a newer server and stays on as a peer', async () => {
  const { start, done } = setup()
  try {
    const old = start('old', '0.2.9')
    await until(async () => (await health())?.version === '0.2.9', 'the old bridge')

    const fresh = start('new', '0.3.0')
    const h = await until(async () => { const x = await health(); return x?.version === '0.3.0' && x }, 'the handover')
    assert.equal(h.projectDir, fresh.projectDir)
    assert.match(old.log, /handing the bridge to a newer version \(0\.3\.0\)/)

    // The old session is not gone: it reconnects as a peer and is listed again.
    const both = await until(async () => {
      const x = await health()
      return x?.sessions?.length === 2 && x
    }, 'the old server to rejoin as a peer')
    assert.deepEqual(both.sessions.map(s => s.projectDir).sort(), [old.projectDir, fresh.projectDir].sort())
    assert.equal(old.child.exitCode, null, 'yielding must not end the old session')

    // And it does not take the port back while the newer one holds it.
    await new Promise(r => setTimeout(r, 600))
    assert.equal((await health()).version, '0.3.0')
  } finally {
    done()
  }
})

test('a newer bridge keeps the port when an older server starts', async () => {
  const { start, done } = setup()
  try {
    const owner = start('new', '0.3.0')
    await until(async () => (await health())?.version === '0.3.0', 'the bridge')
    const late = start('old', '0.2.9')
    await until(async () => (await health())?.sessions?.length === 2, 'the old server to join as a peer')
    await new Promise(r => setTimeout(r, 400))
    const h = await health()
    assert.equal(h.version, '0.3.0')
    assert.equal(h.projectDir, owner.projectDir)
    assert.doesNotMatch(owner.log, /handing the bridge/)
    assert.doesNotMatch(late.log, /took over/)
  } finally {
    done()
  }
})

test('/peer/yield needs the peer key and a newer version', async () => {
  const { start, done, base } = setup()
  try {
    start('owner', '0.3.0')
    await until(async () => (await health())?.version === '0.3.0', 'the bridge')
    const post = (headers, body) => fetch(`http://127.0.0.1:${PORT}/peer/yield`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    assert.equal((await post({}, { version: '9.0.0' })).status, 401)
    assert.equal((await post({ 'X-Pinpoint-Peer': 'nope' }, { version: '9.0.0' })).status, 401)
    // With the key, but the same version: no handover, or two equal servers would loop.
    const key = readFileSync(join(base, 'peer.key'), 'utf8').trim()
    assert.equal((await post({ 'X-Pinpoint-Peer': key }, { version: '0.3.0' })).status, 409)
    assert.equal((await health()).version, '0.3.0', 'a refused yield leaves the bridge where it was')
  } finally {
    done()
  }
})
