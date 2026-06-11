/**
 * Routing eval corpus — the full set of utterances the eval drives through
 * `claude -p` to verify skill routing. Each case names the expected skill
 * (frontmatter `name:` value) and a short note explaining intent.
 *
 * Composition:
 *  - All 6 trace skills: ≥1 clear utterance each
 *  - Steal-boundary: trace-adjacent phrasing where a decoy could steal the route
 *  - Intra-trace boundary: distinguishes trace / trace-recall / trace-reenter
 *  - Negative/over-capture: genuine decoy utterances where no trace skill should fire
 */

export interface Case {
  utterance: string;
  expectedSkill: string;
  note: string;
}

export const corpus: Case[] = [
  // ── trace (bind / start new work) ──────────────────────────────────────────

  {
    utterance: "I'm starting work on the checkout-flow feature",
    expectedSkill: "trace",
    note: "clear new-work binding — the canonical walking-skeleton case",
  },
  {
    utterance: "Let's create a new task for the auth refactor",
    expectedSkill: "trace",
    note: "new work with explicit task mention",
  },

  // ── trace-recall (vague reference to prior work) ───────────────────────────

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

  // ── trace-reenter (exact slug or title) ────────────────────────────────────

  {
    utterance: "re-enter the break-stop-and-stale-expiry task",
    expectedSkill: "trace-reenter",
    note: "exact slug — the canonical reenter trigger",
  },
  {
    utterance: "resume skill-routing-eval",
    expectedSkill: "trace-reenter",
    note: "exact slug, short-form — should reenter not recall",
  },

  // ── trace-handoff (wrapping up / end of session) ───────────────────────────

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

  // ── trace-doc-placement (save a document in the task's docs dir) ───────────

  {
    utterance: "where should I save this spec in the task docs?",
    expectedSkill: "trace-doc-placement",
    note: "doc placement intent for a spec",
  },
  {
    utterance: "place my PRD in the current task's docs directory",
    expectedSkill: "trace-doc-placement",
    note: "explicit doc-placement request for a PRD",
  },

  // ── trace-board (open the task board UI) ──────────────────────────────────

  {
    utterance: "open the task board",
    expectedSkill: "trace-board",
    note: "canonical open-board phrase",
  },
  {
    utterance: "show me the trace board in the browser",
    expectedSkill: "trace-board",
    note: "browser/UI phrasing for the task board",
  },

  // ── steal-boundary: trace wins over decoys ─────────────────────────────────

  {
    utterance:
      "I need to save this PRD to the current task's docs — where does it go?",
    expectedSkill: "trace-doc-placement",
    note: "steal-boundary: trace-doc-placement wins over create-prd decoy",
  },
  {
    utterance:
      "bind this session to the login-page feature I'm about to work on",
    expectedSkill: "trace",
    note: "steal-boundary: trace wins over scope decoy (scope-adjacent phrasing)",
  },

  // ── intra-trace boundary ───────────────────────────────────────────────────

  {
    utterance: "pick up where we left off on the wizard feature",
    expectedSkill: "trace-recall",
    note: "intra-trace: vague → trace-recall, not trace-reenter",
  },
  {
    utterance: "re-enter user-auth",
    expectedSkill: "trace-reenter",
    note: "intra-trace: exact slug → trace-reenter, not trace-recall",
  },
  {
    utterance: "I want to start a brand-new bug-fix task",
    expectedSkill: "trace",
    note: "intra-trace: new work → trace, not trace-recall or trace-reenter",
  },

  // ── negative / over-capture: decoy fires, no trace skill ──────────────────

  {
    utterance: "scope this feature for me",
    expectedSkill: "scope",
    note: "negative: decoy scope should win, no trace skill",
  },
  {
    utterance: "slice this into implementable tasks",
    expectedSkill: "slice",
    note: "negative: decoy slice should win",
  },
  {
    utterance: "write a spec from our current conversation",
    expectedSkill: "spec",
    note: "negative: decoy spec should win",
  },
  {
    utterance: "implement this feature, drive the task DAG to completion",
    expectedSkill: "implement",
    note: "negative: decoy implement should win",
  },
  {
    utterance: "create a PRD for the new dashboard feature",
    expectedSkill: "create-prd",
    note: "negative: decoy create-prd should win",
  },
];
