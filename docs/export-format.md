# Task export format

A Trace export bundle packages one task so it can leave the machine it was
made on — handed to a teammate, attached to a PR, archived, or read by another
tool. The zip is transport; the tree inside it is the format.

This document is the contract for `formatVersion` 1. A bundle can be produced
or consumed without Trace. Trace does not ship a blank template.

## Bundle tree

```
<slug>-YYYY-MM-DD/
  README.md
  manifest.json
  docs/
    state.md                 # first, when present
    <other docs…>
  transcripts/               # only when transcripts are included
    <sessionId>.jsonl
    <sessionId>.json         # cursor-composer-export only
```

The zip is named `<slug>-YYYY-MM-DD.zip` and contains that single top-level
folder. `YYYY-MM-DD` is the UTC calendar date of `exportedAt` (the first ten
characters of the ISO-8601 timestamp). Unzipping into a directory therefore
yields one tidy folder, not a scatter of files.

`docs/` is always present, even when the task has no documents (an empty
directory). `transcripts/` is omitted unless at least one session transcript
was included.

`README.md` is a human rendering of facts that also appear in `manifest.json`.
It never includes `sourcePath`. A machine consumer should parse `manifest.json`
and ignore the README.

## `formatVersion`

`formatVersion` is an integer. This specification describes version `1`.

- A reader **must refuse** a bundle whose `formatVersion` it does not implement.
- A reader **must ignore** unrecognized keys, so optional additions within a
  version stay readable.
- Bump the integer when a documented field is removed, renamed, changes type,
  or changes meaning, or when a new **required** field is added. New optional
  fields may stay on the same version.

Producers that are not Trace omit `generator`.

## Transcripts

Transcripts are **off by default**. Including them is an explicit opt-in
(`trace export --include-transcripts`, or `GET /api/tasks/<ref>/export?transcripts=1`
on the local board API).

**Transcripts are copied unmodified and are not redacted.** They may contain
secrets, absolute home paths, and machine identifiers. There is no redaction
step. The opt-in is the consent mechanism; partial redaction would produce
false confidence that a bundle is safe to share and would corrupt the
transcript as evidence.

