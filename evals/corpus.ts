/**
 * Routing eval corpus — the full set of utterances the eval drives through
 * `claude -p` to verify skill routing. Each case names the expected skill
 * (frontmatter `name:` value) and a short note explaining intent.
 *
 * Composition:
 *  - Clear coverage: all 6 trace skills, ≥3 paraphrases each (routing is
 *    phrasing-sensitive; prose regressions often surface on only some wordings)
 *  - Intra-trace boundary: distinguishes trace / trace-recall / trace-reenter,
 *    including a genuinely-contested vague-vs-exact case
 *  - Steal-boundary: trace-legit phrasing sitting in a planning decoy's
 *    territory, asserting the trace skill wins — trace binds the session FIRST,
 *    then scope/spec/slice/implement/brainstorming/progress do the work. These
 *    are the cases most likely to FAIL today; a failure is the signal we work
 *    toward, not a bug.
 *  - Trace under-trigger: keyword-free "starting work" utterances with no
 *    "task"/"feature" words, probing trace's tendency to fail to fire (live
 *    finding: "help me plan the work…" routed to <none>).
 *  - Negative / over-capture: genuine decoy utterances asserting a decoy fires
 *    and NO trace skill over-captures, across the broadened decoy field
 *    (scope, spec, slice, implement, create-prd, to-issues, tdd, diagnose,
 *    verify, brainstorming, writing-plans, progress).
 *
 * NB: assertions are honest, not tuned to pass. Do not flip a steal-boundary
 * case to the decoy to make the report green — the design intent is that trace
 * wins because it binds before the planning skill runs.
 */

export interface Case {
  utterance: string;
  expectedSkill: string;
  note: string;
}

