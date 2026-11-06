/**
 * The hand-written MCP layer, on in-memory streams. The bridge tests drive the real server
 * with the official SDK client; these cover the edges that client never sends.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { McpServer, PROTOCOL_VERSIONS } from '../plugin/server/mcp.mjs'
import { tokenFrom } from '../plugin/server/config.mjs'

function wire() {
  const input = new PassThrough()
  const output = new PassThrough()
  const mcp = new McpServer({ name: 'p', version: '1' }, { capabilities: { tools: {} }, instructions: 'hello' })
  mcp.connect(input, output)
  let text = ''
  output.setEncoding('utf8')
  output.on('data', d => { text += d })
  const next = async () => {
    for (let i = 0; i < 100 && !text.includes('\n'); i++) await new Promise(r => setTimeout(r, 2))
    const end = text.indexOf('\n')
    if (end === -1) return null
    const line = text.slice(0, end)
    text = text.slice(end + 1)
    return JSON.parse(line)
  }
  const ask = (msg) => { input.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); return next() }
  return { input, mcp, next, ask }
}

test('initialize keeps a version it supports and offers the newest otherwise', async () => {
  const { ask } = wire()
  const old = await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(old.result.protocolVersion, '2025-06-18')
  assert.deepEqual(old.result.serverInfo, { name: 'p', version: '1' })
  assert.equal(old.result.instructions, 'hello')
  const odd = await ask({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(odd.result.protocolVersion, PROTOCOL_VERSIONS[0])
})

test('ping answers, an unknown method is refused, and a handler error is an error reply', async () => {
  const { ask, mcp } = wire()
  assert.deepEqual((await ask({ id: 'a', method: 'ping' })).result, {})
  assert.equal((await ask({ id: 2, method: 'resources/list' })).error.code, -32601)
  mcp.onRequest('tools/call', async () => { throw new Error('unknown tool: x') })
  const bad = await ask({ id: 3, method: 'tools/call', params: {} })
  assert.equal(bad.id, 3)
  assert.equal(bad.error.message, 'unknown tool: x')
})

test('notifications, stray replies and garbage get no answer and do not stop the server', async () => {
  const { input, ask, next } = wire()
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  input.write('{"jsonrpc":"2.0","id":9,"result":{}}\n')
  input.write('not json\n\n')
  assert.equal((await ask({ id: 1, method: 'ping' })).id, 1)
  assert.equal(await next(), null)
})

test('a message split across chunks, even inside a character, arrives whole', async () => {
  const { input, mcp, next } = wire()
  mcp.onRequest('echo', req => ({ said: req.params.text }))
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: 'é❓' } })}\r\n`)
  const cut = bytes.indexOf(0xc3) + 1
  input.write(bytes.subarray(0, cut))
  await new Promise(r => setTimeout(r, 5))
  input.write(bytes.subarray(cut))
  assert.equal((await next()).result.said, 'é❓')
})

test('a notification goes out as one line with no id', async () => {
  const { mcp, next } = wire()
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: 'x' } })
  assert.deepEqual(await next(), { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'x' } })
})

test('an unset or unexpanded token option means no token', () => {
  assert.equal(tokenFrom(undefined), undefined)
  assert.equal(tokenFrom(''), undefined)
  assert.equal(tokenFrom('   '), undefined)
  assert.equal(tokenFrom('${user_config.token}'), undefined)
  assert.equal(tokenFrom(' secret '), 'secret')
})
