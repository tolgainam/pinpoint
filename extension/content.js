/**
 * Pinpoint overlay.
 *
 * Mounts a comment toolbar into a shadow root on any localhost page. You toggle comment
 * mode, click elements, write notes, and hit Dispatch; the batch goes to the service
 * worker, which posts it to the local bridge and into a Claude Code session.
 *
 * Two rules shape the whole file:
 *   - the host page's DOM is never mutated (highlights and pins are our own absolutely
 *     positioned elements, not outlines applied to page nodes)
 *   - the host page's CSS can never reach us, and ours can never reach it (shadow root)
 */
;(async function () {
  if (window.__PINPOINT__) return
  window.__PINPOINT__ = true

  const KEY = `pinpoint:${location.origin}${location.pathname}`
  const BAR_KEY = 'pinpoint:bar'
  const PREFS_KEY = 'pinpoint:prefs'
  const MAX_TEXT = 200
  const MAX_HTML = 600

  // ---------------------------------------------------------------- state

  /** @type {{n:number, note:string, selector:string, docX:number, docY:number,
      status:'pending'|'sent'|'resolved'|'answered'|'backlog'}[]} */
  let comments = []
  let seq = 0
  let mode = false
  let connected = false
  let frozen = null          // element awaiting a note
  let openCard = null        // the composer or pin card currently on screen
  /** Sticky: whatever you chose last time is the default next time, so turning
      screenshots off once keeps them off without a separate global switch. */
  let wantShot = true
  /** Same stickiness, but the toggle only exists when the page has actually logged
      something — see the composer. */
  let wantDebug = false

  // ---------------------------------------------------------------- shadow root

  const host = document.createElement('div')
  host.id = 'pinpoint-host'
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'

  const root = host.attachShadow({ mode: 'open' })
  const css = await fetch(chrome.runtime.getURL('overlay.css')).then(r => r.text()).catch(() => '')
  const style = document.createElement('style')
  style.textContent = css
  root.append(style)

  const layer = el('div', 'layer')
  root.append(layer)
  document.documentElement.append(host)

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  // ---------------------------------------------------------------- selector

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-component']
  /**
   * Hashed class names from CSS-in-JS: stable within a build, meaningless across one.
   *
   * The short-prefix arm requires a digit in the tail. Without one it also swallowed
   * ordinary hyphenated names — `hero-actions`, `card-header`, `nav-wrapper` all match
   * "up to four letters, hyphen, six or more alphanumerics" — which quietly cost every
   * selector and breadcrumb the most descriptive class on the element.
   */
  const GENERATED_CLASS = /^(css|sc|emotion|jsx|styled|makeStyles)[-_]|^[A-Za-z]+__[A-Za-z0-9]{5,}$|^[a-z]{1,4}-(?=[a-z0-9]{6,}$)[a-z]*\d[a-z0-9]*$/
  /** Runtime-generated ids: React useId, Radix, Headless UI. */
  const GENERATED_ID = /^(:r|radix-|headlessui-|mui-|react-aria)|\d{5,}/

  const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, '\\$&'))

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1 } catch { return false }
  }

  /** A selector that identifies this element on its own, or null. */
  function anchorFor(node) {
    for (const a of TEST_ATTRS) {
      const v = node.getAttribute?.(a)
      if (v) {
        const s = `[${a}="${v.replace(/["\\]/g, '\\$&')}"]`
        if (unique(s)) return s
      }
    }
    if (node.id && !GENERATED_ID.test(node.id)) {
      const s = '#' + esc(node.id)
      if (unique(s)) return s
    }
    return null
  }

  function segment(node) {
    const cls = Array.from(node.classList || [])
      .filter(c => c && c.length < 30 && !GENERATED_CLASS.test(c))
      .slice(0, 2)
    let seg = node.tagName.toLowerCase() + cls.map(c => '.' + esc(c)).join('')

    const parent = node.parentElement
    if (parent) {
      const sibs = Array.from(parent.children).filter(s => s.tagName === node.tagName)
      if (sibs.length > 1) {
        // Only pay for :nth-of-type when the classes did not already single it out.
        let same = sibs
        try { same = sibs.filter(s => s.matches(seg)) } catch { /* fall back to all siblings */ }
        if (same.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`
      }
    }
    return seg
  }

  /**
   * Prefer identity that survives a re-render: a test id, then a hand-written id, then
   * the shortest `>` chain that happens to be unique. Anchoring on an ancestor's test id
   * keeps the result short and readable, which matters because Claude greps for it.
   */
  function buildSelector(target) {
    const direct = anchorFor(target)
    if (direct) return direct

    const parts = []
    let node = target
    for (let depth = 0; node && node.nodeType === 1 && node !== document.documentElement; depth++) {
      const anchor = depth > 0 ? anchorFor(node) : null
      if (anchor && parts.length) {
        const sel = `${anchor} > ${parts.join(' > ')}`
        if (unique(sel)) return sel
      }
      parts.unshift(segment(node))
      const sel = parts.join(' > ')
      if (unique(sel)) return sel
      if (parts.length >= 6) break
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  // ---------------------------------------------------------------- main-world probe

  /** One round trip to the page's own world. Resolves null on timeout — the probe is
      an enrichment, so nothing it answers is ever worth blocking a comment on. */
  function ask(req, timeout = 250) {
    return new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      const done = value => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), timeout)
      function onMessage(ev) {
        const d = ev.data
        if (ev.source !== window || !d || d.tag !== 'pinpoint:probe' || d.dir !== 'res' || d.id !== id) return
        done(d)
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ tag: 'pinpoint:probe', dir: 'req', id, ...req }, location.origin)
    })
  }

  /** Which component rendered this. */
  const probeComponent = (selector, x, y) =>
    ask({ kind: 'component', selector, x, y }).then(r => r?.component || null)

  /** The page's console/network ring buffer. */
  const probeDebug = () => ask({ kind: 'debug' }).then(r => (Array.isArray(r?.debug) ? r.debug : []))

  // ---------------------------------------------------------------- computed style

  /**
   * The properties people actually comment on. A full getComputedStyle dump is ~340
   * entries of noise; the point of this subset is that "this spacing is wrong" arrives
   * with the box model instead of making Claude guess between margin, padding, and gap.
   *
   * Width and height are deliberately absent — `rect` already carries the rendered size,
   * and the computed values only restate it.
   */
  const STYLE_PROPS = [
    'display', 'position', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
    'gap', 'grid-template-columns', 'flex', 'overflow',
    'padding', 'margin', 'border-width', 'border-radius', 'box-sizing',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'white-space',
    'color', 'background-color', 'border-color', 'box-shadow', 'opacity',
  ]

  /** Values that mean "nobody set this". Reporting them is what turns a useful payload
      into a wall of `margin: 0px` — but a property missing from this map is always kept,
      because for those the default is itself worth seeing. */
  const STYLE_DEFAULT = {
    position: 'static', 'flex-direction': 'row', 'flex-wrap': 'nowrap',
    'justify-content': 'normal', 'align-items': 'normal', gap: 'normal',
    'grid-template-columns': 'none', flex: '0 1 auto', overflow: 'visible',
    padding: '0px', margin: '0px', 'border-width': '0px', 'border-radius': '0px',
    'box-sizing': 'content-box', 'letter-spacing': 'normal', 'text-align': 'start',
    'text-transform': 'none', 'white-space': 'normal', 'box-shadow': 'none',
    opacity: '1', 'background-color': 'transparent',
  }

  /** Computed colours come back as `rgb(...)`; stylesheets are written in hex, and hex
      is what Claude greps for. Alpha becomes the 8-digit form rather than a prose
      suffix, because the result has to stay valid CSS — a colour inside a `box-shadow`
      is rewritten in place, and `#00000059 0 2px 8px` must still parse. */
  function toHex(value) {
    const m = String(value).match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/)
    if (!m) return value
    let a = 1
    if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4])
    if (a === 0) return 'transparent'
    const byte = n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')
    return '#' + byte(m[1]) + byte(m[2]) + byte(m[3]) + (a < 1 ? byte(a * 255) : '')
  }

  /** Computed lengths carry layout sub-pixels — `455.65625px` for a `1fr` track. Left
      raw they read as authored values somebody could grep for, which they are not. */
  const roundPx = v => v.replace(/(\d+\.\d+)px/g, (_, n) => `${Math.round(Number(n) * 10) / 10}px`)

  function tidy(prop, value) {
    if (prop === 'font-family') return String(value).split(',')[0].replace(/["']/g, '').trim()
    let out = String(value)
    if (/color|shadow/.test(prop)) out = out.replace(/rgba?\([^)]*\)/g, toHex)
    return roundPx(out).slice(0, 120)
  }

  /** @returns {Record<string,string>} only the properties worth sending. */
  function styleOf(node) {
    const cs = getComputedStyle(node)
    const out = {}
    for (const prop of STYLE_PROPS) {
      const raw = cs.getPropertyValue(prop)
      if (!raw) continue
      const value = tidy(prop, raw.trim())
      if (!value) continue
      // border-color without a border is noise no matter what it says.
      if (prop === 'border-color' && (!out['border-width'] || out['border-width'] === '0px')) continue
      if (STYLE_DEFAULT[prop] === value) continue
      out[prop] = value
    }
    return out
  }

  /** tag plus whatever classes survive the generated-name filter — the shortest label
      that still tells you which element you are looking at. */
  function nodeLabel(node, maxClasses = 2) {
    const cls = Array.from(node.classList || [])
      .filter(c => c && c.length < 24 && !GENERATED_CLASS.test(c))
      .slice(0, maxClasses)
    return node.tagName.toLowerCase() + cls.map(c => `.${c}`).join('')
  }

  /** Where this element sits, nearest ancestor first. Answers "is the gap on the parent?"
      without a second round trip. */
  function parentChain(node, max = 4) {
    const out = []
    let n = node.parentElement
    while (n && n !== document.body && n !== document.documentElement && out.length < max) {
      out.push(nodeLabel(n))
      n = n.parentElement
    }
    return out
  }

  // ---------------------------------------------------------------- element capture

  function describe(target, snapRect) {
    const rect = snapRect || target.getBoundingClientRect()
    const cls = typeof target.className === 'string' ? target.className.trim() : ''
    return {
      selector: buildSelector(target),
      styles: styleOf(target),
      parents: parentChain(target),
      tag: target.tagName.toLowerCase(),
      elementId: target.id || undefined,
      classes: cls ? cls.slice(0, 200) : undefined,
      role: target.getAttribute('role') || undefined,
      ariaLabel: target.getAttribute('aria-label') || undefined,
      text: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) || undefined,
      html: target.outerHTML.slice(0, MAX_HTML),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      docX: Math.round(rect.left + scrollX),
      docY: Math.round(rect.top + scrollY),
    }
  }

  // ---------------------------------------------------------------- ancestor chain

  const MAX_DEPTH = 8

  /**
   * The clicked element first, then its ancestors. Stops before <body>: a comment on
   * the document body says nothing useful, and the chain is a menu — every entry in it
   * has to be worth choosing.
   */
  function ancestorChain(target) {
    const list = []
    let node = target
    while (
      node && node.nodeType === 1 &&
      node !== document.body && node !== document.documentElement &&
      list.length < MAX_DEPTH
    ) {
      list.push({ node, component: undefined, probed: false })
      node = node.parentElement
    }
    return list.length ? list : [{ node: target, component: undefined, probed: false }]
  }

  /** What a crumb says before its component name comes back from the probe. */
  const crumbLabel = entry => entry.component || nodeLabel(entry.node, 1)

  // ---------------------------------------------------------------- intent

  /**
   * The first character decides what a note is: `?` asks a question, `!` parks it on the
   * backlog, anything else is an ordinary fix request. One marker, only at the start, and
   * it must have a note after it — so a comment that genuinely reads "!" is still a note.
   *
   * This is the whole switch. It replaced a composer checkbox because a marker you type
   * while writing costs nothing, and every checkbox is chrome that stays on screen for
   * the comments that do not need it.
   */
  const MARKER = { '?': 'question', '!': 'backlog' }

  function intentOf(note) {
    const m = note.match(/^\s*([?!])\s*(\S[\s\S]*)$/)
    // The marker never travels with the text: it would land in the batch heading and in
    // backlog titles, where it reads as a typo.
    return m ? { kind: MARKER[m[1]], text: m[2].trim() } : { kind: null, text: note.trim() }
  }

  // ---------------------------------------------------------------- highlight

  const highlight = el('div', 'highlight')
  const tagLabel = el('div', 'tag')
  highlight.append(tagLabel)
  layer.append(highlight)

  function showHighlight(target, isSelected, snapRect) {
    // A frozen frame's element may be gone from the DOM, in which case its live rect is
    // all zeros — the snapshot taken at freeze time is the only honest geometry left.
    const r = snapRect || target.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = `${r.left}px`
    highlight.style.top = `${r.top}px`
    highlight.style.width = `${r.width}px`
    highlight.style.height = `${r.height}px`
    highlight.classList.toggle('frozen', !!isSelected)
    const id = target.id && !GENERATED_ID.test(target.id) ? `#${target.id}` : ''
    tagLabel.textContent = `${target.tagName.toLowerCase()}${id}  ${Math.round(r.width)}×${Math.round(r.height)}`
  }

  function hideHighlight() {
    highlight.style.display = 'none'
  }

  // ---------------------------------------------------------------- comment mode

  const capture = el('div', 'layer capture')
  capture.style.display = 'none'
  layer.append(capture)

  /** The topmost page element under the cursor, ignoring our own overlay. Returns the
      snapshot rect alongside it when a frozen frame is up, because the live one has
      moved on — that is the whole point of having frozen. */
  function elementUnder(x, y) {
    if (frame) return frameHit(x, y)
    const stack = document.elementsFromPoint(x, y)
    const node = stack.find(n => n !== host) || null
    return node ? { node, rect: null } : null
  }

  capture.addEventListener('mousemove', ev => {
    if (openCard) return
    const hit = elementUnder(ev.clientX, ev.clientY)
    if (hit) showHighlight(hit.node, false, hit.rect)
    else hideHighlight()
  })

  capture.addEventListener('click', ev => {
    ev.preventDefault()
    ev.stopPropagation()
    if (openCard) { closeCard(); return }
    const hit = elementUnder(ev.clientX, ev.clientY)
    if (!hit) return
    frozen = hit.node
    showHighlight(hit.node, true, hit.rect)
    openComposer(hit.node, ev.clientX, ev.clientY, hit.rect)
  })

  function setMode(on) {
    mode = on
    capture.style.display = on ? 'block' : 'none'
    modeBtn.classList.toggle('on', on)
    modeBtn.textContent = on ? 'Commenting' : 'Comment'
    if (!on) { closeCard(); hideHighlight(); frozen = null; if (frame) releaseFrame() }
  }

  // ---------------------------------------------------------------- screenshots

  const PAD = 24          // context around the element, in CSS px
  const MAX_EDGE = 1400   // cap the crop so storage and the wire stay sane

  /** Wait for a real paint. Hidden tabs never fire rAF, so never wait on it forever. */
  function nextPaint() {
    return new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      requestAnimationFrame(() => requestAnimationFrame(finish))
      setTimeout(finish, 120)
    })
  }

  /** Decode by hand rather than fetch(dataUrl): a strict page CSP can block the fetch. */
  function dataUrlToBlob(url) {
    const bin = atob(url.slice(url.indexOf(',') + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: 'image/png' })
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(blob)
    })
  }

  /**
   * One viewport capture with our own UI hidden.
   *
   * Pins and the toolbar showing up in the screenshot is the easiest thing here to get
   * silently wrong, so hiding is not optional — and a style write is not enough, the
   * browser has to actually paint the hidden state before the capture happens.
   */
  /** Why the last screenshot failed. A silent null here is indistinguishable from
      "the user turned screenshots off", which is exactly the wrong thing to guess. */
  let lastShotError = ''

  async function captureViewport() {
    host.style.visibility = 'hidden'
    await nextPaint()
    try {
      const res = await chrome.runtime.sendMessage({ type: 'capture' })
      if (res?.ok && res.dataUrl) return res.dataUrl
      lastShotError = res?.error || 'the worker returned no image'
    } catch (err) {
      lastShotError = String(err?.message || err)
    } finally {
      host.style.visibility = ''
    }
    console.warn('[pinpoint] screenshot failed:', lastShotError)
    return null
  }

  /** Crop one element's region, with padding, out of a viewport capture. */
  async function cropTo(dataUrl, rect) {
    try {
      const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl))
      // Derive scale from the image itself instead of trusting devicePixelRatio:
      // HiDPI and browser zoom both land here and they do not always agree.
      const scale = bitmap.width / document.documentElement.clientWidth

      const x = Math.max(0, Math.round((rect.x - PAD) * scale))
      const y = Math.max(0, Math.round((rect.y - PAD) * scale))
      const w = Math.min(bitmap.width - x, Math.round((rect.w + PAD * 2) * scale))
      const h = Math.min(bitmap.height - y, Math.round((rect.h + PAD * 2) * scale))
      if (w < 1 || h < 1) { bitmap.close(); return null }

      const shrink = Math.min(1, MAX_EDGE / Math.max(w, h))
      const outW = Math.max(1, Math.round(w * shrink))
      const outH = Math.max(1, Math.round(h * shrink))

      const canvas = new OffscreenCanvas(outW, outH)
      canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, outW, outH)
      bitmap.close()
      return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
    } catch (err) {
      lastShotError = `crop failed: ${err?.message || err}`
      console.warn('[pinpoint]', lastShotError)
      return null
    }
  }

  // ---------------------------------------------------------------- frozen frame

  /**
   * Hover menus, dropdowns, and toasts are the hardest things to report anywhere,
   * because they are gone by the time you have reached for the tool. Freezing takes a
   * picture of the viewport and, in the same breath, the geometry of everything visible
   * in it — then pins are placed against that picture instead of against the live page.
   *
   * Deliberately no `chrome.debugger`. Pausing JS would keep timers from firing, but it
   * cannot hold a CSS `:hover` open either (the pointer still has to leave), it breaks
   * whenever DevTools is attached, it puts a banner across the top of the browser, and
   * it is a frightening permission on a store listing. A picture plus geometry needs
   * none of that and covers the same cases.
   *
   * The honest limitation: the DOM moves on. A node that unmounts is still described
   * from the reference we kept — tag, classes, text, and markup all survive — but it has
   * no computed style and no unique selector any more. The comment says so, and the
   * screenshot is the primary evidence.
   *
   * @type {{shot: string, items: {node: Element, rect: DOMRect}[]} | null}
   */
  let frame = null

  const frameImg = el('div', 'frame')
  frameImg.style.display = 'none'
  layer.append(frameImg)

  const frameNote = el('div', 'frame-note')
  frameNote.style.display = 'none'
  layer.append(frameNote)

  /**
   * Every visible element and where it was, captured synchronously so it reflects the
   * instant the hotkey was pressed. All reads and no writes, so this is one forced
   * layout rather than a thrash.
   */
  function snapshotGeometry() {
    const items = []
    for (const node of document.body?.querySelectorAll('*') ?? []) {
      if (node === host) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue
      items.push({ node, rect })
    }
    return items
  }

  /** Smallest rect containing the point — a good stand-in for "topmost" that also picks
      the leaf, and it puts an open dropdown above the content it covers. */
  function frameHit(x, y) {
    let best = null
    let bestArea = Infinity
    for (const it of frame.items) {
      const r = it.rect
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
      const area = r.width * r.height
      if (area < bestArea) { best = it; bestArea = area }
    }
    return best
  }

  async function freezeFrame() {
    if (frame) { releaseFrame(); return }

    const items = snapshotGeometry()
    const shot = await captureViewport()
    if (!shot) { say(`cannot freeze — ${lastShotError}`, true); return }

    frame = { shot, items }
    frameImg.style.backgroundImage = `url("${shot}")`
    frameImg.style.display = 'block'
    frameNote.textContent = 'frozen — pin what you see · Esc to release'
    frameNote.style.display = 'block'
    setMode(true)
  }

  function releaseFrame() {
    if (!frame) return
    frame = null
    frameImg.style.display = 'none'
    frameImg.style.backgroundImage = ''
    frameNote.style.display = 'none'
    closeCard()
    hideHighlight()
    say('frame released')
  }

  // ---------------------------------------------------------------- cards

  function closeCard() {
    openCard?.remove()
    openCard = null
    frozen = null
    if (mode) hideHighlight()
  }

  /** Keep a card fully on screen no matter which corner the element sits in. */
  function placeCard(card, x, y) {
    const w = card.offsetWidth || 320
    const h = card.offsetHeight || 160
    card.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`
    card.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`
  }

  function openComposer(target, x, y, snapRect) {
    const chain = ancestorChain(target)
    let depth = 0        // index into chain; 0 is the element you clicked
    let captured         // always describes chain[depth].node; set by selectDepth below

    const card = el('div', 'card')
    const crumbs = el('div', 'crumbs')
    crumbs.tabIndex = 0
    crumbs.title = '↑ parent · ↓ child — or click a level'
    const meta = el('div', 'meta', '…')
    const box = el('textarea')
    box.placeholder = 'What is wrong here?    ⌘↵ add · ? ask · ! backlog'
    const hint = el('div', 'hint')

    const row = el('div', 'row')
    const shotLabel = el('label', 'toggle')
    const shotBox = document.createElement('input')
    shotBox.type = 'checkbox'
    shotBox.checked = wantShot
    shotLabel.append(shotBox, document.createTextNode('screenshot'))
    // Only mounted if the page has logged something. A toggle that is greyed out on
    // every healthy page is worse than no toggle: it is chrome you learn to ignore.
    const debugLabel = el('label', 'toggle')
    const debugBox = document.createElement('input')
    debugBox.type = 'checkbox'
    debugBox.checked = wantDebug
    const debugCount = document.createTextNode('debug')
    debugLabel.append(debugBox, debugCount)

    const cancel = el('button', '', 'Cancel')
    const add = el('button', 'primary', 'Add')
    row.append(shotLabel, el('span', 'spacer'), cancel, add)
    card.append(crumbs, meta, box, hint, row)
    layer.append(card)
    openCard = card
    placeCard(card, x + 12, y + 12)
    box.focus()

    // ------------------------------------------------------------ depth

    /**
     * Move the selection to one level of the chain. Everything the composer shows and
     * everything the comment will carry — selector, component, highlight, and the rect
     * the screenshot is cropped to — is derived from here, so walking the chain and
     * having clicked that element in the first place are indistinguishable downstream.
     */
    function selectDepth(i) {
      depth = Math.max(0, Math.min(i, chain.length - 1))
      const entry = chain[depth]
      target = entry.node
      frozen = target
      // Only the element actually clicked has a snapshot rect; its ancestors are measured
      // live, which is right — a container that outlives a transient child still exists.
      captured = describe(target, depth === 0 ? snapRect : null)
      if (entry.component) captured.component = entry.component
      showHighlight(target, true, depth === 0 ? snapRect : null)
      paintCrumbs()
      paintMeta()

      if (entry.probed) return
      entry.probed = true
      const r = target.getBoundingClientRect()
      probeComponent(captured.selector, r.left + r.width / 2, r.top + r.height / 2).then(component => {
        if (!component) return
        entry.component = component
        if (chain[depth] !== entry) return   // walked on while the probe was in flight
        captured.component = component
        paintCrumbs()
        paintMeta()
      })
    }

    function paintMeta() {
      const c = chain[depth].component
      meta.textContent = c ? `<${c}>  ${captured.selector}` : captured.selector
      meta.title = captured.selector
    }

    function paintCrumbs() {
      crumbs.textContent = ''
      chain.forEach((entry, i) => {
        if (i) crumbs.append(el('span', 'sep', '‹'))
        const crumb = el('span', 'crumb', crumbLabel(entry))
        crumb.classList.toggle('on', i === depth)
        crumb.onclick = () => { selectDepth(i); box.focus() }
        crumbs.append(crumb)
        // Centre the current crumb by hand rather than with scrollIntoView, which is
        // allowed to scroll every ancestor — including the page we promised not to touch.
        if (i === depth) requestAnimationFrame(() => {
          const c = crumb.getBoundingClientRect()
          const strip = crumbs.getBoundingClientRect()
          crumbs.scrollLeft += (c.left - strip.left) - (strip.width - c.width) / 2
        })
      })
    }

    /**
     * ↑/↓ walk the chain, but a textarea owns those keys once there is text to move a
     * caret through. Intercepting them only while the box is empty costs nothing — an
     * empty textarea has nowhere for the caret to go — and covers the actual gesture:
     * click, press ↑ twice to reach the card you meant, then start typing. After that
     * the crumbs stay clickable.
     */
    function onArrow(ev) {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return false
      if (ev.target === box && box.value !== '') return false
      ev.preventDefault()
      selectDepth(depth + (ev.key === 'ArrowUp' ? 1 : -1))
      return true
    }

    // ------------------------------------------------------------ intent

    /** The button and the hint are the only confirmation that a marker took effect,
        so both change on the keystroke that types it. */
    function paintIntent() {
      const { kind } = intentOf(box.value)
      add.textContent = kind === 'question' ? 'Ask' : kind === 'backlog' ? 'Backlog' : 'Add'
      add.classList.toggle('ask', kind === 'question')
      hint.textContent =
        kind === 'question' ? 'question — Claude answers on the pin and changes no files'
        : kind === 'backlog' ? 'parked — appended to .pinpoint/backlog.md, never dispatched'
        : ''
      hint.classList.toggle('show', !!hint.textContent)
    }

    // ------------------------------------------------------------ submit

    const submit = async () => {
      const note = box.value.trim()
      if (!note) { box.focus(); return }

      wantShot = shotBox.checked

      // Re-measure: the composer has been open for a while and the app may have moved.
      // Never against a frozen frame though — there the snapshot is the truth, and the
      // live page has by definition moved past the state being reported.
      let rect = captured.rect
      if (!frame) {
        const live = (() => { try { return document.querySelector(captured.selector) } catch { return null } })() || target
        const r = live.getBoundingClientRect()
        rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      }

      let shot = null
      if (wantShot) {
        add.disabled = true
        add.textContent = 'Capturing…'
        // Crop out of the frame that was frozen, not a fresh capture of a page that has
        // since closed the menu.
        const viewport = frame ? frame.shot : await captureViewport()
        shot = viewport ? await cropTo(viewport, rect) : null
        if (!shot) say(`no screenshot — ${lastShotError}`, true)
      }

      wantDebug = debugBox.checked
      // Re-read rather than reusing what the composer saw: the interesting error is
      // often the one thrown while the note was being typed.
      const debug = debugBox.checked && debugLabel.isConnected ? await probeDebug() : []

      const { kind, text } = intentOf(note)
      const comment = {
        ...captured,
        rect,
        n: ++seq,
        note: text,
        transient: frame ? true : undefined,
        debug: debug.length ? debug : undefined,
        shot: shot || undefined,
        question: kind === 'question' || undefined,
        status: kind === 'backlog' ? 'backlog' : 'pending',
      }
      comments.push(comment)
      chrome.storage.local.set({ [PREFS_KEY]: { wantShot, wantDebug } }).catch(() => {})
      closeCard()
      save()
      render()
      if (kind === 'backlog') sendToBacklog(comment)
    }

    add.onclick = submit
    cancel.onclick = closeCard
    box.addEventListener('input', paintIntent)
    box.addEventListener('keydown', ev => {
      if (onArrow(ev)) return
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit() }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeCard() }
    })
    crumbs.addEventListener('keydown', ev => {
      if (onArrow(ev)) return
      if (ev.key === 'Enter') { ev.preventDefault(); box.focus() }
    })

    // The buffer is read again at submit — this first look only decides whether the
    // toggle is worth showing, and what to label it.
    probeDebug().then(entries => {
      if (!entries.length || !openCard || openCard !== card) return
      debugCount.textContent = ` debug (${entries.length})`
      debugLabel.title = entries.slice(0, 3).map(e => `${e.kind}: ${e.text}`).join('\n')
      row.insertBefore(debugLabel, row.querySelector('.spacer'))
    })

    selectDepth(0)
    paintIntent()
  }

  /**
   * Backlog items never enter the queue: they are appended to the project's own
   * `.pinpoint/backlog.md` and have no expiry, where a dispatched batch is a delivery
   * buffer pruned after a day. A write that fails leaves the pin marked unsaved rather
   * than vanishing, because the alternative is losing the comment silently.
   */
  async function sendToBacklog(comment) {
    let res
    try {
      res = await chrome.runtime.sendMessage({
        type: 'backlog',
        payload: {
          origin: location.origin,
          url: location.href,
          pathname: location.pathname,
          title: document.title,
          viewport: { w: innerWidth, h: innerHeight },
          comment: {
            note: comment.note,
            selector: comment.selector,
            tag: comment.tag,
            elementId: comment.elementId,
            classes: comment.classes,
            role: comment.role,
            ariaLabel: comment.ariaLabel,
            text: comment.text,
            html: comment.html,
            rect: comment.rect,
            styles: comment.styles,
            parents: comment.parents,
            transient: comment.transient,
            debug: comment.debug,
            component: comment.component,
            question: comment.question,
            shot: comment.shot,
          },
        },
      })
    } catch (err) {
      res = { ok: false, error: String(err) }
    }

    if (res?.ok) {
      comment.backlogId = res.id
      comment.unsaved = false
      say(`#${comment.n} → backlog`)
    } else {
      comment.unsaved = true
      say(res?.error || 'backlog write failed', true)
    }
    save()
    render()
  }

  const STATE_LABEL = {
    pending: 'pending',
    sent: 'dispatched',
    resolved: 'resolved',
    answered: 'answered',
    backlog: 'backlog',
  }

  function openPinCard(comment, x, y) {
    const card = el('div', 'card')
    card.append(el('div', 'meta', `${comment.component ? `<${comment.component}>  ` : ''}${comment.selector}`))
    if (comment.question) card.append(el('div', 'kind', 'question — no files changed'))
    if (comment.transient) card.append(el('div', 'kind frozen', 'pinned from a frozen frame'))
    card.append(el('div', 'note', comment.note))

    if (comment.answer) card.append(el('div', 'answer', comment.answer))
    if (comment.resolution) card.append(el('div', 'resolution', `✓ ${comment.resolution}`))

    const row = el('div', 'row')
    const parts = [STATE_LABEL[comment.status] ?? comment.status]
    if (comment.status === 'backlog' && comment.unsaved) parts.push('not written — bridge down')
    if (comment.debug?.length) parts.push(`${comment.debug.length} console`)
    if (!comment.shot) parts.push('no screenshot')
    const status = el('span', 'meta', parts.join(' · '))
    const remove = el('button', 'danger', comment.status === 'resolved' ? 'Dismiss' : 'Remove')
    row.append(status, el('span', 'spacer'))

    if (comment.status === 'backlog' && comment.unsaved) {
      const retry = el('button', '', 'Retry')
      retry.onclick = () => { closeCard(); sendToBacklog(comment) }
      row.append(retry)
    }
    row.append(remove)
    card.append(row)

    remove.onclick = () => {
      comments = comments.filter(c => c !== comment)
      closeCard()
      save()
      render()
    }

    layer.append(card)
    openCard = card
    placeCard(card, x + 12, y + 12)
  }

  // ---------------------------------------------------------------- pins

  const pins = el('div', 'layer')
  layer.append(pins)

  /** Pin elements, one per comment, rebuilt only when the list itself changes. */
  let pinNodes = []

  function renderPins() {
    pins.textContent = ''
    pinNodes = comments.map(c => {
      const pin = el('div', 'pin', c.status === 'resolved' ? '✓' : String(c.n))
      pin.classList.toggle('sent', c.status === 'sent')
      pin.classList.toggle('resolved', c.status === 'resolved')
      pin.classList.toggle('answered', c.status === 'answered')
      pin.classList.toggle('backlog', c.status === 'backlog')
      pin.classList.toggle('question', !!c.question && c.status !== 'resolved')
      pin.classList.toggle('unsaved', !!c.unsaved)
      pin.title = c.note
      pin.addEventListener('click', ev => {
        ev.preventDefault()
        ev.stopPropagation()
        if (openCard) { closeCard(); return }
        openPinCard(c, ev.clientX, ev.clientY)
      })
      pins.append(pin)
      return { pin, comment: c }
    })
    positionPins()
  }

  /**
   * Re-resolve each element from its selector before positioning: an app that re-renders
   * replaces nodes, and a pin stuck to a stale rect is worse than no pin. When the element
   * is genuinely gone the pin stays at its last document position, dimmed.
   */
  function positionPins() {
    for (const { pin, comment } of pinNodes) {
      let live = null
      try { live = document.querySelector(comment.selector) } catch { /* stale selector */ }
      if (live) {
        const r = live.getBoundingClientRect()
        comment.docX = Math.round(r.left + scrollX)
        comment.docY = Math.round(r.top + scrollY)
        pin.classList.remove('detached')
      } else {
        pin.classList.add('detached')
      }
      pin.style.left = `${comment.docX - scrollX}px`
      pin.style.top = `${comment.docY - scrollY}px`
    }
  }

  let queued = false
  function schedulePins() {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; positionPins() })
  }

  addEventListener('scroll', schedulePins, { passive: true, capture: true })
  addEventListener('resize', () => { schedulePins(); clampBar() }, { passive: true })

  // ---------------------------------------------------------------- toolbar

  const bar = el('div', 'bar')
  const grip = el('div', 'grip', '⌖')
  const dot = el('div', 'dot')
  const modeBtn = el('button', 'mode', 'Comment')
  const count = el('div', 'count', '0')
  const sendBtn = el('button', 'primary', 'Dispatch')
  const clearBtn = el('button', '', '✕')
  clearBtn.title = 'Clear all pins on this page'
  bar.append(grip, dot, modeBtn, count, sendBtn, clearBtn)
  layer.append(bar)

  const toast = el('div', 'toast')
  layer.append(toast)

  let toastTimer
  function say(text, bad) {
    toast.textContent = text
    toast.classList.toggle('bad', !!bad)
    toast.classList.add('show')
    const r = bar.getBoundingClientRect()
    toast.style.left = `${Math.max(8, r.left)}px`
    toast.style.top = `${Math.max(8, r.top - 36)}px`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200)
  }

  modeBtn.onclick = () => setMode(!mode)
  clearBtn.onclick = () => {
    if (!comments.length) return
    comments = []
    seq = 0
    closeCard()
    save()
    render()
  }

  // Drag by the grip only, so the buttons stay clickable.
  let drag = null
  grip.addEventListener('pointerdown', ev => {
    const r = bar.getBoundingClientRect()
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top }
    grip.setPointerCapture(ev.pointerId)
  })
  grip.addEventListener('pointermove', ev => {
    if (!drag) return
    setBarPos(ev.clientX - drag.dx, ev.clientY - drag.dy)
  })
  grip.addEventListener('pointerup', ev => {
    if (!drag) return
    drag = null
    grip.releasePointerCapture(ev.pointerId)
    const r = bar.getBoundingClientRect()
    chrome.storage.local.set({ [BAR_KEY]: { x: r.left, y: r.top } })
  })

  function setBarPos(x, y) {
    const r = bar.getBoundingClientRect()
    bar.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`
    bar.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`
  }

  function clampBar() {
    const r = bar.getBoundingClientRect()
    setBarPos(r.left, r.top)
  }

  // ---------------------------------------------------------------- render

  function render() {
    const pending = comments.filter(c => c.status === 'pending').length
    count.textContent = String(pending)
    sendBtn.disabled = pending === 0
    sendBtn.textContent = pending ? `Dispatch ${pending}` : 'Dispatch'
    renderPins()
    // Mirror the count onto the toolbar icon, so a tab you scrolled away from still shows it.
    chrome.runtime.sendMessage({ type: 'count', n: pending }).catch(() => {})
  }

  // ---------------------------------------------------------------- dispatch

  sendBtn.onclick = async () => {
    const outgoing = comments.filter(c => c.status === 'pending')
    if (!outgoing.length) return

    sendBtn.disabled = true

    // One uncropped shot for layout context — but only when this batch has crops at all.
    // If you turned screenshots off, you meant off.
    let pageShot = null
    if (outgoing.some(c => c.shot)) {
      sendBtn.textContent = 'Capturing…'
      pageShot = frame ? frame.shot : await captureViewport()
    }
    // Screenshots are the whole point of the batch arriving with context. Say so when
    // one is missing, rather than letting Claude receive a text-only comment quietly.
    if (wantShot && !outgoing.some(c => c.shot)) say('dispatching without screenshots', true)
    sendBtn.textContent = 'Sending…'

    const payload = {
      pageShot: pageShot || undefined,
      origin: location.origin,
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      comments: outgoing.map(c => ({
        note: c.note,
        selector: c.selector,
        tag: c.tag,
        elementId: c.elementId,
        classes: c.classes,
        role: c.role,
        ariaLabel: c.ariaLabel,
        text: c.text,
        html: c.html,
        rect: c.rect,
        styles: c.styles,
        parents: c.parents,
        transient: c.transient,
        debug: c.debug,
        component: c.component,
        question: c.question,
        shot: c.shot,
      })),
    }

    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'dispatch', payload })
    } catch (err) {
      res = { ok: false, error: String(err) }
    }

    if (res?.ok) {
      // The server numbers comments by their position in what we just sent, so record
      // that mapping — Phase 4 resolves pins by "<batch>#<n>".
      outgoing.forEach((c, i) => {
        c.status = 'sent'
        c.batch = res.batch
        c.serverN = i + 1
      })
      say(`Dispatched ${outgoing.length} to Claude Code`)
      setMode(false)
      save()
    } else {
      say(res?.error || 'dispatch failed', true)
    }
    render()
  }

  // ---------------------------------------------------------------- health

  async function ping() {
    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'ping' })
    } catch {
      res = null
    }
    connected = !!res?.connected
    dot.classList.toggle('on', connected)
    dot.title = connected ? `bridge up · ${res.projectDir ?? ''}` : 'bridge down — is a Claude Code session running?'
  }

  // ---------------------------------------------------------------- bridge events

  /**
   * The other direction: Claude resolving a comment greys its pin out here, which is the
   * only signal that the fix has landed without switching to the terminal. Events are
   * matched on the server's own numbering, recorded at dispatch time.
   */
  const byServerId = id => comments.find(c => c.batch && `${c.batch}#${c.serverN}` === id)

  function onBridgeEvent(ev) {
    if (!ev) return

    // An addressed reply is the answer to a question pin, so it lands on the card and
    // stays there. An unaddressed one is a status line, and a toast is all it deserves.
    if (ev.type === 'reply') {
      const hit = ev.id ? byServerId(ev.id) : null
      if (hit) {
        hit.answer = ev.text
        if (hit.status !== 'resolved') hit.status = 'answered'
        save()
        render()
      }
      if (ev.text) say(`${hit ? `#${hit.n} — ` : ''}${ev.text}`.slice(0, 180))
      return
    }

    if (ev.type === 'backlog-done') {
      const done = comments.find(c => c.backlogId && c.backlogId === ev.id)
      if (!done || done.status === 'resolved') return
      done.status = 'resolved'
      if (ev.outcome) done.resolution = ev.outcome
      save()
      render()
      say(`✓ #${done.n} done${ev.outcome ? ` — ${ev.outcome}` : ''}`)
      return
    }

    if (ev.type !== 'resolved') return
    const hit = byServerId(ev.id)
    if (!hit || hit.status === 'resolved') return

    hit.status = 'resolved'
    if (ev.resolution) hit.resolution = ev.resolution
    save()
    render()
    say(`✓ #${hit.n} resolved${ev.resolution ? ` — ${ev.resolution}` : ''}`)
  }

  // ---------------------------------------------------------------- storage

  let saveTimer
  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [KEY]: { seq, comments } }).catch(() => {
        // Over quota. Screenshots are the bulky part and the least costly to lose —
        // keeping the notes and their selectors matters far more.
        const lean = comments.map(({ shot, ...rest }) => rest)
        chrome.storage.local.set({ [KEY]: { seq, comments: lean } }).catch(() => {})
      })
    }, 150)
  }

  async function load() {
    const got = await chrome.storage.local.get([KEY, BAR_KEY, PREFS_KEY])
    const prefs = got[PREFS_KEY]
    if (prefs && typeof prefs.wantShot === 'boolean') wantShot = prefs.wantShot
    if (prefs && typeof prefs.wantDebug === 'boolean') wantDebug = prefs.wantDebug
    const saved = got[KEY]
    if (saved) {
      comments = Array.isArray(saved.comments) ? saved.comments : []
      seq = Number(saved.seq) || comments.length
    }
    const pos = got[BAR_KEY]
    if (pos) setBarPos(pos.x, pos.y)
    else setBarPos((innerWidth - bar.getBoundingClientRect().width) / 2, innerHeight - 56)
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    // ping-content is how the worker checks whether this page already has us, before
    // it decides to inject. It must answer, or the worker injects a second copy.
    if (msg?.type === 'ping-content') { respond({ ok: true }); return false }
    if (msg?.type === 'toggle') { setMode(!mode); respond({ ok: true, mode }); return false }
    if (msg?.type === 'freeze') { freezeFrame(); respond({ ok: true }); return false }
    if (msg?.type === 'bridge-event') { onBridgeEvent(msg.event); respond({ ok: true }); return false }
    return false
  })

  addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return
    if (openCard) { closeCard(); return }
    if (frame) { releaseFrame(); setMode(false); return }
    if (mode) setMode(false)
  }, true)

  await load()
  render()
  ping()
  setInterval(ping, 5000)
})()
