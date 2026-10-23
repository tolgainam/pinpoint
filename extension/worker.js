/**
 * Pinpoint service worker.
 *
 * The content script never talks to the bridge directly. Everything goes through here,
 * because (a) an MV3 worker fetch to a host in host_permissions is not subject to the
 * page's CORS rules, and (b) Phase 3's screenshots need chrome.tabs.captureVisibleTab,
 * which is unavailable to content scripts.
 */
const BRIDGE = 'http://127.0.0.1:8788'
/** Said to the bridge on every call, so setup and the doctor can see which version is loaded. */
const EXT_VERSION = chrome.runtime.getManifest().version
const IDENTITY = { 'X-Pinpoint-Extension': EXT_VERSION }
const TIMEOUT = 4000
const ACCENT = '#d97757' /* design-ok: the badge API takes a literal; mirrors --pp-accent in tokens.css */
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/
const WEB = /^https?:\/\//
const WEB_TABS = ['http://*/*', 'https://*/*']

// ---------------------------------------------------------------- bridge

async function call(path, init = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(BRIDGE + path, { ...init, headers: { ...(init.headers ?? {}), ...IDENTITY }, signal: ctl.signal })
    const body = await res.text()
    let json
    try { json = JSON.parse(body) } catch { json = null }
    return { ok: res.ok, status: res.status, body, json }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The bridge routes each page to the session for its project, so it has to know which
 * page is asking. A request from here carries the extension's origin, not the page's,
 * so the tab's origin rides along as `page`, plus a manual `pick` once the toolbar has one.
 */
function pageOf(sender) {
  try { return new URL(sender.tab?.url ?? '').origin } catch { return undefined }
}

/**
 * Which tab a request came from. The bridge keeps it on the batch, and every answer about
 * that batch carries it back, so a reply reaches the window that asked and no other.
 */
function sourceOf(sender) {
  const t = sender.tab
  return t?.id == null ? undefined : { tabId: t.id, windowId: t.windowId, url: t.url }
}

function routed(payload, sender, pick) {
  const source = sourceOf(sender)
  return { ...payload, page: pageOf(sender), ...(source ? { source } : {}), ...(pick ? { pick } : {}) }
}

async function health(page, pick) {
  try {
    const qs = new URLSearchParams()
    if (page) qs.set('page', page)
    if (pick) qs.set('pick', pick)
    const r = await call(`/health${qs.size ? `?${qs}` : ''}`)
    return r.ok && r.json ? { connected: true, ...r.json } : { connected: false }
  } catch {
    return { connected: false }
  }
}

/**
 * The shared secret is optional: only a bridge started with PINPOINT_TOKEN asks for it.
 * It is kept in this browser's extension storage, set on the welcome page, and goes to
 * the bridge on 127.0.0.1 and nowhere else.
 */
const TOKEN_KEY = 'pinpoint:token'

async function bridgeToken() {
  try { return String((await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY] ?? '').trim() } catch { return '' }
}

async function post(path, payload) {
  try {
    const token = await bridgeToken()
    const r = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Pinpoint-Token': token } : {}) },
      body: JSON.stringify(payload),
    })
    if (r.status === 401) return { ok: false, error: 'the bridge wants a token — enter PINPOINT_TOKEN on the Pinpoint welcome page (right-click the icon > Options)' }
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
/** Captures run one at a time. See capture(). */
let captureQueue = Promise.resolve()

/** Chrome's own limit is two a second; this leaves a margin over it. */
const CAPTURE_GAP = 600
const QUOTA = /quota|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds/i

/**
 * Content scripts cannot call captureVisibleTab, so every screenshot comes through here.
 * Chrome rate limits this to roughly two calls a second and throws when you exceed it.
 *
 * Pacing alone is not enough. A batch of comments, a follow-up and a resolve re-shot can
 * all ask at once, and each one measured the gap from the same "last call" and fired
 * together. So the calls are queued: each waits for the one before it, then for the gap.
 * A quota error that still gets through is retried after a full second, not a fraction of
 * one, because the window it is counting in is a second wide.
 *
 * The permission model is the trap. captureVisibleTab accepts <all_urls> or activeTab —
 * a host permission for localhost is NOT enough — and activeTab is granted by clicking
 * the extension icon and revoked again on the next navigation. So a page reload silently
 * takes screenshots away until the icon is clicked again, and the only decent response
 * is to say so in plain words rather than return an empty image.
 */
function capture() {
  const run = captureQueue.then(captureOnce)
  captureQueue = run.catch(() => {})
  return run
}

/** Wait out the gap since the last capture, so the page can hide itself only when it is time. */
async function captureTurn() {
  await captureQueue.catch(() => {})
  const wait = Math.max(0, CAPTURE_GAP - (Date.now() - lastCapture))
  if (wait) await new Promise(r => setTimeout(r, wait))
}

async function captureOnce() {
  const wait = Math.max(0, CAPTURE_GAP - (Date.now() - lastCapture))
  if (wait) await new Promise(r => setTimeout(r, wait))

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      lastCapture = Date.now()
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
      return { ok: true, dataUrl }
    } catch (err) {
      const msg = String(err?.message || err)
      if (/permission|activeTab|all_urls|cannot access/i.test(msg)) {
        return { ok: false, permission: true, error: 'click the Pinpoint icon on this tab to allow screenshots, then add the comment again (or allow them on every page: right-click the icon > Options)' }
      }
      if (attempt === 3) return { ok: false, error: msg }
      await new Promise(r => setTimeout(r, QUOTA.test(msg) ? 1100 : 350 * (attempt + 1)))
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
/** Which run of the bridge lastSeq belongs to. A new run starts counting again from 1. */
let lastEpoch = ''
let seqLoaded = false
/** True once a stream has connected, so the next connect is a return. */
let streamedBefore = false
let retry = null
let backoff = 1000

/**
 * An event that names its tab goes to that tab and to no other. There is no fallback to
 * "every tab": a closed or moved tab means the answer has nowhere to go, and that is told
 * to the user instead of being shown on a page of another project. Returns what happened,
 * for events with a target; the bridge passes it on to Claude Code.
 */
async function fanOut(event) {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: WEB_TABS })
  } catch { return undefined }

  const want = event.target?.tabId
  if (want == null) {
    for (const t of tabs) {
      if (!t.id) continue
      chrome.tabs.sendMessage(t.id, { type: 'bridge-event', event }).catch(() => { /* no overlay there */ })
    }
    return undefined
  }

  const tab = tabs.find(t => t.id === want)
  let reason = 'the tab that sent this comment is closed'
  if (tab) {
    try {
      const got = await chrome.tabs.sendMessage(tab.id, { type: 'bridge-event', event })
      if (got?.handled) return { ok: true }
      reason = 'the tab that sent this comment now shows a different page'
    } catch {
      reason = 'the tab that sent this comment has no Pinpoint overlay (reload it)'
    }
  }

  // Tell the Pinpoint toolbars that are still open for this project. Each page checks the
  // project itself, so a page of another project stays quiet.
  const text = `Claude Code answered, but ${reason}. Open the page again to see it.`
  for (const t of tabs) {
    if (!t.id || t.id === want) continue
    chrome.tabs.sendMessage(t.id, { type: 'bridge-event', event: { type: 'undelivered', projectDir: event.projectDir, text } }).catch(() => {})
  }
  return { ok: false, reason }
}

