---
description: Install or refresh the Pinpoint browser extension, then check everything is connected
---

Run this exact command and show the user its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"
```

It copies the extension to `~/.claude/pinpoint/extension` (refreshing it if it is already
there), puts that path on the clipboard, opens `chrome://extensions`, prints the steps for
loading it, and ends with the same checks as `/pinpoint:doctor`.

Chrome's "Load unpacked" is a file picker, so the user does that step themselves. Walk
them through it if they ask, in the words the script uses. Chrome runs the extension from
that folder, so it must stay where it is; after a Pinpoint update they run
`/pinpoint:setup` again and press Reload on the Pinpoint card.

The install is done when, on their dev page, clicking the Pinpoint icon shows the
toolbar and the pill on it shows their project name. The toolbar starts hidden, so a
page with no toolbar before that click is normal.

Then look at the checks at the end of the output:

- If any line says FAIL, help with the first one only: explain it in a sentence and give
  its Fix. Do not run the fix yourself when it stops a process (`pkill`, `kill`); the
  user runs that. When they say it is done, run `/pinpoint:doctor` again.
- A Channels line marked info is not a problem. Tell the user in one line whether
  comments will arrive on their own or need `/pinpoint:comments`.
