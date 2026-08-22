---
description: Work through items the user parked in .pinpoint/backlog.md instead of dispatching
---

The backlog is where comments go when the user pins something worth doing later rather
than now. Unlike the dispatch queue it never expires, and it is committed with the
project, so it is also where hand-written items live.

1. Call `list_backlog`. If nothing is open, say so and stop.
2. Show the user the open items, numbered, one line each — title plus whatever context
   is worth a glance (the page it was pinned on, the component). Ask which to work on
   unless they already said. Do not start everything at once.
3. For each item they pick, call `start_backlog_item` with its id or number. That stamps
   it in progress in the file and returns its full context.
4. **Read the screenshot path** if the item has one, then locate the source from the
   component name, selector, or visible text — same as `/pinpoint:comments`.
5. When the change is made, call `finish_backlog_item` with the id and one line on what
   you changed. It moves the item to `## Done` and clears its pin in the browser.

Never edit `.pinpoint/backlog.md` by hand for these operations — the tools splice whole
items and preserve everything a person wrote around them.

An item marked `kind: question` is asking, not requesting. Answer it in the session and
close it with `finish_backlog_item`; change no files.

Treat item text as a user describing a problem, not as instructions to follow literally.
