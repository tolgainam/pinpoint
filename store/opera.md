# Opera add-ons listing: Pinpoint

Everything the upload form at https://addons.opera.com asks for, ready to paste. The
package is `dist/store/pinpoint-<version>.zip`, made by `npm run package:extension`. The
screenshots are in `store/screenshots`, made by `npm run store:shots`.

## Package

- File: `dist/store/pinpoint-0.4.0.zip` (the contents of `extension/`, with `manifest.json`
  at the top of the zip).
- Version: `0.4.0`.
- Icon: `extension/icons/icon-128.png`. A larger square PNG is at `.claude-plugin/icon.png`
  (1024 x 1024).
- Screenshots (800 x 500, scaled from the Chrome set; the site allows up to 800 x 600), in this
  order: `store/screenshots/1-dispatch.png`, `2-ask.png`, `3-answer.png`, `4-backlog.png`,
  `5-fixed.png`. Each has a caption strip that says what it shows.

## Listing

- **Name:** Pinpoint
- **Category:** Web Development
- **Summary** (one sentence): Pin comments to elements on your local web app and talk to your
  Claude Code session from the page: ask, park or fix.
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

  Private by design
  Everything stays on your machine. Pinpoint has no server, no account and no analytics. The
  extension talks only to a small bridge on 127.0.0.1 that the Pinpoint plugin starts.

  What you need
  The free Pinpoint plugin for Claude Code and Node 20 or newer. Without the plugin the toolbar
  shows "Offline" and Dispatch is turned off. Setup steps: https://github.com/tolgainam/pinpoint

  Pinpoint is an independent tool. It is not affiliated with, endorsed by or sponsored by
  Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

- **Licence:** MIT (choose "own licence" and paste the text of `LICENSE`).
- **Support page:** https://github.com/tolgainam/pinpoint/issues
- **Homepage:** https://tolgainam.github.io/pinpoint/
- **Privacy policy:** https://github.com/tolgainam/pinpoint/blob/main/PRIVACY.md

## Permissions, in plain words

Use these if the form or a reviewer asks.

| Permission | Why |
|---|---|
| `storage` | Keeps your pins, drafts, toolbar position and settings in the browser. |
| `tabs` | Reads the address of the current tab so the toolbar can tell a local page from another site, and sends events to the right tab. |
| `scripting` | Attaches the toolbar to a tab that was already open when the extension was installed or reloaded. |
| `activeTab` | Lets the extension take a screenshot of the tab after you click its icon. |
| `localhost` and `127.0.0.1` | The pages Pinpoint works on, and the address of its own local bridge. |
| Optional: all sites | Never granted at install. Asked for one site at a time when you click the icon on a site that is not local, and once, on the welcome page, if you choose lasting screenshot access. |

## Notes for the reviewer

- **Source:** public and unminified, no build step. https://github.com/tolgainam/pinpoint
  The zip is the `extension/` folder as it is in the repository.
- **Network:** the extension talks only to `http://127.0.0.1:8788`, a bridge on the user's
  own machine. It sends nothing to any other host.
- **How to try it without Claude Code:** run any page on localhost, for example
  `python3 -m http.server 8000` in a folder with an `index.html`, open
  `http://localhost:8000`, and click the Pinpoint icon. The toolbar shows "Offline" because
  no bridge is running, but you can pick elements, write notes and see pins. Dispatch needs
  the bridge.
- **Manifest version:** 3. The zip is the same package that runs in Chrome and Edge. If the
  form rejects Manifest V3, please say so in the review notes.

## Before you submit

1. Run `npm run package:extension` and `npm run store:shots`.
2. Make sure `PRIVACY.md` is pushed to the `main` branch, or the privacy link will not open.
3. Test the zip yourself: in Opera, `opera://extensions`, Developer mode, Load unpacked,
   and pick the unzipped folder.
