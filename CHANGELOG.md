# Changelog

## 1.0.0

Update both halves. Press Reload on Pinpoint in your browser's extensions page, and run
`claude plugin update pinpoint@pinpoint-marketplace` for the plugin. An older extension with a
newer bridge, or a newer extension with an older bridge, still works. The features that need
both halves stay hidden until both are updated.

- Pinpoint also works in Cowork. Cowork has no channels flag, so there is no live delivery: run
  `/pinpoint:comments` each time to pull comments into the session.
- Apply to: choose which elements a change covers. After you pick a value, the composer shows
  Only this, Same classes, Same component role, Same container or Every tag, each with a count
  for the current page. Hover or focus an option and the members are outlined. Choose one and
  the change previews on all of them. A wider group warns you when its members differ. The
  card of a saved comment says which group it applies to, for example "Applies to: Same
  classes · 3 elements". The bridge checks the group and tells the model that it is a set of
  rendered nodes, that the selector is only a hint, and that the shared source is the place to
  change. Only this changes nothing, as before.
- Pins follow the routes of single-page apps. A page that keeps its state in the URL keeps its
  pins. Pins are stored by origin, path and route. Only `#/path` and `#!/path` count as a route,
  so a hash that only holds state (`#tab=2`) no longer hides pins. Old pins move to the new
  key on their own. A pin made on another URL state says so on its card, and a pin whose element
  is gone is dimmed. Each comment has its own id, and two tabs merge their changes by id, so neither
  loses the other's work.
- Inbox on the toolbar. A badge counts the comments that need you: a failed dispatch, an
  unsaved parked note, an unseen answer, an edit or a resolve, or a pin whose element is gone.
  This page lists them in groups, shows answers in full and jumps to the pin. Project lists the
  comments of the other routes on the same origin and asks the bridge once per opening for
  newer answers. An answer can now say that it needs your input (`requiresResponse`). Nothing
  depends on it being set.
- Keyboard and screen reader. The toolbar is one tab stop with arrow keys. Pins are buttons with
  a spoken name: number, kind, state and note. Escape returns focus to a stated place. A polite
  live region announces results. Focus rings, reduced motion, forced colours and 200 percent
  zoom are handled. Alt+Shift+P shows the toolbar and moves the keyboard to it. This adds a
  command and no permission.
- The design system stays fresh. The bridge re-checks the config and theme files it read, and
  refreshes in the background when they change. A failed refresh keeps the last good summary
  and marks it stale. The status pill has a Refresh design system button, and an open composer
  says when its data may be out of date.
- Screenshots are saved without blocking the bridge, with a size limit of 12 MiB each and
  40 MiB per dispatch. A failed write leaves no half batch behind and the page is told. A
  parked note whose screenshot cannot be saved is kept, with a warning.
- Backlog and history are written under a project lock. Two sessions on one project can write at
  once without losing an entry or finishing the wrong item. A lock left by a dead process is
  recovered.
- Behind the scenes: `npm run check` runs the syntax, design token, repo rule and type checks
  in one go, and CI runs it before the tests. The lockfile now resolves zod and body-parser
  outside the ranges of the high severity advisories.

## 0.4.5

- Two sessions open on one project no longer swap places. A dispatch goes to the session that
  started last. Before, the order was the order they last connected to the bridge, and that
  changes whenever the bridge restarts or is taken over by a newer plugin: the older session
  reconnected after the new one and counted as the newest, so dispatches landed in a terminal
  you were not watching and nothing showed in the one you were.
- When there is a choice, the toolbar says which session got it: "Dispatched 1 to Claude Code
  (2 sessions open: the one started at 17:15)".

## 0.4.4

- Answers no longer go missing when the bridge restarts. The bridge numbers its events from 1 on
  every start, and the extension remembered the last number it had seen, so after a restart it
  asked for "everything after 24" of a bridge that had sent six, and any answer that landed
  while its background worker was reconnecting was lost until the extension was reloaded. Every
  event now names the run of the bridge it belongs to, and a worker that comes back with another
  run's number is given everything.
- An answer is no longer only an event. `reply` saves the answer on the comment in the batch file
  before it sends anything, and the bridge serves what it holds at `GET /state`. A page asks for
  the state of its pins when it loads, when you come back to the tab, when the extension
  reconnects and every 30 seconds while the tab is visible, and fills in what it missed. A missed
  event, a restarted bridge, a sleeping worker or a closed tab now costs nothing: the answer is
  there when you look. The brief also tells Claude when a question was already answered.
- A timer wakes the extension's background worker every 30 seconds, so an answer still arrives
  when the browser window is in the background. This adds the `alarms` permission, which shows
  no warning.

## 0.4.3

- `/pinpoint:setup` and `/pinpoint:doctor` now say what your browser really has. The extension names
  its version to the bridge on every call, so the checks can tell "not installed", "installed but
  older, press Reload" and "connected" apart. Before, setup said to press Reload on a card that
  was not there after you removed the extension.

## 0.4.2

- Typing `?` or `!` at the start of a note now says what it will do at once: a line above the
  box ("You are asking a question", "You are adding to the backlog"), a coloured box, and the
  button becomes Ask or Backlog. The space after the marker is optional, and a marker with
  nothing after it cannot be sent.
- Answers reach the pin. Claude's own calls came as `reply {id, message}` about as often as
  `reply {id, text}`, and the bridge read only `text`, so half the answers arrived empty and the
  pin said "answered" with nothing under it. `reply` now takes either name, refuses an empty
  answer and tells Claude how to call it again, and `resolve_comment` takes the note under
  `note` and the other names Claude uses as well as `resolution`.
