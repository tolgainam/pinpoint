# Chrome Web Store listing: Pinpoint

Everything the Chrome Web Store dashboard asks for. Upload the zip, then paste the text into
each tab. Build the zip and the images with `npm run package:extension` and
`npm run store:shots`.

## Package

- File: `dist/store/pinpoint-1.0.0.zip`. It is the `extension/` folder with `manifest.json`
  at the top. The same file works for Edge Add-ons.
- The extension's name and description come from `manifest.json`. The description is under
  132 characters, which the store requires.

## Store listing tab

- **Name:** Pinpoint
- **Summary:** taken from the manifest. It reads: Pin comments to elements on a local dev page and dispatch them into a running Claude Code session.
- **Category:** Developer Tools
- **Language:** English
- **Description:**

  Pinpoint is a two-way link between the page you are looking at and your Claude Code session.

  Pin it. Click an element, write what is wrong, press Dispatch. Claude Code gets the CSS
  selector, the component name where it can be found, the visible text, the element's size and
  position, the page address and a cropped screenshot of exactly what you saw.

  Ask it. Start a note with ? and Claude answers on the pin. No files change.

  Park it. Start a note with ! and it joins your project's backlog, to pick up later.

  Watch it get fixed. Claude edits your code, checks the element again and marks the comment
  done. The pin turns green. Not right yet? Reply on the pin and it goes another round.

  Claude Code and Cowork
  Pinpoint works in Claude Code and in Cowork. In Claude Code it is built on channels, a live
  link into your running session. That is what lets answers, progress and fixes come back to
  the page, not just comments go out. Channels are a research preview, so you start Claude
  Code with one extra flag. The setup steps show it. Without the flag, and in Cowork, nothing
  is lost: run /pinpoint:comments in the session and every dispatched comment is there.

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

- **Graphics** (in `store/chrome/`):
  - Icon: 128 x 128 is taken from the zip (`icons/icon-128.png`).
  - Screenshots, 1280 x 800, in this order: `screenshots/1-dispatch.png` (pin and dispatch),
    `2-ask.png` (ask a question), `3-answer.png` (the answer on the pin), `4-backlog.png`
    (park it) and `5-fixed.png` (Claude fixes it). Each has a caption strip that says what it shows.
  - Small promo tile, 440 x 280 (required): `promo-small-440x280.png`.
  - Marquee, 1400 x 560 (optional): `promo-marquee-1400x560.png`.
- **Official URL / homepage:** https://tolgainam.github.io/pinpoint/
- **Support URL:** https://github.com/tolgainam/pinpoint/issues

## Privacy tab

- **Single purpose:** Let a developer pin comments to elements on a web page and send them,
  with the element's details and a screenshot, to the coding agent running on the same
  machine.
- **Permission justifications**

  | Permission | Justification |
  |---|---|
  | `storage` | Keeps pins, unsent drafts, the toolbar position and settings in the browser. |
  | `tabs` | Reads the address of the current tab to tell a local page from another site, and sends events from the worker to the right tab. |
  | `scripting` | Attaches the toolbar to a tab that was already open when the extension was installed or reloaded, and to a site the user chose. |
  | `alarms` | Wakes the extension's background worker every 30 seconds so that an answer from the coding agent still reaches the page while the browser window is in the background. |
  | `activeTab` | Takes a screenshot of the tab after the user clicks the icon. |
  | Host access: `http://localhost/*`, `http://127.0.0.1/*` | The pages Pinpoint works on, and the address of its own local bridge (`127.0.0.1:8788`). |
  | Optional host access: all sites | Not granted at install. Asked for one site at a time when the user clicks the icon on a site that is not local, and once on the welcome page if the user chooses screenshots without clicking. |

- **Remote code:** No. The extension loads no code from anywhere. All of it is in the package.
- **Data usage** (what the form asks you to tick):
  - Collects: *Website content* (the text, styles and screenshot of the element the user
    picks) and *Web history* (the address of the page being commented on), only when the user
    adds a comment.
  - Not collected: personally identifiable information, health, financial, authentication,
    personal communications, location, user activity beyond the above.
  - Certify all three: the data is not sold, not used for anything unrelated to the single
    purpose, and not used for credit or lending.
  - Where the data goes: only to a bridge on the user's own computer (`127.0.0.1`).
- **Privacy policy URL:** https://github.com/tolgainam/pinpoint/blob/main/PRIVACY.md

## Distribution tab

- **Visibility:** Public. (Choose "Unlisted" first if you want to test the install link.)
- **Regions:** all.

## Notes for review

- **Source:** public and unminified, no build step: https://github.com/tolgainam/pinpoint
- **Network:** only `http://127.0.0.1:8788`. Nothing is sent to any other host.
- **Shortcuts:** Alt+Shift+F freezes the page and Alt+Shift+P moves the keyboard to the toolbar.
  Both are extension commands and need no permission.
- **How to try it without the plugin:** open any page on localhost and click the icon. The
  toolbar shows "Offline" because no bridge is running, but you can pick elements, write
  notes and see pins. Dispatch needs the bridge.
- **Why the broad optional permission exists:** Chrome's screenshot call accepts only
  `<all_urls>` or `activeTab`. `activeTab` is lost on every navigation, so the welcome page
  offers `<all_urls>` as an opt-in button. It is off by default.

## Before you submit

1. Run `npm run package:extension` and `npm run store:shots`.
2. Push `PRIVACY.md` to `main`, so the privacy link opens.
3. Try the zip yourself: `chrome://extensions`, Developer mode, Load unpacked, and pick the
   unzipped folder.
4. Pay attention to the two Privacy-tab answers most often rejected: the permission
   justifications and the data-usage ticks. Paste them from this file.
