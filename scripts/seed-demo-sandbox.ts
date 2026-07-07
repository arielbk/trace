// Seed a fully isolated Trace demo sandbox at ~/.trace-demo.
//
// Everything Trace persists lives beside its sqlite file, so pointing
// TRACE_DB at the sandbox relocates the whole store: db, task docs, the lot.
// This script fabricates four fake projects with a spread of tasks, sessions
// across all three providers (claude / codex / cursor), sub-agents, spawned
// ralph-style children, docs (PRDs, task DAGs, state.md with manifest
// footers), archived work, and a couple of unassigned sessions.
//
// Run:   node scripts/seed-demo-sandbox.ts
// Serve: TRACE_DB=~/.trace-demo/trace.sqlite node apps/cli/dist/trace.js serve
//
// Re-running wipes and re-seeds the sandbox. It never touches ~/.trace.

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  openTraceStore,
  resolveTaskDocsDir,
} from "../packages/core/src/store.ts";
import { syntheticLocator } from "../packages/core/src/transcript-locator.ts";
import { getDatabaseSync } from "../packages/core/src/node-sqlite.ts";
import type {
  SessionOrigin,
  SessionTool,
  TokenTotals,
} from "../packages/core/src/types.ts";

const SANDBOX = join(homedir(), ".trace-demo");
const DB_PATH = join(SANDBOX, "trace.sqlite");
const PROJECTS_DIR = join(SANDBOX, "projects");
const TRANSCRIPTS_DIR = join(SANDBOX, "transcripts");

// ---------------------------------------------------------------------------
// Helpers

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ISO timestamp `days` days and `hours` hours ago, pinned to feel like a workday. */
function ago(days: number, hours = 0): string {
  return new Date(NOW - days * DAY - hours * HOUR).toISOString();
}

function tok(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
): TokenTotals {
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
  };
}

type SessionSpec = {
  id?: string;
  tool: SessionTool;
  model: string;
  title?: string;
  at: string;
  tokens: TokenTotals;
  transcriptPath?: string;
  origin?: SessionOrigin;
  subagentType?: string;
  agentId?: string;
  parentSessionId?: string;
};

