# Changelog

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
