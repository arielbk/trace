# The local connection

EQNX keeps your tasks on your machine. The board — bundled or hosted — reads
them over a small HTTP API on `http://127.0.0.1:4317`, and the **local
connection** is the background process that serves it.

Once installed it starts at login and stays running, so opening the board is
never "first, start a server". This guide walks the whole life of that
connection, in the order you meet it.

## Install it

`eqnx setup` installs the connection alongside whatever agent integrations you
pick. It runs once per machine, after the usual preview and confirmation:

```sh
eqnx setup            # pick your agents, confirm, done
eqnx setup --yes      # same, without the questions
```

If you want the connection and no agent integrations at all:

```sh
eqnx connection install
```

Both write a per-user launchd job — `com.arielbk.trace.connection` — into
`~/Library/LaunchAgents/`, hand it to launchd, and start it. It runs as you, in
your login session. There is no root daemon and nothing is installed
system-wide.

Installing is idempotent. Running `eqnx setup` again on an unchanged install
leaves the running connection alone; removing your last agent integration does
not remove the connection.

## Open the board

```sh
eqnx board            # https://app.eqnx.ai
eqnx board --local    # the board EQNX ships with itself
```

`eqnx board` mints a fresh, single-use pairing link for `https://app.eqnx.ai`
and opens it. With hosted access disabled — or with `--local` — it opens the bundled
board. A healthy connection belonging to this installation is reused. The bundled
fallback starts a foreground server if it cannot reuse one, and tells you to
keep that terminal open.

`eqnx serve` still exists. It runs the board in the foreground, in your
terminal, and is the right tool when you are developing on EQNX itself or
troubleshooting. It is not needed day to day.

### Configuring the hosted origin

The default allowed origin is `https://app.eqnx.ai`. Ordinary installation needs
only `npm install -g @eqnx/cli` followed by `eqnx setup`.
For development or custom hosting, replace that origin explicitly:

```sh
export TRACE_WEB_ORIGIN=https://your-board.example
eqnx setup
```

`TRACE_WEB_ORIGIN` must be an `https://` origin with no path. It is written
into the launchd job when the connection is installed, because a login service
inherits nothing from your shell. Keep the override exported for later setup,
update, and board commands. To change it, run setup again with the new value.
An empty override disables hosted access; invalid overrides also fail closed:

```sh
export TRACE_WEB_ORIGIN=''
eqnx setup
```

Requests from any other origin are refused, and so is any origin at all on the
local management routes.

## Pair a browser

Each browser gets its own credential. The first page prepares a command with a
short code, for example:

```sh
eqnx connection pair ABCD-1234
```

Run the exact command shown on your page in Terminal, then return to that page.
It connects automatically, with no extra tab or preliminary Connect click.
The command expires after five minutes; the page offers a fresh one if needed.

The short code identifies a pending request. Only the authenticated local CLI
can approve it. A separate random secret stays in the requesting tab and claims
its browser credential after approval. Requests are single-use, held in memory,
and cleared by a restart or connection reset. Up to ten may wait at once.

For a terminal-first flow, `eqnx connection pair --open` still opens a pairing
link in your default browser and prints a fallback. `eqnx connection pair`
prints that link without opening it. These links also expire after five minutes
and one use; their secrets are carried in the URL fragment.

Pairing does not restart anything, and it does not disturb browsers that are
already paired.

## Log out, reboot, come back

launchd starts the job again at your next login, so you do not have to start it in a terminal. Paired browsers reconnect on their own — their credential is
persisted, and the board re-handshakes when the tab regains focus.

Pairing links are the exception: they live only in the process that minted
them, so an unclaimed link stops working after a restart. Run
`eqnx connection pair` again.

If a visit to the hosted board finds the connection gone, the board says so and
retries with a backoff rather than dropping what you were looking at. It
distinguishes a connection it cannot reach from one that refused it — a revoked
credential — from one running a version it does not speak.

## Add a second browser

Use another browser or browser profile on the same computer: same command,
one link each. This connection listens only on this machine’s loopback address;
a phone or another laptop cannot use it to read this computer’s tasks.

```sh
eqnx connection pair
eqnx connection browsers
```

`browsers` lists what is paired, by id, with the date it was paired. Each entry
is a separate credential — revoking one leaves the others alone.

## Revoke access

```sh
eqnx connection revoke <id>   # one browser
eqnx connection reset         # every browser, all at once
```

Both take effect on the next request, against the connection that is already
running — no restart, no re-pairing of the browsers you kept. `reset` also
invalidates any outstanding pairing links, and leaves your own local management
access intact.

## Upgrade

```sh
eqnx update
eqnx update --yes
```

A package manager replaces the EQNX executable in place, which leaves the
login service still running yesterday's copy — launchd does not notice on its
own. `eqnx update` restarts the connection onto the new version as its last
step, and it does this whether or not you have any agent integrations
registered. Paired browsers survive the restart.

If the upgrade lands but the restart does not, `eqnx update` says exactly that
and points you at `eqnx connection restart`.

## Diagnose and recover

```sh
eqnx connection status
```

Reports who holds `127.0.0.1:4317` — this installation's connection, another
EQNX, or an unrelated process — along with whether launchd is holding the job
and where its logs are. Logs are owner-only and omit credentials and pairing secrets. At startup,
logs larger than 1 MiB are rotated, retaining one previous copy.

| What you see                        | What to run                          |
| ----------------------------------- | ------------------------------------ |
| Connection: not running             | `eqnx connection restart`           |
| Another EQNX installation holds it | stop that one, then restart this one |
| Another process is listening        | free port 4317, then restart         |
| A runtime speaking another protocol | `eqnx connection restart`           |
| Board loads but shows no tasks      | `eqnx connection browsers`          |

EQNX never terminates a process it did not start. If something else is on the
port it tells you, and stops there.

## Uninstall

```sh
eqnx connection uninstall
```

Stops and removes the launchd job, deletes its plist, and revokes every paired
browser. It is deliberately narrow: your tasks, your task documents, and your
agent integrations are untouched, and running it twice is not an error. To undo
it, run `eqnx connection install` again — and pair your browsers afresh.

## Boundaries

- **macOS only.** The login service is a launchd user agent. On **Linux** and
  **Windows**, agent integrations work exactly as they do everywhere else, but
  there is no managed connection — run `eqnx serve` in a terminal to connect a
  board, and it will tell you as much if you ask it to install one.
- **Ephemeral installs are refused.** A connection started from an `npx` cache
  or a source checkout would break the moment that path moved, so
  `eqnx connection install` declines them and says why.
- **Your browser may ask about the local network.** A hosted page reaching
  `127.0.0.1` is a local network request, and recent browsers prompt for it the
  first time. Denying the prompt looks exactly like a connection that is down;
  allow it, or open `eqnx board --local` instead.
- **The hosted board can read, and can archive and pin.** Writing documents,
  exporting, signing in, and syncing stay on this machine, whatever the local
  API supports.
