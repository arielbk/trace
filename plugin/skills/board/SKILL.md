---
name: trace-board
description: Open the Trace task board — the local web UI for browsing tasks. Use only when the user asks to open the board, open the task board, view tasks in the browser, or start the Trace web UI. Not for binding, re-entering, or recalling tasks (those are trace, trace-reenter, and trace-recall).
---

# Trace board

Use this skill only when the user asks to **open the task board** — the local
web UI for browsing Trace tasks. Other intents belong elsewhere: binding or
starting work is `trace`, re-entering a named task is `trace-reenter`, and
resolving a vague reference is `trace-recall`.

**Open the board for the user yourself — never ask them to run a command.**

First check whether a board is already serving on the default port; if so, just
point the browser at it instead of starting a duplicate server:

```sh
curl -sf --max-time 2 -o /dev/null http://127.0.0.1:4317/ && open http://127.0.0.1:4317/
```

If that succeeds a board is already up — the browser is now on it, so tell the
user the URL and stop. (Use `xdg-open` on Linux, `start` on Windows.)

Otherwise start the server yourself as a **background** process, so it keeps
listening across turns:

```sh
npx @arielbk/trace@0.13.0 serve
```

It reads the live store from `~/.trace/trace.sqlite`, prints
`trace serve listening on http://127.0.0.1:4317` (the next available port if
4317 is taken), and opens the board in the user's default browser
automatically. Read that stdout line and tell the user the URL.

The user stops the server with Ctrl-C, or it exits when the session ends — you
don't need to track or kill the process.
