/**
 * The welcome page: opened once on first install, and again from the popover's
 * "How it works" row or right-click icon > Options.
 *
 * Two live things on it and nothing else. The bridge check asks the worker for /health
 * (the worker owns every bridge call) once when the page opens and again on
 * "Check again", never on a timer: a page left open in a tab should not keep pinging.
 * What the answer means is status.js's bridgeSummary, so the version line here is word
 * for word the popover's. Step 3 ticks itself off the toolbar's tip flag, which is set
 * the first time the toolbar is on screen; the other steps are plain guidance.
 */
;(function () {
  const $ = id => document.getElementById(id)
  const EXT_VERSION = chrome.runtime.getManifest().version
  const TIP_KEY = 'pp.tipSeen'

  let checking = false

  async function check() {
    if (checking) return
    checking = true
    $('check-again').disabled = true
    let res = null
    try { res = await chrome.runtime.sendMessage({ type: 'check-bridge' }) } catch { /* worker asleep or gone */ }
    checking = false
    $('check-again').disabled = false
    paint(PinpointStatus.bridgeSummary(res, EXT_VERSION))
  }

  function paint(sum) {
    const box = $('bridge')
    box.dataset.state = sum.connected ? 'connected' : 'offline'
    box.querySelector('.dot').classList.toggle('on', sum.connected)
    $('bridge-title').textContent = sum.title
    $('bridge-line').hidden = !sum.line
    $('bridge-line').textContent = sum.line ?? ''
    $('bridge-version').hidden = !sum.version
    $('bridge-version-text').textContent = sum.version?.line ?? ''
    // "Check again" is for when something is wrong; a healthy answer needs no button.
    $('bridge-foot').hidden = sum.connected && !sum.version
  }

  function tickToolbar(seen) {
    $('step-toolbar').classList.toggle('done', !!seen)
  }

  $('check-again').onclick = check

  chrome.storage.local.get(TIP_KEY).then(got => tickToolbar(got[TIP_KEY])).catch(() => {})
  // The page is often open beside the dev server while someone follows it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TIP_KEY in changes) tickToolbar(changes[TIP_KEY].newValue)
  })

  check()
})()
