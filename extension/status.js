/**
 * Pinpoint connection status: what the toolbar pill, its popover and Dispatch say, worked
 * out from one /health answer plus this port's manual pick.
 *
 * Pure on purpose. No DOM, no chrome.*, so the same file loads as a content script (it
 * runs before content.js and leaves `PinpointStatus` on the isolated world's global) and
 * as a plain import in the Node tests. That is why it has no import or export either: a
 * file with neither is a valid classic script and a valid ES module at the same time.
 */
;(function () {
  const base = p => String(p ?? '').replace(/\/+$/, '').split('/').pop() || ''
  const parentOf = p => base(String(p ?? '').replace(/\/+$/, '').replace(/\/[^/]*$/, ''))
  const isHome = p => /^\/(Users|home)\/[^/]+\/?$/.test(String(p ?? ''))

  /** Home folders read as ~, the way the specs and every terminal show them. */
  const tilde = p => String(p ?? '').replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')

  /**
   * A detected cwd worth naming. The root and a home folder are what Docker, a proxy or
   * `serve` from ~ report, and the bridge refuses to match either, so naming one as "the
   * page's project" would be a confident wrong answer.
   */
  const meaningful = dir => (dir && dir !== '/' && !isHome(dir) ? dir : null)

  /** One name per projectDir; two projects called `app` show their parent: "work/app". */
  function displayNames(sessions) {
    const seen = {}
    for (const s of sessions) seen[base(s.projectDir)] = (seen[base(s.projectDir)] || 0) + 1
    const out = new Map()
    for (const s of sessions) {
      const n = base(s.projectDir)
      const p = parentOf(s.projectDir)
      out.set(s.projectDir, seen[n] > 1 && p ? `${p}/${n}` : n)
    }
    return out
  }

  const inside = (child, parent) =>
    child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

  /**
   * The bridge's own auto match, minus realpath. Only used for the Auto row's label while
   * a manual pick is on, because then the bridge answers for the pick and never says what
   * Auto would have chosen.
   */
  function autoMatch(cwd, dirs) {
    const above = dirs.filter(d => inside(cwd, d)).sort((a, b) => b.length - a.length)
    if (above.length) return above[0]
    const below = dirs.filter(d => inside(d, cwd))
    return below.length === 1 ? below[0] : null
  }

  /**
   * @param {object|null} health  the worker's ping answer: {connected, sessions, route}
   * @param {{projectDir: string, name?: string}|null} pick  this port's manual choice
   * @param {string} port  shown in the "kept for :5173" line
   * @param {string|null} lastDir  last project this port sent to, for the Offline popover
   */
  function view(health, pick, port, lastDir) {
    if (!health?.connected) {
      return {
        state: 'offline', dot: false, pin: false, label: 'Offline',
        canDispatch: false, canPark: false, projectPick: null, project: null,
        heading: 'Claude Code is not running',
        lines: ['Start Claude Code in your project folder, then retry.',
          ...(lastDir ? [`Last used: ${tilde(lastDir)}`] : [])],
        retry: true, rows: null, sendsTo: null,
      }
    }

    // A bridge from before routing answers without `route`. It still delivers, to its
    // own project, exactly as it always did, so it must not end up as "Choose" forever.
    if (!health.route) {
      const dir = health.projectDir || null
      return {
        state: 'legacy', dot: true, pin: false, label: dir ? base(dir) : 'Connected',
        canDispatch: true, canPark: true, projectPick: null, project: dir,
        heading: 'Sending to Claude Code in', lines: dir ? [tilde(dir)] : [],
        retry: false, rows: null, sendsTo: null,
      }
    }

    const sessions = Array.isArray(health.sessions) ? health.sessions : []
    const dirs = sessions.map(s => s.projectDir)
    const names = displayNames(sessions)
    const r = health.route
    const detected = meaningful(r.detected)
    const pickDir = pick?.projectDir || null
    const running = pickDir ? dirs.find(d => same(d, pickDir)) ?? null : null

    // What Auto means for this page, whether or not it is the one in use.
    let auto
    if (!pickDir && r.how === 'auto' && r.projectDir) auto = { dir: r.projectDir }
    else if (detected) auto = autoMatch(detected, dirs) ? { dir: autoMatch(detected, dirs) } : { none: base(detected) }
    else if (dirs.length === 1) auto = { dir: dirs[0] }
    else auto = {}

    const autoLabel = auto.dir ? `Auto: ${names.get(auto.dir) ?? base(auto.dir)}`
      : auto.none ? `Auto: none for ${auto.none}` : 'Auto'
    const rows = [
      { dir: null, name: autoLabel, path: '', selected: !pickDir },
      ...sessions.map(s => ({ dir: s.projectDir, name: names.get(s.projectDir), path: tilde(s.projectDir), selected: same(s.projectDir, pickDir) })),
    ]

    /**
     * Park and the design-system chips need a project, not a live session. With a pick
     * that is the pick, running or not: it is where the user said this page belongs, and
     * the bridge only accepts it if a session has run there. Without one it is the
     * detected project. A pick is never swapped for the detected project, because the
     * user chose against it. `project` is the same answer, for keying caches on.
     */
    const parkTo = pickDir ?? detected
    const common = { rows, retry: false, canPark: !!parkTo, projectPick: pickDir }

    if (r.how === 'reconnecting') {
      return {
        ...common, state: 'connecting', dot: false, pin: !!pickDir, label: 'Connecting',
        canDispatch: false, project: parkTo,
        heading: 'Connecting to Claude Code',
        lines: ['Sessions are reconnecting after a handover. Try again in a few seconds.'],
        sendsTo: null,
      }
    }

    if (pickDir) {
      const name = names.get(running) ?? pick.name ?? base(pickDir)
      // The session list is the truth: a ping answered for the previous pick can still land.
      if (running) {
        return {
          ...common, state: 'manual', dot: true, pin: true, label: name,
          canDispatch: true, project: running,
          heading: 'Sending to Claude Code in', lines: [`${tilde(running)} (your pick)`],
          sendsTo: running,
        }
      }
      // A pick whose session is gone never falls back to Auto: that would send to a
      // project you deliberately chose against.
      return {
        ...common, state: 'manual-gone', dot: false, pin: true, label: name,
        canDispatch: false, project: pickDir,
        heading: `No Claude Code in ${name}`,
        lines: [`Start one in ${tilde(pickDir)}, or send to another project:`],
        sendsTo: null,
      }
    }

    /**
     * Strict routing. The bridge refuses a page detected in a project with no session
     * even when one other session runs, but a bridge from before that rule still answers
     * "only" there, so the same case is caught here too: one click on a row sends it
     * there on purpose instead.
     */
    const matched = (r.how === 'auto' && r.projectDir) || (r.how === 'only' && !detected && r.projectDir)
    if (matched) {
      return {
        ...common, state: 'auto', dot: true, pin: false, label: names.get(matched) ?? base(matched),
        canDispatch: true, canPark: true, project: matched,
        heading: 'Sending to Claude Code in', lines: [tilde(matched)],
        sendsTo: matched,
      }
    }

    if (detected) {
      const name = base(detected)
      return {
        ...common, state: 'none', dot: false, pin: false, label: name,
        canDispatch: false, project: detected,
        heading: `No Claude Code in ${name}`,
        lines: [`Start one in ${tilde(detected)}, or send to another project:`],
        sendsTo: null,
      }
    }

    return {
      ...common, state: 'choose', dot: false, pin: false, label: 'Choose',
      canDispatch: false, project: null,
      heading: 'Which project is this page?', lines: [`Pick one; it is kept for :${port}.`],
      sendsTo: null,
    }
  }

  /** One folder however it is written: the toolbar compares paths the bridge spelled. */
  function same(a, b) {
    if (!a || !b) return false
    const trim = p => String(p).replace(/\/+$/, '') || '/'
    return trim(a) === trim(b)
  }

  /**
   * Whether a bridge event stamped with a project belongs on this page. Only one from the
   * project this page sends to does; in a state with no target (no session here, a pick
   * that is gone, nothing chosen) every stamped event is some other project's. Unstamped
   * events come from a bridge before routing and pass as before.
   */
  function eventFor(v, projectDir) {
    if (!projectDir) return true
    return same(projectDir, v.sendsTo)
  }

  /**
   * What a dispatch names as its target. In Auto it is the project the toolbar is showing,
   * so if that session quit inside the 5s between pings the bridge refuses, rather than
   * re-resolving and quietly falling back to whichever single session is left.
   */
  const dispatchPick = v => v.sendsTo ?? undefined

  /** localhost:5173 and 127.0.0.1:5173 are the same dev server, so they share a key. */
  function portOf(loc) {
    return String(loc.port || (loc.protocol === 'https:' ? '443' : '80'))
  }

  globalThis.PinpointStatus = { view, portOf, tilde, displayNames, same, eventFor, dispatchPick }
})()
