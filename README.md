<div align="center">

```
       ┌─┐
       │ │  P I N P O I N T
       └─┼─┐
         │ │   comment on the page.
         └─┘   fix it in the terminal.
```

**Pin comments to elements on your localhost app. Hit Dispatch. Claude Code
receives the element, the page state, and a screenshot of exactly what you saw.**

[Website](https://tolgainam.github.io/pinpoint/) · [Install](#install) · [How it works](#how-it-works)

</div>

---

Reviewing a running app and getting fixes made is a lossy loop. You spot something wrong
in the browser, then describe it in prose — *"the spacing under the brand header on the
explore page is too tight"* — and Claude has to reconstruct which element you meant. The
context that was obvious on screen never survives the trip.

Pinpoint closes that loop. Click an element, type what's wrong, dispatch. What arrives in
your session is a CSS selector, the component name, the visible text, the bounding box,
the page URL and colour scheme, and a cropped PNG of the element itself.

```
browser overlay ──POST /dispatch──▶ bridge ──▶ queue on disk (json + PNGs)
                                      │
                                      ├──▶ channel event   → lands in your session
                                      └──▶ list_comments   → /pinpoint:comments
```

## Install

Two pieces: a Claude Code plugin, and a Chrome extension.

**1. The plugin**

```
/plugin marketplace add tolgainam/pinpoint
/plugin install pinpoint@pinpoint-marketplace
```

**2. The extension**

```
/pinpoint:setup
```

This prints the extension's path, copies it to your clipboard, and opens
`chrome://extensions`. Turn on **Developer mode**, click **Load unpacked**, paste.

Requires Node 20+. Nothing else — dependencies install themselves with the plugin.

<details>
<summary>Running from a clone instead</summary>

```bash
git clone https://github.com/tolgainam/pinpoint
cd pinpoint && npm install
```

The repo ships a `.mcp.json`, so a session started in this directory spawns the bridge
automatically. Load `extension/` unpacked as above.
</details>

## Use

Open your dev app on `http://localhost:…`, then click the Pinpoint icon in the toolbar.

| Control | What it does |
|---|---|
| **Comment** | Comment mode: hover highlights elements, click opens a note composer |
| count | Pending comments not yet dispatched |
| **Dispatch** | Sends the batch to the running session |
| `✕` | Clears every pin on this page |
| dot | Green when the bridge is reachable |

`⌘↵` adds a note, `Esc` closes the composer or leaves comment mode. Drag the bar by its
`⌖` grip. Pins survive a reload — they're keyed by origin + pathname in
`chrome.storage.local`.

When Claude fixes a comment it calls `resolve_comment`, and the pin turns green with a ✓
and the one-line resolution. You never have to switch to the terminal to know it landed.

### Two ways to receive comments

**On demand** — works in any session, no flags:

```
/pinpoint:comments
```

**Hands-free** — dispatches wake the session on their own:

```bash
claude --dangerously-load-development-channels server:pinpoint
```

[Channels](https://code.claude.com/docs/en/channels-reference) are a research preview, and
custom ones aren't on Anthropic's allowlist yet — hence the alarming flag and the
full-screen warning at startup. The queue on disk is the source of truth either way, so
nothing is lost by staying on the pull path.

### Screenshots

Clicking the extension icon on a tab is what grants Chrome's `activeTab` permission, and
that is what `captureVisibleTab` needs. Chrome revokes it on every navigation, so after a
full page reload you click the icon again. If a capture fails you get the reason in a
toast, not silence.

The overlay hides itself before every capture, so pins and the toolbar never appear in
the image. One viewport capture per action gets cropped per comment, because
`captureVisibleTab` is rate-limited.

## How it works

**`server/pinpoint.js`** — an MCP server that Claude Code spawns over stdio, which also
binds `127.0.0.1:8788`. The `experimental: { 'claude/channel': {} }` capability is what
lets it push into a live session. Screenshots are written to disk as real PNGs and
referenced by absolute path; Claude opens them with the ordinary Read tool, which renders
images. That sidesteps MCP image plumbing entirely.

Resolutions travel back over SSE. Events are numbered and the last 200 kept, so a client
reconnecting with `?since=N` gets whatever it missed — necessary because Chrome kills the
extension's service worker whenever it feels like it.

**`extension/`** — MV3, overlay mounted in a Shadow DOM so page CSS can't reach it and
its own CSS can't leak. Selectors are built preferring `[data-testid]`, then `#id`, then a
stable class chain, then an `:nth-of-type` path. React component names come from a
`_debugOwner` fiber walk where available.

**Queue** — `~/.claude/pinpoint/queue/<batch>/`, global rather than per-project so a
dispatch is never stranded in the wrong repo. Resolved batches are pruned after 24h.

### Security

The bridge binds `127.0.0.1` only, and any page you visit can `fetch()` a localhost port —
so requests from an unrecognised web `Origin` are rejected, and `application/json` is
required, which forces a CORS preflight the server refuses. Comment text is treated as
untrusted input in the channel instructions, since anything reaching the session is
model-visible.

Set `PINPOINT_TOKEN` to also require an `X-Pinpoint-Token` header.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PINPOINT_PORT` | `8788` | Bridge port |
| `PINPOINT_QUEUE` | `~/.claude/pinpoint/queue` | Where batches land |
| `PINPOINT_TOKEN` | — | Shared secret for `/dispatch` |
| `PINPOINT_RETAIN_HOURS` | `24` | How long resolved batches are kept |
| `PINPOINT_MAX_BATCHES` | `200` | Hard ceiling on batches kept |

## Try it without a project

```bash
npm run demo    # a deliberately opinionated landing page on :3000
```

Pin something, dispatch it, watch it get fixed. Its stylesheet hot-swaps rather than
reloading the page, so screenshot permission survives between rounds.

## Known limits

Turning a clicked element into `Header.tsx:42` would be the most valuable thing here, but
**React 19 removed `_debugSource` from fibers**, so file:line isn't reliably available.
Pinpoint captures strong *identifiers* instead — component name, `data-testid`, visible
text, classes — and lets Claude grep for them. That works well and depends on no fragile
internals.

Chrome only. `localhost` and `127.0.0.1` only, by design.

## License

MIT