async function readStream() {
  const res = await fetch(`${BRIDGE}/events?since=${lastSeq}&epoch=${encodeURIComponent(lastEpoch)}`, { headers: IDENTITY })
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
  backoff = 1000
  // Back after being away: the pages ask what they missed. Not on the first connection of this
  // worker, when they have only just loaded and ask anyway.
  if (streamedBefore) fanOut({ type: 'sync' })
  streamedBefore = true

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
        if (event.epoch) lastEpoch = event.epoch
        chrome.storage.session?.set({ lastSeq, lastEpoch }).catch(() => {})
      }
      const delivery = await fanOut(event)
      if (delivery && event.seq) post('/delivery', { seq: event.seq, ...delivery }).catch(() => {})
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
        const got = await chrome.storage.session?.get(['lastSeq', 'lastEpoch'])
        if (got?.lastSeq) lastSeq = got.lastSeq
        if (got?.lastEpoch) lastEpoch = got.lastEpoch
      } catch { /* session storage unavailable */ }
    }
    await readStream()
  } catch { /* bridge down or session ended — reconnect below */ }

  streaming = false
  // The health ping usually gets here first; this is the fallback when no tab is open.
  retry = setTimeout(ensureStream, backoff)
  backoff = Math.min(backoff * 2, 30000)
}

