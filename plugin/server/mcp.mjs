/**
 * The part of MCP this server needs: JSON-RPC 2.0 over stdio, one message per line.
 *
 * Pinpoint answers initialize, ping, tools/list and tools/call, and sends one notification.
 * That is small enough to write by hand, and doing so means the plugin has no dependencies,
 * so Claude Code installs nothing and every line a user runs is in this repository. The
 * tests drive it with the official SDK client, so a difference from the protocol fails them.
 */

/** Newest first. A client that asks for anything else gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']

const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

export class McpServer {
  /**
   * @param {{name: string, version: string}} info
   * @param {{capabilities: object, instructions?: string}} options
   */
  constructor(info, { capabilities, instructions }) {
    this.output = null
    /** @type {Map<string, (req: {method: string, params: any}) => Promise<object> | object>} */
    this.handlers = new Map([
      ['initialize', req => ({
        protocolVersion: PROTOCOL_VERSIONS.includes(req.params?.protocolVersion) ? req.params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities,
        serverInfo: info,
        ...(instructions ? { instructions } : {}),
      })],
      ['ping', () => ({})],
    ])
  }

  /** @param {string} method @param {(req: {method: string, params: any}) => Promise<object> | object} handler */
  onRequest(method, handler) {
    this.handlers.set(method, handler)
  }

  /**
   * Start reading. Closing the input is the caller's to handle: this server shuts down for
   * more reasons than that one.
   * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
   */
  connect(input, output) {
    this.output = output
    // A client that is gone makes the next write fail. That write reports it; the stream's
    // own error event would otherwise end the process first.
    output.on('error', err => console.error('[pinpoint] stdout:', err?.message ?? err))
    input.setEncoding('utf8')
    let buffer = ''
    input.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line) this.receive(line)
      }
    })
  }

  /** @param {string} line */
  receive(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      console.error('[pinpoint] ignored a message that is not JSON:', err?.message ?? err)
      return
    }
    // Notifications have no id and need no answer, and nothing here sends requests, so a
    // message with an id but no method is not one this server is waiting for.
    if (typeof msg?.method !== 'string' || msg.id === undefined) return
    this.answer(msg).catch(err => console.error('[pinpoint] could not answer:', err?.message ?? err))
  }

  /** @param {{id: string | number, method: string, params?: any}} msg */
  async answer({ id, method, params }) {
    const handler = this.handlers.get(method)
    if (!handler) return this.send({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } })
    try {
      return await this.send({ jsonrpc: '2.0', id, result: await handler({ method, params }) })
    } catch (err) {
      return this.send({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: String(err?.message ?? err) } })
    }
  }

  /** @param {{method: string, params?: object}} message */
  notification({ method, params }) {
    return this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  /** @param {object} message @returns {Promise<void>} Settles when the message is written. */
  send(message) {
    return new Promise((done, fail) => {
      if (!this.output) return fail(new Error('not connected'))
      this.output.write(`${JSON.stringify(message)}\n`, err => (err ? fail(err) : done()))
    })
  }
}
