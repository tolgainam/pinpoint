# Contributing

These notes are for people working on Pinpoint itself. The plugin does not load this file.

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

## Try it without a project

```bash
npm run demo    # five demo pages on :3000
```

Port 3000 taken? `DEMO_PORT=3100 npm run demo` serves them on another one. The extension
works on any `localhost` port.

Pin something, dispatch it, watch it get fixed. The stylesheets hot-swap rather than
reloading the page, so screenshot permission survives between rounds.

`/` is a deliberately opinionated landing page with no design system at all.
`/fixtures/longform/` is a long page full of carousels, scroll containers, sticky
sections and charts, for testing pins on elements that move. The other three —
`/fixtures/tailwind/`, `/fixtures/shadcn/`, `/fixtures/chakra/` — each sit in a
directory that looks like a real project built with that stack, so the design-system
probe has something to read:

```bash
PINPOINT_PROJECT_DIR=demo/fixtures/shadcn npm run server
```

See [demo/fixtures/README.md](demo/fixtures/README.md) for what each one is meant to prove.

## Working on the toolbar

```bash
npm test                    # unit tests, the design check and the reference screenshots
npm run check:design        # raw colours or px outside extension/tokens.css
npx playwright install chromium   # once, so the screenshot test runs instead of skipping
```

Every colour, type size, spacing step, radius and shadow lives in
`extension/tokens.css`. The PNGs in `test/screens` are the reference look, one set per
platform; the test fails when a key screen changes. Baselines change only with the
owner's sign-off, via `npm run screens:update`, which also writes
`test/screens/PENDING.md` listing what moved.

The design rules are at the top of this file. Developing from a clone with the plugin also
installs two `pinpoint` servers; see
[Installing from a clone](README.md#installing-from-a-clone-instead).

## Firefox build and signing

A permanent Firefox install of your own build needs a signed add-on, because release Firefox refuses
unsigned ones. Get an API key and secret from
[addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/),
put them in your shell as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, then run
`npm run sign:firefox`. Mozilla signs it for self-distribution, which can take up to 24
hours, and the signed `.xpi` lands in `web-ext-artifacts/`. Install it from
`about:addons`, gear icon, **Install Add-on From File**. A self-distributed add-on does not
update itself: sign and install each new version the same way.

Firefox runs the same files as Chrome. `npm run build:firefox` writes the Firefox copy to
`dist/firefox`; the only differences are four manifest keys (event page instead of a
service worker, `options_ui`, an add-on id and a minimum version).
