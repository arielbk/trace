import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  computeDocsFingerprint,
  hasProseBody,
  type DocFingerprintInput,
  type ProseStamp,
} from "./prose-fingerprint.ts";
import {
  partitionStateDocument,
  readStateDocument,
  stateDocumentPath,
} from "./state-document.ts";

/**
 * State freshness — "has the prose drifted from the docs?" — computed once.
 *
 * The board's staleness flag, `eqnx state check`, and the re-entry manifest's
 * `stateFreshness:` block are three readers of one invariant. When each
 * re-derived it (resolve docs dir, drop the State Document, hash the rest,
 * compare to the stamp) they could silently disagree, and no test could catch
 * the disagreement because there was no shared surface to test.
 *
 * Callers own what they do with the verdict: `check` gates the prose-pass
 * directive on an explicit session binding, the board renders a badge, and
 * `reflect` stamps the fingerprint this module computed.
 */
export type StateFreshness = {
  stateExists: boolean;
  statePath: string;
  /** Fingerprint of the task's docs right now — what `reflect` should stamp. */
  fingerprint: string;
  /** The stamp currently on disk, when the State Document carries one. */
  stamp?: ProseStamp;
  /**
   * Whether a prose pass is due. Absent — the task abstains — when there is no
   * State Document or no doc to reflect on.
   */
  needsProsePass?: boolean;
  /** Why a pass is due: `seed` when no prose exists yet, `refresh` otherwise. */
  mode?: "seed" | "refresh";
  /** The doc set the fingerprint was taken over, as state.md-relative paths. */
  changedDocs?: string[];
};

/**
 * Compute the verdict for a task. Reads only — nothing here writes, so a board
 * render never moves the State Document's mtime.
 */
export function computeStateFreshness(
  docsDir: string,
  docs: readonly { path: string }[],
): StateFreshness {
  const { others } = partitionStateDocument(docs);
  const inputs: DocFingerprintInput[] = others.map((doc) => ({
    path: relative(docsDir, doc.path),
    content: readDocOrEmpty(doc.path),
  }));
  const fingerprint = computeDocsFingerprint(inputs);
  const statePath = stateDocumentPath(docsDir);

  const verdict: StateFreshness = {
    stateExists: existsSync(statePath),
    statePath,
    fingerprint,
  };

  // Nothing to reflect on: an empty task should never be asked for prose, and
  // should never show a staleness badge either.
  if (others.length === 0) return verdict;

  const document = readStateDocument(docsDir, "");
  if (document.stamp) verdict.stamp = document.stamp;

  // A State Document that is missing, or present with only its scaffold title,
  // needs seeding. Otherwise it has drifted iff the stamp no longer matches —
  // a missing or garbled stamp counts as drift.
  const seeding = !document.exists || !hasProseBody(document.prose);
  verdict.needsProsePass = seeding || document.stamp?.fingerprint !== fingerprint;
  if (verdict.needsProsePass) {
    verdict.mode = seeding ? "seed" : "refresh";
    verdict.changedDocs = inputs.map((doc) => doc.path).sort();
  }

  return verdict;
}

function readDocOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
