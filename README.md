# Pinpoint

A comment toolbar for the browser that dispatches into a running Claude Code session.

Pin comments to elements on a localhost dev app, hit **Dispatch**, and the batch —
element identity, page state, and a cropped screenshot per comment — arrives in your
terminal as work to do.

## Status

Not built yet. See [PLAN.md](./PLAN.md) for the architecture and the phased build order.

**Next step is Phase 0**: prove the Claude Code *channels* path works on this machine
before writing any code.

```bash
claude --channels plugin:fakechat@claude-plugins-official
# open http://localhost:8787, send a message, confirm it lands in the session
```

## Shape

| Path | What |
|---|---|
| `server/` | MCP channel server + local HTTP bridge (Bun) |
| `extension/` | Chrome MV3 extension — the overlay you actually click |
| `commands/` | `/pinpoint:comments` slash command |
| `.claude-plugin/` | Plugin manifest |

## Requirements

- Claude Code >= 2.1.235
- Bun
- Chrome
