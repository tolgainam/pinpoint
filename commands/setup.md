---
description: Install the Pinpoint browser extension — prints its path, copies it, opens Chrome
---

Run this exact command and show the user its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"
```

It prints the path to the unpacked extension, copies that path to the clipboard, and
opens `chrome://extensions`. Chrome's "Load unpacked" is a file picker, so the user has
to do the final step themselves — walk them through it if they ask.

Then confirm the bridge is up:

```bash
curl -s localhost:8788/health
```

A JSON response means this session is receiving dispatches. Anything else means the MCP
server did not start — check `claude --debug` output, and that `node --version` is 20 or
newer.

Two things to mention once they are set up:

- Clicking the Pinpoint icon on a tab is what grants screenshot permission for it.
  Chrome revokes that on every navigation, so a full page reload means clicking again.
- Comments arrive here on their own only if the session was started with channels
  enabled. Otherwise they wait in the queue until `/pinpoint:comments` pulls them.
