# Pinpoint backlog

Things worth building, in the order they're worth building. Pinpoint appends
browser-pinned items to `## Open` and moves finished ones to `## Done`; everything else
here is hand-written.

This file is **committed on purpose**. A gitignored backlog is a private todo list; a
committed one is a record of what was asked and why, which git history doesn't capture
on its own. Add `.pinpoint/` to `.gitignore` if you'd rather keep yours private.

**Format:** one checkbox per item. Sub-bullets are optional and free-form; `id`,
`selector`, and `shot` appear on items Pinpoint wrote itself.

---

## Open

- [ ] **Chrome Web Store listing**
  - size: M
  - why: the biggest remaining install friction. "Load unpacked" is the one step that
    can't be automated away, because it's a file picker.
  - cost: one-time developer fee plus review. Only worth it once there are users.

- [ ] **Pick a donate platform and wire up the link**
  - size: XS
  - why: the README and landing page both have a support section with a TODO comment
    where the link goes. Deliberately a comment — a support heading pointing nowhere
    reads worse than no heading.

- [ ] **Confirm the repo name and URLs before announcing**
  - size: XS
  - why: `package.json`, both manifests, and the landing page hardcode
    `tolgainam/pinpoint` and `tolgainam.github.io/pinpoint`. If the repo lands anywhere
    else, `/plugin marketplace add` won't resolve.

- [ ] **make this functional** — /
  - id: `bk-20260822-132312-bj3p`
  - added: 2026-08-22 13:23
  - url: http://localhost:3000/
  - selector: `[data-testid="cta-primary"]`
  - text: "Start free"
  - parents: div.hero-actions ‹ section.hero

- [ ] **make larger** — /
  - id: `bk-20260822-133132-poep`
  - added: 2026-08-22 13:31
  - url: http://localhost:3000/
  - selector: `[data-testid="cta-primary"]`
  - text: "Start free"
  - parents: div.hero-actions ‹ section.hero

---

## Considered and dropped

Kept so they don't get re-litigated.

- **Voice notes in the composer** — typing a one-line note is not the bottleneck, and
  transcription (a local model, or shipping audio) is a heavy dependency for marginal
  speed. Revisit only if notes regularly run longer than a sentence.

- **Breakpoint sweep** — capturing the element at other widths means resizing the
  visible tab (disruptive) or an offscreen copy that doesn't share app state
  (dishonest). An L for a case that "put the viewport width prominently in the
  payload" mostly covers — and that half ships with the computed-state item.

