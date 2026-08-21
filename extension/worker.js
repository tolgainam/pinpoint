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

async function dispatch(payload) {
  try {
    const r = await call('/dispatch', {
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
      if (attempt === 2) return { ok: false, error: String(err) }
      await new Promise(r => setTimeout(r, 350 * (attempt + 1)))
    }
  }
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
  if (msg?.type === 'ping') { health().then(respond); return true }
  if (msg?.type === 'dispatch') { dispatch(msg.payload).then(respond); return true }
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

// Attach to localhost tabs that were already open at install or reload time.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] })
    for (const t of tabs) if (t.id) ensureInjected(t.id)
  } catch (err) {
    console.warn('[pinpoint] startup injection failed', err)
  }
})
