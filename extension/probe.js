/**
 * Pinpoint main-world probe.
 *
 * Framework internals (React fibers, Vue instances) are expando properties the page
 * puts on DOM nodes, and a content script runs in an isolated world where those are
 * invisible. So this tiny script runs in the page's own world and answers questions
 * over postMessage.
 *
 * It never receives a DOM node — content.js sends a selector (plus a point as a
 * fallback) and this resolves it here. Nothing is written to the page.
 */
;(() => {
  // executeScript can re-run this on a page that already has it; a second listener
  // would answer every probe twice.
  if (window.__PINPOINT_PROBE__) return
  window.__PINPOINT_PROBE__ = true

  const TAG = 'pinpoint:probe'

  /** Names that tell you nothing about where the code lives. */
  const NOISE = /^(Fragment|Suspense|SuspenseList|StrictMode|Profiler|Provider|Consumer|Context|ForwardRef|Memo|Anonymous|Root|App)$/

  function nameOfType(type) {
    if (!type) return null
    if (typeof type === 'string') return null                 // host element, e.g. 'div'
    if (typeof type === 'function') return type.displayName || type.name || null
    if (typeof type === 'object') {
      return (
        type.displayName ||
        nameOfType(type.render) ||                            // forwardRef
        nameOfType(type.type) ||                              // memo
        null
      )
    }
    return null
  }

  function reactName(el) {
    let fiber = null
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        fiber = el[k]
        break
      }
    }
    if (!fiber) return null

    // React 19 dropped _debugSource, so file:line is gone — but the owner chain still
    // carries the component that rendered this element, which is enough to grep for.
    let node = fiber._debugOwner || fiber.return
    for (let hops = 0; node && hops < 40; hops++) {
      const name = nameOfType(node.type ?? node.elementType)
      if (name && !NOISE.test(name)) return name
      node = node._debugOwner || node.return
    }
    return null
  }

  function vueName(el) {
    let node = el
    for (let hops = 0; node && hops < 40; hops++) {
      const vc = node.__vueParentComponent || node.__vue__
      if (vc) {
        const t = vc.type || vc.$options
        const name = t && (t.name || t.__name || t._componentTag)
        if (name && !NOISE.test(name)) return name
      }
      node = node.parentElement
    }
    return null
  }

  function describe(el) {
    try {
      return reactName(el) || vueName(el) || null
    } catch {
      return null
    }
  }

  window.addEventListener('message', ev => {
    if (ev.source !== window) return
    const d = ev.data
    if (!d || d.tag !== TAG || d.dir !== 'req') return

    let el = null
    if (typeof d.selector === 'string' && d.selector) {
      try { el = document.querySelector(d.selector) } catch { /* selector we built is bad */ }
    }
    if (!el && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      el = document.elementFromPoint(d.x, d.y)
    }

    window.postMessage({ tag: TAG, dir: 'res', id: d.id, component: el ? describe(el) : null }, '*')
  })
})()
