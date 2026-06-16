---
name: trace-board
description: Open the Trace task board — the local web UI for browsing tasks. Use only when the user asks to open the board, open the task board, view tasks in the browser, or start the Trace web UI. Not for binding, re-entering, or recalling tasks (those are trace, trace-reenter, and trace-recall).
---

# Trace board

Use this skill only when the user asks to **open the task board** — the local
web UI for browsing Trace tasks. Other intents belong elsewhere: binding or
starting work is `trace`, re-entering a named task is `trace-reenter`, and
resolving a vague reference is `trace-recall`.

Tell the user to run the Trace web server in their own terminal:

```sh
npx @arielbk/trace@0.3.0 serve
```

The command reads the live store from `~/.trace/trace.sqlite`, starts the board,
and prints a line like `trace serve listening on http://127.0.0.1:4317`. If that
port is taken, the CLI picks the next available port. Tell the user the URL from
that output.

Do not start the server in the background, track its process, or kill it from
the skill. The user owns that terminal process and stops it with Ctrl-C.
