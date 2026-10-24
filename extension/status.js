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
  /**
   * A git worktree reads as its repo: "rigboard worktree", not "agent-a9c963b0e4f734fe4".
   * The bridge names folders itself (it can also read a worktree's .git file); this is the
   * fallback for a bridge that sends no name, and it can only go by the path.
   */
  const nameOf = p => {
    const m = String(p ?? '').replace(/\/+$/, '').match(/^(.*)\/\.claude\/worktrees\/[^/]+$/)
    return m && m[1] ? `${base(m[1])} worktree` : base(p)
  }
  const isHome = p => /^\/(Users|home)\/[^/]+\/?$/.test(String(p ?? ''))

  /** Home folders read as ~, the way the specs and every terminal show them. */
  const tilde = p => String(p ?? '').replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')

  /**
   * A detected cwd worth naming. The root and a home folder are what Docker, a proxy or
   * `serve` from ~ report, and the bridge refuses to match either, so naming one as "the
   * page's project" would be a confident wrong answer.
   */
  const meaningful = dir => (dir && dir !== '/' && !isHome(dir) ? dir : null)

  /**
   * One name per projectDir, the bridge's when it sent one; two projects called `app`
   * show their parent: "work/app". Two worktrees of one repo keep the same name, since
   * their parent is only `worktrees`; the path under each row tells them apart.
   */
  function displayNames(sessions) {
    const nameFor = s => (s.name ? String(s.name) : nameOf(s.projectDir))
    const seen = {}
    for (const s of sessions) seen[nameFor(s)] = (seen[nameFor(s)] || 0) + 1
    const out = new Map()
    for (const s of sessions) {
      const n = nameFor(s)
      const p = parentOf(s.projectDir)
      out.set(s.projectDir, seen[n] > 1 && p && n === base(s.projectDir) ? `${p}/${n}` : n)
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
        state: 'legacy', dot: true, pin: false, label: dir ? nameOf(dir) : 'Connected',
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
    const detectedName = detected ? r.detectedName || nameOf(detected) : null
    const pickDir = pick?.projectDir || null
    const running = pickDir ? dirs.find(d => same(d, pickDir)) ?? null : null

    // What Auto means for this page, whether or not it is the one in use.
    let auto
    if (!pickDir && r.how === 'auto' && r.projectDir) auto = { dir: r.projectDir }
    else if (detected) auto = autoMatch(detected, dirs) ? { dir: autoMatch(detected, dirs) } : { none: detectedName }
    else if (dirs.length === 1) auto = { dir: dirs[0] }
    else auto = {}

    const autoLabel = auto.dir ? `Auto: ${names.get(auto.dir) ?? nameOf(auto.dir)}`
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
        ...common, state: 'connecting', dot: false, pin: !!pickDir, label: 'Reconnecting',
        canDispatch: false, project: parkTo,
        heading: 'Reconnecting to Claude Code',
        lines: ['A Claude Code session just closed. Try again in a few seconds.'],
        sendsTo: null,
      }
    }

    if (pickDir) {
      const name = names.get(running) ?? (pick.name || nameOf(pickDir))
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
        ...common, state: 'auto', dot: true, pin: false, label: names.get(matched) ?? nameOf(matched),
        canDispatch: true, canPark: true, project: matched,
        heading: 'Sending to Claude Code in', lines: [tilde(matched)],
        sendsTo: matched,
      }
    }

    if (detected) {
      const name = detectedName
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
      heading: 'Which project is this page?', lines: [`Pick one; it is kept for ${/^\d+$/.test(port) ? ':' : ''}${port}.`],
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

  /**
   * localhost:5173 and 127.0.0.1:5173 are the same dev server, so they share a key. Any
   * other site is keyed by its host: every https site is port 443, and a pick made for
   * one must not follow the user to the next.
   */
  function portOf(loc) {
    if (loc.hostname && !/^(localhost|127\.0\.0\.1)$/.test(loc.hostname)) return String(loc.host || loc.hostname)
    return String(loc.port || (loc.protocol === 'https:' ? '443' : '80'))
  }

  /**
   * Whether this bridge carries a comment's "Apply to" scope. Only a bridge that says so in
   * /health does; one from before 0.7 answers without `capabilities` and would drop it.
   */
  const canCarryScope = health => !!health?.connected && health?.capabilities?.['comment-scope-v1'] === true

  /**
   * Whether this bridge answers the inbox's Project view with fresh state (POST /inbox). One
   * without project-inbox-v1 still gets the view, from what this browser stored.
   */
  const canProjectInbox = health => !!health?.connected && health?.capabilities?.['project-inbox-v1'] === true

  // ---------------------------------------------------------------- versions

  /**
   * major.minor.patch as numbers, read the way server/version.js reads them: plain dotted
   * numbers, a leading v allowed, anything else 0.0.0. Copied rather than imported, since
   * this file has to stay a classic script. A bridge that sends no version, or one that
   * does not parse, therefore reads as the oldest there is.
   */
  function parseVersion(v) {
    const m = String(v ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0]
  }

  function compareVersions(a, b) {
    const x = parseVersion(a)
    const y = parseVersion(b)
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  }

  const EXTENSION_OLDER = 'Extension is older than the plugin. Run /pinpoint:setup, then press Reload on the Pinpoint card in chrome://extensions.'
  const PLUGIN_OLDER = 'Plugin is older than the extension. Run claude plugin update pinpoint@pinpoint-marketplace, then restart Claude Code.'

  /**
   * Whether the bridge and this extension disagree on their version, and what to do
   * about it. Null when they match, and null while Offline too: with no bridge there is
   * nothing to compare against, and Offline already has its own fix to show.
   *
   * The pill only gains a mark and the popover one line; nothing is blocked, because a
   * version apart usually still works and the user may be mid-review.
   *
   * @param {object|null} health  the worker's ping answer
   * @param {string} extVersion  chrome.runtime.getManifest().version
   * @returns {{older: 'extension'|'plugin', line: string}|null}
   */
  function versionNote(health, extVersion) {
    if (!health?.connected) return null
    const d = compareVersions(health.version, extVersion)
    if (d === 0) return null
    return d > 0 ? { older: 'extension', line: EXTENSION_OLDER } : { older: 'plugin', line: PLUGIN_OLDER }
  }

  // ---------------------------------------------------------------- welcome page

  const SETUP_LINE = 'Run /pinpoint:setup in Claude Code.'

  /**
   * What the welcome page's "Claude Code" box says after one /health, asked without a
   * page, so the bridge answers for no tab in particular. Connected names the running
   * projects the way the popover rows do; not connected gives the one setup line. The
   * version line is the popover's, so the two never word the same problem differently.
   *
   * @param {object|null} health
   * @param {string} extVersion
   * @returns {{connected: boolean, title: string, line: string|null, version: ReturnType<typeof versionNote>}}
   */
  function bridgeSummary(health, extVersion) {
    if (!health?.connected) return { connected: false, title: 'Not connected', line: SETUP_LINE, version: null }
    const sessions = Array.isArray(health.sessions) ? health.sessions : []
    const names = [...displayNames(sessions).values()]
    if (!names.length && health.projectDir) names.push(nameOf(health.projectDir))
    return {
      connected: true,
      title: names.length ? `Connected: ${names.join(', ')}` : 'Connected',
      line: null,
      version: versionNote(health, extVersion),
    }
  }

  /**
   * The first-show tip's second line. Offline gets the fix instead of the explanation,
   * so the first thing a new user reads is what to do about it.
   */
  const tipLine = v => (v?.state === 'offline'
    ? 'Run /pinpoint:setup in Claude Code to connect.'
    : 'The pill shows where comments go.')

  /**
   * The first-show tip's flag in chrome.storage.local, read by the toolbar and by the
   * welcome page's step 3. One name in one place, so the two cannot drift apart.
   */
  const TIP_KEY = 'pp.tipSeen'

  globalThis.PinpointStatus = {
    view, portOf, tilde, displayNames, same, eventFor, dispatchPick,
    compareVersions, versionNote, bridgeSummary, tipLine, TIP_KEY, canCarryScope, canProjectInbox,
  }
})()
