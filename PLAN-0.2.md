# Pinpoint 0.2 — from dispatch tool to review cockpit

> **Status: Phases A and B shipped, C half shipped (2026-08-22).** Scoped 2026-08-22 after a deliberate cut: 33 ideas
> were generated and researched, 10 were dropped or parked with reasoning recorded in
> [`.pinpoint/backlog.md`](.pinpoint/backlog.md) (the item-level source of truth), and
> 15 survived. Mockups of the headline UX live at `.pinpoint/mockups.html`.
> [PLAN.md](./PLAN.md) is the 0.1 plan and stays untouched as the record of the build.

## Theme

0.1 closed the loop browser → terminal. 0.2 deepens both directions of that loop
without growing the UI: richer context rides along with each pin, and Claude's
*outcomes* (never its transcript) come back to the pin. Guiding principles, decided
during scoping:

- **Intent over UI.** New behaviour is triggered by what the user types or toggles per
  comment (`?` and `!` prefixes, a debug toggle), not by new persistent chrome. The
  overlay stays uncrowded.
- **The overlay speaks in pins.** Anything not about a specific element belongs in the
  terminal — full output, permissions, steering. The overlay renders outcomes only.
- **Same trust model.** Localhost, single user, same machine. Nothing here crosses a
  network boundary (team mode stays dropped).

## Build order

Phase A — composer quick wins (all S) — **shipped**
1. ~~**Backlog switch**~~ — pin without dispatching; writes to `.pinpoint/backlog.md`.
   No `prune()` for backlog items; shots to `.pinpoint/shots/`. Shipped with a third
   tool, `finish_backlog_item`, so items can reach `## Done` without hand-editing —
   and as a `!` marker rather than the planned checkbox, matching question mode's `?`.
2. ~~**Selection depth control**~~ — after click, `↑`/`↓` walks the ancestor chain with a
   breadcrumb; screenshot re-crops to the final choice.
3. ~~**Question mode**~~ — a note starting with `?` dispatches as a question; answered via
   `reply` on the pin card, no files touched. The two markers are now the whole
   composer vocabulary: `?` asks, `!` parks, anything else fixes.

Phase B — richer capture (S, S, M) — **shipped**
4. ~~**Element state**~~ — curated computed styles (box model, colour, typography,
   flex/grid) + tag/class parent chain. Foundation for Phase C.
5. ~~**Console errors & network failures**~~ — ring buffer in `probe.js`; attached only
   when the composer's debug toggle is on, and that toggle only exists when the page
   has actually logged something.
10. ~~**Transient-state capture**~~ — freeze hotkey. Shipped as a screenshot plus a
    synchronous geometry snapshot, *not* a debugger pause: pausing JS still cannot hold
    a CSS `:hover` open, and the permission was not worth it. See the backlog.

Phase C — design-system layer (M, M)
6. ~~**Design-system awareness**~~ — see the detection matrix below. Payloads speak
   tokens, off-scale values get flagged, a guardrail line rides with every batch.
   Shipped with a test suite: one fixture project per row of the matrix, plus the
   hand-rolled and no-design-system cases. Two things the build changed: only spacing
   properties are measured against the step (a 13px type size is not off a 4px grid —
   type scales are ratios), and fixture directories are excluded from the walk, because
   this repo's own fixtures made it read as a Tailwind v4 project.
7. **Token chips** — chips show the element's current tokens; tapping opens pickers
   rendered from the project's own scale; picks dispatch as structured deltas. Phase 3
   (live preview in-page before dispatch) is where the dropped "live CSS trial" idea
   now lives. Must degrade to raw values + steppers with no design system.

Phase D — the loop back (M, S, S, L)
8. **Per-pin progress and results** — typed events over the existing SSE/`reply`
   plumbing: `working`, `edited` (files + diffstat), `resolved`. Scope guard: not a
   chat client.
9. **Follow-up threads** — reply on a green pin reopens with full context. Capped:
   after ~2 unresolved rounds the card says "take it to the terminal". Also carries
   Claude's mid-fix questions (e.g. shared-component scope: "this instance or
   everywhere?" — the behaviour that replaced the dropped scope dial).
11. **Batch history on disk** — bridge appends batches + resolutions to
    `.pinpoint/history.md`. No overlay UI.
12. **Re-capture after a fix** — Claude sees a fresh crop before resolving;
    before/after lands on the pin. Last on purpose: most expensive, and it pays off
    once there is something worth verifying. Failure paths (tab closed, element gone,
    permission lapsed) must be graceful.

Ops (pre-announce, not build items)
13. Chrome Web Store listing (M) · 14. donate link (XS) · 15. confirm repo
name/URLs (XS).

## Design-system detection matrix (item 6)

Two probes, because no single source covers every stack:

**Static probe (bridge, reads project files once per session)**
| Stack | Detect by | Tokens from |
|---|---|---|
| Tailwind v4 | `@theme` block in CSS entry | `@theme` custom properties |
| Tailwind v3 | `tailwind.config.{js,ts}` | resolved config (scales, palette) |
| shadcn/ui | `components.json` | its CSS variables (`--primary`, …) + Tailwind base |
| MUI | `@mui/material` in deps | default theme + any `createTheme` literal it can parse |
| Chakra | `@chakra-ui/react` in deps | default tokens + `extendTheme` literal |
| Mantine | `@mantine/core` in deps | `--mantine-*` CSS variables |
| Ant Design | `antd` in deps | `theme` token config if literal; else runtime probe |
| Bootstrap | `bootstrap` in deps | `--bs-*` CSS variables |
| DaisyUI | tailwind plugin entry | its theme variables |

**Runtime probe (extension, works for *every* stack including hand-rolled)**
- All CSS custom properties resolved on `:root` (and the pinned element) — the
  universal token source; catches styled-components/Emotion/vanilla-extract themes
  that static parsing can't reach.
- Component fingerprints from the DOM: `data-slot` (shadcn), `data-radix-*` (Radix),
  `Mui*` class prefixes, `ant-*`, `mantine-*`, `chakra-*` — names the component and
  its likely source file for the payload.

Tailwind + shadcn are first-class (deepest mapping, guardrail wording); everything
else rides the CSS-variable path + fingerprint table. Unknown stack ⇒ chips degrade
to raw values, guardrail line is omitted, nothing breaks.

## What was dropped, in one line each

Recorded fully in the backlog: multi-element comments, region select, team mode (0.1
decisions) · voice notes, breakpoint sweep, copy-edit mode, action trail (folded into
the debug toggle), design reference attachment, scope dial (replaced by behaviour),
live CSS trial (folded into token chips) · Firefox support (parked until traction).
