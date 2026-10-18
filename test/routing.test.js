/**
 * Several sessions, one bridge, and comments that land in the right one. The owner of
 * the port is one session; every other server is a peer on a link to it, and a page's
 * comments go to the session for that page's project, not to whoever holds the port.
 *
 * Two real servers over MCP, because the thing under test is which process's stdio the
 * channel notification comes out of. lsof is stubbed with a script that maps ports to
 * directories, so detection is exercised without depending on real dev servers.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8813
const BRIDGE = `http://127.0.0.1:${PORT}`

let base, queueDir, ownerDir, peerDir, otherDir, keyFile
let owner, peer
/** Channel notifications each session received, by batch id. */
const heard = { owner: [], peer: [] }
const events = []
let stream

async function start(name, projectDir) {
  const client = new Client({ name: `test-${name}`, version: '0' })
  client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') heard[name].push(n.params.meta.batch_id)
  }
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'server', 'pinpoint.js')],
    env: {
      ...process.env,
      PINPOINT_PORT: String(PORT),
      PINPOINT_QUEUE: queueDir,
      PINPOINT_PROJECT_DIR: projectDir,
      PINPOINT_PEER_KEY: keyFile,
      PINPOINT_RETRY_MS: '100',
      PINPOINT_RECAPTURE_MS: '400',
      PINPOINT_LSOF: join(base, 'lsof-stub.js'),
      STUB_LSOF_MAP: JSON.stringify({ 5173: join(peerDir, 'web'), 5174: otherDir }),
    },
    stderr: 'ignore',
  }))
  return client
}

const health = (qs = '') => fetch(`${BRIDGE}/health${qs}`).then(r => r.json()).catch(() => null)

const dispatch = body => fetch(`${BRIDGE}/dispatch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
  body: JSON.stringify({ comments: [{ note: 'make it blue', rect: { x: 0, y: 0, w: 10, h: 10 } }], ...body }),
})

const textOf = res => res.content.map(c => c.text).join('\n')

async function until(predicate, what, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = await predicate()
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'pinpoint-routing-'))
  queueDir = join(base, 'queue')
  ownerDir = join(base, 'owner')
  peerDir = join(base, 'peer')
  otherDir = join(base, 'other')
  keyFile = join(base, 'key', 'peer.key')
  for (const d of [queueDir, ownerDir, join(peerDir, 'web'), otherDir]) mkdirSync(d, { recursive: true })

  // Answers the two lsof calls the bridge makes: the listener on a port (the pid is the
  // port itself, to keep the stub stateless) and that pid's cwd.
  const stub = join(base, 'lsof-stub.js')
  writeFileSync(stub, `#!${process.execPath}
const map = JSON.parse(process.env.STUB_LSOF_MAP || '{}')
const args = process.argv.slice(2)
const port = (args.find(a => a.startsWith('-iTCP:')) || '').slice(6)
if (port) { if (map[port]) console.log(port); else process.exit(1) }
const p = args.indexOf('-p')
if (p !== -1 && map[args[p + 1]]) console.log('p' + args[p + 1] + '\\nfcwd\\nn' + map[args[p + 1]])
`)
  chmodSync(stub, 0o755)

  owner = await start('owner', ownerDir)
  await until(async () => (await health())?.ok, 'the owner to take the port')
  peer = await start('peer', peerDir)

  const res = await fetch(`${BRIDGE}/events?since=0`)
  stream = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await stream.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '))
          buf = buf.slice(i + 2)
          if (line) events.push(JSON.parse(line.slice(6)))
        }
      }
    } catch { /* closed with the server */ }
  })()
})

after(async () => {
  await stream?.cancel().catch(() => {})
  await peer?.close().catch(() => {})
  await owner?.close().catch(() => {})
  rmSync(base, { recursive: true, force: true })
})

test('a peer registers with the bridge over its link', async () => {
  const h = await until(async () => {
    const got = await health()
    return got?.sessions?.length === 2 && got
  }, 'the peer to appear in /health sessions')
  assert.deepEqual(h.sessions.map(s => s.projectDir).sort(), [ownerDir, peerDir].sort())
  assert.equal(h.sessions.find(s => s.projectDir === peerDir).name, 'peer')
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'the peer key should be private to the user')
})

test('/peer refuses a browser and a missing key', async () => {
  const noKey = await fetch(`${BRIDGE}/peer?projectDir=${encodeURIComponent(otherDir)}`)
  assert.equal(noKey.status, 401)
  const key = readFileSync(keyFile, 'utf8').trim()
  const browser = await fetch(`${BRIDGE}/peer/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pinpoint-Peer': key, Origin: 'http://localhost:3000' },
    body: JSON.stringify({ type: 'reply', text: 'spoofed' }),
  })
  assert.equal(browser.status, 403)
})