- **Copy-edit mode** (pre-fill the element's text, dispatch an exact before/after) —
  if you already know the exact replacement, a model round-trip is token waste: edit
  the source, or put it in a plain note. The ordinary note flow covers fuzzy copy
  work ("make this friendlier") already.

- **Action trail** (recent clicks/inputs as steps-to-reproduce) — a whole
  event-recording system for a case that's rare in a styling-first workflow. Folded
  into the console-errors debug toggle as a possible later addition.

- **Design reference attachment** — paste-only would have avoided any Figma auth,
  but it's an M for "make it look like this picture", which pasting the picture into
  the terminal already does.

- **Scope dial per comment** — replaced by behaviour, not UI: default to the narrow
  fix, and when the edit lands in a shared component Claude asks on the pin ("this
  instance or everywhere?"). A toggle puts the risky choice one accidental click
  away; a question makes it deliberate.

- **Live CSS trial** (Claude proposes CSS, extension previews, user approves) —
  DevTools already covers the experiment; the part worth keeping — carrying the
  tuned value into code — ships as token chips phase 3. A standalone L would
  duplicate it.

- **Firefox support** — parked, not rejected: an L-sized port with zero current
  users. `captureVisibleTab` and the MV3 specifics don't travel; Safari is a bigger
  job still. Revisit when the Chrome version has traction.

- **Multi-element comments** (shift-click to add elements to one comment) — commenting
  on the shared parent already covers this, and gives Claude a better framing: a
  container-level instruction with a container-level screenshot. The only case it misses
  is elements with no meaningful shared parent, which is rare enough not to build for.

- **Region select** (drag a rectangle instead of clicking a node) — same reasoning. The
  parent element is almost always the region you meant.

- **Team mode** (shared queue over a network, designer comments, developer's session
  receives) — a different security model entirely. The current one assumes localhost is
  trusted, which stops being true the moment this crosses a machine boundary. Revisit
  only if the single-user version proves itself.

---

## Done

Completed items move here with the date and a line on what changed, rather than being
deleted — the record is the point.

- [x] **Capture element state beyond the screenshot** — computed styles and parent chain
  - done: 2026-08-22 — every comment carries a curated computed-style map plus the
    rendered size and the parent chain; the bridge groups it back into CSS declarations.
    Properties still at their initial value are dropped, colours become hex (8-digit
    with alpha, so a colour rewritten inside a `box-shadow` stays valid CSS), and
    computed lengths are rounded — a `1fr` track reported as `455.65625px` reads like an
    authored value someone could grep for.
  - note: found and fixed a 0.1 bug on the way. `GENERATED_CLASS` matched `hero-actions`,
    `card-header`, and `nav-wrapper` as hashes, so every selector and breadcrumb had been
    quietly dropping the most descriptive class on the element. The tail now needs a digit.

- [x] **Attach console errors and network failures** — when you ask for them
  - done: 2026-08-22 — `probe.js` keeps a 20-entry ring of console errors and warnings,
    uncaught exceptions, unhandled rejections, failed fetch/XHR responses, and assets
    that did not load, with stacks. Repeats are counted rather than pushed, so a render
    loop that throws costs one slot instead of the buffer. The fetch and XHR wrappers
    delegate to the originals and pass results and errors through untouched.
  - note: the toggle only exists when the page has logged something. A control greyed
    out on every healthy page is chrome you learn to ignore, and most comments are about
    styling. The buffer is re-read at submit — the interesting error is often the one
    thrown while the note was being typed.

- [x] **Transient-state capture** — pin hover menus, dropdowns, toasts, mid-animation
  - done: 2026-08-22 — Alt+Shift+F (a `chrome.commands` shortcut, so a focus-trapped
    menu cannot swallow it) captures the viewport and, synchronously in the same breath,
    the geometry of everything visible. The frame renders over the page, comment mode
    turns on, and clicks hit-test against the snapshot instead of the live DOM.
  - decided (2026-08-22): no `chrome.debugger`. Pausing JS stops timers but still cannot
    hold a CSS `:hover` open — the pointer has to leave either way — and it breaks with
    DevTools attached, banners the browser, and is a frightening permission on a store
    listing. A picture plus geometry covers the same cases for none of that.
  - note: the documented limit is that the DOM moves on. A node that unmounts is still
    described from the reference kept at freeze time (tag, classes, text, markup all
    survive) but has no computed style and no unique selector. Verified both paths: a
    CSS-`:hover` menu item stays fully attached and keeps its styles; a self-removing
    toast degrades to text and tag. Those comments are labelled, and the brief tells
    Claude to trust the screenshot over the selector.

- [x] **Backlog switch in the composer** — pin a comment without dispatching it
  - done: 2026-08-22 — a note starting with `!` posts the comment to a new
    `POST /backlog` on the bridge, which appends it to `## Open` here and writes its
    screenshot to `.pinpoint/shots/`. The pin renders grey and never enters the queue,
    so `prune()` never sees it. `list_backlog`, `start_backlog_item`, and
    `finish_backlog_item` work the file by whole-line splice, so hand-written items and
    hand-written prose around them survive every operation; finishing one broadcasts
    `backlog-done` over the existing SSE channel and clears the pin. `/pinpoint:backlog`
    drives it.
  - note: a third tool beyond the two planned — `finish_backlog_item`. Without it
    nothing could move an item to `## Done`, and the alternative was Claude hand-editing
    the file, which is exactly what the splice logic exists to avoid.
  - note: shipped first as a composer checkbox, changed to the `!` marker the same day
    on the user's call. Correct: it makes the switch the same shape as question mode's
    `?`, and it takes the footer back to one toggle. A checkbox is chrome that sits
    there for every comment that does not need it.

- [x] **Selection depth control** — walk up the ancestor chain after clicking
  - done: 2026-08-22 — the composer opens with a scrollable breadcrumb of the clicked
    element's ancestors (capped at 8, stopping before `<body>`). `↑`/`↓` walk it and
    crumbs are clickable; selector, highlight, component probe, and the screenshot crop
    all re-derive from the chosen level, so walking is indistinguishable downstream from
    having clicked that element.
  - note: `↑`/`↓` are intercepted only while the note is empty. An empty textarea has no
    caret to move, so nothing is taken away — and the gesture it serves is click, press
    `↑` twice, start typing. After that the crumbs carry it.

- [x] **Question mode** — ask about an element without requesting a change
  - done: 2026-08-22 — a note starting with `?` sets `question` on the comment; the
    marker is stripped from the text, the primary button turns violet, and the pin is
    violet through its whole life. The batch renders the comment with ❓ and a per-comment
    guardrail line naming the id to answer. `reply` grew an optional `id`: with one the
    text lands on that pin card as the answer, without one it is still a passing toast.
  - note: no new chrome, as decided — the `?` is the entire switch. `!` for the backlog
    now rides the same mechanism; see that item.

- [x] **Design-system awareness** — speak the project's token vocabulary
  - size: M
  - why: fixes that invent raw px and hex values rot a design system, and "this
    spacing is wrong" has a better answer when the payload can say "this is `p-6` on
    a 4px scale". Off-scale values — a 13px font, a hex that's not in the palette —
    are very often the actual bug, and spotting them requires knowing the scale.
  - shape: two probes. Static (bridge): `tailwind.config.*` / `@theme` blocks,
    `components.json` (shadcn), and `package.json` deps for MUI, Chakra, Mantine,
    Ant Design, Bootstrap, DaisyUI. Runtime (extension): all CSS custom properties on
    `:root` — the universal token source, covers styled-components/Emotion and
    hand-rolled systems — plus component fingerprints (`data-slot`, `data-radix-*`,
    `Mui*`, `ant-*`, `mantine-*`, `chakra-*`). Cached as a compact summary: spacing
    scale, palette with token names, type scale, which library is in play. Tailwind +
    shadcn are first-class; everything else rides the CSS-variable path. Full matrix
    in PLAN-0.2.md. Every batch carries it, plus a guardrail line telling
    Claude to fix within the scale and prefer class/variant changes over raw CSS.
  - shape: the computed-styles item above then maps raw values to the nearest token
    before dispatch (`padding: 24px` → `p-6`), and values that map to no token are
    flagged as off-scale in the payload.
  - note: library fingerprints (`data-slot`, `data-radix-*`, MUI class prefixes)
    identify the component and its source file, which upgrades the scope dial — see
    that item.
  - done: 2026-08-22 13:54 — 2026-08-22 — server/design-system.js probes the project once per session (never executing project code: configs are read as text and parsed loosely) and merges what the page reports about itself — every custom property resolved on :root, plus library fingerprints from the DOM. Every batch now carries a one-line summary and a guardrail, and each computed declaration is annotated with the token it matches or the reason it matches none. 46 tests cover one fixture project per row of the matrix plus the hand-rolled and no-design-system cases. Two corrections the build forced: only spacing properties are measured against the step, since a 13px type size is not off a 4px grid; and fixture directories are excluded from the walk, because this repo's own fixtures made it read as a Tailwind v4 project.

- [x] **Token chips in the composer** — annotate in the design system's own vocabulary
  - size: M
  - why: prose is the wrong medium for "make this p-8 instead of p-6". Once the
    design-system probe exists, the composer can show what the element *is* and let
    you pick what it *should be*, Figma-inspector style.
  - shape, phase 1: when the composer opens, a row of chips shows the element's
    current values mapped to tokens (`p-6`, `text-muted-foreground`, `text-sm`);
    off-scale values render with a warning. You learn an element is off-system
    before typing a word.
  - shape, phase 2: tapping a chip opens a picker rendered from the project's own
    scale — spacing as a visual ramp, colours as a swatch grid of the real palette,
    type at actual sizes. Picking sends a structured delta (`padding: p-6 → p-8`)
    alongside any prose.
  - note: must degrade without a design system — chips fall back to raw computed
    values with ± steppers.
  - note: cap the pickers. Show the ramp around the current value plus recently
    used, not the entire Tailwind palette.
  - note: phase 3 — applying the picked value live in the page before dispatch —
    is where "try it in the browser first" now lives; the standalone live CSS trial
    item was dropped in its favour.
  - done: 2026-08-22 14:05 — 2026-08-22 — all three phases together, since a picker with no preview is a worse version of typing the number. The composer asks the bridge once per page for the merged scales (new POST /design-system, the same merge a dispatch does, so a chip can never name a token the brief would not) and shows one chip per property the element actually sets: the token name where there is one, a ⚠ where a spacing value is off the step. Tapping a chip opens a picker built from the project's own scale — spacing and radius as a ramp sliced around the current value, colours as a swatch grid of the real palette, and ± steppers where there is no scale at all. A pick previews on the real element and dispatches as a structured delta, so a comment can now consist of nothing but the change. Notes: colours with no palette stay a readout rather than pretending to be a control; a shorthand like `12px 22px` is shown with its warnings but not offered a picker, because a scale answers one value and replacing four sides with one number is not what was asked; picks are abandoned when you walk the ancestor chain, since they belong to the element they were made on; and the preview — the one place Pinpoint writes to the host page — is unwound on every path out of the card, including before the screenshot, so the picture shows the problem and the delta carries the proposal.

- [x] **Per-pin progress and results** — Claude's outcomes, rendered on the pin
  - size: M
  - why: a pin is silent between Dispatch and green. The terminal keeps the
    transcript; the overlay should show outcomes — the difference between a dispatch
    tool and a place you can actually work from.
  - shape: extend the reply protocol to typed events the overlay renders on the pin
    card — `working` (pin pulses, "editing card.tsx…"), `edited` (files touched plus
    a diffstat), `resolved` (the existing one-liner, plus before/after once
    re-capture ships). The SSE channel and `reply` plumbing already exist; this is
    structure, not new transport.
  - scope guard: not a chat client. If it isn't about a specific element, it doesn't
    belong in the overlay — full output, permissions, and steering stay in the
    terminal.
  - done: 2026-08-22 14:25 — 2026-08-22 — a report_progress tool broadcasting `working` and `edited` (with the files touched and their diffstat) over the SSE channel that already existed. The pin pulses while work is in flight and the card lists what changed. State is written onto the comment as well as broadcast, so a service worker Chrome killed mid-fix still shows it when the page comes back. The scope guard held: outcomes only, never a transcript.

- [x] **Follow-up threads on resolved pins** — "still 2px off" without starting over
  - size: S
  - why: when a fix is almost right, the current move is a fresh comment with no
    history. Round-tripping is the defining complaint about agent UI work; the second
    round should carry the first round's context.
  - shape: a reply box on green pins. Replying reopens the comment, takes a fresh
    capture, and dispatches it linked to the original batch and resolution.
  - note: the same reply box answers Claude's mid-fix questions ("move the portal to
    body, or drop overflow-hidden?") — surfaced on the pin via per-pin progress
    events, answered inline. Most terminal round-trips during UI work are exactly
    these.
  - note: capped, not a chat. After ~2 unresolved rounds on one pin, the card says
    "take it to the terminal" and stops offering the reply box — long negotiation
    belongs in the session, not the overlay.
  - done: 2026-08-22 14:26 — 2026-08-22 — a reply box on green and answered pins. It reopens the same pin for another round rather than creating a second one: a new pin on the same node would say the first request had been abandoned, when it was answered and just not well enough. A fresh crop is taken on the way, since the element has changed since round one. The bridge reads the previous round out of the queue and the brief states what was asked, what was done about it, and that it was not enough — the thing that makes a second attempt start from somewhere. The same box answers Claude's mid-fix questions. Capped at three rounds, after which the card says to take it to the terminal.

- [x] **Batch history on disk** — a markdown log, not a panel
  - size: S
  - why: the queue is on disk and pruned after 24h, but invisible. You can't see what
    you asked for last week or what came of it.
  - shape: the bridge appends each dispatched batch and its resolutions to
    `.pinpoint/history.md` — browsable in the editor and in git, no overlay UI.
  - decided (2026-08-22): reshaped from a toolbar panel/dock to a file. The overlay
    stays uncrowded; per-pin progress already covers the live view.
  - done: 2026-08-22 14:26 — 2026-08-22 — .pinpoint/history.md, appended under a date heading, newest at the bottom. Resolutions land as their own later line rather than being spliced back into the batch that produced them: the file is one a human also edits, and an append-only log cannot corrupt what someone wrote around it. A write that fails is logged and never costs a dispatch — it is a record, not a step.

- [x] **Re-capture after a fix, so Claude can verify its own work**
  - size: L
  - why: two reasons, and the second is the real one.
    1. The baseline disappears. Once the fix lands you're comparing against memory, and
       memory is not good enough to judge *right* versus merely *different*.
    2. Claude never sees the result of its own edit. It resolves a comment on the belief
       that the change was correct — which misses CSS lost to specificity, applied to a
       sibling, or overridden by a different code path. Every other part of this tool is
       built on "let Claude see what you saw". This is the missing half.
  - shape: `resolve_comment` broadcasts a re-capture request over SSE; the worker
    captures and crops the same rect; the before/after pair goes back to both the pin
    card and the session.
  - blockers: needs the tab open, the element still present, and `activeTab` still
    granted. Fails often enough that the failure path has to be graceful.
  - sequencing: after the three items above. It's the most expensive thing here and it
    only pays off once there's something worth verifying.
  - done: 2026-08-22 14:26 — 2026-08-22 — resolve_comment broadcasts a request and waits briefly; the page waits out the hot reload, re-measures the element rather than reusing the old rect (a fix that changes the size is exactly what this catches, and yesterday's box would clip it), crops, and posts back. The path lands in the tool result, and the instructions tell Claude to read it and say so if the edit did not land. Every failure path — no tab listening, element gone, scrolled out of view, screenshot permission lapsed, page too slow — resolves the comment anyway and reports the fix as unverified, which is information rather than an error. Covered end to end by test/bridge.test.js, which drives the real MCP server over stdio and answers the handshake over HTTP.
