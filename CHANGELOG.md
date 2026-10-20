# Changelog

## 0.3.0

- The toolbar starts hidden. Clicking the Pinpoint icon shows it.
- Per-project routing: comments from a page go to the Claude Code session for that
  page's project, not to whichever session holds the bridge.
- A status pill on the toolbar shows where comments go, with a session picker when
  several sessions are open.
- Guided `/pinpoint:setup` and a new `/pinpoint:doctor`: a short pass/fail list (Node,
  bridge and its version, sessions, duplicate MCP entries, channels, extension copy) with
  one fix for each problem.
- Stable extension folder: setup copies the extension to `~/.claude/pinpoint/extension`,
  so an update only needs Reload in `chrome://extensions` instead of loading a new path.
- Bridge takeover and yield: when the session holding the bridge closes, another takes it
  over, and an older bridge hands the port to a newer one after an update. Bridges older
  than 0.3.0 cannot be asked; `/pinpoint:doctor` prints the command that stops them.
