#!/usr/bin/env node
/**
 * The two promo images the Chrome Web Store asks for: a small tile (440x280, required)
 * and a marquee (1400x560, optional). Drawn from the logo and the page's own colours and
 * written to store/chrome. Run through `npm run store:shots`.
 */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { available } from '../test/screens/shoot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'store', 'chrome')

const browser = await available()
if (!browser.ok) {
  console.error(`store-tiles: ${browser.why}`)
  process.exit(1)
}

const logo = `data:image/svg+xml;base64,${(await readFile(join(ROOT, 'docs', 'pinpoint-logo.svg'))).toString('base64')}`

/** One layout at two scales. `u` is the unit everything is sized from. */
const tile = (w, h, u) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${w}px; height: ${h}px; background: #fff; color: #0a0a0a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .t { box-sizing: border-box; width: 100%; height: 100%; padding: ${u * 3}px; display: flex; align-items: center; gap: ${u * 2.4}px; }
  img { width: ${u * 9}px; height: ${u * 9}px; flex: none; }
  .n { font-size: ${u * 2.6}px; font-weight: 700; letter-spacing: ${u * 0.28}px; margin: 0 0 ${u * 0.8}px; }
  .s { font-size: ${u * 1.3}px; line-height: 1.3; white-space: nowrap; margin: 0; letter-spacing: -0.01em; }
  .s em { font-style: normal; color: #c0552f; }
  .k { font-size: ${u * 1.1}px; color: #5c5c5c; margin: ${u * 0.9}px 0 0; white-space: nowrap; }
  .r { height: 2px; background: #0a0a0a; width: ${u * 4}px; margin: ${u * 1.2}px 0; }
</style><div class="t"><img src="${logo}" alt=""><div>
  <p class="n">PINPOINT</p><div class="r"></div>
  <p class="s">Comment on the page.<br><em>Fix it in the terminal.</em></p>
  <p class="k">A two-way link to Claude Code</p>
</div></div>`

await mkdir(OUT, { recursive: true })
const page = await (await browser.chromium.launch({ channel: 'chromium' })).newPage()
for (const [file, w, h, u] of [['promo-small-440x280.png', 440, 280, 14], ['promo-marquee-1400x560.png', 1400, 560, 28]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(tile(w, h, u))
  await page.screenshot({ path: join(OUT, file) })
}

/**
 * Opera's add-ons site takes screenshots up to 800x600. The Chrome set is 1280x800, so the
 * same pictures are scaled to 800x500 rather than shot a second time at a width where the
 * demo page lays out differently.
 */
const SHOTS = join(OUT, 'screenshots')
const OPERA = join(ROOT, 'store', 'screenshots')
await mkdir(OPERA, { recursive: true })
await page.setViewportSize({ width: 800, height: 500 })
for (const name of (await readdir(SHOTS)).filter(f => f.endsWith('.png'))) {
  const png = (await readFile(join(SHOTS, name))).toString('base64')
  await page.setContent(`<!doctype html><style>html,body{margin:0}img{display:block;width:800px;height:500px}</style><img src="data:image/png;base64,${png}">`)
  await page.screenshot({ path: join(OPERA, name) })
}
await page.context().browser().close()
console.log(`store-tiles: wrote 2 tiles to ${OUT} and scaled the screenshots to ${OPERA}`)