The one declared exception to verbatim copy is `cursor-composer-export` (see
[Format tags](#format-tags)): Cursor GUI composers have no on-disk transcript
file, so Trace serializes the composer’s messages to JSON.

A session whose transcript could not be included still appears in
`manifest.json`. The gap is a recorded fact (`transcript.status`), never a
silent hole.

## `manifest.json`

UTF-8 JSON, pretty-printed with a trailing newline. All timestamps are
ISO-8601 strings. Token counts are numbers. Cost figures are optional
list-price-equivalent USD amounts derived from a pinned rate table; they are
never stored as a source of truth. No duration, currency-conversion, or
author field is part of this version.

### Top level

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `formatVersion` | yes | integer | `1` for this specification |
| `generator` | no | string | Trace version that produced the bundle. Absent when the producer is not Trace |
| `exportedAt` | yes | string | ISO-8601 timestamp of the export |
| `pricedAt` | no | string | Identifier of the rate table used to derive cost. Present on Trace-produced bundles so two bundles can be compared on basis |
| `task` | yes | object | The exported task |
| `project` | yes | object | The project the task is keyed to |
| `docs` | yes | array | Bundle documents; empty array when there are none |
| `sessions` | yes | array | Every session on the task, including subagents and spawned children |
| `totals` | yes | object | Rolled-up counts, tokens, timestamps, and optional cost |

### `task`

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes | string | Stable task id |
| `slug` | yes | string | Used in the folder and zip names |
| `title` | yes | string | |
| `description` | no | string | Omitted when the task has none |
| `createdAt` | yes | string | ISO-8601 |

### `project`

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `slug` | yes | string | |
| `remote` | no | string | Present when a remote is known (for example a GitHub `owner/repo` or host path) |

### `docs[]`

Each entry describes one file under `docs/`. `state.md` is ordered first when
present. Two inputs that share a basename keep distinct bundle paths: the
second becomes `docs/<stem>-2<ext>`, then `-3`, and so on.

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `path` | yes | string | Bundle-relative, always under `docs/` |
| `title` | no | string | From the registered doc row when present |
| `description` | no | string | From the registered doc row when present |
| `source` | yes | string | `native` (task docs directory) or `registered` (copied from elsewhere) |
| `sourcePath` | yes | string | Absolute path the file was read from. Manifest-only; not in the README |

### `sessions[]`

Every recorded session is a row. Headline session count lives on
`totals.rootSessions` (root sessions only). In-process subagents and spawned
children are present as rows with their `origin`. Token totals still roll up
across that fan-out.

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes | string | Session id; also the transcript filename stem when included |
| `tool` | yes | string | `claude`, `codex`, `cursor`, or `copilot` |
| `model` | yes | string \| null | |
| `origin` | yes | string | `root`, `subagent`, or `spawned` |
| `parentSessionId` | yes | string \| null | Parent session id for `subagent` and `spawned` rows |
| `subagentType` | yes | string \| null | |
| `title` | yes | string \| null | |
| `createdAt` | yes | string | ISO-8601 |
| `updatedAt` | yes | string | ISO-8601 |
| `machineId` | yes | string | Machine that recorded the session |
| `tokens` | yes | object | See [Tokens](#tokens) |
| `cost` | no | object | List-price-equivalent USD for this session. Absent when the session is unpriced (unknown or missing model). See [Cost](#cost) |
| `transcript` | no | object | Present only when transcripts were requested. See [Transcript object](#transcript-object) |

### Transcript object

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `status` | yes | string | See [Status values](#status-values) |
| `format` | no | string | Present when `status` is `included`. See [Format tags](#format-tags) |
| `path` | no | string | Bundle-relative path of the copied file. Present when `status` is `included` |

When transcripts were **not** requested, the `transcript` key is omitted
entirely — that is distinct from a requested export whose file could not be
included.

### Status values

| `status` | Meaning |
| --- | --- |
| `included` | Bytes were copied into `transcripts/` |
| `another-machine` | The session’s `machineId` is not this machine’s; the file was never here. Sync stores a path string only, so transcript bytes do not cross machines |
| `file-gone` | A path was recorded on this machine but the file is missing |
| `no-transcript-file` | This kind of session has no transcript file (for example a Codex subagent with a synthetic locator) |

### Format tags

| `format` | File | Contents |
| --- | --- | --- |
| `claude-jsonl` | `<sessionId>.jsonl` | Claude Code JSONL, byte-identical to the source file |
| `codex-jsonl` | `<sessionId>.jsonl` | Codex JSONL, byte-identical to the source file |
| `copilot-jsonl` | `<sessionId>.jsonl` | GitHub Copilot CLI events JSONL, byte-identical to the source file |
| `cursor-agent-jsonl` | `<sessionId>.jsonl` | `cursor-agent` CLI JSONL, byte-identical to the source file |
| `cursor-composer-export` | `<sessionId>.json` | JSON array of extracted Cursor GUI composer messages (see below) |

Native JSONL schemas are the producing tool’s, not Trace’s. This specification
does not restate them.

`cursor-composer-export` is a JSON array of messages, pretty-printed with a
trailing newline. Each element is one of:

```json
{ "kind": "user", "text": "…" }
{ "kind": "assistant", "text": "…" }
{ "kind": "thinking", "text": "…" }
{ "kind": "tool", "name": "…", "status": "…" }
```

`status` on a `tool` message is optional.

### Tokens

Used on each session and on `totals.tokens`.

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `input` | yes | number | |
| `output` | yes | number | |
| `cacheCreation` | yes | number | |
| `cacheRead` | yes | number | |
| `total` | yes | number | Recorded total for that row |

Token objects do not carry a price. Cost lives on the sibling `cost` object
(session row) or on `totals.cost`.

### Cost

Used on each session (`sessions[].cost`) and on `totals.cost`. Both are
optional. A missing `cost` object means "unpriced", never "free" — do not
emit `{ "usd": 0 }` to stand in for an unknown model.

Session `cost`:

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `usd` | yes | number | List-price-equivalent USD for that session. All four token buckets are priced |

`totals.cost` is present when at least one session is priced, and absent when
none are (including a bundle with no sessions):

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `usd` | yes | number | Sum of priced sessions. Never null; omit the whole object instead |
| `pricedSessions` | yes | number | Sessions that resolved to a rate |
| `unpricedSessions` | yes | number | Sessions that did not. A non-zero value means the total is partial |

### `totals`

| Key | Required | Type | Notes |
| --- | --- | --- | --- |
| `rootSessions` | yes | number | Count of rows with `origin` `root`. This is the headline session count |
| `subagentSessions` | yes | number | Count of `origin` `subagent` |
| `spawnedSessions` | yes | number | Count of `origin` `spawned` |
| `tokens` | yes | object | Sum across **all** sessions, including subagents and spawned children |
| `freshTotal` | yes | number | `tokens.input + tokens.output` (cache creation and cache read excluded) |
| `firstSessionAt` | no | string | Earliest session `createdAt`. Omitted when there are no sessions |
| `lastSessionAt` | no | string | Latest session `createdAt`. Omitted when there are no sessions |
| `tools` | yes | string[] | Distinct `tool` values, in first-seen order |
| `models` | yes | string[] | Distinct non-empty `model` values, in first-seen order |
| `cost` | no | object | Present when at least one session is priced. See [Cost](#cost) |

There is no duration field. Consumers that want a span compute it from
`firstSessionAt` and `lastSessionAt`.

## Producing a bundle

Trace writes this format from two front doors that share one builder:

```sh
trace export [task] [--include-transcripts] [--out <path>]
```

```
GET /api/tasks/<ref>/export
GET /api/tasks/<ref>/export?transcripts=1
```

A non-Trace producer is valid when the tree, `manifest.json` keys and types,
and transcript rules above are satisfied. Omit `generator`. Cost and
`pricedAt` are optional; omit them when not pricing. Do not invent duration
or author fields.

`trace import` is not part of this version. The manifest carries real ids and
full session rows so a future importer is not blocked by missing identity.
