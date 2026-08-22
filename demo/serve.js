#!/usr/bin/env node
/**
 * Static server for the demo page, with a live reload so a fix made from a pinned
 * comment shows up in the browser without touching the keyboard.
 *
 *   node demo/serve.js   ->   http://localhost:3000
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DEMO_PORT ?? 3000)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const clients = new Set()

// Debounced: an editor writing a file often produces several events in a row.
let timer
let changed = new Set()
watch(DIR, { recursive: true }, (_event, filename) => {
  if (filename) changed.add(String(filename))
  clearTimeout(timer)
  timer = setTimeout(() => {
    const files = [...changed]
    changed = new Set()
    const chunk = `data: ${JSON.stringify(files)}\n\n`
    for (const emit of clients) {
      try { emit(chunk) } catch { clients.delete(emit) }
    }
  }, 80)
})

/**
 * Injected into every page, so index.html itself stays free of demo plumbing.
 *
 * A stylesheet change re-links the stylesheet rather than reloading the page, and that
 * is not just a nicety here: Chrome revokes an extension's activeTab grant on every
 * navigation, so a full reload after each fix would take Pinpoint's screenshots away
 * again and again. Only a markup change is worth a real reload.
 */
const RELOAD = `
<script>
  new EventSource('/__reload').onmessage = ev => {
    let files = []
    try { files = JSON.parse(ev.data) } catch { location.reload(); return }
    if (!files.every(f => f.endsWith('.css'))) { location.reload(); return }
    for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
      const url = new URL(link.href)
      url.searchParams.set('v', String(Date.now()))
      link.href = url.pathname + url.search
    }
  }
</script>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/__reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const emit = chunk => res.write(chunk)
    emit(': connected\n\n')
    clients.add(emit)
    req.on('close', () => clients.delete(emit))
    return
  }

  // normalize() collapses any ../ before it can escape the demo directory.
  let rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '')
  let path = join(DIR, rel)
  if (!path.startsWith(DIR)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    // A directory means its index.html. The demo pages link to each other by folder,
    // and a folder that 404s would make the switcher a list of broken links.
    if ((await stat(path)).isDirectory()) {
      rel = join(rel, 'index.html')
      path = join(DIR, rel)
    }
    await stat(path)
  } catch {
    res.writeHead(404).end('not found')
    return
  }

  const type = TYPES[extname(rel)] ?? 'application/octet-stream'
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' }

  if (rel.endsWith('.html')) {
    res.writeHead(200, headers).end((await readFile(path, 'utf8')) + RELOAD)
    return
  }
  res.writeHead(200, headers).end(await readFile(path))
})

server.timeout = 0
server.keepAliveTimeout = 0
server.listen(PORT, '127.0.0.1', () => console.log(`demo on http://localhost:${PORT}`))
