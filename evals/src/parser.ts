/**
 * Pure stream parser for `claude -p --output-format stream-json --verbose`.
 *
 * The stream is newline-delimited JSON. Somewhere in it the assistant emits
 * `tool_use` blocks; a skill invocation looks like:
 *
 *   { "type": "tool_use", "name": "Skill", "input": { "skill": "<name>", "args": "…" } }
 *
 * These blocks are nested inside assistant `message.content` arrays, so rather
 * than hard-code the envelope shape we walk every parsed line recursively and
 * collect the `input.skill` of every Skill tool-use we find, in order.
 *
 * NOTE: the captured field is `input.skill`, NOT `input.skill_name` (verified
 * against claude CLI 2.1.172 — see the PRD's Verified Assumptions).
 */
export function parse(streamJson: string): string[] {
  const fired: string[] = [];

  for (const line of streamJson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Tolerate non-JSON noise on the stream (banners, partial flushes).
      continue;
    }

    collectSkills(event, fired);
  }

  return fired;
}

/** Recursively find Skill tool-use blocks and push their `input.skill`. */
function collectSkills(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSkills(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;

  if (obj.type === "tool_use" && obj.name === "Skill") {
    const input = obj.input;
    if (input && typeof input === "object") {
      const skill = (input as Record<string, unknown>).skill;
      if (typeof skill === "string") out.push(skill);
    }
  }

  for (const value of Object.values(obj)) collectSkills(value, out);
}

/**
 * Map a plugin-namespaced skill id to the corpus's expected name (the skill's
 * frontmatter `name:`).
 *
 * The trace skills ship inside the `trace` plugin, so the CLI emits them as
 * `trace:<dir>` (e.g. `trace:doc-placement`). The corpus names them by their
 * frontmatter `name:` (`trace-doc-placement`), and the root skill's dir and
 * name are both just `trace`. Non-trace skills (decoys) pass through unchanged.
 */
export function normalizeSkill(fired: string): string {
  const m = fired.match(/^trace:(.+)$/);
  if (!m) return fired;
  const short = m[1];
  return short === "trace" ? "trace" : `trace-${short}`;
}
