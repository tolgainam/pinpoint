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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8813
const BRIDGE = `http://127.0.0.1:${PORT}`

let base, queueDir, ownerDir, peerDir, otherDir, keyFile, homeDir, repoDir, mapFile
let owner, peer
/** Channel notifications each session received, by batch id. */
const heard = { owner: [], peer: [], nested: [] }
/** What the lsof stub answers: port to cwd, or to {pid, cwd} when the pid matters. */
let lsofMap
const setLsof = map => { lsofMap = map; writeFileSync(mapFile, JSON.stringify(map)) }
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
      PINPOINT_ACK_MS: '500',
      PINPOINT_DETECT_RECHECK_MS: '0',
      PINPOINT_LSOF: join(base, 'lsof-stub.js'),
      STUB_LSOF_FILE: mapFile,
      // A home of its own, so a test that fails cannot write a backlog into the real one.
      HOME: homeDir,
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
  homeDir = join(base, 'home')
  repoDir = join(base, 'repo')
  mapFile = join(base, 'lsof-map.json')
  for (const d of [queueDir, ownerDir, join(peerDir, 'web'), otherDir, homeDir, join(repoDir, '.git'), join(repoDir, 'packages', 'app')]) {
    mkdirSync(d, { recursive: true })
  }
  setLsof({ 5173: join(peerDir, 'web'), 5174: otherDir })

  // Answers the two lsof calls the bridge makes: the listener on a port and that pid's
  // cwd. A plain entry uses the port as its pid; {pid, cwd} lets a test swap the process.
  // Read from a file on every call, so a test can change what is listening.
  const stub = join(base, 'lsof-stub.js')
  writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs')
const map = JSON.parse(fs.readFileSync(process.env.STUB_LSOF_FILE, 'utf8'))
const all = Object.entries(map).map(([port, v]) => typeof v === 'string' ? { port, pid: port, cwd: v } : { port, ...v })
const args = process.argv.slice(2)
const port = (args.find(a => a.startsWith('-iTCP:')) || '').slice(6)
if (port) { const hit = all.find(e => e.port === port); if (hit) console.log(String(hit.pid)); else process.exit(1) }
const p = args.indexOf('-p')
const proc = p !== -1 && all.find(e => String(e.pid) === args[p + 1])
if (proc) console.log('p' + proc.pid + '\\nfcwd\\nn' + proc.cwd)
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

  // /health counts the routed project's backlog and batches, not the bridge's own.
  const forPeer = await health(`?pick=${encodeURIComponent(peerDir)}`)
  const forOwner = await health(`?pick=${encodeURIComponent(ownerDir)}`)
  assert.equal(forPeer.backlog, 1)
  assert.equal(forOwner.backlog, 0)
  assert.ok(forPeer.pending >= 2, 'the two batches routed to the peer')
  assert.equal(forOwner.pending, 0)
})

const park = page => fetch(`${BRIDGE}/backlog`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
  body: JSON.stringify({ page, comment: { note: 'parked from a package' } }),
})

test('Park with no session for the page writes to the repo root, never to home', async () => {
  setLsof({ ...lsofMap, 5177: join(repoDir, 'packages', 'app'), 5178: homeDir })

  const inRepo = await park('http://localhost:5177')
  assert.equal(inRepo.status, 200)
  assert.equal((await inRepo.json()).file, join(repoDir, '.pinpoint', 'backlog.md'))
  assert.ok(!existsSync(join(repoDir, 'packages', 'app', '.pinpoint')), 'not into the package folder')

  const inHome = await park('http://localhost:5178')
  assert.equal(inHome.status, 409)
  assert.match(await inHome.text(), /not a project folder/)
  assert.ok(!existsSync(join(homeDir, '.pinpoint')), 'nothing written into home')
})

test('a pick matches its session however the path is spelled', async () => {
  const link = join(base, 'peer-link')
  symlinkSync(peerDir, link)
  for (const pick of [link, `${peerDir}/`]) {
    const h = await health(`?pick=${encodeURIComponent(pick)}`)
    assert.equal(h.route.how, 'manual', pick)
    assert.equal(h.route.projectDir, peerDir, 'answered in the session\'s own spelling')
    assert.equal(h.route.error, undefined)
  }
})

test('detection never caches a miss, and notices a new process on the same port', async () => {
  const at = () => health(`?page=${encodeURIComponent('http://localhost:5179')}`).then(h => h.route.detected)
  assert.equal(await at(), null)
  setLsof({ ...lsofMap, 5179: { pid: 7001, cwd: otherDir } })
  assert.equal(await at(), otherDir, 'the server that just started is seen at once')
  setLsof({ ...lsofMap, 5179: { pid: 7002, cwd: join(peerDir, 'web') } })
  assert.equal(await at(), join(peerDir, 'web'), 'a different pid is a different server')
})

test('a peer that acknowledges its delivers keeps its link', async () => {
  const res = await dispatch({ pick: peerDir })
  const { batch } = await res.json()
  await until(() => heard.peer.includes(batch), 'the delivery')
  await new Promise(r => setTimeout(r, 800))
  assert.equal((await health()).sessions.length, 2)
})

test('a nested session\'s batches are not listed in the session above it', async () => {
  const nestedDir = join(ownerDir, 'nested')
  mkdirSync(nestedDir, { recursive: true })
  const nested = await start('nested', nestedDir)
  try {
    await until(async () => (await health())?.sessions?.length === 3, 'the nested session to join')
    const res = await dispatch({ pick: nestedDir, comments: [{ note: 'nested only' }] })
    const { batch } = await res.json()
    await until(() => heard.nested.includes(batch), 'the nested delivery')

    assert.match(textOf(await nested.callTool({ name: 'list_comments', arguments: {} })), /nested only/)
    assert.doesNotMatch(textOf(await owner.callTool({ name: 'list_comments', arguments: {} })), /nested only/)
  } finally {
    await nested.close()
    await until(async () => (await health())?.sessions?.length === 2, 'the nested session to leave')
  }
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
