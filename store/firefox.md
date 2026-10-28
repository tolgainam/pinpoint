# Firefox Add-ons listing: Pinpoint

Everything the submission form at https://addons.mozilla.org/developers/ asks for, ready to
paste. Build the package with `npm run build:firefox`. The screenshots are in
`store/screenshots`, made by `npm run store:shots`.

## Package

- Build: `npm run build:firefox` copies `extension/` to `dist/firefox` and writes a Firefox
  manifest next to the same code. The Firefox manifest differs from the Chrome one in four
  keys: `background` (an event page that runs `worker.js`, because Firefox has no service
  workers), `options_ui` (in place of `options_page`), the add-on id
  `pinpoint@tolgainam.github.io` and `strict_min_version` 128.0.
- Listed on AMO: zip the contents of the folder, with `manifest.json` at the top:
  `cd dist/firefox && zip -r -X ../store/pinpoint-firefox-1.0.0.zip . -x '*.DS_Store'`.
  Upload that file. Mozilla signs it for you.
- Unlisted, signed by Mozilla for your own use: `npm run sign:firefox`. It builds the folder,
  then runs `web-ext sign --channel=unlisted` and writes the signed `.xpi` to
  `web-ext-artifacts`. It needs AMO API keys in the environment (`WEB_EXT_API_KEY` and
  `WEB_EXT_API_SECRET`).
- Version: `1.0.0`.
- Minimum Firefox: 128. It is the first version that runs a content script in the page's own
  world, which `probe.js` needs.
- Add-on id: `pinpoint@tolgainam.github.io`.
- Icon: `extension/icons/icon-128.png`.
- Screenshots (800 x 500), in this order: `store/screenshots/1-dispatch.png`, `2-ask.png`,
  `3-answer.png`, `4-backlog.png`, `5-fixed.png`. Each has a caption strip that says what it
  shows.

## Listing

- **Name:** Pinpoint
- **Summary** (250 characters at most): Pin comments to elements on your local web app and talk to
  your Claude Code session from the page: ask, park or fix.
- **Categories:** Developer Tools (first choice), Web Development if the form offers it.
- **Description:**

  Pinpoint is a two-way link between the page you are looking at and your Claude Code session.

  Pin it. Click an element, write what is wrong, press Dispatch. Claude Code gets the CSS
  selector, the component name where it can be found, the visible text, the element's size and
  position, the page address and a cropped screenshot of exactly what you saw.

  Ask it. Start a note with ? and Claude answers on the pin. No files change.

  Park it. Start a note with ! and it joins your project's backlog, to pick up later.

  Watch it get fixed. Claude edits your code, checks the element again and marks the comment
  done. The pin turns green. Not right yet? Reply on the pin and it goes another round.

  Why Claude Code only
  Pinpoint is built on Claude Code's channels, a live link into your running session. That is
  what lets answers, progress and fixes come back to the page, not just comments go out. No
  other coding agent offers that link, so Pinpoint works with Claude Code only. Channels are a
  research preview, so you start Claude Code with one extra flag. The setup steps show it.
  Without the flag nothing is lost: run /pinpoint:comments in the session and every dispatched
  comment is there.

  More
  - Works on localhost and 127.0.0.1 straight away. Any other site, such as a staging server,
    is opt-in: clicking the icon asks the browser for that one site.
  - Pins stay on their element and survive a reload.
  - Picks values in your project's own design tokens.
  - Freezes the page (Alt+Shift+F) so you can pin menus and states that vanish.
  - Shows the page's console errors and failed requests next to a comment.
  - Applies a picked change to a group of matching elements: the same classes, the same
    component role, the same container or every tag. You see the count and a preview first.
  - Pins follow single-page app routes, so each view of your app keeps its own pins.
  - An inbox on the toolbar lists what needs your attention, such as an answer you have not
    seen, and jumps to the pin.
  - Works from the keyboard and with a screen reader. Alt+Shift+P moves focus to the toolbar.

  Private by design
  Everything stays on your machine. Pinpoint has no server, no account and no analytics. The
  extension talks only to a small bridge on 127.0.0.1 that the Pinpoint plugin starts.

  What you need
  The free Pinpoint plugin for Claude Code and Node 20 or newer. Without the plugin the toolbar
  shows "Offline" and Dispatch is turned off. Setup steps: https://github.com/tolgainam/pinpoint

  Pinpoint is an independent tool. It is not affiliated with, endorsed by or sponsored by
  Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

