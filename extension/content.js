/**
 * Pinpoint overlay.
 *
 * Mounts a comment toolbar into a shadow root on any localhost page. You toggle comment
 * mode, click elements, write notes, and hit Dispatch; the batch goes to the service
 * worker, which posts it to the local bridge and into a Claude Code session.
 *
 * Two rules shape the whole file:
 *   - the host page's DOM is never mutated (highlights and pins are our own absolutely
 *     positioned elements, not outlines applied to page nodes). The single exception is
 *     the composer's token picker, which writes an inline style to show a picked value on
 *     the real element — and unwinds it on every path out of the card, including before
 *     the screenshot is taken.
 *   - the host page's CSS can never reach us, and ours can never reach it (shadow root)
 */
;(async function () {
  /**
   * Reloading an unpacked extension does not clear the isolated world it already has in
   * every open tab. The previous copy of this script keeps running there — orphaned, its
   * `chrome.runtime` dead, its overlay still painted — and the flag it set is still on
   * `window`. A bare `if (flag) return` therefore made a freshly injected copy bail out
   * and hand the page straight back to the corpse, which is what "I reloaded the
   * extension and nothing changed" actually is.
   *
   * So the marker carries a liveness test instead of a boolean. `chrome.runtime.id` is
   * captured in the *previous* copy's closure and reads undefined once that copy is
   * orphaned, which is the only reliable way to tell "someone already owns this page"
   * from "someone used to".
   */
  const prior = window.__PINPOINT__
  if (prior?.alive?.()) return
  try { prior?.unmount?.() } catch { /* it is going away either way */ }
  // Versions before this one had nothing to unmount with, so evict their host by hand.
  document.getElementById('pinpoint-host')?.remove()
  window.__PINPOINT__ = { alive: () => !!chrome.runtime?.id, unmount: () => {} }

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
  let frozen = null          // element awaiting a note
  let openCard = null        // the composer or pin card currently on screen
  /** Sticky: whatever you chose last time is the default next time, so turning
      screenshots off once keeps them off without a separate global switch. */
  let wantShot = true
  /** Same stickiness, but the toggle only exists when the page has actually logged
      something — see the composer. */
  // On by default, unlike the screenshot toggle. The ring only ever holds the page's own
  // errors — everything other extensions log is invisible to it — so a non-empty one is
  // almost always worth sending, and the ⚠ on the toolbar makes it easy to see and undo.
  let wantDebug = true

  // ---------------------------------------------------------------- shadow root

  const host = document.createElement('div')
  host.id = 'pinpoint-host'
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'

  const root = host.attachShadow({ mode: 'open' })
  // Tokens first: overlay.css only ever says var(--pp-*), and tokens.css defines them.
  const sheet = name => fetch(chrome.runtime.getURL(name)).then(r => r.text()).catch(() => '')
  const css = (await Promise.all([sheet('tokens.css'), sheet('overlay.css')])).join('\n')
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

  // ---------------------------------------------------------------- design system

  /**
   * The runtime half of the design-system probe. The bridge reads the project's config
   * files; this reads what the page actually resolved, which is the only path that reaches
   * a theme built with styled-components, Emotion, vanilla-extract, or nothing at all.
   *
   * Custom properties are read off `:root` through getComputedStyle rather than out of
   * the stylesheets: a cross-origin sheet refuses `.cssRules`, and a value set from JS is
   * in no sheet at all. The computed style is where every source ends up regardless.
   */
  const MAX_VARS = 120

  function cssVariables() {
    const out = {}
    try {
      const style = getComputedStyle(document.documentElement)
      for (let i = 0; i < style.length && Object.keys(out).length < MAX_VARS; i++) {
        const name = style[i]
        if (!name.startsWith('--')) continue
        const value = style.getPropertyValue(name).trim()
        // A whole gradient or font stack is not a token worth carrying into the payload.
        if (value && value.length <= 80) out[name] = value
      }
    } catch { /* a page can do surprising things to its own root; a missing probe is fine */ }
    return out
  }

  /**
   * Which component library rendered this page, by the marks its components leave.
   *
   * Ids only — the names live on the bridge, so there is one table to correct when a
   * library renames its marks rather than two that can disagree.
   */
  const DOM_MARKS = [
    ['shadcn', '[data-slot]'],
    ['radix', '[data-radix-popper-content-wrapper],[data-radix-scroll-area-viewport]'],
    ['mui', '[class*="Mui"]'],
    ['antd', '[class*="ant-"]'],
    ['chakra', '[class*="chakra-"]'],
    ['mantine', '[class*="mantine-"]'],
  ]

  /** Libraries that announce themselves in the variables rather than in the markup. */
  const VAR_MARKS = [['bootstrap', '--bs-'], ['mantine', '--mantine-']]

  function fingerprints(vars) {
    const found = new Set()
    for (const [id, selector] of DOM_MARKS) {
      try { if (document.querySelector(selector)) found.add(id) } catch { /* skip */ }
    }
    const names = Object.keys(vars)
    for (const [id, prefix] of VAR_MARKS) {
      if (names.some(n => n.startsWith(prefix))) found.add(id)
    }
    return [...found]
  }

  /** Gathered once per dispatch: it describes the page, not any one element. */
  function designSystem() {
    const vars = cssVariables()
    return { vars, fingerprints: fingerprints(vars) }
  }

  const NO_SCALES = { detected: false, step: null, color: [], spacing: [], type: [], radius: [] }

  /**
   * The project's scales, as the bridge sees them: its config files merged with what this
   * page reports. Asked for once and kept — the answer cannot change while you are
   * commenting, and the composer must open at the speed of a click.
   *
   * The bridge does the merging and the normalising. What comes back is already sorted
   * and already in px and hex, so nothing here has to re-implement colour parsing and
   * then disagree with the brief about what a token is.
   */
  let scalesPromise = null
  let scalesFor = null
  function scales() {
    // Keyed on the project the bridge reads the scales from, which moves with the pick
    // and with what the page's dev server turns out to be.
    if (scalesFor !== status.project) { scalesPromise = null; scalesFor = status.project }
    scalesPromise ??= chrome.runtime
      .sendMessage({ type: 'design-system', pick: status.projectPick ?? undefined, payload: { designSystem: designSystem() } })
      .then(r => (r?.ok && r.detected ? r : NO_SCALES))
      .catch(() => NO_SCALES)
    return scalesPromise
  }

  /** Computed values are always px; anything else is not a length we can put on a scale. */
  const parsePx = value => {
    const m = String(value).trim().match(/^(-?\d*\.?\d+)px$/)
    return m ? Number(m[1]) : null
  }

  /**
   * The properties worth a chip: the ones people comment on, and the ones a scale can
   * actually answer. Order is the order they appear.
   */
  const CHIP_PROPS = [
    { prop: 'padding', group: 'spacing', label: 'padding' },
    { prop: 'gap', group: 'spacing', label: 'gap' },
    { prop: 'font-size', group: 'type', label: 'size' },
    { prop: 'border-radius', group: 'radius', label: 'radius' },
    { prop: 'color', group: 'color', label: 'text' },
    { prop: 'background-color', group: 'color', label: 'bg' },
  ]

  /** The token whose value this is, or null. */
  function tokenFor(data, group, value) {
    const scale = data[group]
    if (!scale?.length) return null
    if (group === 'color') {
      const hex = String(value).trim().toLowerCase().slice(0, 7)
      return scale.find(t => t.hex === hex) ?? null
    }
    const px = parsePx(value)
    return px == null ? null : (scale.find(t => t.px === px) ?? null)
  }

  /** Token names are long and the chip row is narrow; the prefix is the least useful part. */
  const shortToken = name => String(name).replace(/^--/, '')

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
    // The composer can leave a preview applied to a page element. Every path out of the
    // card has to unwind it — Escape, clicking away, submitting — so the hook lives here
    // rather than on the one button anyone remembers to wire it to.
    try { openCard?.cleanup?.() } catch { /* a broken cleanup must not trap the card open */ }
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
    // The page's console and network failures are deliberately NOT here. They are a
    // property of the page, not of the element: an error thrown by clicking one button
    // would ride along with a comment pinned to another, which reads as evidence and is
    // not. What the composer says about this element is what it measured on it — the
    // chips, and the ⚠ on any value that is off the project's scale. The page's errors
    // live on the toolbar, next to Dispatch, where a page-level fact belongs.

    const chips = el('div', 'chips')
    const picker = el('div', 'picker')

    const cancel = el('button', '', 'Cancel')
    const add = el('button', 'primary', 'Add')
    row.append(shotLabel, el('span', 'spacer'), cancel, add)
    card.append(crumbs, meta, chips, picker, box, hint, row)
    layer.append(card)
    openCard = card
    card.cleanup = restorePreviews
    // Whether Park is possible changes with the 5s ping, so the toolbar repaints this.
    card.repaintIntent = () => paintIntent()
    placeCard(card, x + 12, y + 12)
    box.focus()

    // ------------------------------------------------------------ token chips

    /** Picked values, by property. These are the comment's least ambiguous content. */
    const deltas = new Map()
    /** Inline styles we overwrote to show a pick, so they can be put back exactly. */
    const previewed = new Map()
    /** What the bridge knows about the project's scales; null until it answers. */
    let data = null
    let openPicker = null

    /**
     * Put the page back exactly as it was found.
     *
     * This is the one place Pinpoint writes to the host page's DOM, and it is a
     * deliberate exception: seeing the value on the real element beats reading it as
     * text. The exception is only defensible because it is always undone — on cancel, on
     * Escape, on walking to another element, and before the screenshot is taken, so the
     * picture shows the problem rather than the proposal.
     */
    function restorePreviews() {
      for (const [node, saved] of previewed) {
        for (const [prop, was] of saved) {
          // Priority is part of the original: an inline `!important` that came back
          // without it would be a change we made and did not admit to.
          if (was.value) node.style.setProperty(prop, was.value, was.priority)
          else node.style.removeProperty(prop)
        }
      }
      previewed.clear()
    }

    function preview(node, prop, value) {
      let saved = previewed.get(node)
      if (!saved) previewed.set(node, (saved = new Map()))
      // Only the first overwrite is the original. Picking twice must not save the preview.
      if (!saved.has(prop)) {
        saved.set(prop, { value: node.style.getPropertyValue(prop), priority: node.style.getPropertyPriority(prop) })
      }
      // `important`, because a preview that loses to the page's own stylesheet shows
      // nothing and reads as a broken control.
      node.style.setProperty(prop, value, 'important')
    }

    /** Record a pick, show it on the element, and repaint the row around it. */
    function pick(entry, current, currentToken, value, token) {
      const node = target
      if (value === current) {
        deltas.delete(entry.prop)
      } else {
        deltas.set(entry.prop, {
          prop: entry.prop,
          from: current,
          fromToken: currentToken ? shortToken(currentToken.name) : undefined,
          to: value,
          toToken: token ? shortToken(token.name) : undefined,
        })
        preview(node, entry.prop, value)
      }
      closePicker()
      paintChips()
      paintIntent()
      box.focus()
    }

    function closePicker() {
      openPicker = null
      picker.textContent = ''
      picker.classList.remove('show')
    }

    /**
     * The scale around the current value, not the whole scale. A spacing ramp is twenty
     * steps long and a palette is a hundred swatches; what anyone actually wants is the
     * next one up or down, and the cap is what keeps the card a card.
     */
    function nearby(scale, px, span = 4) {
      if (px == null) return scale.slice(0, span * 2 + 1)
      let closest = 0
      scale.forEach((t, i) => {
        if (Math.abs(t.px - px) < Math.abs(scale[closest].px - px)) closest = i
      })
      return scale.slice(Math.max(0, closest - span), closest + span + 1)
    }

    function openPickerFor(entry, current, currentToken) {
      if (openPicker === entry.prop) { closePicker(); return }
      picker.textContent = ''
      openPicker = entry.prop
      picker.classList.add('show')

      const scale = data?.[entry.group] ?? []

      if (entry.group === 'color') {
        // Nothing to pick from without a palette: a colour has no neighbours to step to,
        // so the chip stays a readout rather than pretending to be a control.
        if (!scale.length) { closePicker(); return }
        const grid = el('div', 'swatches')
        for (const t of scale.slice(0, 28)) {
          const swatch = el('button', 'swatch')
          swatch.style.background = t.hex
          swatch.title = `${shortToken(t.name)} — ${t.value}`
          swatch.classList.toggle('on', t.hex === String(current).toLowerCase().slice(0, 7))
          swatch.onclick = () => pick(entry, current, currentToken, t.hex, t)
          grid.append(swatch)
        }
        picker.append(grid)
        return
      }

      const px = parsePx(current)
      if (scale.length) {
        const ramp = el('div', 'ramp')
        for (const t of nearby(scale, px)) {
          const step = el('button', 'step')
          step.classList.toggle('on', t.px === px)
          const bar = el('span', 'bar')
          // Spacing reads as a size, so show it as one. Capped, or one outlier token
          // squashes every other rung flat.
          bar.style.width = `${Math.min(t.px, 64)}px`
          step.append(bar, el('span', 'name', shortToken(t.name)), el('span', 'val', t.value))
          step.onclick = () => pick(entry, current, currentToken, `${t.px}px`, t)
          ramp.append(step)
        }
        picker.append(ramp)
        return
      }

      // No scale to pick from, so the honest fallback: nudge the number. Shift moves by
      // four, which is the step almost every hand-rolled layout turns out to use anyway.
      if (px == null) { closePicker(); return }
      const stepper = el('div', 'stepper')
      const readout = el('span', 'val', `${px}px`)
      let next = px
      const nudge = by => {
        next = Math.max(0, Math.round((next + by) * 100) / 100)
        readout.textContent = `${next}px`
        preview(target, entry.prop, `${next}px`)
      }
      const down = el('button', '', '−')
      const up = el('button', '', '+')
      const apply = el('button', 'primary', 'Use')
      down.onclick = ev => nudge(ev.shiftKey ? -4 : -1)
      up.onclick = ev => nudge(ev.shiftKey ? 4 : 1)
      apply.onclick = () => pick(entry, current, currentToken, `${next}px`, null)
      stepper.append(down, readout, up, el('span', 'spacer'), apply)
      picker.append(stepper)
    }

    /**
     * One chip per property the element actually sets. A chip says what the value is in
     * the project's own words — or says it belongs to no scale, which is the thing worth
     * knowing before you write a word of the note.
     */
    function paintChips() {
      chips.textContent = ''
      const styles = captured.styles ?? {}

      for (const entry of CHIP_PROPS) {
        const current = styles[entry.prop]
        if (!current) continue

        const delta = deltas.get(entry.prop)
        const shown = delta ? delta.to : current
        const token = data ? tokenFor(data, entry.group, shown) : null
        const px = parsePx(shown)
        // A shorthand is several values; a scale answers one. Showing it is useful,
        // offering to replace all four sides with one number is not.
        const multi = /\s/.test(String(shown).trim())
        const offScale = !token && !multi && entry.group === 'spacing'
          && data?.step && px != null && px > 0 && px % data.step !== 0

        const chip = el('button', 'chip')
        chip.classList.toggle('warn', !!offScale)
        chip.classList.toggle('changed', !!delta)
        chip.append(el('span', 'chip-key', entry.label))
        if (entry.group === 'color') {
          const dot = el('span', 'chip-dot')
          dot.style.background = String(shown)
          chip.append(dot)
        }
        chip.append(el('span', 'chip-val', token ? shortToken(token.name) : String(shown)))
        if (offScale) chip.append(el('span', 'chip-warn', '⚠'))

        const pickable = !multi && (entry.group === 'color' ? (data?.color.length ?? 0) > 0 : px != null)
        chip.disabled = !pickable
        chip.title = [
          `${entry.prop}: ${current}`,
          token ? `matches ${shortToken(token.name)}` : null,
          offScale ? `off the ${data.step}px scale` : null,
          delta ? `will be requested as ${delta.to}` : null,
          pickable ? null : 'no scale to pick from',
        ].filter(Boolean).join(' · ')

        const currentToken = data ? tokenFor(data, entry.group, current) : null
        if (pickable) chip.onclick = () => openPickerFor(entry, current, currentToken)
        chips.append(chip)
      }

      chips.classList.toggle('show', chips.childElementCount > 0)
    }

    // The scales arrive after the card does. Chips are painted twice on purpose: raw
    // values immediately, token names a moment later, rather than an empty row while the
    // bridge is asked.
    scales().then(answer => {
      if (openCard !== card) return
      data = answer
      paintChips()
    })

    // ------------------------------------------------------------ depth

    /**
     * Move the selection to one level of the chain. Everything the composer shows and
     * everything the comment will carry — selector, component, highlight, and the rect
     * the screenshot is cropped to — is derived from here, so walking the chain and
     * having clicked that element in the first place are indistinguishable downstream.
     */
    function selectDepth(i) {
      const moved = chain[depth]?.node !== chain[Math.max(0, Math.min(i, chain.length - 1))]?.node
      if (moved) {
        // Picks belong to the element they were made on. Carrying them up the chain would
        // silently retarget a request at a container nobody was looking at.
        restorePreviews()
        deltas.clear()
        closePicker()
      }
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
      paintChips()

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
      // Park needs a project to write into, though not a running session.
      add.disabled = kind === 'backlog' && !status.canPark
      hint.textContent =
        kind === 'question' ? 'question — Claude answers on the pin and changes no files'
        : kind === 'backlog' && !status.canPark ? 'Pick a project from the status pill first.'
        : kind === 'backlog' ? 'parked — appended to .pinpoint/backlog.md, never dispatched'
        : deltas.size ? `${deltas.size} picked value${deltas.size === 1 ? '' : 's'} ride with this comment`
        : ''
      hint.classList.toggle('show', !!hint.textContent)
    }

    // ------------------------------------------------------------ submit

    const submit = async () => {
      const picks = [...deltas.values()]
      // A picked value is a complete request on its own — "padding → p-8" leaves nothing
      // to ask about — so the note stops being mandatory once there is one.
      const note = box.value.trim()
        || picks.map(d => `${d.prop} → ${d.toToken ?? d.to}`).join(', ')
      if (!note) { box.focus(); return }
      // Checked here and not only on the button, because ⌘↵ calls this directly.
      if (intentOf(note).kind === 'backlog' && !status.canPark) { paintIntent(); box.focus(); return }

      // Put the page back before the picture is taken. The screenshot is evidence of the
      // problem; the deltas are the proposal. A shot of the proposal would document a
      // change that has not been made anywhere.
      restorePreviews()

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

      const { kind, text } = intentOf(note)

      // A backlog item is written straight to a file with no batch around it, so it is
      // the one comment that has nowhere else to carry the page's errors. Dispatched
      // comments do not need them here — the batch sends them once, for all of them.
      const debug = kind === 'backlog' && wantDebug ? await probeDebug() : []
      const comment = {
        ...captured,
        rect,
        n: ++seq,
        note: text,
        transient: frame ? true : undefined,
        deltas: picks.length ? picks : undefined,
        debug: debug.length ? debug : undefined,
        shot: shot || undefined,
        question: kind === 'question' || undefined,
        status: kind === 'backlog' ? 'backlog' : 'pending',
      }
      comments.push(comment)
      dismissTip()
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
        pick: status.projectPick ?? undefined,
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
            deltas: comment.deltas,
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

  /**
   * After this many rounds on one pin, the card stops offering a reply box.
   *
   * Deliberately low. A long negotiation belongs in the session, where there is room to
   * argue and a transcript to argue against; a card that lets it run forever turns the
   * overlay into a bad chat client, which is the one thing it must not become.
   */
  const MAX_ROUNDS = 3

  /**
   * A second go at a pin that came back not quite right, carrying the first go with it.
   *
   * The comment is reopened rather than duplicated: same pin, same element, a new round.
   * A second pin on the same node would say the first request had been abandoned, which
   * is exactly wrong — it was answered, just not well enough.
   */
  async function sendFollowUp(comment, text) {
    const prior = comment.batch && comment.serverN ? `${comment.batch}#${comment.serverN}` : undefined

    let rect = comment.rect
    let shot = comment.shot
    let live = null
    try { live = document.querySelector(comment.selector) } catch { /* stale selector */ }
    if (live) {
      const r = live.getBoundingClientRect()
      rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      // A fresh crop, because the element has been edited since the first round and the
      // old picture now shows a state nobody is talking about.
      if (wantShot) {
        const viewport = await captureViewport()
        shot = (viewport ? await cropTo(viewport, rect) : null) ?? shot
      }
    }

    comment.followUpOf = prior
    comment.round = (comment.round ?? 1) + 1
    comment.note = text
    comment.rect = rect
    comment.shot = shot
    comment.status = 'pending'
    // The previous round's answer is now history: it is in the brief the bridge builds
    // from `followUpOf`, and leaving it on the card would read as still true.
    comment.resolution = undefined
    comment.answer = undefined
    comment.progress = undefined
    comment.deltas = undefined

    save()
    render()
    await dispatchComments([comment])
  }

  const STATE_LABEL = {
    pending: 'pending',
    sent: 'dispatched',
    resolved: 'resolved',
    answered: 'answered',
    backlog: 'backlog',
  }

  /**
   * The three things a comment can be, which is the whole composer vocabulary: `?` asks,
   * `!` parks, anything else is a fix request. Each gets its own band in the card, so a
   * stack of comments on one element is readable without opening them one at a time.
   */
  const kindOf = c => (c.question ? 'question' : c.status === 'backlog' ? 'backlog' : 'action')

  /**
   * What makes two comments share a pin. No selector means a node that vanished from a
   * frozen frame: it has no element to share, so it keys to itself rather than pooling
   * with every other orphan.
   */
  const stackKey = c => c.selector || `\u0000#${c.n}`

  /** One comment, as a section of a pin card. `refresh` rebuilds the card around it. */
  function commentSection(comment, stacked, refresh) {
    const sect = el('div', `sect ${kindOf(comment)}`)
    if (comment.status === 'resolved') sect.classList.add('done')

    if (comment.question) sect.append(el('div', 'kind', 'question — no files changed'))
    if (comment.status === 'backlog') sect.append(el('div', 'kind parked', 'parked — not dispatched'))
    if (comment.transient) sect.append(el('div', 'kind frozen', 'pinned from a frozen frame'))
    sect.append(el('div', 'note', comment.note))

    if (comment.deltas?.length) {
      const asked = el('div', 'deltas')
      for (const d of comment.deltas) {
        asked.append(el('div', 'delta', `${d.prop}: ${d.fromToken ?? d.from} → ${d.toToken ?? d.to}`))
      }
      sect.append(asked)
    }

    if (comment.answer) sect.append(el('div', 'answer', comment.answer))
    if (comment.resolution) sect.append(el('div', 'resolution', `✓ ${comment.resolution}`))

    // What Claude did, as outcomes. Files and a state, never a transcript.
    if (comment.progress && comment.status !== 'resolved') {
      const p = el('div', `progress ${comment.progress.state}`)
      p.append(el('div', 'progress-head', comment.progress.state === 'working'
        ? (comment.progress.note || 'working…')
        : (comment.progress.note || 'edited')))
      for (const f of comment.progress.files ?? []) p.append(el('div', 'file', f))
      sect.append(p)
    }

    const row = el('div', 'row')
    // The number is only worth showing when there is more than one to tell apart — on a
    // lone comment it just repeats what the pin already says.
    const parts = [`${stacked ? `#${comment.n} · ` : ''}${STATE_LABEL[comment.status] ?? comment.status}`]
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
    sect.append(row)

    // A reply box on a pin Claude has already spoken on: either it resolved the comment
    // and got it not quite right, or it asked a question mid-fix and is waiting.
    const answered = comment.status === 'resolved' || comment.status === 'answered'
    const round = comment.round ?? 1
    if (answered && round < MAX_ROUNDS) {
      const box = el('textarea', 'reply')
      box.placeholder = comment.status === 'answered' ? 'Answer…' : 'Still not right?'
      box.rows = 2
      const send = el('button', 'primary', 'Send')
      const sendRow = el('div', 'row')
      sendRow.append(el('span', 'spacer'), send)
      const go = async () => {
        const text = box.value.trim()
        if (!text) { box.focus(); return }
        send.disabled = true
        send.textContent = 'Sending…'
        closeCard()
        await sendFollowUp(comment, text)
      }
      send.onclick = go
      box.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go() }
        // Escape belongs to the card, but only once the box is empty — otherwise it
        // throws away something typed.
        if (ev.key === 'Escape' && box.value) { ev.stopPropagation(); box.value = '' }
      })
      sect.append(box, sendRow)
    } else if (answered && round >= MAX_ROUNDS) {
      sect.append(el('div', 'hint show', `${round} rounds on this one — take it to the terminal`))
    }

    remove.onclick = () => {
      comments = comments.filter(c => c !== comment)
      save()
      render()
      // The card is rebuilt around what is left rather than closed. Clearing three
      // comments off one element should not mean finding the pin again three times.
      refresh()
    }
    return sect
  }

  /**
   * A pin card covers every comment on that element, in the order they were written, and
   * is rebuilt in place as they come and go — so it closes only when you close it, or when
   * the last comment under it is gone.
   */
  function openPinCard(stack, x, y) {
    const key = stackKey(stack[0])
    const card = el('div', 'card')

    function fill() {
      const live = comments.filter(c => stackKey(c) === key)
      if (!live.length) { closeCard(); return }

      card.textContent = ''
      const head = live[0]
      const stacked = live.length > 1

      const top = el('div', 'card-head')
      top.append(el('div', 'meta',
        `${head.component ? `<${head.component}>  ` : ''}${head.selector}${stacked ? `  ·  ${live.length} comments` : ''}`))
      const close = el('button', 'close', '✕')
      close.title = 'Close'
      close.onclick = closeCard
      top.append(close)
      card.append(top)

      for (const c of live) card.append(commentSection(c, stacked, fill))
      card.refresh = fill
      // Re-anchor: the card is shorter now, and a clamped one should drift back toward
      // the pin rather than stay pushed up against the viewport edge.
      placeCard(card, x + 12, y + 12)
    }

    layer.append(card)
    openCard = card
    fill()
  }

  // ---------------------------------------------------------------- pins

  const pins = el('div', 'layer')
  // Starts hidden along with the bar; see setHidden.
  pins.style.display = 'none'
  layer.append(pins)

  /** Pin elements, one per *element*, rebuilt only when the list itself changes. */
  let pinNodes = []

  /**
   * Comments on the same element share one pin. Every pin sits at its element's top-left,
   * so a second comment on the same node used to land on the same pixel and hide the first
   * one entirely — the older comment was still there, just unreachable. Grouping by selector
   * rather than by coordinates keeps the key honest: same element, same stack, even while
   * the page reflows underneath.
   */
  function stacks() {
    const byEl = new Map()
    for (const c of comments) {
      const key = stackKey(c)
      const got = byEl.get(key)
      if (got) got.push(c)
      else byEl.set(key, [c])
    }
    return [...byEl.values()]
  }

  /** Which comment a stacked pin looks like: the one most in need of attention, newest first. */
  const PIN_RANK = { pending: 0, answered: 1, sent: 2, backlog: 3, resolved: 4 }
  const leadOf = stack =>
    [...stack].sort((a, b) => (PIN_RANK[a.status] ?? 9) - (PIN_RANK[b.status] ?? 9) || b.n - a.n)[0]

  function renderPins() {
    pins.textContent = ''
    pinNodes = stacks().map(stack => {
      const c = leadOf(stack)
      const pin = el('div', 'pin', c.status === 'resolved' ? '✓' : String(c.n))
      pin.classList.toggle('sent', c.status === 'sent')
      pin.classList.toggle('resolved', c.status === 'resolved')
      pin.classList.toggle('answered', c.status === 'answered')
      pin.classList.toggle('backlog', c.status === 'backlog')
      pin.classList.toggle('question', !!c.question && c.status !== 'resolved')
      pin.classList.toggle('unsaved', stack.some(x => x.unsaved))
      pin.classList.toggle('stack', stack.length > 1)
      pin.classList.toggle('working', stack.some(x => x.progress?.state === 'working' && x.status !== 'resolved'))
      if (stack.length > 1) pin.dataset.more = String(stack.length - 1)
      pin.title = stack.map(x => `#${x.n} ${x.note}`).join('\n')
      pin.addEventListener('click', ev => {
        ev.preventDefault()
        ev.stopPropagation()
        if (openCard) { closeCard(); return }
        openPinCard(stack, ev.clientX, ev.clientY)
      })
      pins.append(pin)
      return { pin, comment: c, stack }
    })
    positionPins()
  }

  /**
   * Re-resolve each element from its selector before positioning: an app that re-renders
   * replaces nodes, and a pin stuck to a stale rect is worse than no pin. When the element
   * is genuinely gone the pin stays at its last document position, dimmed.
   */
  function positionPins() {
    for (const { pin, comment, stack } of pinNodes) {
      let live = null
      try { live = document.querySelector(comment.selector) } catch { /* stale selector */ }
      if (live) {
        const r = live.getBoundingClientRect()
        // Every comment in the stack shares the element, so every one gets the fresh
        // position — a comment that later stands alone must not carry a stale rect.
        for (const c of stack) {
          c.docX = Math.round(r.left + scrollX)
          c.docY = Math.round(r.top + scrollY)
        }
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

  // Named, because unmount has to be able to take them off again.
  const onScroll = schedulePins
  const onResize = () => { schedulePins(); clampBar() }
  addEventListener('scroll', onScroll, { passive: true, capture: true })
  addEventListener('resize', onResize, { passive: true })

  // ---------------------------------------------------------------- toolbar

  const bar = el('div', 'bar')
  const grip = el('div', 'grip', '⌖')
  const dot = el('div', 'dot')
  const modeBtn = el('button', 'mode', 'Comment')
  const count = el('div', 'count', '0')
  const sendBtn = el('button', 'primary', 'Dispatch')
  /**
   * ✕ dismisses the overlay. It used to mean "clear all pins", which made it a dead
   * button on every page that had none — you press the one control that looks like a
   * close button and nothing at all happens. A ✕ on a floating widget means close; the
   * destructive action needed its own affordance rather than the universal glyph.
   */
  const closeBtn = el('button', '', '✕')
  closeBtn.title = 'Hide Pinpoint — the toolbar icon brings it back'
  // Only mounted when there is something to clear, for the same reason the ⚠ is.
  const clearBtn = el('button', 'danger', 'Clear')
  clearBtn.title = 'Remove every pin on this page'
  // Mounted only when the page has actually logged something, and sitting next to
  // Dispatch because that is what it modifies: what the whole batch carries with it.
  const bugBtn = el('button', 'bug', '')
  bar.append(grip, dot, modeBtn, count, sendBtn, closeBtn)
  // Hidden from the first frame rather than shown and then hidden, so a page load never
  // flashes the toolbar. setHidden owns the state from here on.
  bar.style.display = 'none'
  layer.append(bar)

  // ---------------------------------------------------------------- page errors

  /**
   * What the page logged, as opposed to what an element looks like.
   *
   * This lives on the toolbar rather than in the composer because it is true of the
   * page, not of any element on it: a fetch that 404s on click is not evidence about
   * whichever button you happen to pin afterwards. So it is read once, shown once, and
   * sent once — with the batch, not with a comment.
   *
   * The console you can already see is a poor substitute: almost everything in it comes
   * from other extensions running in their own isolated worlds, which this cannot see
   * and would not want to send. This list is only the page's own.
   */
  let pageDebug = []

  const bugPanel = el('div', 'debug bug-panel')
  const bugHead = el('div', 'debug-head')
  const bugLabel = el('label', 'toggle')
  const bugBox = document.createElement('input')
  bugBox.type = 'checkbox'
  const bugLabelText = document.createTextNode('send with the batch')
  bugLabel.append(bugBox, bugLabelText)
  const bugClose = el('button', 'debug-more', 'close')
  const bugList = el('div', 'debug-list')
  bugHead.append(bugLabel, el('span', 'spacer'), bugClose)
  bugPanel.append(bugHead, bugList)
  layer.append(bugPanel)

  function paintBugList() {
    bugList.textContent = ''
    // Newest first: the thing that just went wrong is why the panel is open.
    for (const e of pageDebug.slice().reverse()) {
      const item = el('div', 'debug-entry')
      item.append(el('span', `debug-kind ${e.kind}`, e.kind), el('span', 'debug-text', e.text))
      if (e.n > 1) item.append(el('span', 'debug-n', `×${e.n}`))
      bugList.append(item)
      // Where it came from, on demand. The stack is the answer to "what generates this",
      // and a `title` was never an answer: a tooltip is invisible until you already know
      // to hover, which is the same as not being there.
      if (!e.stack) continue
      item.classList.add('has-stack')
      const stack = el('div', 'debug-stack', e.stack)
      bugList.append(stack)
      item.onclick = () => {
        item.classList.toggle('open', stack.classList.toggle('show'))
        placeBugPanel()   // it just changed height, and it is anchored by its bottom edge
      }
    }
  }

  /**
   * Above the bar, never below it — the bar already sits at the bottom of the viewport.
   * Measured rather than assumed: the list grows when a stack is expanded, and `bottom`
   * is no use here because everything else in the layer is positioned from the top.
   */
  function placeBugPanel() {
    const r = bar.getBoundingClientRect()
    const w = bugPanel.offsetWidth || 320
    const h = bugPanel.offsetHeight || 140
    bugPanel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`
    bugPanel.style.top = `${Math.max(8, r.top - h - 8)}px`
  }

  function closeBugPanel() {
    bugPanel.classList.remove('show')
  }

  /** Re-read the ring and keep the button honest about what is in it. */
  async function refreshDebug() {
    pageDebug = await probeDebug()
    const n = pageDebug.length
    bugBtn.textContent = `⚠ ${n}`
    bugBtn.title = n
      ? `${n} error${n === 1 ? '' : 's'} logged by this page — click to read them`
      : ''
    if (n && !bugBtn.isConnected) bar.insertBefore(bugBtn, sendBtn)
    if (!n) { bugBtn.remove(); closeBugPanel() }
    if (bugPanel.classList.contains('show')) { paintBugList(); placeBugPanel() }
  }

  bugBtn.onclick = async () => {
    if (bugPanel.classList.contains('show')) { closeBugPanel(); return }
    await refreshDebug()
    if (!pageDebug.length) return
    bugBox.checked = wantDebug
    paintBugList()
    bugPanel.classList.add('show')
    placeBugPanel()
  }
  bugClose.onclick = closeBugPanel
  bugBox.onchange = () => {
    wantDebug = bugBox.checked
    chrome.storage.local.set({ [PREFS_KEY]: { wantShot, wantDebug } }).catch(() => {})
  }

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
    closeCard()
    save()
    render()
  }

  /**
   * Hidden, not unloaded. The pins stay in storage and the probe keeps its ring buffer —
   * this is "get out of my way while I look at the page", not "forget everything". The
   * toolbar icon brings it back, which is also how it was summoned in the first place.
   *
   * Every page load starts hidden, and that is deliberate: the script mounts on every
   * localhost page, and a toolbar sitting over an app you only meant to look at is in the
   * way more often than not. Nothing is stored, so the next load is hidden again. Comments,
   * the bridge and the badge keep running underneath, exactly as they do after ✕.
   */
  let hidden = true
  function setHidden(on) {
    hidden = on
    if (on) { setMode(false); closeBugPanel() }
    bar.style.display = on ? 'none' : ''
    pins.style.display = on ? 'none' : ''
    // Place the bar first: the tip is anchored to it.
    if (!on) { placed ? clampBar() : placeBar(); paintTip() }
  }

  // Closing the toolbar is a clear enough "I have seen it" for the tip as well.
  closeBtn.onclick = () => { dismissTip(); setHidden(true) }

  // Drag by the grip only, so the buttons stay clickable.
  let drag = null
  grip.addEventListener('pointerdown', ev => {
    const r = bar.getBoundingClientRect()
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top }
    // The panel is anchored to where the bar was, so it cannot come along for the ride.
    closeBugPanel()
    grip.setPointerCapture(ev.pointerId)
  })
  grip.addEventListener('pointermove', ev => {
    if (!drag) return
    setBarPos(ev.clientX - drag.dx, ev.clientY - drag.dy)
    if (tip.classList.contains('show')) placeTip()
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
    // A display:none bar measures as a 0x0 box at the origin, which would clamp it into
    // the top-left corner. It is clamped again on the way back in instead.
    if (hidden) return
    const r = bar.getBoundingClientRect()
    setBarPos(r.left, r.top)
  }

  /**
   * First placement waits until the bar is actually on screen. Centring needs its width,
   * and a hidden bar has none, so placing it at load would park it off-centre by half a
   * toolbar. load() fills in the saved spot; the first show uses it.
   */
  let savedPos = null
  let placed = false
  function placeBar() {
    if (savedPos) setBarPos(savedPos.x, savedPos.y)
    else setBarPos((innerWidth - bar.getBoundingClientRect().width) / 2, innerHeight - 56)
    placed = true
  }

  // ---------------------------------------------------------------- render

  function render() {
    // Numbering is per page and purely cosmetic — the server numbers a batch by position,
    // independently of this. So once the page is clear, the next comment is #1 again
    // rather than continuing a count nobody can still see.
    if (!comments.length) seq = 0
    const pending = comments.filter(c => c.status === 'pending').length
    count.textContent = String(pending)
    sendBtn.disabled = pending === 0
    sendBtn.textContent = pending ? `Dispatch ${pending}` : 'Dispatch'
    paintDispatch()
    renderPins()
    // Clear only exists while there is something to clear.
    if (comments.length && !clearBtn.isConnected) bar.insertBefore(clearBtn, closeBtn)
    if (!comments.length) clearBtn.remove()
    // Mirror the count onto the toolbar icon, so a tab you scrolled away from still shows it.
    chrome.runtime.sendMessage({ type: 'count', n: pending }).catch(() => {})
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Send a set of comments as one batch. Factored out of the toolbar button because a
   * follow-up on a green pin dispatches on its own, without waiting for the next time
   * someone presses Dispatch — the reply *is* the send.
   */
  async function dispatchComments(outgoing, onStatus = () => {}) {
    if (!outgoing.length) return false
    // A follow-up dispatches from a pin card, not the toolbar, so the toolbar's block has
    // to hold here too, or a dead pick would be sidestepped by replying on a pin.
    if (!status.canDispatch) {
      say(status.heading, true)
      openPop()
      return false
    }

    // One uncropped shot for layout context — but only when this batch has crops at all.
    // If you turned screenshots off, you meant off.
    let pageShot = null
    if (outgoing.some(c => c.shot)) {
      onStatus('Capturing…')
      pageShot = frame ? frame.shot : await captureViewport()
    }
    // Screenshots are the whole point of the batch arriving with context. Say so when
    // one is missing, rather than letting Claude receive a text-only comment quietly.
    if (wantShot && !outgoing.some(c => c.shot)) say('dispatching without screenshots', true)
    onStatus('Sending…')

    const payload = {
      pageShot: pageShot || undefined,
      origin: location.origin,
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      designSystem: designSystem(),
      // Once for the batch, not once per comment: the page logged these, not the
      // elements. Re-read now — the interesting error is often the last one, thrown
      // while the notes were being written.
      debug: wantDebug ? await probeDebug() : undefined,
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
        followUpOf: c.followUpOf,
        round: c.round,
        deltas: c.deltas,
        debug: c.debug,
        component: c.component,
        question: c.question,
        shot: c.shot,
      })),
    }

    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'dispatch', payload, pick: PinpointStatus.dispatchPick(status) })
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
      rememberLast(res.projectDir)
      save()
    } else {
      say(res?.error || 'dispatch failed', true)
    }
    render()
    return !!res?.ok
  }

  sendBtn.onclick = async () => {
    if (sendBtn.classList.contains('blocked')) { openPop(); return }
    const outgoing = comments.filter(c => c.status === 'pending')
    if (!outgoing.length) return
    sendBtn.disabled = true
    const ok = await dispatchComments(outgoing, text => { sendBtn.textContent = text })
    if (ok) setMode(false)
    render()
  }

  // ---------------------------------------------------------------- health

  /**
   * The dot became a pill: dot plus a short label saying where Dispatch would go, and a
   * popover with the running sessions to choose from. What it says is worked out in
   * status.js, which is pure so it can be tested; this half only paints it.
   *
   * The popover lives inside the bar rather than in the layer. It is anchored to the pill
   * anyway, it follows a drag for free, and hiding the bar (✕, or the icon) takes it away
   * with it without the hide path having to know it exists.
   */
  const PORT = PinpointStatus.portOf(location)
  // Per port, not per origin: localhost:5173 and 127.0.0.1:5173 are one dev server.
  const PICK_KEY = `pinpoint:pick:${PORT}`
  const LAST_KEY = `pinpoint:last:${PORT}`

  /** @type {{projectDir: string, name: string} | null} */
  let chosen = null
  let lastDir = null
  let lastHealth = null
  // Until the first ping answers nothing is known, and Offline would be a claim. Waiting
  // is the honest state, and it keeps Dispatch blocked for the half second it lasts.
  let status = PinpointStatus.view({ connected: true, route: { how: 'reconnecting' } }, null, PORT, null)

  const routeLoaded = chrome.storage.local.get([PICK_KEY, LAST_KEY]).then(got => {
    const p = got[PICK_KEY]
    if (p && typeof p.projectDir === 'string') chosen = { projectDir: p.projectDir, name: String(p.name ?? '') }
    if (typeof got[LAST_KEY] === 'string') lastDir = got[LAST_KEY]
  }).catch(() => {})

  const pill = el('button', 'pill')
  const pillMark = el('span', 'pill-mark', '⚑')
  const pillLabel = el('span', 'pill-label')
  // A version apart is a quiet mark after the label, never a new colour or a blocked
  // button: everything still works, and the popover says what to run.
  const pillWarn = el('span', 'pill-warn', '!')
  // The old status dot moves inside the pill rather than being rebuilt, so the toolbar's
  // own layout code stays as it was.
  bar.insertBefore(pill, dot)
  pill.append(dot, pillMark, pillLabel, pillWarn)
  pillMark.style.display = 'none'
  pillWarn.style.display = 'none'
  pillLabel.textContent = status.label

  const EXT_VERSION = chrome.runtime.getManifest().version
  /** The bridge and this extension on different versions, or null. status.js decides. */
  let versionInfo = null

  const pop = el('div', 'pop')
  const popHead = el('div', 'pop-head')
  const popLines = el('div', 'pop-lines')
  const popList = el('div', 'pop-list')
  const popFoot = el('div', 'pop-foot')
  const popRetry = el('button', '', 'Retry')
  popFoot.append(popRetry)
  const popVersion = el('div', 'pop-version')
  /**
   * The way back to the welcome page, in every state, Offline included: that is when a
   * new user most needs it. The worker opens it, because a content script cannot open
   * an extension page itself.
   */
  const popHow = el('button', 'pop-row pop-how')
  popHow.append(el('span', 'pop-name', 'How it works'), el('span', 'pop-path', '›'))
  popHow.onclick = () => { chrome.runtime.sendMessage({ type: 'open-welcome' }).catch(() => {}); closePop() }
  pop.append(popHead, popLines, popList, popFoot, popVersion, popHow)
  bar.append(pop)

  const popOpen = () => pop.classList.contains('show')

  /** What the popover last showed, so a ping that changed nothing touches nothing. */
  let popShown = ''

  function openPop() {
    if (popOpen()) return
    pop.classList.add('show')
    popShown = ''
    paintPop()
    paintTip()
  }

  function closePop() {
    pop.classList.remove('show')
    paintTip()
  }

  /**
   * Above the bar, unless the bar was dragged near the top and there is no room. Left
   * edge on the pill's, slid back in when the bar sits near the right edge. The width is
   * capped by the viewport in CSS, so on a narrow window it fits once slid.
   */
  function placePop() {
    const r = bar.getBoundingClientRect()
    pop.classList.toggle('below', r.top < (pop.offsetHeight || 200) + 16)
    const w = pop.offsetWidth
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8))
    pop.style.left = `${left - r.left}px`
  }

  function paintPop() {
    if (!popOpen()) return
    // Rebuilding on every ping would drop a click that lands mid-rebuild and lose focus.
    const shown = JSON.stringify([status.heading, status.lines, status.retry, status.rows, versionInfo?.line])
    if (shown === popShown) { placePop(); return }
    popShown = shown
    popHead.textContent = status.heading
    popLines.textContent = ''
    for (const line of status.lines) popLines.append(el('div', 'pop-line', line))
    popFoot.style.display = status.retry ? '' : 'none'
    popVersion.textContent = ''
    popVersion.style.display = versionInfo ? '' : 'none'
    if (versionInfo) popVersion.append(el('span', 'pop-version-mark', '!'), el('span', '', versionInfo.line))

    // Rebuilt on every ping, so keep the scroll where the reader left it.
    const scroll = popList.scrollTop
    popList.textContent = ''
    popList.style.display = status.rows ? '' : 'none'
    for (const row of status.rows ?? []) {
      const item = el('button', `pop-row${row.selected ? ' on' : ''}`)
      item.append(el('span', 'pop-mark', row.selected ? '●' : '○'), el('span', 'pop-name', row.name))
      if (row.path) item.append(el('span', 'pop-path', row.path))
      item.onclick = () => choose(row)
      popList.append(item)
    }
    popList.scrollTop = scroll
    placePop()
  }

  /** A pick applies at once and the popover stays open, so the new heading confirms it. */
  async function choose(row) {
    chosen = row.dir ? { projectDir: row.dir, name: row.name } : null
    if (chosen) chrome.storage.local.set({ [PICK_KEY]: chosen }).catch(() => {})
    else chrome.storage.local.remove(PICK_KEY).catch(() => {})
    applyStatus()
    await ping()
  }

  function applyStatus() {
    status = PinpointStatus.view(lastHealth, chosen, PORT, lastDir)
    versionInfo = PinpointStatus.versionNote(lastHealth, EXT_VERSION)
    dot.classList.toggle('on', status.dot)
    pillMark.style.display = status.pin ? '' : 'none'
    pillWarn.style.display = versionInfo ? '' : 'none'
    pillLabel.textContent = status.label
    pill.title = status.sendsTo ? `Sending to ${PinpointStatus.tilde(status.sendsTo)}` : status.heading
    paintDispatch()
    paintPop()
    paintTip()
    openCard?.repaintIntent?.()
  }

  /**
   * Blocked, not disabled: a disabled button gets no hover and no click, and both have
   * to open the popover so the reason is one gesture away. Nothing is queued while it
   * is blocked; the comments stay pending on the page.
   */
  function paintDispatch() {
    const blocked = !status.canDispatch
    sendBtn.classList.toggle('blocked', blocked)
    sendBtn.setAttribute('aria-disabled', String(blocked))
  }

  pill.onclick = () => (popOpen() ? closePop() : openPop())
  popRetry.onclick = () => ping()
  sendBtn.addEventListener('mouseenter', () => { if (sendBtn.classList.contains('blocked')) openPop() })

  /** Outside means outside both the popover and the controls that open it. */
  function onOutside(ev) {
    if (!popOpen()) return
    const path = ev.composedPath()
    if (path.includes(pop) || path.includes(pill) || path.includes(sendBtn)) return
    closePop()
  }
  addEventListener('pointerdown', onOutside, true)

  /**
   * Pings overlap: the 5s beat, Retry, and a pick each send one. Only the newest answer
   * counts, or one asked for the previous pick could land last and undo the new one.
   */
  let pingSeq = 0

  async function ping() {
    await routeLoaded
    const mine = ++pingSeq
    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'ping', pick: chosen?.projectDir })
    } catch {
      res = null
    }
    if (mine !== pingSeq) return
    lastHealth = res
    applyStatus()
    rememberLast(status.sendsTo)
  }

  /** The project this port last sent to, so the Offline popover can say where to start one. */
  function rememberLast(dir) {
    if (!dir || dir === lastDir) return
    lastDir = dir
    chrome.storage.local.set({ [LAST_KEY]: dir }).catch(() => {})
  }

  // ---------------------------------------------------------------- first-show tip

  /**
   * One card, the first time the toolbar is ever on screen, on any page: what to click
   * first and what the pill is for. `pp.tipSeen` in chrome.storage.local is the one flag,
   * shared by every page and port. It reads "shown" once the tip has been on screen (the
   * welcome page ticks its step 3 off that) and true once it is gone for good.
   *
   * It lives inside the bar like the popover, so it follows a drag for free and goes when
   * the bar is hidden. It sits above the bar, never over it, so Comment, the pill and
   * Dispatch stay clickable. It steps aside while the popover is open, since both claim
   * the same space, and comes back when that closes.
   *
   * Gone, and the flag set, on a click on the card or its x, the first comment saved, or
   * the toolbar being closed.
   */
  const TIP_KEY = 'pp.tipSeen'
  /** @type {undefined|'shown'|true} */
  let tipSeen = true   // until storage says otherwise, so it never flashes up for an old user
  const tip = el('div', 'tip')
  const tipText = el('div', 'tip-text')
  const tipLine2 = el('div', 'tip-line')
  tipText.append(el('div', 'tip-head', 'Click Comment, then click any element.'), tipLine2)
  const tipX = el('button', 'tip-x', '✕')
  tipX.title = 'Got it'
  const tipArrow = el('div', 'tip-arrow')
  tip.append(tipText, tipX, tipArrow)
  tip.onclick = () => dismissTip()
  bar.append(tip)

  const tipLoaded = chrome.storage.local.get(TIP_KEY).then(got => { tipSeen = got[TIP_KEY] }).catch(() => {})

  function paintTip() {
    const due = tipSeen !== true && !hidden && !popOpen()
    tip.classList.toggle('show', due)
    if (!due) return
    if (!tipSeen) {
      tipSeen = 'shown'
      chrome.storage.local.set({ [TIP_KEY]: 'shown' }).catch(() => {})
    }
    tipLine2.textContent = PinpointStatus.tipLine(status)
    placeTip()
  }

  /**
   * Above the bar, below it when the bar sits at the top edge, the same rule the popover
   * uses. The arrow points at the middle of Comment wherever the card had to slide to.
   */
  function placeTip() {
    const r = bar.getBoundingClientRect()
    tip.classList.toggle('below', r.top < (tip.offsetHeight || 64) + 16)
    const w = tip.offsetWidth
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) - r.left
    tip.style.left = `${left}px`
    const m = modeBtn.getBoundingClientRect()
    tipArrow.style.left = `${m.left - r.left - left + m.width / 2}px`
  }

  function dismissTip() {
    if (tipSeen === true) return
    tipSeen = true
    tip.classList.remove('show')
    chrome.storage.local.set({ [TIP_KEY]: true }).catch(() => {})
  }

  // Dismissed in another tab: gone here too, rather than waiting for a reload.
  function onStorage(changes, area) {
    if (area !== 'local' || !(TIP_KEY in changes)) return
    if (changes[TIP_KEY].newValue === true) { tipSeen = true; tip.classList.remove('show') }
  }
  chrome.storage.onChanged.addListener(onStorage)

  // ---------------------------------------------------------------- bridge events

  /**
   * The other direction: Claude resolving a comment greys its pin out here, which is the
   * only signal that the fix has landed without switching to the terminal. Events are
   * matched on the server's own numbering, recorded at dispatch time.
   */
  const byServerId = id => comments.find(c => c.batch && `${c.batch}#${c.serverN}` === id)

  /**
   * Every Pinpoint tab hears every event, and events now say which project's session sent
   * them. One about a pin on this page is always ours: batch and backlog ids are unique,
   * and a pin keeps hearing from the session it went to even after the pick has moved on.
   * Anything else stamped with a project is kept only if it is the project this page
   * sends to; status.js has the rule.
   */
  function belongsHere(ev) {
    if (ev.id && (byServerId(ev.id) || comments.some(c => c.backlogId === ev.id))) return true
    return PinpointStatus.eventFor(status, ev.projectDir)
  }

  function onBridgeEvent(ev) {
    if (!ev) return
    if (!belongsHere(ev)) return

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

    // What Claude is doing about this pin, while it is doing it. Outcomes only — the
    // transcript stays in the terminal, and this is not a chat client.
    if (ev.type === 'progress') {
      const hit = byServerId(ev.id)
      if (!hit || hit.status === 'resolved') return
      hit.progress = { state: ev.state, note: ev.text ?? ev.note ?? '', files: ev.files ?? [] }
      save()
      render()
      if (openCard?.refresh) openCard.refresh()
      return
    }

    // A fresh crop of the same element, so Claude can look at its own edit rather than
    // assume it. Best-effort by design: the tab may be gone, the element may be gone, and
    // the screenshot permission may have lapsed on the last navigation.
    if (ev.type === 'recapture') {
      recapture(ev).catch(err => sendRecapture(ev.id, null, String(err?.message ?? err)))
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

  // ---------------------------------------------------------------- re-capture

  function sendRecapture(id, shot, error) {
    chrome.runtime.sendMessage({ type: 'recapture', payload: { id, shot, error } }).catch(() => {})
  }

  async function recapture(ev) {
    // Let a hot reload land first. A crop taken in the same tick as the resolve shows the
    // page before the stylesheet was swapped, which is worse than no crop: it looks like
    // evidence the fix did not work.
    await new Promise(r => setTimeout(r, Math.min(Number(ev.settle) || 0, 2000)))

    let live = null
    try { live = ev.selector ? document.querySelector(ev.selector) : null } catch { /* stale selector */ }
    // Re-measure rather than reusing the old rect: a fix that changes the size is exactly
    // the kind this is meant to catch, and cropping to yesterday's box would clip it.
    let rect = ev.rect
    if (live) {
      const r = live.getBoundingClientRect()
      rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    }
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      sendRecapture(ev.id, null, live ? 'the element has no size' : 'the element is no longer on the page')
      return
    }
    // Off-screen is not a failure worth a picture of the wrong thing.
    if (rect.y + rect.h < 0 || rect.y > innerHeight) {
      sendRecapture(ev.id, null, 'the element is scrolled out of view')
      return
    }

    const viewport = await captureViewport()
    if (!viewport) { sendRecapture(ev.id, null, lastShotError || 'screenshot unavailable'); return }
    const shot = await cropTo(viewport, rect)
    sendRecapture(ev.id, shot, shot ? undefined : lastShotError || 'crop failed')
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
    savedPos = got[BAR_KEY] || null
    // Shown before storage answered: it was centred as a stand-in, so move it now.
    if (!hidden) placeBar()
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    // ping-content is how the worker checks whether this page already has us, before
    // it decides to inject. It must answer, or the worker injects a second copy.
    if (msg?.type === 'ping-content') { respond({ ok: true }); return false }
    // The icon is a plain on/off switch for the overlay. It used to toggle comment mode,
    // but with the overlay starting hidden that made the first click and every later one
    // mean different things. Comment mode lives on the toolbar's own button.
    if (msg?.type === 'toggle') {
      setHidden(!hidden)
      respond({ ok: true, mode, hidden })
      return false
    }
    // Freezing an overlay nobody can see would pin against an invisible toolbar, so the
    // hotkey brings it up first.
    if (msg?.type === 'freeze') {
      if (hidden) setHidden(false)
      freezeFrame()
      respond({ ok: true })
      return false
    }
    if (msg?.type === 'bridge-event') { onBridgeEvent(msg.event); respond({ ok: true }); return false }
    return false
  })

  function onKeydown(ev) {
    if (ev.key !== 'Escape') return
    // The popover is the topmost thing, so it goes first. Stopped here, in the window's
    // capture phase, so the composer's own Escape handler never sees this press.
    if (popOpen()) { ev.preventDefault(); ev.stopImmediatePropagation(); closePop(); return }
    if (openCard) { closeCard(); return }
    if (frame) { releaseFrame(); setMode(false); return }
    if (mode) setMode(false)
  }
  addEventListener('keydown', onKeydown, true)

  /**
   * Everything this script put outside its own shadow root. The next copy of the script
   * calls this before it mounts, so a reloaded extension replaces the overlay instead of
   * stacking a second one on top of a dead one.
   */
  window.__PINPOINT__.unmount = () => {
    removeEventListener('scroll', onScroll, { capture: true })
    removeEventListener('resize', onResize)
    removeEventListener('keydown', onKeydown, true)
    removeEventListener('pointerdown', onOutside, true)
    try { chrome.storage.onChanged.removeListener(onStorage) } catch { /* runtime already gone */ }
    host.remove()
  }

  await load()
  await tipLoaded
  render()
  paintTip()
  ping()
  refreshDebug()
  // Same beat as the health ping. The ring only changes when the page does something,
  // and five seconds is soon enough for a button you are about to go and click.
  setInterval(() => { ping(); refreshDebug() }, 5000)
})()