// ---------------------------------------------------------------- open state

const openKey = tabId => `open:${tabId}`

async function openState(tabId) {
  if (tabId == null) return false
  try { return !!(await chrome.storage.session.get(openKey(tabId)))[openKey(tabId)] } catch { return false }
}

async function setOpenState(tabId, open) {
  if (tabId == null) return
  try {
    if (open) await chrome.storage.session.set({ [openKey(tabId)]: true })
    else await chrome.storage.session.remove(openKey(tabId))
  } catch { /* session storage unavailable: the toolbar just starts hidden */ }
}

chrome.tabs.onRemoved.addListener(tabId => { setOpenState(tabId, false) })

// ---------------------------------------------------------------- badge

/**
 * The badge stays the pending count and nothing else; a second meaning would blur it. A
 * bridge that is down goes in the tooltip instead, as a suffix on whatever it says.
 *
 * The tooltip itself is the only state. This worker is torn down whenever Chrome likes,
 * and a Set of offline tabs kept here would come back empty and never clear the suffix.
 * Chrome keeps each tab's title across that, so it is read back, its suffix taken off,
 * and put on again only if the bridge is down right now.
 */
const OFFLINE = ' · Claude Code offline'

const bare = title => (title.endsWith(OFFLINE) ? title.slice(0, -OFFLINE.length) : title)

async function setTitle(tabId, title, down) {
  const want = bare(title) + (down ? OFFLINE : '')
  if (want !== title) await chrome.action.setTitle({ tabId, title: want })
}

async function badge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT })
    if (title) {
      // A new title keeps whatever the last health ping said about the bridge.
      const was = await chrome.action.getTitle({ tabId })
      await chrome.action.setTitle({ tabId, title: bare(title) + (was.endsWith(OFFLINE) ? OFFLINE : '') })
    }
  } catch { /* tab closed */ }
}

async function noteHealth(tabId, res) {
  if (!tabId) return res
  try {
    await setTitle(tabId, await chrome.action.getTitle({ tabId }), !res.connected)
  } catch { /* tab closed */ }
  return res
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['status.js', 'a11y.js', 'scope.js', 'route.js', 'content.js'] })
    return true
  } catch (err) {
    console.warn('[pinpoint] could not inject into tab', tabId, err)
    return false
  }
}

// ---------------------------------------------------------------- events

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'ping') { ensureStream(); health(pageOf(sender), msg.pick).then(r => noteHealth(sender.tab?.id, r)).then(respond); return true }
  if (msg?.type === 'dispatch') { post('/dispatch', routed(msg.payload, sender, msg.pick)).then(respond); return true }
  if (msg?.type === 'backlog') { post('/backlog', routed(msg.payload, sender, msg.pick)).then(respond); return true }
  if (msg?.type === 'design-system') { post('/design-system', routed(msg.payload, sender, msg.pick)).then(respond); return true }
  if (msg?.type === 'recapture') { post('/recapture', msg.payload).then(respond); return true }
  // Whether the toolbar was left open in this tab. Per tab, and gone with the tab or the
  // browser session: a new tab starts hidden, as it always did.
  if (msg?.type === 'open-state') { openState(sender.tab?.id).then(open => respond({ open })); return true }
  if (msg?.type === 'set-open') { setOpenState(sender.tab?.id, !!msg.open).then(() => respond({ ok: true })); return true }
  // The page asks what the bridge holds about its pins, for the ones it did not hear about.
  if (msg?.type === 'state') {
    const ids = Array.isArray(msg.ids) ? msg.ids.filter(i => typeof i === 'string').slice(0, 100) : []
    call(`/state?ids=${encodeURIComponent(ids.join(','))}`).then(r => respond(r.ok && r.json ? r.json : { ok: false })).catch(() => respond({ ok: false }))
    return true
  }
  if (msg?.type === 'capture-wait') { captureTurn().then(() => respond({ ok: true })); return true }
  if (msg?.type === 'capture') { capture().then(respond); return true }
  // The welcome page's bridge check: no page and no pick, so the bridge answers for no
  // tab in particular. Asked once on open and on "Check again", never on a timer.
  if (msg?.type === 'check-bridge') { health().then(respond); return true }
  if (msg?.type === 'open-welcome') { openWelcome().then(() => respond({ ok: true })); return true }
  if (msg?.type === 'count') {
    const tabId = sender.tab?.id
    if (tabId) badge(tabId, msg.n ? String(msg.n) : '', msg.n ? `${msg.n} comment${msg.n === 1 ? '' : 's'} waiting to dispatch` : 'Pinpoint — show or hide toolbar')
    respond({ ok: true })
    return false
  }
  return false
})

