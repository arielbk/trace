/**
 * Routing eval corpus — the full set of utterances the eval drives through
 * `claude -p` to verify skill routing. Each case names the expected skill
 * (frontmatter `name:` value) and a short note explaining intent.
 *
 * Composition:
 *  - Clear coverage: all 6 trace skills, ≥1 unambiguous utterance each
 *  - Intra-trace boundary: distinguishes trace / trace-recall / trace-reenter,
 *    including a genuinely-contested vague-vs-exact case
 *  - Steal-boundary: trace-legit phrasing sitting in a planning decoy's
 *    territory, asserting the trace skill wins — trace binds the session FIRST,
 *    then scope/spec/slice/implement do the work. These are the cases most
 *    likely to FAIL today; a failure is the signal we work toward, not a bug.
 *  - Negative / over-capture: genuine decoy utterances asserting a decoy fires
 *    and NO trace skill over-captures.
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
    note: "STEAL: near `scope`/`slice`; new piece of work → trace binds first",
  },
  {
    utterance: "I'm about to write a PRD for this task — where should it live?",
    expectedSkill: "trace-doc-placement",
    note: "STEAL: near `create-prd`/`spec`; the placement intent should win over PRD-generation",
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
    expectedSkill: "spec",
    note: "negative: spec trigger (create-prd is a near-twin — a decoy firing either way still proves no over-capture)",
  },
  {
    utterance: "implement a debounce on the search input handler",
    expectedSkill: "implement",
    note: "negative: pure coding task, no task reference — trace must not over-capture",
  },
  {
    utterance: "write product requirements for a referral program",
    expectedSkill: "create-prd",
    note: "negative: pure PRD generation, no placement question",
  },
];
