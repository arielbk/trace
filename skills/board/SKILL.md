---
name: trace-board
description: Open the Trace task board — the web UI for browsing tasks. Use only when the user asks to open the board, open the task board, view tasks in the browser, or start the Trace web UI. Not for binding, re-entering, or recalling tasks (those are trace, trace-reenter, and trace-recall).
---

# Trace board

Use this skill only when the user asks to **open the task board** — the web UI
for browsing Trace tasks. Other intents belong elsewhere: binding or starting
work is `trace`, re-entering a named task is `trace-reenter`, and resolving a
vague reference is `trace-recall`.

**Open the board for the user yourself — never ask them to run a command.**

One command does all of it:

```sh
trace board
```

It reuses the local Trace connection that is already running rather than
starting a second one, opens the board in the user's default browser, and
prints the address it opened. Read that address off stdout, then
tell the user the URL.

Where it opens depends on how this machine is set up, and the command decides:
with a hosted board configured it opens there through a fresh, single-use
pairing link that expires in five minutes; otherwise it serves the board Trace
ships with itself. Nothing about that choice needs to be made here.

If the user asks specifically for the local board — or the hosted one is
misbehaving — pass the explicit fallback:

```sh
trace board --local
```

If the command reports that the connection is not running, it names the
recovery command in its own output (`trace connection install` to install the
background connection, `trace connection status` to see what is holding the
port). Run what it names rather than improvising.

`trace serve` still exists, but it is the foreground development runtime for
debugging the server itself — it is no longer the way to open a board. The
user stops a foreground server with Ctrl-C; the background connection keeps
running on its own.
