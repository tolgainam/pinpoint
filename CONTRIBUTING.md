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

## Checks

`npm run check` runs four quick gates and stops at the first failure:

1. Syntax: `node --check` on every `.js` file in `server/`, `scripts/` and `extension/`.
2. Design tokens: `scripts/check-design.js`, the raw-value check above.
3. Repo rules (`scripts/check-rules.js`): the version is the same in the server, `package.json` and the three manifests; nothing in `server/` writes to stdout, which carries the MCP transport; no sync write of decoded base64; every async HTTP handler call has a `.catch`; the content script lists in the manifest and `extension/worker.js` agree.
4. Types: `tsc` over the explicit file list in `tsconfig.check.json`. Add a module there once it passes as it is; there is no project-wide type check.

CI runs it before `npm test`.
