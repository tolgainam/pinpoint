/**
 * One button per framework fixture that fails on purpose.
 *
 * The fixtures are static markup by design — their job is the design-system probe, and a
 * page that runs nothing is the cleanest way to test what a page declares. But a page
 * that runs nothing also logs nothing, and the toolbar's ⚠ only appears when the page has
 * something to report, so on those three pages the feature was invisible.
 *
 * Invisible for the right reason, which is the confusing kind: a devtools console on a
 * fixture page is rarely empty, but everything in it belongs to other extensions running
 * in their own isolated worlds. Pinpoint's probe only sees the page's own errors, so a
 * console full of wallet noise still leaves the ring buffer at zero. This closes that
 * gap with an error the page genuinely owns.
 *
 * Wire it up with `data-misbehave="<tag>"` on any element; the tag names the log line.
 */
;(() => {
  const button = document.querySelector('[data-misbehave]')
  if (!button) return
  const tag = button.dataset.misbehave || 'demo'

  button.addEventListener('click', async () => {
    // A 404 and a console error, which is two of the six kinds the ring records — enough
    // to see that the panel groups them by kind rather than dumping one blob.
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: tag }),
      })
      if (!res.ok) throw new Error(`waitlist failed: ${res.status} ${res.statusText}`)
    } catch (err) {
      console.error(`[${tag}] could not join the waitlist`, err)
    }
  })
})()
