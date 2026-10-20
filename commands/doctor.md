---
description: Check that Pinpoint is connected (bridge, sessions, extension, channels) and say how to fix what is not
---

Run this exact command and show the user its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js"
```

Each line is a check: `ok`, `FAIL` with a one-line Fix under it, or `info`.

- If nothing says FAIL, say so in one line and stop.
- Otherwise walk the user through the **first FAIL only**. Say what it means in one plain
  sentence, then give its Fix as written. Do not move on to the next one in the same
  reply; when they say it is done, run this command again and take the next.
- Never run a fix that stops a process (`pkill`, `kill`) yourself; the user runs it. Fixes
  that use `/mcp` are steps for the user too.
- The Channels line is never a failure. Mention in one line whether comments will arrive
  on their own or need `/pinpoint:comments`, and only if the user asks about it or
  everything else passed.
