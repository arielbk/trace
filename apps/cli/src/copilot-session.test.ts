import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  parentProcessCommand,
  resolveCopilotSession,
} from "./copilot-session.ts";

test("uses PowerShell to walk native Windows parent PIDs", () => {
  expect(parentProcessCommand(1234, "win32")).toEqual({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter 'ProcessId = 1234').ParentProcessId",
    ],
  });
});

test("resolves the live Copilot session from an ancestor PID lock", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-copilot-home-"));
  const sessionDir = join(home, "session-state", "copilot-session-1");

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    writeFileSync(join(sessionDir, "inuse.200.lock"), "");

    expect(
      resolveCopilotSession(
        { COPILOT_HOME: home },
        { ancestorPids: [101, 200], isPidAlive: () => true },
      ),
    ).toEqual({
      id: "copilot-session-1",
      transcriptPath: join(sessionDir, "events.jsonl"),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("chooses only the concurrently running session whose lock PID is an ancestor", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-copilot-home-"));
  const matching = join(home, "session-state", "matching");
  const sibling = join(home, "session-state", "sibling");

  try {
    for (const directory of [matching, sibling]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "events.jsonl"), "");
    }
    writeFileSync(join(matching, "inuse.200.lock"), "");
    writeFileSync(join(sibling, "inuse.300.lock"), "");

    expect(
      resolveCopilotSession(
        { COPILOT_HOME: home },
        { ancestorPids: [101, 200], isPidAlive: () => true },
      ),
    ).toEqual({
      id: "matching",
      transcriptPath: join(matching, "events.jsonl"),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skips a stale matching lock", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-copilot-home-"));
  const sessionDir = join(home, "session-state", "stale");

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    writeFileSync(join(sessionDir, "inuse.200.lock"), "");

    expect(
      resolveCopilotSession(
        { COPILOT_HOME: home },
        { ancestorPids: [200], isPidAlive: () => false },
      ),
    ).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("honors COPILOT_HOME over the default Copilot config directory", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-copilot-home-"));
  const sessionDir = join(home, "session-state", "custom-home");

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    writeFileSync(join(sessionDir, "inuse.200.lock"), "");

    expect(
      resolveCopilotSession(
        { COPILOT_HOME: home },
        { ancestorPids: [200], isPidAlive: () => true },
      ),
    ).toEqual({
      id: "custom-home",
      transcriptPath: join(sessionDir, "events.jsonl"),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
