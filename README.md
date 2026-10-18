<div align="center">

# ◈ &nbsp;P I N P O I N T

### Comment on the page. Fix it in the terminal.

Pin comments to elements on your localhost app. Hit Dispatch. Claude Code receives the
element, the page state, and a screenshot of exactly what you saw.

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

### Installing from a clone instead

If you'd rather not use the plugin marketplace — testing, hacking on it, or you just want
everything in one place — the whole thing runs from a clone. Nothing here needs the plugin
installed.

**1. Get it and install the one dependency**

```bash
git clone https://github.com/tolgainam/pinpoint
cd pinpoint && npm install
```

**2. Load the extension**

Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load
unpacked**, and select the `extension/` folder inside the clone. It'll appear in the
toolbar — pin it so you can reach it.

You won't have `/pinpoint:setup` here, since that's a plugin command. These are the steps
it would have run for you.

**3. Point your own project at the bridge**

Pinpoint edits files in whichever project your Claude Code session is running in, so the
bridge has to be registered *there* rather than in the clone. In the project you actually
want to work on, create `.mcp.json`:

```json
{
  "mcpServers": {
    "pinpoint": {
      "command": "node",
      "args": ["/absolute/path/to/pinpoint/server/pinpoint.js"],
      "env": {
        "PINPOINT_PROJECT_DIR": "/absolute/path/to/your/project",
        "PINPOINT_PORT": "8788"
      }
    }
  }
}
```

Use real absolute paths for both. `PINPOINT_PROJECT_DIR` defaults to the working
directory, so it usually resolves on its own — set it explicitly anyway and you'll never
have to wonder where the backlog and screenshots went.

**4. Start a session in your project**

```bash
cd /path/to/your/project && claude
```

Open your dev app on `localhost` and click the Pinpoint icon to bring up the toolbar. The
dot on it should be green.

<details>
<summary>Just want to try it without wiring up a project?</summary>

Run the session from the clone instead. It ships its own `.mcp.json`, so the bridge starts
automatically:

```bash
cd pinpoint && claude
npm run demo    # serves the demo page on localhost:3000
```

