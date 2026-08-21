# Pinpoint — a comment toolbar that dispatches into Claude Code

## Context

Reviewing a running web app and getting fixes made is currently a lossy manual loop: you spot something wrong in the browser, then describe it in prose in the terminal ("the spacing under the brand header on the explore page is too tight"), and Claude has to reconstruct which element you meant. The context that was obvious on screen — which element, which page state, what it looked like — never survives the trip.

This builds a Vercel-toolbar-style overlay that closes that loop. You pin comments directly to elements on a page, hit **Dispatch**, and the batch — element identity, page state, and a cropped screenshot per comment — arrives in a running Claude Code session as work to do.

It is a **standalone tool**, not tied to any repo. Canary is only the first thing to test it against.

**Decisions already made:** Chrome MV3 extension (needed for screenshots), packaged as a Claude Code plugin, both hands-free and on-demand delivery, scoped to `localhost` dev servers.

**Working name:** `pinpoint`. Easy to change — it appears in the plugin name, the `<channel source>` attribute, and the queue path.

---

## The key finding

Claude Code has a documented mechanism for exactly this: **channels** ([docs](https://code.claude.com/docs/en/channels-reference)). A channel is an MCP server that Claude Code spawns over stdio, which can also bind a local HTTP port and push inbound events into the live session via an MCP notification. The reference docs contain a webhook-receiver example that is ~90% of the bridge we need.

Verified locally: Claude Code `2.1.235`, Bun `1.3.11`, `claude-plugins-official` marketplace present, port `8788` free.

**Two important constraints, stated up front:**

1. Channels are a **research preview**. Custom channels are not on Anthropic's allowlist, so hands-free mode requires launching with `--dangerously-load-development-channels`, which shows a full-screen warning dialog at every start. The flag syntax may change.
2. Channels require Anthropic auth (claude.ai or Console key) and are unavailable on Bedrock/Vertex/Foundry.

**This is why the design makes the pull path the foundation and the channel an accelerator.** The same server binary works both ways; if channels break, get restricted, or you just don't want the scary flag, `/pinpoint:comments` keeps working with zero channel involvement.

---

## Architecture

Three parts, one repo at `~/Github/pinpoint`:

```
pinpoint/
├── .claude-plugin/plugin.json    # plugin manifest
├── .mcp.json                     # declares the server; Claude Code auto-spawns it
├── commands/comments.md          # /pinpoint:comments slash command
├── server/pinpoint.ts            # MCP channel server + HTTP bridge (Bun)
└── extension/                    # Chrome MV3 extension
    ├── manifest.json
    ├── content.js                # overlay UI in a Shadow DOM
    ├── worker.js                 # screenshots + dispatch
    └── overlay.css
```

**Data flow:**

```
browser overlay ──POST /dispatch──▶ bridge ──▶ writes queue/<batch>/ (json + PNGs)
                                      │
                                      ├──▶ mcp.notification  → <channel> event  (hands-free)
                                      └──▶ list_comments tool → /pinpoint:comments (on demand)
```

---

## Part 1 — Server + bridge (`server/pinpoint.ts`)

A single Bun script, following the official webhook-channel example structurally.

**MCP setup** — the `experimental` capability key is what makes it a channel:

```ts
const mcp = new Server(
  { name: 'pinpoint', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: 'Web page comments arrive as <channel source="pinpoint" batch_id="..." origin="..." count="N">. '
      + 'The body is a markdown brief listing each comment with its element selector, component name, and a screenshot path. '
      + 'Read the screenshot files to see what the user saw. Fix the issues, then call resolve_comment for each one you addressed.',
  },
)
await mcp.connect(new StdioServerTransport())
```

**HTTP routes** on `127.0.0.1:8788`:

| Route | Purpose |
|---|---|
| `POST /dispatch` | Receives the batch. Writes queue files, then fires the channel notification. |
| `GET /health` | `{ok, projectDir, version}` — the extension polls this for the toolbar's connection dot. |
| `GET /events` | SSE stream so the browser learns when a comment is resolved. |

**Tools** (these are what make the pull path work without any channel):

- `list_comments` — pending batches as markdown, including absolute screenshot paths
- `resolve_comment` — mark one done; broadcasts over SSE so the pin greys out in the browser
- `reply` — push a one-line status back to the toolbar

**Screenshots go to disk as real PNG files, not into MCP results.** Claude reads them with the ordinary Read tool, which renders images. This sidesteps MCP image-content plumbing entirely and is the single biggest simplification in the design.

**Queue location:** `~/.claude/pinpoint/queue/<timestamp>-<id>/` containing `batch.json` and `shot-NN.png`. Global rather than per-project, so a dispatch is never stranded in the wrong repo.

**Port conflict (two sessions open):** wrap `Bun.serve` in try/catch. On `EADDRINUSE`, log to stderr and continue **tools-only**. The on-disk queue is the shared source of truth, so the second session still sees every comment via `/pinpoint:comments`. Each session gets its own stdio subprocess — that is expected and fine.

**Security — this matters and is easy to get wrong.** Any web page you visit can `fetch()` a localhost port. Three layers:

1. Bind `127.0.0.1` explicitly, never `0.0.0.0`.
2. **Reject any request whose `Origin` is not `http://localhost:*` or `http://127.0.0.1:*`.** Require `Content-Type: application/json`, which forces a CORS preflight the server refuses for unknown origins — this is the layer that actually stops a drive-by page.
3. Treat comment text as untrusted input in the channel `instructions`, since anything reaching the session is model-visible.

**Detail that will bite otherwise:** channel `meta` keys must match `[A-Za-z0-9_]+`. Keys containing hyphens are **silently dropped**. Use `batch_id`, not `batch-id`.

---

## Part 2 — Chrome extension (`extension/`)

MV3, `host_permissions: ["http://localhost/*", "http://127.0.0.1/*"]`, permissions `["storage", "scripting", "tabs"]`.

**Overlay** — mounted in a **Shadow DOM** so host-page CSS cannot break it and its own CSS cannot leak. Host element fixed at `z-index: 2147483647`. Never mutate the host DOM: highlights are absolutely-positioned divs inside the shadow root, not outlines applied to page elements.

**Toolbar pill**, bottom-centre and draggable: comment-mode toggle, pending count, Dispatch button, connection dot. Use the `pointer-events-none` wrapper + `pointer-events-auto` pill pattern so the bar never eats clicks meant for the page.

**Comment mode:** `mousemove` → `document.elementFromPoint` → draw highlight rect. Click freezes the selection and opens a composer popover. `Esc` exits.

**Pins** render as numbered dots at each element's top-left, repositioned on a single rAF-throttled `scroll`/`resize` loop that re-resolves elements from their stored selector.

**Persistence:** `chrome.storage.local` keyed by `origin + pathname`, so a page reload doesn't lose a batch in progress.

**Captured per comment:**
- `selector` — built preferring `[data-testid]` → `#id` → stable class chain → `:nth-of-type` path
- `tag`, `id`, `classes`, `role`, `aria-label`
- `text` (`innerText`, ~200 chars) and `html` (`outerHTML`, ~600 chars)
- `rect` — bounding box in CSS px
- `component` — best-effort React component name (see caveat below)

**Captured once per dispatch:** `url`, `pathname`, `title`, viewport size, DPR, `prefers-color-scheme`.

**Screenshots** — content scripts cannot call `chrome.tabs.captureVisibleTab`, so the content script messages the service worker, which captures and crops. Two non-obvious requirements:

- **Hide the overlay before capturing.** Set the shadow host to `visibility: hidden`, await a rAF, capture, restore. Otherwise every screenshot has pins and a toolbar in it.
- **Capture once per dispatch, not once per comment.** `captureVisibleTab` is rate-limited. Take one viewport PNG, then crop N regions from it with `createImageBitmap` + `OffscreenCanvas` (rect + ~24px padding). Keep the uncropped shot too, as page context.

---

## Part 3 — Claude Code plugin

`.claude-plugin/plugin.json`:

```json
{ "name": "pinpoint", "version": "0.1.0", "mcpServers": "./.mcp.json" }
```

`.mcp.json` — `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are both expanded by Claude Code:

```json
{
  "mcpServers": {
    "pinpoint": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/pinpoint.ts"],
      "env": {
        "PINPOINT_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}",
        "PINPOINT_PORT": "8788"
      }
    }
  }
}
```

`commands/comments.md` — the `/pinpoint:comments` command: call `list_comments`, Read each screenshot, group comments by likely source file, apply fixes, then `resolve_comment` for each.

**Two ways to run:**

```bash
# hands-free — dispatch wakes the session
claude --dangerously-load-development-channels server:pinpoint

# on demand — plain session, pull when ready
claude          # then: /pinpoint:comments
```

---

## Known limitation: source mapping

The most valuable thing would be turning a clicked element into `Header.tsx:42`. **React 19 removed `_debugSource` from fibers**, so file:line is not reliably available — and Canary, the first test target, is on React 19.

The realistic approach, which the plan assumes: capture strong *identifiers* (component name via the `_debugOwner` fiber walk, `data-testid`, visible text, class names) and let Claude grep the repo for them. That works well and needs no fragile internals. Treat a file:line breakthrough as a bonus, not a requirement — and do not let the extension's design depend on it.

---

## Build order

Sequenced to kill the biggest unknown first.

| Phase | Work | Proves |
|---|---|---|
| **0** | `/plugin install fakechat@claude-plugins-official`, restart with `--channels`, send a message from `localhost:8787` | The channel path works on this machine and account. ~15 min, before writing any code. |
| **1** | `server/pinpoint.ts` + plugin manifest. Test with `curl`. | Bridge receives, queues, and pushes into the session. |
| **2** | Extension: overlay, pinning, dispatch. No screenshots yet. | End-to-end loop with real comments. |
| **3** | Screenshots: capture, hide-overlay, crop, write PNGs. | Claude can see what you saw. |
| **4** | Two-way: `resolve_comment` → SSE → pins grey out. | The loop closes. |

Stop after any phase and the tool is still useful. If Phase 0 fails, Phases 1–4 still deliver the `/pinpoint:comments` pull workflow — only hands-free is lost.

---

## Verification

**Phase 0 (do this first):**
```bash
claude --channels plugin:fakechat@claude-plugins-official
# open http://localhost:8787, type a message, confirm it lands as `← fakechat · web: ...`
```
If this fails, stop and reassess — everything hands-free depends on it.

**Bridge, without the browser:**
```bash
curl -s localhost:8788/health
curl -X POST localhost:8788/dispatch \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"origin":"http://localhost:3000","comments":[{"note":"test","selector":"h1"}]}'
# expect: a <channel source="pinpoint"> event appears in the session
```
Confirm the Origin gate rejects a foreign origin:
```bash
curl -X POST localhost:8788/dispatch -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{}'   # expect 403
```

**Extension:** `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Open any localhost dev app (Canary: `npm run dev`), pin two comments, Dispatch.

**Full loop:** with Canary running and a session started with the development-channels flag, comment on a real element, dispatch, and confirm Claude receives the brief, reads the screenshot PNG, locates the component, and makes the fix.

**Screenshot correctness:** verify the saved PNG contains *no* pins or toolbar — the most likely thing to get silently wrong.
