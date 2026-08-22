# Demo projects — one per design-system stack

Three browsable pages, each sitting inside a directory that looks like a real project
built with that stack. They exist to exercise both halves of the design-system probe:

- the **static** half reads this directory's config files (`tailwind.config.js`,
  `components.json`, `src/theme.js`, `package.json` deps),
- the **runtime** half reads what the page resolved on `:root` plus the marks the
  library leaves on elements (`data-slot`, `class*="chakra-"`).

## Running one

Serve the pages, then point the bridge at the project you want probed:

```bash
npm run demo                                                  # all four pages on :3000
PINPOINT_PROJECT_DIR=demo/fixtures/tailwind npm run server     # probe reads that project
```

| Page | Project dir | What it should prove |
|---|---|---|
| [/fixtures/tailwind/](http://localhost:3000/fixtures/tailwind/) | `demo/fixtures/tailwind` | `tailwind.config.js` parsed without being executed; a 4px spacing scale; `p-[13px]` flagged off it; the guardrail asks for utility classes |
| [/fixtures/shadcn/](http://localhost:3000/fixtures/shadcn/) | `demo/fixtures/shadcn` | `components.json` plus `@layer base :root`; hsl triplets matched back to `--primary` and friends; `data-slot` and `data-radix-*` fingerprints found in the page |
| [/fixtures/chakra/](http://localhost:3000/fixtures/chakra/) | `demo/fixtures/chakra` | an `extendTheme` literal read as text; `space` in rem resolved to a 4px step; `--chakra-*` variables and `chakra-*` classes found at runtime |
| [/](http://localhost:3000/) | the repo root | no library at all — CSS custom properties only |

Running the bridge with `PINPOINT_PROJECT_DIR` set here also puts that project's
`.pinpoint/backlog.md` and `.pinpoint/shots/` inside it. Those are gitignored.

These pages are the same test bed for the token chips in the composer: the chips read
the merged summary a dispatch would carry, so a chip that names the wrong token here
names the wrong token everywhere.

## No build step

The stylesheets are hand-written to match what each framework would have generated for
this page. That is not a shortcut around a missing build — it is the honest shape of the
test. The probe never runs the framework: it reads config files as text and reads the
custom properties the browser resolved. Both are true of these pages exactly as they are
of a compiled one, and a demo that needed `npm install` in three subdirectories would be
a demo nobody runs.

Configs and dependency lists, on the other hand, are the real thing — those are what the
static probe parses, so a simplified one would test nothing.

## Why `fixtures/`

The probe skips any directory named `fixtures` when it walks a project, which is the
only reason these can live in the repo at all. Without that, running the bridge at the
repo root would find three configs and report Pinpoint itself as a Tailwind + shadcn +
Chakra project — the same false positive `test/fixtures/` caused while the probe was
being built.