Comments will edit files in the clone rather than in your own code, which is exactly what
you want for a look around. See [Try it without a project](#try-it-without-a-project).
</details>

### If something isn't working

Three things go wrong, and each has one cause.

**The dot in the toolbar never turns green.** The bridge isn't running. It starts with your
Claude Code session, so check the session is open and that `.mcp.json` points at a real
path. `node server/pinpoint.js` from the clone will tell you if the server itself is
broken.

**Hovering doesn't highlight anything.** Pinpoint only attaches to `http://localhost/*`
and `http://127.0.0.1/*` — by design, and not configurable. `0.0.0.0`, a LAN IP, a
`.local` hostname, or any https:// site will do nothing at all. Check the address bar
first.

**Comments arrive without screenshots.** Chrome grants screenshot access when you click the
extension icon and revokes it on the next navigation. Click the icon again after navigating.
A batch without a screenshot still dispatches — it just says so.

## Use

Open your dev app on `http://localhost:…`, then click the Pinpoint icon in Chrome's
toolbar. The overlay starts hidden on every page load; the icon shows it and clicking it
again hides it. Pins and comments keep working while it is hidden.

> **It only attaches to `http://localhost/*` and `http://127.0.0.1/*`.** That is deliberate
> and not configurable. On `0.0.0.0`, a LAN IP, a `.local` hostname, or any https:// site,
> nothing will happen at all — check the address bar before assuming it is broken.

| Control | What it does |
|---|---|
| **Comment** | Comment mode: hover highlights elements, click opens a note composer |
| count | Pending comments not yet dispatched |
| **Dispatch** | Sends the batch to the running session |
| `✕` | Hides the overlay (the icon brings it back) |
| **Clear** | Removes every pin on this page; shown only when there are pins |
| **Alt+Shift+F** | Freezes the page so vanishing states can be pinned, and shows the overlay if hidden |
| status pill | Dot plus where Dispatch goes: the project name, Choose, or Offline. Click it to see the running sessions and pick one for this port; Auto lets Pinpoint match the page to its project. Dispatch stays disabled while nothing can receive it |

`⌘↵` adds a note, `Esc` closes the composer or leaves comment mode. Drag the bar by its
`⌖` grip. Pins survive a reload — they're keyed by origin + pathname in
`chrome.storage.local`.

When Claude fixes a comment it calls `resolve_comment`, and the pin turns green with a ✓
and the one-line resolution. You never have to switch to the terminal to know it landed.

While it works, the pin shows what it's doing: it pulses on `working`, and lists the files
it touched on `edited`. Outcomes only — the transcript stays in the terminal, which is
where there's room for it.

### Say it's still not right

A green pin has a reply box. Type into it and the same pin reopens for a second round,
carrying the first one with it: Claude gets what you originally asked, what it did about
it, and the fact that it wasn't enough. It takes a fresh screenshot on the way, because
the element has changed since the first round.

The same box answers Claude's own questions — when a fix would land in a shared component
it asks on the pin ("this instance, or everywhere?") rather than guessing.

Capped at three rounds. After that the card says to take it to the terminal, and means it:
a long negotiation belongs in the session, not in a box that size.

### Claude checks its own work

Resolving a comment asks the page for a fresh crop of the same element and hands Claude the
path to it. That closes the one gap in the loop — Claude used to resolve a comment on the
belief that its edit was correct, which misses CSS lost to specificity, a rule applied to a
sibling, or a value overridden somewhere else. Every one of those looks fine in a diff.

It's best-effort. A closed tab, an element that's gone, an expired screenshot permission —
all ordinary, and none of them fail the resolve. What you get instead is "the fix is
unverified", which is worth knowing on its own.

### A record of what you asked for

Every dispatch and every resolution is appended to `.pinpoint/history.md`, newest at the
bottom. The queue in `~/.claude` is pruned after a day; this isn't. There's no panel for
it — it's a markdown file, browsable in the editor and in git, and nothing reads it back.

### Pick the right element

Clicking grabs whatever node is on top, which is often a span three levels below the
thing you meant. The composer opens with a breadcrumb of that element's ancestors: press
`↑` and `↓` to walk it, or click a level. The highlight, the selector, and the crop all
follow, so walking up costs one keypress instead of a re-click.

`↑`/`↓` are intercepted only while the note is still empty — once you start typing they
belong to the textarea again, and the breadcrumb stays clickable.

### Say what kind of comment it is

The first character of a note decides where it goes. There is no switch to find, and
nothing on screen for the comments that don't need it.

| Start the note with | What happens |
|---|---|
| nothing | Ordinary fix request — dispatched to the session |
| `?` | A question. Claude answers with `reply` and changes no files; the answer lands on the pin card. The button turns violet. |
| `!` | Parked on the backlog instead of dispatched. |

Only the first marker counts, and it has to have a note after it — a comment that
genuinely reads `!` is still a note. The button label and the line under the box both
change on the keystroke that types the marker, so you can see it took.

### Park it for later

A note starting with `!` is appended to `.pinpoint/backlog.md` in your project instead of
being sent. Its pin goes grey, it never enters the dispatch queue, and it never expires.
Screenshots land in `.pinpoint/shots/` (~20–80KB each — fifty items is a few MB in the
repo).

That file is meant to be committed and hand-edited; Pinpoint only appends to `## Open`
and moves finished items to `## Done`, leaving everything else where you put it. Work
through it with:

```
/pinpoint:backlog
```

Add `.pinpoint/` to `.gitignore` if you'd rather keep yours private.

### It speaks your design system

Pinpoint reads your project once a session — `tailwind.config.*`, `@theme` blocks,
`components.json`, MUI/Chakra/Ant theme literals, `package.json` deps — and reads every CSS
custom property the page actually resolved. Configs are parsed as text and never executed.

So a payload says `padding: 24px ← 24px = --spacing-6` instead of `padding: 24px`, and
flags `13px` as off a 4px scale with the nearest tokens named. Off-scale values are very
often the actual bug. A guardrail line rides with every batch telling Claude to fix within
the scale rather than inventing raw px and hex.

The composer shows the same thing as chips — the element's current tokens, with a warning
where a value is off-system. Tap one for a picker built from your real scale: spacing as a
ramp, colours as your actual palette, or ± steppers where there's no scale to speak of.
Picks preview on the live element and dispatch as `padding: 24px (spacing-6) → 32px
(spacing-8)`, so a comment can be nothing but the change. Works with no design system at
all — the chips fall back to raw values.

### What rides along with a comment

Every comment carries the element's curated computed styles — box model, layout,
typography, colour — plus its rendered size and its parent chain. That is the difference
between "this spacing is wrong" and "padding is 12px 22px on a flex row with a 12px gap".
Colours are converted to hex (8-digit when there's alpha) because that's what stylesheets
are written in.

It is a curated subset on purpose: a full `getComputedStyle` dump is ~340 properties, and
properties still sitting at their initial value are dropped, so what arrives is what
somebody actually set.

### Freeze the page to pin what's vanishing

Hover menus, dropdowns, and toasts disappear the moment you reach for the tool. Press
**Alt+Shift+F** (rebindable at `chrome://extensions/shortcuts`) while the state is on
screen: Pinpoint takes a picture of the viewport and, in the same breath, the geometry of
everything visible in it. Comment mode turns on and you pin against that picture. `Esc`
releases it.

Deliberately no `chrome.debugger` permission. Pausing JS would stop timers, but it still
can't hold a CSS `:hover` open, it breaks whenever DevTools is attached, and it puts a
banner across the browser. A picture plus geometry covers the same cases with no extra
permission.

The honest limit: the DOM moves on. An element that unmounts is still described from the
reference held at freeze time — tag, classes, text, and markup survive — but it has no
computed style and no unique selector any more. Those comments are labelled, and the
brief tells Claude to trust the screenshot over the selector.

### Console errors and failed requests

`probe.js` keeps a 20-entry ring buffer of `console.error`/`warn`, uncaught exceptions,
unhandled rejections, failed `fetch`/XHR responses, and assets that didn't load. Repeats
are counted rather than pushed, so a render loop that throws costs one slot, not twenty.

Nothing attaches by default. When the page has logged something, the composer grows a
**debug (n)** toggle; tick it and that comment carries the buffer, with stack traces.
When the page is clean there's no toggle at all. The buffer is re-read at dispatch, so
an error thrown while you were typing the note still makes it.

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
its own CSS can't leak. `probe.js` runs in the page's own world at `document_start` —
the only place that can see framework internals and console output — and wraps `fetch`
and `XMLHttpRequest`. Both wrappers delegate to the original and pass its result or its
error through untouched; the buffer is a side effect, never a change in behaviour. Selectors are built preferring `[data-testid]`, then `#id`, then a
stable class chain, then an `:nth-of-type` path. React component names come from a
`_debugOwner` fiber walk where available.

**Queue** — `~/.claude/pinpoint/queue/<batch>/`, global rather than per-project so a
dispatch is never stranded in the wrong repo. Resolved batches are pruned after 24h.

**Backlog** — `<project>/.pinpoint/backlog.md`, deliberately somewhere else. The queue is
a delivery buffer that expires; the backlog is a record that belongs to the repo and
never does. Nothing prunes it.

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
| `PINPOINT_PROJECT_DIR` | cwd | Where `.pinpoint/backlog.md` and `shots/` live |

## Try it without a project

```bash
npm run demo    # four demo pages on :3000
```

Pin something, dispatch it, watch it get fixed. The stylesheets hot-swap rather than
reloading the page, so screenshot permission survives between rounds.

`/` is a deliberately opinionated landing page with no design system at all. The other
three — `/fixtures/tailwind/`, `/fixtures/shadcn/`, `/fixtures/chakra/` — each sit in a
directory that looks like a real project built with that stack, so the design-system
probe has something to read:

```bash
PINPOINT_PROJECT_DIR=demo/fixtures/shadcn npm run server
```

See [demo/fixtures/README.md](demo/fixtures/README.md) for what each one is meant to prove.

## Known limits

Turning a clicked element into `Header.tsx:42` would be the most valuable thing here, but
**React 19 removed `_debugSource` from fibers**, so file:line isn't reliably available.
Pinpoint captures strong *identifiers* instead — component name, `data-testid`, visible
text, classes — and lets Claude grep for them. That works well and depends on no fragile
internals.

Chrome only. `localhost` and `127.0.0.1` only, by design.

## Not affiliated with Anthropic

Pinpoint is an independent, community-built tool. It is **not affiliated with,
endorsed by, or sponsored by Anthropic**. "Claude" and "Claude Code" are trademarks of
Anthropic, PBC, used here only to describe what this tool interoperates with.

Pinpoint talks to Claude Code through its documented plugin, MCP, and channel
interfaces. Those interfaces — channels especially — are Anthropic's to change, and a
change on their side can break this tool without warning.

## Support

Pinpoint is free to use and it stays that way. If it saves you time and you
want to say thanks, a sponsorship link will live here.

<!-- TODO: replace with a real link before announcing — GitHub Sponsors, Ko-fi,
     Buy Me a Coffee, or whatever you settle on. An empty donate section is worse
     than none, so this stays a comment until it points somewhere. -->

Free ways to help that are worth just as much: star the repo, file an issue when
something breaks, or tell someone who reviews a lot of UI.

## License

Source-available, non-commercial. See [LICENSE](./LICENSE). © 2026 Tolga Inam

Not open source: you may read it and run it for your own non-commercial use. Copying,
modifying, or redistributing it needs written permission — which is usually given for the
asking, so ask.