type DocSpec = {
  file: string;
  title?: string;
  description?: string;
  at: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Reset the sandbox

if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
mkdirSync(PROJECTS_DIR, { recursive: true });
mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Fake-but-real project directories, so live CLI demos can cd into them and
// git-root resolution keys tasks to the right place.
const PROJECT_META: Record<string, string> = {
  "lumen-dashboard": "Analytics SaaS dashboard. React 19 + Vite + TanStack Query.",
  "atlas-api": "Payments and webhooks API. TypeScript, Fastify, Postgres.",
  "pulse-mobile": "React Native companion app for Lumen.",
  "forge-cli": "Project scaffolding CLI with a template registry.",
};

const projectRoots: Record<string, string> = {};
for (const [name, blurb] of Object.entries(PROJECT_META)) {
  const dir = join(PROJECTS_DIR, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\n${blurb}\n`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.4.2", private: true }, null, 2) + "\n",
  );
  execSync("git init --quiet", { cwd: dir });
  projectRoots[name] = dir;
}

const store = openTraceStore(DB_PATH);
// Second handle on the same WAL db, for backdating timestamps the store API
// stamps with "now".
const raw = new (getDatabaseSync())(DB_PATH);

function seedTask(spec: {
  title: string;
  description: string;
  project: keyof typeof PROJECT_META;
  at: string;
  archivedAt?: string;
}) {
  const task = store.createTask(
    spec.title,
    projectRoots[spec.project],
    spec.description,
  );
  raw
    .prepare("UPDATE tasks SET created_at = ?, archived_at = ? WHERE id = ?")
    .run(spec.at, spec.archivedAt ?? null, task.id);
  const docsDir = resolveTaskDocsDir(DB_PATH, task.slug);
  mkdirSync(docsDir, { recursive: true });
  return { task, docsDir };
}

function seedSession(spec: SessionSpec, taskId?: string): string {
  const id = spec.id ?? randomUUID();
  store.registerSession({
    id,
    transcriptPath: spec.transcriptPath ?? syntheticLocator(spec.tool, id),
    tool: spec.tool,
    model: spec.model,
    title: spec.title ?? null,
    origin: spec.origin ?? "root",
    subagentType: spec.subagentType ?? null,
    agentId: spec.agentId ?? null,
    parentSessionId: spec.parentSessionId ?? null,
    tokenTotals: spec.tokens,
  });
  if (taskId) store.assignSession(id, taskId);
  raw
    .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
    .run(spec.at, id);
  return id;
}

function seedDoc(taskId: string, docsDir: string, spec: DocSpec) {
  const path = join(docsDir, spec.file);
  writeFileSync(path, spec.content);
  const when = new Date(spec.at);
  utimesSync(path, when, when);
  store.addTaskDoc(taskId, path, {
    title: spec.title,
    description: spec.description,
  });
  raw
    .prepare(
      "UPDATE task_docs SET created_at = ? WHERE task_id = ? AND path = ?",
    )
    .run(spec.at, taskId, path);
}

/**
 * Write a realistic Claude Code JSONL transcript. The claude adapter re-parses
 * this on every read, so model / ai-title / summed usage become the session's
 * live values, and the re-entry flow can show a real tail.
 */
function writeClaudeTranscript(
  sessionId: string,
  model: string,
  title: string,
  at: string,
  turns: Array<{ user: string; assistant: string; out: number; read: number }>,
): string {
  const path = join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ type: "ai-title", aiTitle: title, sessionId }),
  ];
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: turn.user },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          model,
          content: [{ type: "text", text: turn.assistant }],
          usage: {
            input_tokens: 6,
            output_tokens: turn.out,
            cache_creation_input_tokens: Math.round(turn.read / 12),
            cache_read_input_tokens: turn.read,
          },
        },
      }),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
  const when = new Date(at);
  utimesSync(path, when, when);
  return path;
}

// ===========================================================================
// lumen-dashboard
// ===========================================================================

// --- Hero task: checkout wizard -------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Rework the checkout into a multi-step wizard",
    description:
      "Split the single-page checkout into a four-step wizard with per-step validation, resumable state, and a Stripe payment-intent step",
    project: "lumen-dashboard",
    at: ago(6, 3),
  });

  seedDoc(task.id, docsDir, {
    file: "checkout-wizard.prd.md",
    title: "Checkout wizard PRD",
    description: "Requirements for the four-step checkout wizard",
    at: ago(5, 4),
    content: `# Checkout wizard PRD

## Problem

Checkout is a single 1,400-line page. Validation fires on submit only, drop-off
is 38% at the payment field, and support keeps seeing "my cart emptied" reports
after browser restarts.

## Goals

- Four steps: cart review, shipping, payment, confirmation.
- Per-step validation with inline errors; a step cannot be entered until the
  previous one is valid.
- Wizard state survives a page reload (sessionStorage, 30-minute TTL).
- Payment step creates a Stripe payment intent server-side and confirms
  client-side.

## Non-goals

- No changes to cart pricing or promo-code logic.
- No guest-checkout redesign; the existing email-capture flow stays.

## Success metrics

- Payment-step drop-off below 25% within two weeks of rollout.
- Zero "lost cart" support tickets attributable to reloads.

## Rollout

Feature-flagged (checkout_wizard_v2), 10% -> 50% -> 100% over one week.
`,
  });

  seedDoc(task.id, docsDir, {
    file: "checkout-wizard.tasks.md",
    title: "Checkout wizard task DAG",
    description: "Vertical slices with dependencies for the wizard build",
    at: ago(4, 6),
    content: `# Checkout wizard — task slices

Slices are vertical tracer bullets; each lands with tests and a feature-flag
guard. Dependencies flow top to bottom.

## Slices

- [x] **wizard-shell** — Route, step indicator, sessionStorage persistence with TTL
- [x] **cart-review-step** — Read-only cart summary, quantity edit drops back to cart
- [x] **shipping-step** — Address form, per-field validation, address normalization call
- [x] **step-state-machine** — Guarded transitions; deep-linking to an invalid step redirects
- [ ] **payment-step** — Stripe payment intent server route + Elements confirm flow
- [ ] **confirmation-step** — Order summary, receipt email trigger, flag-guarded redirect
- [ ] **abandonment-telemetry** — Step-level drop-off events into the analytics pipeline

## Notes

- step-state-machine unblocks both payment-step and confirmation-step.
- abandonment-telemetry can land any time after wizard-shell.
`,
  });

  seedDoc(task.id, docsDir, {
    file: "handoff-2026-07-03.md",
    title: "Handoff — shipping step done",
    description: "Session handoff after the shipping step landed",
    at: ago(3, 5),
    content: `# Handoff — shipping step done

Shipping step merged behind the flag. Address normalization uses the existing
/api/address/normalize endpoint; we debounce at 400ms and cache the last five
lookups per session.

Next session should start on the step state machine — the guard logic sketch
is in the PRD and the failing test file already exists at
src/checkout/wizard/machine.test.tsx.

Watch out: the cart-review step re-fetches the cart on every mount. Fine for
now, but the payment step must NOT do that or the payment intent will be
recreated on remount.
`,
  });

  // Older scoping session.
  seedSession(
    {
      tool: "claude",
      model: "claude-opus-4-8",
      title: "Scope the checkout wizard",
      at: ago(5, 5),
      tokens: tok(31_420, 28_907, 412_055, 5_214_890),
    },
    task.id,
  );

  // Slicing session with two sub-agents.
  const slicing = seedSession(
    {
      tool: "claude",
      model: "claude-fable-5",
      title: "Slice the wizard into a task DAG",
      at: ago(4, 7),
      tokens: tok(24_112, 41_336, 380_204, 7_902_311),
    },
    task.id,
  );
  seedSession(
    {
      id: `${slicing}:subagent:agent-e41f9c`,
      tool: "claude",
      model: "claude-haiku-4-5-20251001",
      title: "Explore checkout call sites",
      at: ago(4, 7),
      tokens: tok(9_204, 6_118, 51_002, 894_401),
      origin: "subagent",
      subagentType: "Explore",
      agentId: "agent-e41f9c",
      parentSessionId: slicing,
    },
    task.id,
  );
  seedSession(
    {
      id: `${slicing}:subagent:agent-b8a2d0`,
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Map cart state dependencies",
      at: ago(4, 6),
      tokens: tok(7_881, 9_340, 44_180, 1_204_772),
      origin: "subagent",
      subagentType: "general-purpose",
      agentId: "agent-b8a2d0",
      parentSessionId: slicing,
    },
    task.id,
  );

  // Codex took the payment-intent server route.
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Payment intent server route",
      at: ago(3, 6),
      tokens: tok(88_410, 36_774, 0, 2_310_450),
    },
    task.id,
  );

  // Most recent session — real transcript on disk so re-entry shows a tail.
  const heroId = randomUUID();
  const heroTranscript = writeClaudeTranscript(
    heroId,
    "claude-fable-5",
    "Wizard step state machine",
    ago(0, 2),
    [
      {
        user: "Let's implement the step-state-machine slice from checkout-wizard.tasks.md. The failing test file is src/checkout/wizard/machine.test.tsx.",
        assistant:
          "Read the slice spec and the failing tests. The machine needs four states (cart, shipping, payment, confirmation) with guarded forward transitions — a step is enterable only when every earlier step reports valid. I'll model it as a reducer with an explicit `furthestValidStep` rather than a boolean per step, which makes the deep-link redirect rule fall out naturally.",
        out: 1_842,
        read: 412_040,
      },
      {
        user: "Sounds right. Make sure a reload restores the furthest step, not the first.",
        assistant:
          "Done — persistence now stores `{ currentStep, furthestValidStep, savedAt }` and the rehydrate path clamps `currentStep` to `furthestValidStep` after TTL check. Added a test: reload on payment with valid shipping restores payment, reload after 31 minutes restores cart.",
        out: 2_654,
        read: 688_220,
      },
      {
        user: "Run the full wizard suite.",
        assistant:
          "All green: 34 passed across machine.test.tsx, shell.test.tsx, shipping-step.test.tsx. Typecheck clean. The machine reducer is 96 lines; deep-link redirect is handled in the route loader, not the component, so there's no flash of the wrong step.",
        out: 1_203,
        read: 501_180,
      },
      {
        user: "Great. Update state.md and hand off — payment step is next.",
        assistant:
          "state.md updated: decisions recorded (reducer over XState, furthestValidStep clamp), next step is the payment-step slice — the Stripe server route already landed from the codex session, so the remaining work is the Elements confirm flow and NOT re-creating the intent on remount (see handoff-2026-07-03.md).",
        out: 986,
        read: 455_310,
      },
    ],
  );
  seedSession(
    {
      id: heroId,
      tool: "claude",
      model: "claude-fable-5",
      at: ago(0, 2),
      tokens: tok(24, 6_685, 171_396, 2_056_750),
      transcriptPath: heroTranscript,
    },
    task.id,
  );
  seedSession(
    {
      id: `${heroId}:subagent:agent-77c1ab`,
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Review wizard machine slice",
      at: ago(0, 2),
      tokens: tok(6_240, 4_478, 38_112, 720_904),
      origin: "subagent",
      subagentType: "code-reviewer",
      agentId: "agent-77c1ab",
      parentSessionId: heroId,
    },
    task.id,
  );

  seedDoc(task.id, docsDir, {
    file: "state.md",
    description: "Living state file for the checkout wizard",
    at: ago(0, 2),
    content: `# Checkout wizard: state machine landed, payment step next

## Decisions

- Wizard state is a plain reducer with an explicit furthestValidStep — not XState; the guard rules are simple enough that a library would obscure them.
- Reload rehydration clamps currentStep to furthestValidStep, with a 30-minute TTL on the sessionStorage snapshot.
- Deep-link redirects happen in the route loader so there is no flash of an unenterable step.
- Payment intent is created server-side once per wizard entry; the payment step must never re-create it on remount.

## Current State

- wizard-shell, cart-review-step, shipping-step, and step-state-machine slices are merged behind checkout_wizard_v2.
- 34 tests green across the wizard suite; typecheck clean.
- Stripe payment-intent server route landed (codex session) but the client confirm flow is unstarted.

## Next Step

Build the payment-step slice: Stripe Elements confirm flow against the existing /api/checkout/payment-intent route, with the no-recreate-on-remount guard from handoff-2026-07-03.md.

## Open Questions

- Does the confirmation step need to poll for webhook-settled payment status, or is client-side confirmation enough for v1?
- Should abandonment-telemetry land before the 50% rollout stage?

---

<!-- trace:docs-manifest:start -->
## Docs in this task

- [Checkout wizard PRD](checkout-wizard.prd.md) — Requirements for the four-step checkout wizard
- [Checkout wizard task DAG](checkout-wizard.tasks.md) — Vertical slices with dependencies for the wizard build
- [Handoff — shipping step done](handoff-2026-07-03.md) — Session handoff after the shipping step landed

<!-- trace:docs-manifest:end -->
`,
  });
}

// --- Dark mode theming pass -------------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Dark mode theming pass",
    description:
      "Audit hardcoded colors, move the palette to semantic tokens, and ship a dark theme behind the appearance setting",
    project: "lumen-dashboard",
    at: ago(9, 2),
  });
  seedSession(
    {
      tool: "cursor",
      model: "composer-1",
      title: "Token audit for dark palette",
      at: ago(8, 6),
      tokens: tok(64_230, 18_112, 0, 0),
    },
    task.id,
  );
  seedSession(
    {
      tool: "cursor",
      model: "sonnet-4.5",
      title: "Chart series colors in dark mode",
      at: ago(8, 3),
      tokens: tok(41_889, 12_054, 0, 0),
    },
    task.id,
  );
  seedDoc(task.id, docsDir, {
    file: "palette-notes.md",
    title: "Palette decisions",
    description: "Semantic token names and the dark-mode chart ramp",
    at: ago(8, 4),
    content: `# Palette decisions

- Semantic tokens only in components: surface, surface-raised, ink, ink-muted,
  accent, positive, negative. Raw hex lives in one theme file per mode.
- Dark chart ramp is NOT the light ramp inverted — series colors were rebuilt
  for contrast on surface (#111417) and validated at AA against gridlines.
- Elevation in dark mode uses lighter surfaces, not shadows.
`,
  });
}

// --- Flaky test (archived) ---------------------------------------------------
{
  const { task } = seedTask({
    title: "Fix flaky billing period test",
    description:
      "billing-period.test.ts fails around month boundaries; freeze the clock and pin the timezone",
    project: "lumen-dashboard",
    at: ago(21, 4),
    archivedAt: ago(19, 6),
  });
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Freeze clock in billing period suite",
      at: ago(20, 5),
      tokens: tok(38_204, 9_871, 0, 604_112),
    },
    task.id,
  );
}

// --- Chart migration ----------------------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Migrate charts to visx 4",
    description:
      "Replace the deprecated in-house chart wrappers with visx 4 primitives, keeping the existing chart API surface",
    project: "lumen-dashboard",
    at: ago(13, 1),
  });
  seedDoc(task.id, docsDir, {
    file: "visx-migration.prd.md",
    title: "visx migration plan",
    description: "Inventory of chart call sites and the migration order",
    at: ago(12, 5),
    content: `# visx 4 migration plan

## Inventory

23 chart call sites across 9 pages. Bar and line cover 17 of them; the rest
are two heatmaps, three sparklines, and one sankey (deferred).

## Order

1. Bar + line behind a chartsV2 flag (17 call sites, one shared wrapper).
2. Sparklines — pure SVG, no axes, lowest risk.
3. Heatmaps — need the new color-scale tokens from the dark-mode task first.
4. Sankey — deferred; usage is one internal admin page.

## API contract

Page-level chart props do not change. The wrapper owns the visx swap, so the
migration is invisible above the wrapper layer.
`,
  });
  seedSession(
    {
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Inventory chart call sites",
      at: ago(12, 6),
      tokens: tok(18_112, 22_907, 204_118, 3_112_450),
    },
    task.id,
  );
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Port bar and line charts",
      at: ago(11, 4),
      tokens: tok(102_388, 44_120, 0, 3_889_204),
    },
    task.id,
  );
}

// --- Onboarding empty states (archived) ---------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Onboarding empty states",
    description:
      "Design and ship empty states for the six dashboard cards a fresh workspace sees before any data arrives",
    project: "lumen-dashboard",
    at: ago(31, 3),
    archivedAt: ago(27, 2),
  });
  seedDoc(task.id, docsDir, {
    file: "empty-states-copy.md",
    title: "Empty state copy",
    description: "Final copy for the six empty dashboard cards",
    at: ago(29, 5),
    content: `# Empty state copy

Six cards, one sentence + one action each. Tone: helpful, not cute.

- Events: "No events yet — install the snippet to start tracking." [View install guide]
- Funnels: "Funnels need at least two tracked events." [Create your first event]
- Retention: "Retention fills in after your first week of data."
- Sessions: "Session replays appear within minutes of installing the snippet." [View install guide]
- Alerts: "No alerts configured." [New alert]
- Reports: "Weekly reports start after your first full week."
`,
  });
  seedSession(
    {
      tool: "cursor",
      model: "composer-1",
      title: "Empty state card variants",
      at: ago(30, 6),
      tokens: tok(51_204, 14_890, 0, 0),
    },
    task.id,
  );
  seedSession(
    {
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Wire empty states to workspace data checks",
      at: ago(29, 4),
      tokens: tok(14_204, 19_886, 168_204, 2_204_118),
    },
    task.id,
  );
}

// ===========================================================================
// atlas-api
// ===========================================================================

// --- Ralph showcase: webhook retries ------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Webhook delivery retries with backoff",
    description:
      "Ralph loop build: durable webhook delivery with exponential backoff, a dead-letter table, and a redelivery admin endpoint",
    project: "atlas-api",
    at: ago(2, 7),
  });

  seedDoc(task.id, docsDir, {
    file: "webhook-retries.tasks.md",
    title: "Webhook retries task DAG",
    description: "Slice DAG the ralph loop is working through",
    at: ago(2, 6),
    content: `# Webhook delivery retries — task slices

Sandbox note: iterations run in a no-network sandbox. Do not run installs or
external CLIs; deps are pre-seeded.

## Slices

- [x] **delivery-attempts-table** — Migration + repository for delivery_attempts with status enum
- [x] **backoff-scheduler** — Exponential backoff with jitter (1m, 5m, 30m, 2h, 12h), max 5 attempts
- [x] **delivery-worker** — Claims due attempts with SKIP LOCKED, records outcome per attempt
- [x] **dead-letter-table** — Exhausted deliveries land in webhook_dead_letters with final error
- [ ] **redelivery-endpoint** — POST /admin/webhooks/:id/redeliver resets the attempt chain
- [ ] **delivery-metrics** — Counters for attempted/succeeded/dead-lettered per endpoint

## Notes

- delivery-worker depends on both the table and the scheduler.
- redelivery-endpoint depends on dead-letter-table.
`,
  });

  const ralphParent = seedSession(
    {
      tool: "claude",
      model: "claude-fable-5",
      title: "Ralph loop: webhook retries",
      at: ago(1, 9),
      tokens: tok(9_204, 12_411, 88_204, 1_412_006),
    },
    task.id,
  );
  const iterations: Array<[string, number, TokenTotals]> = [
    ["Ralph iteration 1 — delivery-attempts-table", 8, tok(21_400, 33_204, 240_118, 3_304_882)],
    ["Ralph iteration 2 — backoff-scheduler", 7, tok(19_887, 29_441, 198_204, 2_887_390)],
    ["Ralph iteration 3 — delivery-worker", 5, tok(26_204, 41_072, 301_442, 4_112_006)],
    ["Ralph iteration 4 — dead-letter-table", 3, tok(15_112, 22_390, 154_889, 2_204_950)],
  ];
  for (const [title, hoursAgo, tokens] of iterations) {
    seedSession(
      {
        tool: "claude",
        model: "claude-sonnet-5",
        title,
        at: ago(1, hoursAgo),
        tokens,
        origin: "spawned",
        parentSessionId: ralphParent,
      },
      task.id,
    );
  }

  seedDoc(task.id, docsDir, {
    file: "state.md",
    description: "Living state file for the ralph webhook-retries run",
    at: ago(1, 2),
    content: `# Webhook retries: four slices merged, redelivery endpoint next

## Decisions

- Backoff schedule is fixed (1m, 5m, 30m, 2h, 12h) with full jitter; no per-endpoint configuration in v1.
- Worker claims due attempts with FOR UPDATE SKIP LOCKED — no advisory locks, no queue dependency.
- Dead-lettered deliveries keep the full final response body for debugging, truncated at 64KB.

## Current State

- Four of six slices merged by ralph iterations 1-4; suite green at 118 tests.
- Iteration 4 flagged that redelivery must reset attempt_count but preserve the original payload hash.

## Next Step

redelivery-endpoint slice: POST /admin/webhooks/:id/redeliver — reset the attempt chain, guard against redelivering an endpoint that is currently disabled.

## Open Questions

- Should delivery-metrics emit per-endpoint or per-workspace counters first?

---

<!-- trace:docs-manifest:start -->
## Docs in this task

- [Webhook retries task DAG](webhook-retries.tasks.md) — Slice DAG the ralph loop is working through

<!-- trace:docs-manifest:end -->
`,
  });
}

// --- Rate limiting --------------------------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Rate limiting middleware",
    description:
      "Per-key sliding-window rate limits at the Fastify plugin layer, with Redis-backed counters and standard rate-limit headers",
    project: "atlas-api",
    at: ago(7, 5),
  });
  seedDoc(task.id, docsDir, {
    file: "rate-limiting.prd.md",
    title: "Rate limiting PRD",
    description: "Limits, algorithm choice, and header contract",
    at: ago(6, 7),
    content: `# Rate limiting PRD

## Limits

- 300 req/min per API key on read endpoints, 60 req/min on writes.
- Webhook management endpoints share the write bucket.

## Algorithm

Sliding window over two fixed Redis counters (current + previous minute,
weighted). Chosen over token bucket: burst forgiveness is not wanted for
writes, and the two-counter window is one Lua script with no clock coupling.

## Headers

RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset on every response;
Retry-After on 429.

## Failure mode

Redis unavailable => fail open with a warning log and a metrics counter, never
fail closed.
`,
  });
  const rl = seedSession(
    {
      tool: "claude",
      model: "claude-opus-4-8",
      title: "Sliding window vs token bucket",
      at: ago(6, 8),
      tokens: tok(28_804, 34_112, 302_411, 4_890_204),
    },
    task.id,
  );
  seedSession(
    {
      id: `${rl}:subagent:agent-3fd88e`,
      tool: "claude",
      model: "claude-haiku-4-5-20251001",
      title: "Explore existing Redis usage",
      at: ago(6, 8),
      tokens: tok(8_112, 5_204, 41_889, 780_204),
      origin: "subagent",
      subagentType: "Explore",
      agentId: "agent-3fd88e",
      parentSessionId: rl,
    },
    task.id,
  );
  seedSession(
    {
      id: `${rl}:subagent:agent-91c04b`,
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Review limiter Lua script",
      at: ago(6, 6),
      tokens: tok(5_990, 4_112, 30_442, 512_960),
      origin: "subagent",
      subagentType: "code-reviewer",
      agentId: "agent-91c04b",
      parentSessionId: rl,
    },
    task.id,
  );
  seedDoc(task.id, docsDir, {
    file: "state.md",
    description: "Living state file for rate limiting",
    at: ago(6, 5),
    content: `# Rate limiting: algorithm chosen, plugin skeleton in review

## Decisions

- Sliding window over two weighted fixed counters, one Lua script, no clock coupling.
- Fail open on Redis unavailability — availability beats strictness for v1.

## Current State

- Plugin skeleton registers per-route buckets; Lua script reviewed by the code-reviewer sub-agent with two nits fixed.
- Header contract implemented; 429 path has tests, fail-open path does not yet.

## Next Step

Test the fail-open path with a stopped Redis container, then wire the metrics counter for limiter_fail_open_total.

## Open Questions

- Do internal service tokens bypass limits entirely or get a 10x bucket?

---

<!-- trace:docs-manifest:start -->
## Docs in this task

- [Rate limiting PRD](rate-limiting.prd.md) — Limits, algorithm choice, and header contract

<!-- trace:docs-manifest:end -->
`,
  });
}

// --- Postgres pool exhaustion (archived) ----------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Postgres pool exhaustion under load",
    description:
      "API p99 spikes traced to connection pool exhaustion; found and fixed an idle-in-transaction leak in the webhook signer",
    project: "atlas-api",
    at: ago(16, 2),
    archivedAt: ago(14, 3),
  });
  seedDoc(task.id, docsDir, {
    file: "diagnosis.md",
    title: "Pool exhaustion diagnosis",
    description: "Root cause: idle-in-transaction leak in the webhook signer",
    at: ago(15, 4),
    content: `# Pool exhaustion diagnosis

## Symptom

p99 above 8s during webhook bursts; pg_stat_activity showed 47 of 50
connections idle in transaction, all from the webhook signer path.

## Root cause

signWebhook opened a transaction to read the signing key, then awaited the
outbound HTTP delivery INSIDE the transaction. Slow receiver => connection
held idle-in-transaction for the full delivery timeout (30s).

## Fix

Read the signing key and commit before any network I/O. Added a lint rule
banning await of http calls inside withTransaction callbacks, and set
idle_in_transaction_session_timeout to 10s as a backstop.

## Verification

Load test at 5x normal webhook volume: pool peak 12/50, p99 340ms.
`,
  });
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Reproduce pool exhaustion",
      at: ago(15, 6),
      tokens: tok(74_205, 21_889, 0, 1_890_442),
    },
    task.id,
  );
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Fix idle-in-transaction leak",
      at: ago(14, 7),
      tokens: tok(58_118, 26_204, 0, 2_112_960),
    },
    task.id,
  );
}

// --- OpenAPI drift audit ---------------------------------------------------------
{
  const { task } = seedTask({
    title: "OpenAPI spec drift audit",
    description:
      "Diff every registered route against openapi.yaml and file the mismatches; five endpoints have drifted since v1.3",
    project: "atlas-api",
    at: ago(4, 6),
  });
  seedSession(
    {
      tool: "cursor",
      model: "composer-1",
      title: "Diff handlers against the spec",
      at: ago(4, 4),
      tokens: tok(92_442, 15_204, 0, 0),
    },
    task.id,
  );
}

// ===========================================================================
// pulse-mobile
// ===========================================================================

// --- Offline sync (all three providers) -------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Offline sync conflict resolution",
    description:
      "Decide and implement the conflict strategy for offline edits: per-field last-writer-wins with vector clocks, surfaced in a conflict banner",
    project: "pulse-mobile",
    at: ago(5, 8),
  });
  seedDoc(task.id, docsDir, {
    file: "sync-conflicts.design.md",
    title: "Conflict resolution design",
    description: "CRDT vs LWW evaluation and the chosen per-field strategy",
    at: ago(4, 5),
    content: `# Conflict resolution design

## Options considered

- Full CRDT (automerge): correct but 1.9MB of JS and a new storage format.
- Whole-record LWW: loses edits silently when two devices touch one record.
- Per-field LWW with vector clocks: chosen. Field-level granularity removes
  90% of real conflicts (different fields edited); true same-field conflicts
  surface a banner instead of resolving silently.

## Clock design

Per-device logical clocks, compacted to the last four devices. Clock ties
break by device id to stay deterministic.

## UX

Same-field conflict shows a banner with both values and a "keep mine / take
theirs" choice; no modal, sync continues around it.
`,
  });
  const sync = seedSession(
    {
      tool: "claude",
      model: "claude-fable-5",
      title: "CRDT vs LWW evaluation",
      at: ago(4, 6),
      tokens: tok(33_204, 38_890, 344_112, 6_204_889),
    },
    task.id,
  );
  seedSession(
    {
      id: `${sync}:subagent:agent-c2e970`,
      tool: "claude",
      model: "claude-haiku-4-5-20251001",
      title: "Explore sync engine internals",
      at: ago(4, 6),
      tokens: tok(10_204, 7_442, 60_112, 1_104_884),
      origin: "subagent",
      subagentType: "Explore",
      agentId: "agent-c2e970",
      parentSessionId: sync,
    },
    task.id,
  );
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Vector clock plumbing",
      at: ago(3, 7),
      tokens: tok(96_204, 41_118, 0, 3_442_890),
    },
    task.id,
  );
  seedSession(
    {
      tool: "cursor",
      model: "sonnet-4.5",
      title: "Conflict banner UI",
      at: ago(3, 4),
      tokens: tok(58_890, 19_204, 0, 0),
    },
    task.id,
  );
  seedDoc(task.id, docsDir, {
    file: "state.md",
    description: "Living state file for offline sync conflicts",
    at: ago(3, 3),
    content: `# Offline sync: per-field LWW chosen, clock plumbing in progress

## Decisions

- Per-field LWW with vector clocks over full CRDT — automerge's 1.9MB and storage migration were not worth it for our conflict profile.
- Clock ties break deterministically by device id.
- Same-field conflicts surface a banner (keep mine / take theirs); sync never blocks on user input.

## Current State

- Design doc settled after the fable evaluation session.
- Vector clock plumbing about 70% done in the codex session — encode/decode and comparison merged, compaction to last-four-devices remains.
- Conflict banner UI built in cursor against mock conflict data.

## Next Step

Finish clock compaction, then wire real conflict detection into the banner and delete the mock data path.

## Open Questions

- Do we need a migration for records created before clocks existed, or can absent clocks read as epoch-zero?

---

<!-- trace:docs-manifest:start -->
## Docs in this task

- [Conflict resolution design](sync-conflicts.design.md) — CRDT vs LWW evaluation and the chosen per-field strategy

<!-- trace:docs-manifest:end -->
`,
  });
}

// --- Push deep links -----------------------------------------------------------------
{
  const { task } = seedTask({
    title: "Push notification deep links",
    description:
      "Tapping a push notification should land on the exact record, cold start included; route state must build before first render",
    project: "pulse-mobile",
    at: ago(10, 3),
  });
  seedSession(
    {
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Deep link routing on cold start",
      at: ago(9, 5),
      tokens: tok(21_442, 26_890, 218_004, 3_004_112),
    },
    task.id,
  );
}

// --- Cold start (archived) -------------------------------------------------------------
{
  const { task, docsDir } = seedTask({
    title: "Reduce cold start below two seconds",
    description:
      "Cold start was 4.1s on mid-range Android; lazy-loaded the chart bundle and deferred sync init to get to 1.8s",
    project: "pulse-mobile",
    at: ago(26, 4),
    archivedAt: ago(22, 5),
  });
  seedDoc(task.id, docsDir, {
    file: "cold-start-profile.md",
    title: "Cold start profile",
    description: "Where the 4.1 seconds went, and what was cut",
    at: ago(24, 6),
    content: `# Cold start profile

Baseline: 4.1s to first meaningful render on a Pixel 6a.

- 1.3s — chart bundle parsed at startup, used on zero of the first three screens. Now lazy.
- 0.9s — sync engine init (schema check + queue replay) before first render. Now deferred to post-interactive.
- 0.4s — duplicate icon font loads. Deduped.
- Result: 1.8s median, 2.3s p95 across the device lab.
`,
  });
  const cold = seedSession(
    {
      tool: "claude",
      model: "claude-opus-4-8",
      title: "Profile and split the startup path",
      at: ago(25, 6),
      tokens: tok(29_889, 35_204, 280_442, 4_412_006),
    },
    task.id,
  );
  seedSession(
    {
      id: `${cold}:subagent:agent-5a01f3`,
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Trace bundle load order",
      at: ago(25, 5),
      tokens: tok(9_442, 8_004, 52_889, 960_204),
      origin: "subagent",
      subagentType: "general-purpose",
      agentId: "agent-5a01f3",
      parentSessionId: cold,
    },
    task.id,
  );
}

// ===========================================================================
// forge-cli
// ===========================================================================

{
  const { task, docsDir } = seedTask({
    title: "Plugin system for custom generators",
    description:
      "Let users ship their own scaffolding generators as plugins: manifest format, loader with permission prompts, and a registry command",
    project: "forge-cli",
    at: ago(8, 6),
  });
  seedDoc(task.id, docsDir, {
    file: "plugin-system.prd.md",
    title: "Plugin system PRD",
    description: "Manifest format, loading model, and security posture",
    at: ago(7, 7),
    content: `# Plugin system PRD

## Shape

A plugin is an npm package with a forge.plugin.json manifest declaring its
generators and the capabilities each needs (fs-write scope, network, env).

## Loading

Plugins load in-process but behind a capability shim: a generator gets a
scoped fs handle rooted at the target directory and nothing else unless the
manifest asked and the user approved at install time.

## Commands

- forge plugin add <pkg> — install, show requested capabilities, confirm.
- forge plugin list — installed plugins with versions and capabilities.
- forge generate <plugin>:<generator> — run one.

## Non-goals

No remote registry of our own; npm is the registry. No sandboxed subprocess
execution in v1 — capability shim only, revisit if adoption warrants it.
`,
  });
  seedDoc(task.id, docsDir, {
    file: "plugin-system.tasks.md",
    title: "Plugin system task DAG",
    description: "Slices for manifest, loader, and commands",
    at: ago(7, 5),
    content: `# Plugin system — task slices

- [x] **manifest-schema** — forge.plugin.json zod schema + validation errors that name the field
- [x] **capability-shim** — Scoped fs handle factory, deny-by-default for network and env
- [ ] **plugin-add-command** — Install flow with capability confirmation prompt
- [ ] **plugin-list-command** — Table of installed plugins
- [ ] **generate-command** — Resolve plugin:generator, run behind the shim
`,
  });
  seedSession(
    {
      tool: "claude",
      model: "claude-fable-5",
      title: "Design the plugin manifest",
      at: ago(7, 8),
      tokens: tok(26_112, 31_889, 290_204, 4_010_442),
    },
    task.id,
  );
  seedSession(
    {
      tool: "claude",
      model: "claude-sonnet-5",
      title: "Capability shim slice",
      at: ago(6, 4),
      tokens: tok(22_890, 28_004, 244_118, 3_512_889),
    },
    task.id,
  );
}

{
  const { task } = seedTask({
    title: "Homebrew tap release automation",
    description:
      "Publish releases to the homebrew tap from CI: formula template, sha256 stamping, and a smoke install on the release runner",
    project: "forge-cli",
    at: ago(36, 5),
    archivedAt: ago(33, 4),
  });
  seedSession(
    {
      tool: "codex",
      model: "gpt-5.4-codex",
      title: "Formula template and CI stamping",
      at: ago(35, 6),
      tokens: tok(44_204, 17_889, 0, 1_204_442),
    },
    task.id,
  );
}

// ===========================================================================
// Unassigned sessions — demo material for `trace session list` / assignment
// ===========================================================================

seedSession({
  tool: "claude",
  model: "claude-fable-5",
  title: "Spike: OpenTelemetry tracing for atlas-api",
  at: ago(1, 4),
  tokens: tok(17_204, 21_889, 190_442, 2_804_118),
});
seedSession({
  tool: "codex",
  model: "gpt-5.4-codex",
  title: "Bump CI runners to Node 24",
  at: ago(0, 3),
  tokens: tok(28_442, 8_204, 0, 512_889),
});

// ---------------------------------------------------------------------------
// Sandbox README + launcher

writeFileSync(
  join(SANDBOX, "README.md"),
  `# Trace demo sandbox

Seeded fake data for demoing Trace — four projects, ${store.listTasks().length} tasks,
sessions across claude/codex/cursor with sub-agents and spawned ralph
children. Fully isolated from ~/.trace; everything keys off TRACE_DB.

- Serve the board:   ./serve.sh          (http://127.0.0.1:4317)
- CLI against it:    TRACE_DB=~/.trace-demo/trace.sqlite trace ...
- Re-seed:           node <trace-v2 repo>/scripts/seed-demo-sandbox.ts

Fake projects live in ./projects/ (real git dirs, so you can cd in and demo
the live skill flow against the sandbox db too).
`,
);
writeFileSync(
  join(SANDBOX, "serve.sh"),
  `#!/bin/sh
export TRACE_DB="$HOME/.trace-demo/trace.sqlite"
exec node "${join(import.meta.dirname, "..", "apps", "cli", "dist", "trace.js")}" serve "$@"
`,
  { mode: 0o755 },
);

const taskCount = store.listTasks().length;
store.close();
raw.close();

console.log(`Seeded ${taskCount} tasks into ${DB_PATH}`);
console.log(`Board: ${join(SANDBOX, "serve.sh")}`);
