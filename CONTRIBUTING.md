# Contributing

These rules are for people working on the toolbar. The plugin does not load this file.

## Design rules

- Colours, type, spacing, radii, shadows and layers come only from `extension/tokens.css`, as `var(--pp-*)`.
- No raw values anywhere else in `extension/`. `npm run check:design` (also part of `npm test`) fails on them.
- The only escape is `/* design-ok: reason */` on the same line, and it needs a real reason.
- The PNGs in `test/screens` are the reference look. `npm test` fails when a key screen changes.
- Baselines change only with the owner's sign-off, via `npm run screens:update`, which writes `test/screens/PENDING.md` listing what moved.
- Never edit a baseline or the tolerance to make the test pass.
- Visual detail (colour, type, icons) is settled with the owner on the running app, not in code review.
