# Pinpoint history

What was pinned, and what came of it. Appended by Pinpoint, newest at the bottom; the
queue in ~/.claude is pruned after a day, this is not. Delete it whenever you like — it
is a log, nothing reads it back.


## 2026-08-22
- 14:29 · **20260822-142925-zujg** · 1 on http://localhost:3000/fixtures/tailwind/
  - · #1 Make this half width of its current state. — `[data-testid="tw-off-scale"]`
- 14:30 · ✓ 20260822-142925-zujg#1 — Strip is now w-1/2 (848px → 424px) and painted bg-warm / text-pp-bg, both added to tailwind.config.js as named tokens.

## 2026-08-24
- 12:14 · **20260824-121424-wzj5** · 2 on http://127.0.0.1:8098/b-swiss.html#
  - · #1 make the text blue — `em`
  - · #2 make this small — `h2`
- 12:16 · ✓ 20260824-121424-wzj5#1 — Added --acc-2:#0b4ed8 to the page palette and pointed h1 em at it, so only the hero phrase turns blue (nav mark and active underline keep --acc red).
- 12:16 · ✓ 20260824-121424-wzj5#2 — h2 38px → 27px, one step down the page's √2 scale (76 / 38 / 27 / 19), so it still outranks the 19px lede.
