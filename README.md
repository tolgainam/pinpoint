# Pinpoint

A comment toolbar for the browser that dispatches into a running Claude Code session.

Pin comments to elements on a localhost dev app, hit **Dispatch**, and the batch —
element identity, page state, and (from Phase 3) a cropped screenshot per comment —
arrives in your terminal as work to do.

## Status

Phases 0–2 done: the channel path is proven, the bridge is live, and the browser overlay
dispatches real comments end to end. Screenshots (Phase 3) and pin resolution over SSE
(Phase 4) are next. See [PLAN.md](./PLAN.md).

## Install

**The extension** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select `extension/`. It activates only on `http://localhost/*` and `http://127.0.0.1/*`.

**The plugin** — point Claude Code at this directory as a plugin, or rely on `.mcp.json`
when working inside this repo. The MCP server is spawned for you; the bridge comes up on
`127.0.0.1:8788`.

## Use

Open a localhost dev app. The toolbar sits bottom-centre — drag it by the `⌖` grip.

| Control | What it does |
|---|---|
| **Comment** | Comment mode: hover highlights elements, click opens a note composer |
| count | Pending comments not yet dispatched |
| **Dispatch** | Sends the batch to the running session |
| `✕` | Clears every pin on this page |
| dot | Green when the bridge is reachable |

`⌘↵` adds a note, `Esc` closes the composer or leaves comment mode. Clicking the
extension icon toggles comment mode too. Pins survive a reload — they are keyed by
origin + pathname in `chrome.storage.local`.

Then either let the channel wake the session, or pull when you are ready:

```bash
# hands-free — a dispatch arrives in the session unprompted
claude --dangerously-load-development-channels server:pinpoint

# on demand — plain session
claude          # then: /pinpoint:comments
```

## Shape

| Path | What |
|---|---|
| `server/pinpoint.ts` | MCP channel server + local HTTP bridge (Bun) |
| `extension/content.js` | The overlay — shadow root, pinning, dispatch |
| `extension/probe.js` | Main-world probe that names the React/Vue component |
| `extension/worker.js` | Service worker: talks to the bridge, owns screenshots |
| `commands/comments.md` | `/pinpoint:comments` slash command |
| `.claude-plugin/` | Plugin manifest |

## Requirements

- Claude Code >= 2.1.235
- Bun
- Chrome 111+ (the component probe needs `world: "MAIN"` content scripts)
