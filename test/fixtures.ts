/**
 * Session entry builders for tests. Only the fields the extensions read are
 * meaningful; the rest are filled with plausible defaults.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let nextId = 0;

function base(timestamp = "2026-01-01T00:00:00.000Z") {
  nextId++;
  return { id: `e${nextId}`, parentId: null, timestamp };
}

function usage(cost: number, output = 0) {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

export function assistantEntry(opts: {
  cost?: number;
  output?: number;
  /** Request start, ms since epoch. */
  startMs?: number;
  durationMs?: number;
  /** When the entry was persisted (end of the response), ms since epoch. */
  endMs?: number;
}): SessionEntry {
  return {
    ...base(new Date(opts.endMs ?? 0).toISOString()),
    type: "message",
    message: {
      role: "assistant",
      content: [],
      usage: usage(opts.cost ?? 0, opts.output ?? 0),
      stopReason: "stop",
      timestamp: opts.startMs ?? 0,
      durationMs: opts.durationMs,
    },
  } as unknown as SessionEntry;
}

export function usageEntry(cost: number): SessionEntry {
  return {
    ...base(),
    type: "usage",
    kind: "compaction",
    provider: "p",
    model: "m",
    usage: usage(cost),
  } as unknown as SessionEntry;
}

export function toolResultEntry(cost: number | undefined): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t",
      toolName: "tool",
      content: [],
      isError: false,
      timestamp: 0,
      ...(cost === undefined ? {} : { usage: usage(cost) }),
    },
  } as unknown as SessionEntry;
}

export function summaryEntry(
  type: "compaction" | "branch_summary",
  cost: number | undefined,
): SessionEntry {
  return {
    ...base(),
    type,
    summary: "summary",
    ...(type === "compaction" ? { firstKeptEntryId: "e0", tokensBefore: 0 } : { fromId: "e0" }),
    ...(cost === undefined ? {} : { usage: usage(cost) }),
  } as unknown as SessionEntry;
}
