# Pinpoint backlog

Things worth building, in the order they're worth building. Hand-edited for now — once
the backlog feature ships, Pinpoint appends pinned items here itself.

This file is **committed on purpose**. A gitignored backlog is a private todo list; a
committed one is a record of what was asked and why, which git history doesn't capture
on its own. Add `.pinpoint/` to `.gitignore` if you'd rather keep yours private.

**Format:** one checkbox per item. Sub-bullets are optional and free-form; `selector`,
`shot`, and `batch` appear on items Pinpoint wrote itself.

---

## Open

- [ ] **Backlog switch in the composer** — pin a comment without dispatching it
  - size: S
  - why: Pinpoint is binary today — comment, dispatch, fix now. Reviewing a page
    doesn't work that way. You spot fifteen things and three are urgent. Right now you
    either dispatch all fifteen and get a mediocre pass on twelve, or you lose the
    twelve entirely. This is the difference between a fix tool and a review tool.
  - shape: a checkbox in the composer, next to the screenshot one. Ticked, the comment
    is written to `.pinpoint/backlog.md` in the project directory instead of being sent.
    Its pin renders in a third, muted state.
  - needs: a bridge endpoint that writes here, `list_backlog` and `start_backlog_item`
    MCP tools, and a `/pinpoint:backlog` command to pick items and work them.
  - note: backlog items must **not** go through `prune()`. The queue expires after 24h
    because it's a delivery buffer; a backlog item has no expiry. Different lifecycle,
    separate handling.
  - note: screenshots land in `.pinpoint/shots/`. ~20–80KB each, so fifty items is a
    few MB in the repo. Acceptable, but worth saying out loud in the README.

- [ ] **Attach console errors and network failures** — automatically, per comment
  - size: S
  - why: the biggest gap between Pinpoint and what a developer would paste by hand.
    Pin a button that does nothing and Claude currently receives "this button does
    nothing" with no stack trace. Half the time the answer is already in the console.
  - shape: `probe.js` already runs at `document_start` in the MAIN world — hook
    `console.error`, `window.onerror`, and `unhandledrejection` there, keep a small ring
    buffer, and attach whatever landed in the last ~30s to each comment.
  - open question: how much to send. A ring buffer of the last 20 entries, truncated,
    is probably right — the whole console is noise.

- [ ] **Capture element state beyond the screenshot** — computed styles and parent chain
  - size: S
  - why: "this spacing is wrong" currently makes Claude guess between margin, padding,
    and gap. The screenshot shows the symptom; the computed box model shows the cause.
  - shape: only the properties people actually comment on — box model, colours,
    typography, flex/grid — plus the tag/class chain up to a sensible ancestor. Not the
    full `getComputedStyle` dump, which is hundreds of properties of noise.

- [ ] **Re-capture after a fix, so Claude can verify its own work**
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

- [ ] **A panel of past batches and their resolutions**
  - size: M
  - why: the queue is on disk and pruned after 24h, but invisible. You can't see what
    you asked for last week or what came of it.

- [ ] **Voice notes in the composer**
  - size: M
  - why: people describe visual problems better out loud than in text, and it's faster
    than typing for anything longer than a sentence.
  - open question: transcribe locally, or ship the audio and let Claude handle it.

- [ ] **Firefox support**
  - size: L
  - why: the overlay is portable; `captureVisibleTab` and the MV3 specifics are not.
    Safari is a bigger job — different extension packaging entirely.

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

---

## Considered and dropped

Kept so they don't get re-litigated.

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

Nothing yet. Completed items move here with the date and a line on what changed, rather
than being deleted — the record is the point.
