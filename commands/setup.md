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

If the user uses Firefox, run the same command with `--firefox` added. It builds the
Firefox copy in `~/.claude/pinpoint/extension-firefox` and opens `about:debugging`. Firefox
removes a temporary add-on when it quits, so tell them to load it again after a restart.

Chrome's "Load unpacked" is a file picker, so the user does that step themselves. Walk
them through it if they ask, in the words the script uses. Chrome runs the extension from
that folder, so it must stay where it is; after a Pinpoint update they run
`/pinpoint:setup` again and press Reload on the Pinpoint card.

The output ends with a block about starting Claude Code with channels on. Tell the user in
one line that this is how comments appear in their session on their own, that it needs
`claude --dangerously-load-development-channels plugin:pinpoint@pinpoint-marketplace` and a
restart of the session (Claude Code shows a full-screen warning; they choose "I am using
this for local development"), and that without it comments wait until `/pinpoint:comments`.
You cannot restart their session for them.

If a store link is printed at the top of the output, tell the user to install from it, and that
the folder steps below it are the fallback for developers.

The output has a line that starts with "Your browser:". It comes from the extension itself, which
tells the bridge its version, so it is the only thing to believe about the browser. Say it as it
is. Do not say to press Reload unless that line says the browser runs an older version, because
the user may have removed the extension altogether, and then the folder steps are an install.
- "no extension has contacted the bridge": it is not installed (or no localhost page is open).
  Walk them through loading the folder, or the store link if one is printed.
- "runs extension X, older than Y": press Reload on the Pinpoint card, then reload the pages.
- "connected": nothing to do in the browser.

The install is done when, on their dev page, clicking the Pinpoint icon shows the
toolbar and the pill on it shows their project name. The toolbar starts hidden in a new tab, so a
page with no toolbar before that click is normal. After that it stays open in the tab.

Then look at the checks at the end of the output:

- If any line says FAIL, help with the first one only: explain it in a sentence and give
  its Fix. Do not run the fix yourself when it stops a process (`pkill`, `kill`); the
  user runs that. When they say it is done, run `/pinpoint:doctor` again.
- A Channels line marked info is not a problem. Tell the user in one line whether
  comments will arrive on their own or need `/pinpoint:comments`.
