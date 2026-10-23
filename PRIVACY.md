# Privacy

Pinpoint runs on your machine and has no server of its own. The author does not receive,
collect or store any data from it. It has no analytics, no telemetry and no account.

## What Pinpoint handles

When you add a comment, the browser extension reads the element you clicked: its selector,
text, computed styles, position, and a cropped screenshot. If you leave the option on, it
also reads the page's recent console errors and failed requests. This can include text
from the page you are viewing.

## Where it goes

- The extension sends this data only to the bridge on `127.0.0.1:8788`, on your own
  machine, and only when you press Dispatch or Park.
- The bridge writes it to files on your disk: `~/.claude/pinpoint/queue` and
  `<project>/.pinpoint/`. You can delete them at any time. Dispatched batches are pruned
  after 24 hours; the backlog is never pruned.
- The bridge passes a dispatched comment to the Claude Code session in your project. What
  Claude Code does with it is governed by Anthropic's terms and your Claude Code settings,
  not by Pinpoint.

## What stays in the browser

Pins and drafts are kept in the extension's local storage in your browser, keyed by page.
Remove the extension, or clear its storage, to delete them.

## Sites

The extension is always on for `localhost` and `127.0.0.1`. On any other site it asks for
permission, for that site only, when you click its icon. You can revoke a site in your
browser's extension settings.

## Children

Pinpoint is a developer tool and is not directed at children.

## Contact

Open an issue at https://github.com/tolgainam/pinpoint/issues.
