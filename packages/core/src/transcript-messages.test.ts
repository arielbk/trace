import { expect, test } from "vitest";
import {
  collectTranscriptHead,
  type JsonObject,
  type TranscriptMessage,
} from "./transcript-messages.ts";

function roleAndText(event: JsonObject): TranscriptMessage | null {
  const role = event.role;
  const text = event.text;
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
    return null;
  }
  return { role, text };
}

function jsonl(events: JsonObject[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

test("collects the first user messages in order, skipping assistant turns", () => {
  const transcript = jsonl([
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second" },
  ]);

  expect(collectTranscriptHead(transcript, 8, roleAndText)).toEqual([
    { role: "user", text: "first" },
    { role: "user", text: "second" },
  ]);
});

test("short-circuits at the limit instead of walking the whole transcript", () => {
  const transcript = jsonl([
    { role: "user", text: "one" },
    { role: "user", text: "two" },
    { role: "user", text: "three" },
  ]);

  expect(collectTranscriptHead(transcript, 2, roleAndText)).toEqual([
    { role: "user", text: "one" },
    { role: "user", text: "two" },
  ]);
});

test("returns an empty head when the transcript cannot be parsed", () => {
  expect(collectTranscriptHead("{ not json", 8, roleAndText)).toEqual([]);
});