- Inspecting pauses while the pointer is over the toolbar, so no highlight hangs over Dispatch.
- The toolbar stays open in a tab once you show it, through reloads, until you close it with the
  cross or the icon. A new tab starts hidden.
- A question's answer opens on its pin by itself, and a "resolved" message no longer covers it.
- The composer sits below the element, or above it when there is no room, and keeps its Add
  button in reach on a short window.
- The toolbar no longer blinks for the whole wait before a screenshot; it hides only for the
  moment of the capture.

## 0.4.1

- Answers go back to the tab that asked. Before, the bridge sent every reply, resolve and
  progress event to every open tab, so two projects on one dev-server port could show each
  other's answers. Now an event goes to the tab that sent the comment. If that tab is gone, or
  now shows another page, the toolbar and the terminal both say so.
- A pin sent to another project is hidden on a page that routes to this one. A manual pick
  hides nothing.
- Claude Code's one-line view of a dispatch now starts with a short label:
  `[Pinpoint localhost:3000/pricing] 3 comments · "Make this button larger" +2 more`.
- Dependencies are current: the MCP SDK is 1.32.1 and `npm audit` reports no vulnerabilities.
- Code scanning findings fixed: CI runs with read-only permissions, and the screenshot
  callback is checked before it is called.
- The clone's own server definition moved from `.mcp.json` to `dev/mcp.json`, so the plugin has
  one server definition and not two. From a clone, start with `claude --mcp-config dev/mcp.json`.
- The README says where Pinpoint works (Claude Code on your own computer) and how to report a
  security problem.
- The npm package is `pinpoint-dev`.

## 0.4.0

- Firefox 128 and newer, and Opera, load the extension. `/pinpoint:setup --firefox` builds the
  Firefox copy (`npm run build:firefox` does the same into `dist/firefox`). Firefox removes
  a temporary add-on when it quits, so load it again after a restart. Safari is not supported.
- Other sites, one at a time. `localhost` stays always on. On any other site, clicking the
  icon asks the browser for that one site; say no and it still works for that page. A yes
  keeps Pinpoint on that site.
- Screenshots without the icon click, if you want them. The welcome page has a button that
  asks the browser once for lasting screenshot access. It is off by default.
- Screenshots no longer fail with Chrome's per-second quota when several are asked for at
  once. They are queued, and a quota error is retried after a second.
- A page left open while the extension reloads now says "Reload this page" instead of
  throwing "Extension context invalidated".
- Bridge token: if the bridge runs with `PINPOINT_TOKEN`, the extension now sends it. Enter
  it on the welcome page. Before this, every dispatch from the extension got a 401.
- `/pinpoint:setup` and the README now say how to start Claude Code with channels on, so
  comments appear in the session on their own (`claude --dangerously-load-development-channels
  plugin:pinpoint@pinpoint-marketplace`). Without it comments wait for `/pinpoint:comments`.
- MIT licence, replacing the source-available one.
- Ready for the Claude plugin directory: a plugin icon, `PRIVACY.md`, a README section that
  lists what Pinpoint runs, writes and sends, and annotations on every MCP tool.
- The extension can be installed from the Chrome Web Store, Mozilla Add-ons and Opera add-ons
  once the listings are live. Loading from a folder stays for developers.
- `npx pinpoint-dev install` adds the plugin to Claude Code from a terminal. `setup` and
  `doctor` run the same checks as the slash commands. pnpm and yarn work too.
- Store packs: `npm run package:extension` builds the zip, and `npm run store:shots` makes the
  screenshots and promo images. Listing text is in `store/`.
- The project website now leads with install buttons for Chrome, Firefox and Opera.
- The project website has search and sharing tags, a sitemap and `robots.txt`.
- Tests: end-to-end tests that load the extension in Chromium, a Firefox manifest test, and a
  fix for bridge tests that failed whenever something else listened on port 3000.

## 0.3.0

- The toolbar starts hidden. Clicking the Pinpoint icon shows it.
- A new logo: the extension icon in Chrome, the grip on the toolbar and the header of the
  welcome page.
- A welcome page opens once on first install: four steps, a bridge check, what the pill
  says. It is also the extension's Options page, and "How it works" at the bottom of the
  pill popover opens it again.
- A one-time tip above the toolbar the first time it is shown, pointing at Comment.
- Version check: when the bridge and the extension are on different versions, the pill
  gets a small "!" and the popover says what to run. Nothing is blocked.
- Per-project routing: comments from a page go to the Claude Code session for that
  page's project, not to whichever session holds the bridge.
- A status pill on the toolbar shows where comments go, with a session picker when
  several sessions are open.
- Guided `/pinpoint:setup` and a new `/pinpoint:doctor`: a short pass/fail list (Node,
  bridge and its version, sessions, duplicate MCP entries, channels, extension copy) with
  one fix for each problem.
- Stable extension folder: setup copies the extension to `~/.claude/pinpoint/extension`,
  so an update only needs Reload in `chrome://extensions` instead of loading a new path.
- Bridge takeover and yield: when the session holding the bridge closes, another takes it
  over, and an older bridge hands the port to a newer one after an update. Bridges older
  than 0.3.0 cannot be asked; `/pinpoint:doctor` prints the command that stops them.
- Demo: a longform page (carousels, scroll containers, sticky sections, charts) for testing
  pins on elements that move, and a reworked Chakra page. `DEMO_PORT` picks the port.

For contributors: colours, type and spacing come from `extension/tokens.css`, a raw-value
check and reference screenshots run in `npm test`, and CI runs the tests on Node 20 and 22.
The rules are in `CONTRIBUTING.md`.
