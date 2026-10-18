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
        canDispatch: false, canPark: false, projectPick: null,
        heading: 'Claude Code is not running',
        lines: ['Start Claude Code in your project folder, then retry.',
          ...(lastDir ? [`Last used: ${tilde(lastDir)}`] : [])],
        retry: true, rows: null, sendsTo: null,
      }
    }

    const sessions = Array.isArray(health.sessions) ? health.sessions : []
    const dirs = sessions.map(s => s.projectDir)
    const names = displayNames(sessions)
    const r = health.route ?? {}
    const detected = meaningful(r.detected)
    const pickDir = pick?.projectDir || null

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
      ...sessions.map(s => ({ dir: s.projectDir, name: names.get(s.projectDir), path: tilde(s.projectDir), selected: s.projectDir === pickDir })),
    ]

    // Park and the design-system chips need a project, not a live session. The bridge
    // falls back to the detected cwd when the route is not live, so a pick of the
    // detected dir steers it there in the one case where it would otherwise follow the
    // single running session into the wrong project's backlog (see "strict" below).
    const common = { rows, retry: false }

    if (r.how === 'reconnecting') {
      return {
        ...common, state: 'connecting', dot: false, pin: !!pickDir, label: 'Connecting',
        canDispatch: false, canPark: !!detected, projectPick: pickDir,
        heading: 'Connecting to Claude Code',
        lines: ['Sessions are reconnecting after a handover. Try again in a few seconds.'],
        sendsTo: null,
      }
    }

    if (pickDir) {
      const name = names.get(pickDir) ?? pick.name ?? base(pickDir)
      // The session list is the truth: a ping answered for the previous pick can still land.
      const live = dirs.includes(pickDir)
      if (live) {
        return {
          ...common, state: 'manual', dot: true, pin: true, label: name,
          canDispatch: true, canPark: true, projectPick: pickDir,
          heading: 'Sending to Claude Code in', lines: [`${tilde(pickDir)} (your pick)`],
          sendsTo: pickDir,
        }
      }
      // A pick whose session is gone never falls back to Auto: that would send to a
      // project you deliberately chose against.
      return {
        ...common, state: 'manual-gone', dot: false, pin: true, label: name,
        canDispatch: false, canPark: !!detected, projectPick: pickDir,
        heading: `No Claude Code in ${name}`,
        lines: [`Start one in ${tilde(pickDir)}, or send to another project:`],
        sendsTo: null,
      }
    }

    /**
     * Strict routing. With one session running and a page detected in another project,
     * the bridge still answers "only" (the behaviour from before routing). The picker
     * makes the safe answer cheap, so here that case counts as "no session for this
     * project": one click on a row sends it there on purpose instead.
     */
    const matched = (r.how === 'auto' && r.projectDir) || (r.how === 'only' && !detected && r.projectDir)
    if (matched) {
      return {
        ...common, state: 'auto', dot: true, pin: false, label: names.get(matched) ?? base(matched),
        canDispatch: true, canPark: true, projectPick: null,
        heading: 'Sending to Claude Code in', lines: [tilde(matched)],
        sendsTo: matched,
      }
    }

    if (detected) {
      const name = base(detected)
      return {
        ...common, state: 'none', dot: false, pin: false, label: name,
        canDispatch: false, canPark: true, projectPick: detected,
        heading: `No Claude Code in ${name}`,
        lines: [`Start one in ${tilde(detected)}, or send to another project:`],
        sendsTo: null,
      }
    }

    return {
      ...common, state: 'choose', dot: false, pin: false, label: 'Choose',
      canDispatch: false, canPark: false, projectPick: null,
      heading: 'Which project is this page?', lines: [`Pick one; it is kept for :${port}.`],
      sendsTo: null,
    }
  }

  /** localhost:5173 and 127.0.0.1:5173 are the same dev server, so they share a key. */
  function portOf(loc) {
    return String(loc.port || (loc.protocol === 'https:' ? '443' : '80'))
  }

  globalThis.PinpointStatus = { view, portOf, tilde, displayNames }
})()