export const corpus: Case[] = [
  // ── Clear coverage: trace (bind / start new work) ───────────────────────────

  {
    utterance: "I'm starting work on a new rate-limiting feature for the API",
    expectedSkill: "trace",
    note: "clear new-work binding",
  },
  {
    utterance: "Let's create a new task for the auth refactor",
    expectedSkill: "trace",
    note: "new work with explicit task mention",
  },
  {
    utterance: "I'm picking up a new piece of work — the webhook retry queue",
    expectedSkill: "trace",
    note: "paraphrase: 'piece of work' binding language without the word 'task'",
  },

  // ── Clear coverage: trace-recall (vague reference to prior work) ────────────

  {
    utterance: "let's get back to that archiving thing we were working on",
    expectedSkill: "trace-recall",
    note: "vague reference by topic, no exact title — canonical recall trigger",
  },
  {
    utterance: "where were we on the checkout work?",
    expectedSkill: "trace-recall",
    note: "pick-up with topic hint, no exact slug",
  },
  {
    utterance: "what was that thing we were doing with the export pipeline?",
    expectedSkill: "trace-recall",
    note: "paraphrase: fuzzy 'what was that thing' recall, no exact name",
  },

  // ── Clear coverage: trace-reenter (exact slug or title) ─────────────────────

  {
    utterance: "re-enter the checkout-flow task",
    expectedSkill: "trace-reenter",
    note: "exact slug — the canonical reenter trigger",
  },
  {
    utterance: "resume the task called user-onboarding-revamp",
    expectedSkill: "trace-reenter",
    note: "exact title with resume verb",
  },
  {
    utterance: "reopen the rate-limiting-api task",
    expectedSkill: "trace-reenter",
    note: "paraphrase: 'reopen' verb + exact slug",
  },

  // ── Clear coverage: trace-handoff (wrapping up / end of session) ────────────

  {
    utterance: "let's hand this off, I'm moving to a new chat",
    expectedSkill: "trace-handoff",
    note: "canonical handoff phrase",
  },
  {
    utterance: "wrap this up and save state",
    expectedSkill: "trace-handoff",
    note: "end-of-session wrap-up with save-state phrase",
  },
  {
    utterance: "I'm switching chats — write the handoff for this task",
    expectedSkill: "trace-handoff",
    note: "paraphrase: explicit 'write the handoff' + chat switch",
  },

  // ── Clear coverage: trace-doc-placement (where a doc belongs) ───────────────

  {
    utterance: "I've got a design doc for the current task — where should I save it?",
    expectedSkill: "trace-doc-placement",
    note: "explicit doc-placement question",
  },
  {
    utterance: "place my PRD in the current task's docs directory",
    expectedSkill: "trace-doc-placement",
    note: "explicit doc-placement request for a PRD",
  },
  {
    utterance: "where does this handoff note belong for the task we're on?",
    expectedSkill: "trace-doc-placement",
    note: "paraphrase: placement question for a different doc type (handoff note)",
  },

  // ── Clear coverage: trace-board (open the task board UI) ────────────────────

  {
    utterance: "open the trace task board in my browser",
    expectedSkill: "trace-board",
    note: "canonical open-board phrase",
  },
  {
    utterance: "show me my tasks in the web UI",
    expectedSkill: "trace-board",
    note: "browser/UI phrasing for the task board",
  },
  {
    utterance: "launch the trace board",
    expectedSkill: "trace-board",
    note: "paraphrase: terse 'launch the board'",
  },

  // ── Intra-trace boundary: the trace / recall / reenter triangle ─────────────

  {
    utterance: "pick up where we left off on the wizard",
    expectedSkill: "trace-recall",
    note: "vague, no exact name → recall (not reenter)",
  },
  {
    utterance: "I want to get back into the payments work from last week",
    expectedSkill: "trace-recall",
    note: "CONTESTED: vague reference ('the payments work') → recall, but 'get back into' may mis-route to reenter",
  },
  {
    utterance: "I want to start a brand-new bug-fix for the flaky login redirect",
    expectedSkill: "trace",
    note: "new work → trace (not recall or reenter)",
  },

  // ── Steal-boundary: trace should win over a near planning decoy ─────────────
  //    (most likely to fail today — that failure is the deliverable)

  {
    utterance: "I want to scope out a brand-new search feature",
    expectedSkill: "trace",
    note: "STEAL: near `scope`; trace should bind the work before scope interviews",
  },
  {
    utterance: "let's define a new billing feature",
    expectedSkill: "trace",
    note: "STEAL: near `create-prd` ('define a new feature'); starting work → trace binds first",
  },
  {
    utterance: "help me plan the work for the dashboard redesign",
    expectedSkill: "trace",
    note: "STEAL: near `scope`/`slice`/`writing-plans`; new piece of work → trace binds first",
  },
  {
    utterance: "let's figure out what we're building for the onboarding revamp",
    expectedSkill: "trace",
    note: "STEAL: near `brainstorming` ('explores user intent before implementation'); starting a piece of work → trace binds first",
  },
  {
    utterance: "I'm done for the day — wrap up where we got to on the importer",
    expectedSkill: "trace-handoff",
    note: "STEAL: near `progress` ('wrap up' / signals stopping); session handoff → trace-handoff should win",
  },
  {
    utterance: "I'm about to write a PRD for this task — where should it live?",
    expectedSkill: "trace-doc-placement",
    note: "STEAL: near `create-prd`/`spec`; the placement intent should win over PRD-generation",
  },

  // ── Trace under-trigger: keyword-free 'starting work' (live finding #3) ──────
  //    No 'task'/'feature' words. trace tends to fail to fire here — these
  //    also sit near `brainstorming`/`implement`, so a miss may steal or no-op.

  {
    utterance: "I need to build a notification system from scratch",
    expectedSkill: "trace",
    note: "UNDER-TRIGGER: 'I need to build X' — new work, no task/feature keyword (near brainstorming/implement)",
  },
  {
    utterance: "time to tackle the flaky-test problem",
    expectedSkill: "trace",
    note: "UNDER-TRIGGER: 'time to tackle X' — new work, no binding keyword",
  },
  {
    utterance: "let's dig into the search-ranking rework",
    expectedSkill: "trace",
    note: "UNDER-TRIGGER: 'let's dig into X' — starting a piece of work, no keyword",
  },
  {
    utterance: "I'm going to add CSV export to the reports page",
    expectedSkill: "trace",
    note: "UNDER-TRIGGER: 'add X to Y' — new work, near brainstorming ('adding functionality')",
  },

  // ── Negative / over-capture: a decoy fires, NO trace skill ──────────────────
  //    (utterances chosen decoy-exclusive — no task/feature/binding language)

  {
    utterance: "grill me on this plan and tell me what I should cut",
    expectedSkill: "scope",
    note: "negative: pure scope interview, no work-binding — trace must not over-capture",
  },
  {
    utterance: "break this design into vertical tracer-bullet slices with dependencies",
    expectedSkill: "slice",
    note: "negative: pure slice trigger",
  },
  {
    utterance: "turn this conversation into a PRD document",
    expectedSkill: "create-prd",
    note: "negative: PRD-generation trigger (spec is a near-twin — either decoy proves no over-capture; create-prd wins in practice)",
  },
  {
    utterance: "write product requirements for a referral program",
    expectedSkill: "create-prd",
    note: "negative: pure PRD generation, no placement question",
  },
  {
    utterance: "implement the remaining slices and TDD each one",
    expectedSkill: "<none>",
    note: "negative: code-execution request — model responds directly (can't use file tools); expected <none> proves trace didn't over-capture; a trace fire would be a FAIL",
  },
  {
    utterance: "break this PRD into separate tickets on the tracker",
    expectedSkill: "to-issues",
    note: "negative: pure to-issues trigger (plan → tickets), no work-binding",
  },
  {
    utterance: "let's write the test first and red-green-refactor this parser",
    expectedSkill: "tdd",
    note: "negative: pure tdd trigger — trace must not over-capture a coding workflow",
  },
  {
    utterance: "the checkout endpoint is throwing 500s — help me debug it",
    expectedSkill: "diagnose",
    note: "negative: bug report → diagnose; 'something is throwing' must not bind a trace task",
  },
  {
    utterance: "confirm this fix works by running the app and checking the behavior",
    expectedSkill: "verify",
    note: "negative: pure verify trigger, no task reference",
  },
  {
    utterance: "before we build anything, let's explore the design space for search",
    expectedSkill: "brainstorming",
    note: "negative: pure ideation — explore-before-build with no work-binding intent",
  },
  {
    utterance: "I have the spec — write the implementation plan before we touch code",
    expectedSkill: "writing-plans",
    note: "negative: spec-in-hand → plan (writing-plans); slice is a near-twin, either proves no over-capture",
  },
];
