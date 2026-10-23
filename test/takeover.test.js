/**
 * Several sessions, one port. Every Claude Code session with the plugin starts its own
 * server, and only one can hold the port; when that one exits, another has to pick the
 * bridge up or the extension goes dark with servers still running.
 *
 * A plain process rather than an MCP client: the port and the exit are what is under
 * test, and closing stdin by hand is exactly what a session ending looks like.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from './port.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = await freePort()

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    return res.headers.get('content-type')?.includes('json') ? await res.json() : null
  } catch {
    return null
  }
}

async function until(predicate, what, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = await predicate()
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('a server that lost the port takes it over once it frees up, and exits with its session', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'pinpoint-project-'))
  const queueDir = mkdtempSync(join(tmpdir(), 'pinpoint-queue-'))

  // Stands in for the session that got there first.
  const owner = createServer((req, res) => res.end('someone else'))
  await new Promise(r => owner.listen(PORT, '127.0.0.1', r))

  let log = ''
  const child = spawn(process.execPath, [join(ROOT, 'server', 'pinpoint.js')], {
    env: {
      ...process.env,
      PINPOINT_PORT: String(PORT),
      PINPOINT_QUEUE: queueDir,
      PINPOINT_PROJECT_DIR: projectDir,
      PINPOINT_RETRY_MS: '100',
      // A tools-only server opens a peer link, which needs a key; keep it out of ~.
      PINPOINT_PEER_KEY: join(queueDir, 'peer.key'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', d => { log += d })
  const exited = new Promise(r => child.on('exit', code => r(code)))

  try {
    await until(() => log.includes('tools-only'), 'the tools-only notice')
    // A few retries' worth, so the quiet-log claim is actually exercised.
    await new Promise(r => setTimeout(r, 400))
    assert.equal(await health(), null, 'the owner should still be the one answering')

    await new Promise(r => owner.close(r))
    const h = await until(health, 'the takeover')
    assert.equal(h.projectDir, projectDir)
    assert.match(log, /took over the bridge/)
    assert.equal(log.match(/tools-only/g).length, 1, 'the retry should not log on every attempt')

    // The session ends: stdin closes, and the port has to come back with it.
    child.stdin.end()
    assert.equal(await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 3000))]), 0)
    assert.equal(await health(), null, 'the port should be free once the server exits')
  } finally {
    child.kill()
    owner.close()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(queueDir, { recursive: true, force: true })
  }
})
