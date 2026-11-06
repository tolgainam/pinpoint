---
description: Show where to get the Pinpoint browser extension, then check everything is connected
---

Run this exact command and show the user its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

It prints what the browser runs now, the store links for the extension, and how to start
Claude Code with channels on, and it ends with the same checks as `/pinpoint:doctor`. The
plugin holds no copy of the extension. It comes from the browser's store.

The output has a line that starts with "Your browser:". It comes from the extension itself, which
tells the bridge its version, so it is the only thing to believe about the browser. Say it as it
is.
- "no extension has contacted the bridge": it is not installed (or no localhost page is open).
  Tell the user to install it from the store link for their browser.
- "runs extension X, older than Y": press Reload on the Pinpoint card, then reload the pages.
- "connected": nothing to do in the browser.

The output has a block about starting Claude Code with channels on. Tell the user in one line
that this is how comments appear in their session on their own, that it needs
`claude --dangerously-load-development-channels plugin:pinpoint@pinpoint-marketplace` and a
restart of the session (Claude Code shows a full-screen warning; they choose "I am using
this for local development"), and that without it comments wait until `/pinpoint:comments`.
You cannot restart their session for them.

The install is done when, on their dev page, clicking the Pinpoint icon shows the
toolbar and the pill on it shows their project name. The toolbar starts hidden in a new tab, so a
page with no toolbar before that click is normal. After that it stays open in the tab.

Then look at the checks at the end of the output:

- If any line says FAIL, help with the first one only: explain it in a sentence and give
  its Fix. Do not run the fix yourself when it stops a process (`pkill`, `kill`); the
  user runs that. When they say it is done, run `/pinpoint:doctor` again.
- A Channels line marked info is not a problem. Tell the user in one line whether
  comments will arrive on their own or need `/pinpoint:comments`.