/**
 * Any other http(s) site is opt-in, one site at a time. Localhost is always on. For
 * anything else the icon click asks Chrome for that one host (a click is the user gesture
 * the prompt needs). A yes registers the content scripts for it, so the site loads
 * Pinpoint on every visit; a no still works for this page, because the click itself grants
 * activeTab. The prompt is the only place a site becomes trusted, never a setting.
 */
const sitePattern = url => { const u = new URL(url); return `${u.protocol}//${u.hostname}/*` }

async function keepOnSite(pattern) {
  const ids = [`${pattern}:probe`, `${pattern}:ui`]
  const have = await chrome.scripting.getRegisteredContentScripts({ ids })
  if (have.length === ids.length) return
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map(s => s.id) })
  await chrome.scripting.registerContentScripts([
    { id: ids[0], matches: [pattern], js: ['probe.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: true },
    { id: ids[1], matches: [pattern], js: ['status.js', 'a11y.js', 'scope.js', 'route.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ])
}

async function allowSite(url) {
  try {
    const origins = [sitePattern(url)]
    const granted = (await chrome.permissions.contains({ origins })) || (await chrome.permissions.request({ origins }))
    if (granted) await keepOnSite(origins[0])
  } catch (err) {
    console.warn('[pinpoint] could not keep Pinpoint on this site', err)
  }
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id) return

  if (!WEB.test(tab.url ?? '')) {
    await badge(tab.id, '—', 'Pinpoint only runs on http and https pages')
    setTimeout(() => badge(tab.id, ''), 4000)
    return
  }

  // First, before any await that could use up the click.
  if (!LOCAL.test(tab.url)) await allowSite(tab.url)

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
 *
 * focus-pinpoint is the keyboard's way in. The overlay is mounted last in the page, so
 * reaching it with Tab means walking the whole page first; this shows the toolbar and
 * focuses its active item instead.
 */
const COMMAND_MESSAGE = { freeze: 'freeze', 'focus-pinpoint': 'focus' }

chrome.commands?.onCommand.addListener(async (command, tab) => {
  const type = COMMAND_MESSAGE[command]
  if (!type || !tab?.id) return
  if (!WEB.test(tab.url ?? '')) return
  if (!(await ensureInjected(tab.id))) return
  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {})
})

/**
 * The welcome page, always in a new tab. It is also the options page, but
 * openOptionsPage would focus an old copy instead, and "How it works" should read as
 * opening something, not as nothing happening because the tab is somewhere else.
 */
function openWelcome() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {})
}

// Attach to localhost tabs that were already open at install or reload time.
chrome.runtime.onInstalled.addListener(async details => {
  // A first install only. An update or a reload of the unpacked folder is someone who
  // has already seen it, and a tab popping open on every reload would be noise.
  if (details?.reason === 'install') openWelcome()
  ensureStream()
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] })
    for (const t of tabs) if (t.id) ensureInjected(t.id)
  } catch (err) {
    console.warn('[pinpoint] startup injection failed', err)
  }
})

/**
 * The page's own 5s ping is what normally wakes a sleeping worker, and a tab in the background
 * runs timers about once a minute, so a reply could wait that long for the stream to come back.
 * An alarm wakes the worker whether or not any page is awake. Chrome allows one every 30s.
 */
try {
  chrome.alarms.create('pinpoint-stream', { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'pinpoint-stream') ensureStream() })
} catch { /* no alarms API: the page's ping still covers it */ }

// A worker that just woke up — install, browser start, or a nap — reconnects immediately.
chrome.runtime.onStartup?.addListener(() => ensureStream())
ensureStream()
