#!/usr/bin/env bun
/**
 * Static server for the demo page, with a live reload so a fix made from a pinned
 * comment shows up in the browser without touching the keyboard.
 *
 * bun demo/serve.ts   →   http://localhost:3000
 */
import { watch } from 'node:fs'
import { join, extname } from 'node:path'

const DIR = import.meta.dir
const PORT = Number(process.env.DEMO_PORT ?? 3000)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const clients = new Set<(chunk: string) => void>()

// Debounced: an editor writing a file often produces several events in a row.
let timer: Timer | undefined
let changed = new Set<string>()
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

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/__reload') {
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder()
          const emit = (chunk: string) => ctrl.enqueue(enc.encode(chunk))
          emit(': connected\n\n')
          clients.add(emit)
          req.signal.addEventListener('abort', () => clients.delete(emit))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const file = Bun.file(join(DIR, path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })

    const type = TYPES[extname(path)] ?? 'application/octet-stream'
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' }

    if (path.endsWith('.html')) {
      return new Response((await file.text()) + RELOAD, { headers })
    }
    return new Response(file, { headers })
  },
})

console.log(`demo on http://localhost:${PORT}`)
