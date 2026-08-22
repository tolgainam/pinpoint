/**
 * Pinpoint service worker.
 *
 * The content script never talks to the bridge directly. Everything goes through here,
 * because (a) an MV3 worker fetch to a host in host_permissions is not subject to the
 * page's CORS rules, and (b) Phase 3's screenshots need chrome.tabs.captureVisibleTab,
 * which is unavailable to content scripts.
 */
const BRIDGE = 'http://127.0.0.1:8788'
const TIMEOUT = 4000
const ACCENT = '#d97757'
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/

// ---------------------------------------------------------------- bridge

async function call(path, init = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(BRIDGE + path, { ...init, signal: ctl.signal })
    const body = await res.text()
    let json
    try { json = JSON.parse(body) } catch { json = null }
    return { ok: res.ok, status: res.status, body, json }
  } finally {
    clearTimeout(timer)
  }
}

async function health() {
  try {
    const r = await call('/health')
    return r.ok && r.json ? { connected: true, ...r.json } : { connected: false }
  } catch {
    return { connected: false }
  }
}

async function post(path, payload) {
  try {
    const r = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) return { ok: false, error: `bridge returned ${r.status}: ${r.body.slice(0, 200)}` }
    return { ok: true, ...(r.json ?? {}) }
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError'
        ? 'bridge timed out'
        : 'bridge unreachable — is a Claude Code session running?',
    }
  }
}

// ---------------------------------------------------------------- capture

let lastCapture = 0

/**
 * Content scripts cannot call captureVisibleTab, so every screenshot comes through here.
 * Chrome rate limits this to roughly two calls a second and throws when you exceed it,
 * so pace the calls rather than losing the user's comment to a quota error.
 *
 * The permission model is the trap. captureVisibleTab accepts <all_urls> or activeTab —
 * a host permission for localhost is NOT enough — and activeTab is granted by clicking
 * the extension icon and revoked again on the next navigation. So a page reload silently
 * takes screenshots away until the icon is clicked again, and the only decent response
 * is to say so in plain words rather than return an empty image.
 */
async function capture() {
  const wait = Math.max(0, 600 - (Date.now() - lastCapture))
  if (wait) await new Promise(r => setTimeout(r, wait))

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      lastCapture = Date.now()
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
      return { ok: true, dataUrl }
    } catch (err) {
      const msg = String(err?.message || err)
      if (/permission|activeTab|all_urls|cannot access/i.test(msg)) {
        return { ok: false, permission: true, error: 'click the Pinpoint icon on this tab to allow screenshots, then add the comment again' }
      }
      if (attempt === 2) return { ok: false, error: msg }
      await new Promise(r => setTimeout(r, 350 * (attempt + 1)))
    }
  }
}

// ---------------------------------------------------------------- resolutions

/**
 * The bridge streams events — a comment resolved, a status line from Claude — over SSE.
 * EventSource does not exist in a service worker, so the stream is read by hand.
 *
 * The worker is torn down whenever Chrome decides it is idle, which would silently drop
 * events. Two things cover that: every event carries a sequence number and reconnects ask
 * for everything after the last one seen, and the content script's 5s health ping wakes
 * the worker often enough to notice the stream is down.
 */
let streaming = false
let lastSeq = 0
let seqLoaded = false
let retry = null
let backoff = 1000

async function fanOut(event) {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] })
  } catch { return }
  for (const t of tabs) {
    if (!t.id) continue
    chrome.tabs.sendMessage(t.id, { type: 'bridge-event', event }).catch(() => { /* no overlay there */ })
  }
}

async function readStream() {
  const res = await fetch(`${BRIDGE}/events?since=${lastSeq}`)
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
  backoff = 1000

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })

    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (!data) continue // heartbeat or comment line

      let event
      try { event = JSON.parse(data) } catch { continue }
      if (event.seq) {
        lastSeq = event.seq
        chrome.storage.session?.set({ lastSeq }).catch(() => {})
      }
      await fanOut(event)
    }
  }
}

async function ensureStream() {
  if (streaming) return
  streaming = true
  clearTimeout(retry)

  try {
    if (!seqLoaded) {
      seqLoaded = true
      try {
        const got = await chrome.storage.session?.get('lastSeq')
        if (got?.lastSeq) lastSeq = got.lastSeq
      } catch { /* session storage unavailable */ }
    }
    await readStream()
  } catch { /* bridge down or session ended — reconnect below */ }

  streaming = false
  // The health ping usually gets here first; this is the fallback when no tab is open.
  retry = setTimeout(ensureStream, backoff)
  backoff = Math.min(backoff * 2, 30000)
}

// ---------------------------------------------------------------- badge

/** The icon is the only surface the user sees when something goes wrong. Never stay silent. */
async function badge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT })
    if (title) await chrome.action.setTitle({ tabId, title })
  } catch { /* tab closed */ }
}

// ---------------------------------------------------------------- injection

/**
 * A tab that was already open when the extension was installed or reloaded has no
 * content script in it — the classic MV3 trap, and it looks exactly like a broken
 * extension. Attach on demand instead of making the user reload the page.
 */
async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping-content' })
    return true
  } catch { /* nothing there yet */ }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['probe.js'] })
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return true
  } catch (err) {
    console.warn('[pinpoint] could not inject into tab', tabId, err)
    return false
  }
}

// ---------------------------------------------------------------- events

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'ping') { ensureStream(); health().then(respond); return true }
  if (msg?.type === 'dispatch') { post('/dispatch', msg.payload).then(respond); return true }
  if (msg?.type === 'backlog') { post('/backlog', msg.payload).then(respond); return true }
  if (msg?.type === 'capture') { capture().then(respond); return true }
  if (msg?.type === 'count') {
    const tabId = sender.tab?.id
    if (tabId) badge(tabId, msg.n ? String(msg.n) : '', msg.n ? `${msg.n} comment${msg.n === 1 ? '' : 's'} waiting to dispatch` : 'Pinpoint — toggle comment mode')
    respond({ ok: true })
    return false
  }
  return false
})

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id) return

  if (!LOCAL.test(tab.url ?? '')) {
    await badge(tab.id, '—', 'Pinpoint only runs on http://localhost and http://127.0.0.1 dev servers')
    setTimeout(() => badge(tab.id, ''), 4000)
    return
  }

  if (!(await ensureInjected(tab.id))) {
    await badge(tab.id, '!', 'Pinpoint could not attach to this page — try reloading it')
    setTimeout(() => badge(tab.id, ''), 4000)
    return
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  } catch {
    await badge(tab.id, '!', 'Pinpoint could not reach this page — try reloading it')
    setTimeout(() => badge(tab.id, ''), 4000)
  }
})

/**
 * The freeze hotkey. A page keydown listener would do for most sites, but the states
 * worth freezing — an open dropdown, a focus-trapped menu — are exactly the ones that
 * swallow keys. A browser command is above all of that.
 */
chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'freeze' || !tab?.id) return
  if (!LOCAL.test(tab.url ?? '')) return
  if (!(await ensureInjected(tab.id))) return
  chrome.tabs.sendMessage(tab.id, { type: 'freeze' }).catch(() => {})
})

// Attach to localhost tabs that were already open at install or reload time.
chrome.runtime.onInstalled.addListener(async () => {
  ensureStream()
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] })
    for (const t of tabs) if (t.id) ensureInjected(t.id)
  } catch (err) {
    console.warn('[pinpoint] startup injection failed', err)
  }
})

// A worker that just woke up — install, browser start, or a nap — reconnects immediately.
chrome.runtime.onStartup?.addListener(() => ensureStream())
ensureStream()