test('a manual pick delivers to that session, not the port owner', async () => {
  const res = await dispatch({ pick: peerDir })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.projectDir, peerDir)

  await until(() => heard.peer.includes(body.batch), 'the peer to receive the channel notification')
  assert.ok(!heard.owner.includes(body.batch), 'the owner must not be notified for the peer\'s batch')
  const batch = JSON.parse(readFileSync(join(queueDir, body.batch, 'batch.json'), 'utf8'))
  assert.equal(batch.projectDir, peerDir)
  assert.ok(existsSync(join(peerDir, '.pinpoint', 'history.md')), 'history belongs to the target project')
  assert.ok(!existsSync(join(ownerDir, '.pinpoint', 'history.md')))
})

test('auto routing follows the dev server cwd to the session above it', async () => {
  const h = await health(`?page=${encodeURIComponent('http://localhost:5173')}`)
  assert.equal(h.route.how, 'auto')
  assert.equal(h.route.projectDir, peerDir)
  assert.equal(h.route.detected, join(peerDir, 'web'))

  const res = await dispatch({ page: 'http://localhost:5173' })
  const body = await res.json()
  assert.equal(body.projectDir, peerDir)
  await until(() => heard.peer.includes(body.batch), 'the auto-routed delivery')
})

test('no session for the page, or a pick that is not live, is refused and nothing is queued', async () => {
  const h = await health(`?page=${encodeURIComponent('http://localhost:5174')}`)
  assert.equal(h.route.how, 'none')
  assert.equal(h.route.detected, otherDir)

  const none = await dispatch({ page: 'http://localhost:5174' })
  assert.equal(none.status, 409)
  assert.match(await none.text(), /No Claude Code session is running for other/)

  const gone = await dispatch({ pick: otherDir })
  assert.equal(gone.status, 409)
  assert.equal((await health(`?pick=${encodeURIComponent(otherDir)}`)).route.how, 'manual')
})

test('Park writes the target project\'s backlog', async () => {
  const res = await fetch(`${BRIDGE}/backlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: JSON.stringify({ pick: peerDir, comment: { note: 'later please' } }),
  })
  const body = await res.json()
  assert.equal(body.file, join(peerDir, '.pinpoint', 'backlog.md'))
  assert.match(readFileSync(body.file, 'utf8'), /later please/)
})

test('list_comments shows only this session\'s project, plus batches from before routing', async () => {
  const legacy = '20000101-000000-old1'
  mkdirSync(join(queueDir, legacy), { recursive: true })
  writeFileSync(join(queueDir, legacy, 'batch.json'), JSON.stringify({
    id: legacy, receivedAt: new Date().toISOString(), origin: 'http://localhost:1',
    comments: [{ n: 1, note: 'legacy note', status: 'pending' }],
  }))

  const mine = textOf(await peer.callTool({ name: 'list_comments', arguments: {} }))
  assert.match(mine, /make it blue/)
  assert.match(mine, /legacy note/)

  const theirs = textOf(await owner.callTool({ name: 'list_comments', arguments: {} }))
  assert.doesNotMatch(theirs, /make it blue/)
  assert.match(theirs, /legacy note/)
})

test('a peer\'s resolve reaches the extension stream through the bridge', async () => {
  const id = `${heard.peer[0]}#1`
  const res = await peer.callTool({ name: 'resolve_comment', arguments: { id, resolution: 'blue now' } })
  // Nobody answers the recapture in this test, but it must be the bridge being asked
  // rather than the peer's own empty listener set.
  assert.match(textOf(res), /did not answer in time|unverified/)
  const ev = await until(() => events.find(e => e.type === 'resolved' && e.id === id), 'the resolved event')
  assert.equal(ev.projectDir, peerDir)
  assert.ok(events.some(e => e.type === 'recapture' && e.id === id), 'the bridge should have asked the page for a crop')
})

test('a peer that exits leaves the session list', async () => {
  await peer.close()
  peer = null
  await until(async () => (await health())?.sessions?.length === 1, 'the peer to drop out of /health')
  const h = await health()
  assert.equal(h.sessions[0].projectDir, ownerDir)
  assert.equal(h.route.how, 'only')
})
