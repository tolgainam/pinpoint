/**
 * A free port for a test bridge. A fixed port means two runs at once, or one run and a
 * leftover process, collide with EADDRINUSE; asking the OS for port 0 and reading back
 * what it gave avoids that.
 */
import { createServer } from 'node:net'

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
