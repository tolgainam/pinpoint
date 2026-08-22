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
  /** Sticky for this page load only, deliberately not persisted. A review pass where
      everything goes to the backlog should not have to tick the box fifteen times, but
      the next page you open must default to dispatching — silently backlogging an
      urgent comment is the one failure mode worth spending a click to avoid. */
  let wantBacklog = false

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
  /** Hashed class names from CSS-in-JS: stable within a build, meaningless across one. */
  const GENERATED_CLASS = /^(css|sc|emotion|jsx|styled|makeStyles)[-_]|^[A-Za-z]+__[A-Za-z0-9]{5,}$|^[a-z]{1,4}-[a-z0-9]{6,}$/
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

  // ---------------------------------------------------------------- component probe

  /** Ask the main-world probe which component rendered this. Never blocks for long. */
  function probeComponent(selector, x, y) {
    return new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      const done = value => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), 250)
      function onMessage(ev) {
        const d = ev.data
        if (ev.source !== window || !d || d.tag !== 'pinpoint:probe' || d.dir !== 'res' || d.id !== id) return
        done(d.component || null)
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ tag: 'pinpoint:probe', dir: 'req', id, selector, x, y }, location.origin)
    })
  }

  // ---------------------------------------------------------------- element capture

  function describe(target) {
    const rect = target.getBoundingClientRect()
    const cls = typeof target.className === 'string' ? target.className.trim() : ''
    return {
      selector: buildSelector(target),
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
  function crumbLabel(entry) {
    if (entry.component) return entry.component
    const node = entry.node
    const cls = Array.from(node.classList || []).find(c => c && c.length < 24 && !GENERATED_CLASS.test(c))
    return node.tagName.toLowerCase() + (cls ? `.${cls}` : '')
  }

  // ---------------------------------------------------------------- intent

  /** A note that opens with `?` is a question: answer it, do not touch files. */
  const isQuestion = note => /^\s*\?/.test(note)

  /** The `?` is a mode switch, not part of the sentence — carrying it through would put
      it in the batch heading and in backlog titles, where it reads as a typo. */
  const stripMarker = note => note.replace(/^\s*\?+\s*/, '').trim() || note.trim()

  // ---------------------------------------------------------------- highlight

  const highlight = el('div', 'highlight')
  const tagLabel = el('div', 'tag')
  highlight.append(tagLabel)
  layer.append(highlight)

  function showHighlight(target, isFrozen) {
    const r = target.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = `${r.left}px`
    highlight.style.top = `${r.top}px`
    highlight.style.width = `${r.width}px`
    highlight.style.height = `${r.height}px`
    highlight.classList.toggle('frozen', !!isFrozen)
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

  /** The topmost page element under the cursor, ignoring our own overlay. */
  function elementUnder(x, y) {
    const stack = document.elementsFromPoint(x, y)
    return stack.find(n => n !== host) || null
  }

  capture.addEventListener('mousemove', ev => {
    if (openCard) return
    const target = elementUnder(ev.clientX, ev.clientY)
    if (target) showHighlight(target, false)
    else hideHighlight()
  })

  capture.addEventListener('click', ev => {
    ev.preventDefault()
    ev.stopPropagation()
    if (openCard) { closeCard(); return }
    const target = elementUnder(ev.clientX, ev.clientY)
    if (!target) return
    frozen = target
    showHighlight(target, true)
    openComposer(target, ev.clientX, ev.clientY)
  })

  function setMode(on) {
    mode = on
    capture.style.display = on ? 'block' : 'none'
    modeBtn.classList.toggle('on', on)
    modeBtn.textContent = on ? 'Commenting' : 'Comment'
    if (!on) { closeCard(); hideHighlight(); frozen = null }
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

  function openComposer(target, x, y) {
    const chain = ancestorChain(target)
    let depth = 0        // index into chain; 0 is the element you clicked
    let captured         // always describes chain[depth].node; set by selectDepth below

    const card = el('div', 'card')
    const crumbs = el('div', 'crumbs')
    crumbs.tabIndex = 0
    crumbs.title = '↑ parent · ↓ child — or click a level'
    const meta = el('div', 'meta', '…')
    const box = el('textarea')
    box.placeholder = 'What is wrong here?   (⌘↵ to add · start with ? to ask)'
    const hint = el('div', 'hint')

    const row = el('div', 'row')
    const shotLabel = el('label', 'toggle')
    const shotBox = document.createElement('input')
    shotBox.type = 'checkbox'
    shotBox.checked = wantShot
    shotLabel.append(shotBox, document.createTextNode('screenshot'))
    const backlogLabel = el('label', 'toggle')
    const backlogBox = document.createElement('input')
    backlogBox.type = 'checkbox'
    backlogBox.checked = wantBacklog
    backlogLabel.append(backlogBox, document.createTextNode('backlog'))
    const cancel = el('button', '', 'Cancel')
    const add = el('button', 'primary', 'Add')
    row.append(shotLabel, backlogLabel, el('span', 'spacer'), cancel, add)
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
      captured = describe(target)
      if (entry.component) captured.component = entry.component
      showHighlight(target, true)
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

    function paintIntent() {
      const asking = isQuestion(box.value)
      add.textContent = asking ? 'Ask' : backlogBox.checked ? 'Backlog' : 'Add'
      add.classList.toggle('ask', asking)
      hint.textContent = asking
        ? 'question — Claude answers on the pin and changes no files'
        : backlogBox.checked
          ? 'goes to .pinpoint/backlog.md, not to the session'
          : ''
      hint.classList.toggle('show', !!hint.textContent)
    }

    // ------------------------------------------------------------ submit

    const submit = async () => {
      const note = box.value.trim()
      if (!note) { box.focus(); return }

      wantShot = shotBox.checked
      wantBacklog = backlogBox.checked
      chrome.storage.local.set({ [PREFS_KEY]: { wantShot } }).catch(() => {})

      // Re-measure: the composer has been open for a while and the app may have moved.
      const live = (() => { try { return document.querySelector(captured.selector) } catch { return null } })() || target
      const r = live.getBoundingClientRect()
      const rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }

      let shot = null
      if (wantShot) {
        add.disabled = true
        add.textContent = 'Capturing…'
        const viewport = await captureViewport()
        shot = viewport ? await cropTo(viewport, rect) : null
        if (!shot) say(`no screenshot — ${lastShotError}`, true)
      }

      const asking = isQuestion(note)
      const comment = {
        ...captured,
        rect,
        n: ++seq,
        note: asking ? stripMarker(note) : note,
        shot: shot || undefined,
        question: asking || undefined,
        status: wantBacklog ? 'backlog' : 'pending',
      }
      comments.push(comment)
      closeCard()
      save()
      render()
      if (wantBacklog) sendToBacklog(comment)
    }

    add.onclick = submit
    cancel.onclick = closeCard
    backlogBox.onchange = paintIntent
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
    card.append(el('div', 'note', comment.note))

    if (comment.answer) card.append(el('div', 'answer', comment.answer))
    if (comment.resolution) card.append(el('div', 'resolution', `✓ ${comment.resolution}`))

    const row = el('div', 'row')
    const parts = [STATE_LABEL[comment.status] ?? comment.status]
    if (comment.status === 'backlog' && comment.unsaved) parts.push('not written — bridge down')
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
      pageShot = await captureViewport()
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
    if (got[PREFS_KEY] && typeof got[PREFS_KEY].wantShot === 'boolean') wantShot = got[PREFS_KEY].wantShot
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
    if (msg?.type === 'bridge-event') { onBridgeEvent(msg.event); respond({ ok: true }); return false }
    return false
  })

  addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return
    if (openCard) { closeCard(); return }
    if (mode) setMode(false)
  }, true)

  await load()
  render()
  ping()
  setInterval(ping, 5000)
})()