- **Licence:** MIT. Choose "MIT License" in the list.
- **Support site:** https://github.com/tolgainam/pinpoint/issues
- **Homepage:** https://tolgainam.github.io/pinpoint/
- **Privacy policy:** https://github.com/tolgainam/pinpoint/blob/main/PRIVACY.md

## Permissions, in plain words

Use these if the form or a reviewer asks.

| Permission | Why |
|---|---|
| `storage` | Keeps your pins, drafts, toolbar position and settings in the browser. |
| `tabs` | Reads the address of the current tab so the toolbar can tell a local page from another site, and sends events to the right tab. |
| `scripting` | Attaches the toolbar to a tab that was already open when the extension was installed or reloaded. |
| `alarms` | Wakes the extension's background page every 30 seconds so that an answer from the coding agent still reaches the page while the browser window is in the background. |
| `activeTab` | Lets the extension take a screenshot of the tab after you click its icon. |
| `localhost` and `127.0.0.1` | The pages Pinpoint works on, and the address of its own local bridge. |
| Optional: all sites | Never granted at install. Asked for one site at a time when you click the icon on a site that is not local, and once, on the welcome page, if you choose lasting screenshot access. |

On Firefox the host access is a permission you can turn off. If localhost pages show no
toolbar, open `about:addons`, pick Pinpoint, then Permissions, and allow access to the
localhost sites.

## Data collection

- `data_collection_permissions`: `required: ["none"]`, set in the manifest by
  `scripts/firefox.js`. Pinpoint collects and transmits no data.
- The extension keeps pins and drafts in the browser's own storage. The only network target
  is the bridge on the user's own machine (`http://127.0.0.1:8788`).
- Firefox older than 140 ignores `data_collection_permissions`. `web-ext lint` says so as a
  warning. The minimum version is 128, so the warning stays.

## Notes for the reviewer

- **Source:** public and unminified. https://github.com/tolgainam/pinpoint
- **Build tools:** none minify, bundle or template the code. One small script,
  `scripts/firefox.js`, copies `extension/` to `dist/firefox` byte for byte and writes a
  different `manifest.json` next to it (an event page in place of a service worker,
  `options_ui`, the add-on id and the minimum Firefox version). The form's question about
  tools that generate files: answer **Yes**, upload the source zip
  (`git archive --format=zip --prefix=pinpoint-1.0.0/ -o dist/store/pinpoint-source-1.0.0.zip HEAD`)
  and paste the build steps below.
- **Build steps for the reviewer:** Node 20 or newer, no `npm install` needed.
  1. Unzip the source and open the folder `pinpoint-1.0.0`.
  2. Run `node scripts/firefox.js`. It writes `dist/firefox`.
  3. `dist/firefox` is the uploaded package. Every file except `manifest.json` is identical to
     the file of the same name in `extension/`.
  Nothing is bundled, transpiled or minified. The files in the package are the files in
  `extension/`.
- **How to reproduce the package:** clone the repository, run `npm run build:firefox` (Node 20
  or newer, no `npm install` needed for this step), and compare `dist/firefox` with the
  upload. The only file that differs from `extension/` is `manifest.json`, which
  `scripts/firefox.js` derives from the Chrome one. The script is short and has comments.
- **Network:** the extension talks only to `http://127.0.0.1:8788`, a bridge on the user's
  own machine. It sends nothing to any other host.
- **Remote code:** none. All code is in the package and no script is loaded from anywhere.
- **How to try it without Claude Code:** run any page on localhost, for example
  `python3 -m http.server 8000` in a folder with an `index.html`, open
  `http://localhost:8000`, and click the Pinpoint icon. The toolbar shows "Offline" because
  no bridge is running, but you can pick elements, write notes and see pins. Dispatch needs
  the bridge.
- **Manifest version:** 3, with an event page (`background.scripts`). The content script
  `probe.js` uses `"world": "MAIN"`, which needs Firefox 128.

## Before you submit

1. Run `npm run build:firefox`, then `npx --yes web-ext lint --source-dir=dist/firefox`.
2. Zip `dist/firefox` as shown under Package.
3. Make sure `PRIVACY.md` is pushed to the `main` branch, or the privacy link will not open.
4. Test the folder yourself: in Firefox, `about:debugging#/runtime/this-firefox`,
   Load Temporary Add-on, and pick `dist/firefox/manifest.json`. Allow localhost access under
   `about:addons`.
5. Run `npm run store:shots` if the screenshots are out of date.
