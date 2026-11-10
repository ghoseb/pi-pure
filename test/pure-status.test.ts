import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  barColor,
  formatContextPct,
  formatCwd,
  formatStatuses,
  readStatusSettings,
  shownStatuses,
  joinLeftRight,
  median,
  renderBar,
  responseDurationMs,
  sessionCost,
  tokensPerSecond,
} from "../extensions/pure-status.ts";
import { assistantEntry, summaryEntry, toolResultEntry, usageEntry } from "./fixtures.ts";

// ── renderBar ─────────────────────────────────────────────────────────────────

describe("renderBar", () => {
  it("0% — all empty ▒", () => {
    const bar = renderBar(0, 16);
    expect(bar).toBe("▒".repeat(16));
    expect([...bar].length).toBe(16);
  });

  it("100% — all filled (solid █)", () => {
    const bar = renderBar(100, 16);
    expect(bar).toBe("█".repeat(16));
    expect([...bar].length).toBe(16);
  });

  it("50% — half filled █, half empty ▒", () => {
    const bar = renderBar(50, 16);
    const filled = [...bar].filter((c) => c === "█").length;
    const empty = [...bar].filter((c) => c === "▒").length;
    expect(filled).toBe(8);
    expect(empty).toBe(8);
  });

  it("width is always exactly the specified number of chars", () => {
    for (const pct of [0, 12.5, 25, 33, 50, 66, 72, 80, 99, 100]) {
      const bar = renderBar(pct, 16);
      expect([...bar].length, `pct=${pct}`).toBe(16);
    }
  });

  it("filled region is solid █", () => {
    const bar = renderBar(100, 16);
    expect(bar).toBe("█".repeat(16));
  });

  it("empty region is medium ▒", () => {
    const bar = renderBar(0, 16);
    expect(bar).toBe("▒".repeat(16));
  });

  it("sub-char partial block appears at the boundary", () => {
    // 25% of 16 = 4.0 exactly — no partial block
    const barExact = renderBar(25, 16);
    const hasPartial = [...barExact].some((c) => "▏▎▍▌▋▊▉".includes(c));
    expect(hasPartial).toBe(false);

    // ~28% of 16 = 4.48 → partial block expected
    const barPartial = renderBar(28, 16);
    const hasPartial2 = [...barPartial].some((c) => "▏▎▍▌▋▊▉".includes(c));
    expect(hasPartial2).toBe(true);
  });

  it("clamps pct below 0 to 0", () => {
    expect(renderBar(-10, 16)).toBe("▒".repeat(16));
  });

  it("clamps pct above 100 to full", () => {
    const bar = renderBar(110, 16);
    expect([...bar].length).toBe(16);
    expect(bar).not.toContain("░");
  });

  it("works with width=1", () => {
    expect([...renderBar(0, 1)].length).toBe(1);
    expect([...renderBar(100, 1)].length).toBe(1);
    expect([...renderBar(50, 1)].length).toBe(1);
  });

  it("partial block is not doubled at boundary", () => {
    // 50% of 8 = 4.0 — no partial, no extra char
    const bar = renderBar(50, 8);
    expect([...bar].length).toBe(8);
    expect(bar).toBe("████▒▒▒▒");
  });
});

// ── barColor ──────────────────────────────────────────────────────────────────

describe("barColor", () => {
  it("0% → success", () => expect(barColor(0)).toBe("success"));
  it("49% → success", () => expect(barColor(49)).toBe("success"));
  it("50% → warning", () => expect(barColor(50)).toBe("warning"));
  it("79% → warning", () => expect(barColor(79)).toBe("warning"));
  it("80% → error", () => expect(barColor(80)).toBe("error"));
  it("100% → error", () => expect(barColor(100)).toBe("error"));
});

// ── formatContextPct ──────────────────────────────────────────────────────────

describe("formatContextPct", () => {
  it("rounds known percentages", () => expect(formatContextPct(27.6)).toBe("28%"));
  it("shows ? when usage is unknown", () => expect(formatContextPct(null)).toBe("?%"));
});

// ── sessionCost ───────────────────────────────────────────────────────────────

describe("sessionCost", () => {
  it("is 0 for an empty session", () => expect(sessionCost([])).toBe(0));

  it("sums every entry kind pi counts towards the session cost", () => {
    const entries = [
      assistantEntry({ cost: 0.5 }),
      usageEntry(0.25),
      toolResultEntry(0.125),
      toolResultEntry(undefined),
      summaryEntry("compaction", 1),
      summaryEntry("compaction", undefined),
      summaryEntry("branch_summary", 2),
    ];
    expect(sessionCost(entries)).toBeCloseTo(3.875);
  });
});

// ── median ────────────────────────────────────────────────────────────────────

describe("median", () => {
  it("is 0 for no samples", () => expect(median([])).toBe(0));
  it("takes the middle of an odd count", () => expect(median([9, 1, 5])).toBe(5));
  it("averages the middle pair of an even count", () => expect(median([4, 1, 3, 2])).toBe(2.5));
  it("does not reorder its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

// ── tokensPerSecond / responseDurationMs ──────────────────────────────────────

describe("tokensPerSecond", () => {
  it("divides output tokens by seconds", () => expect(tokensPerSecond(100, 2000)).toBe(50));
  it("ignores responses without output", () => expect(tokensPerSecond(0, 2000)).toBeNull());
  it("ignores responses too short to measure", () => expect(tokensPerSecond(10, 100)).toBeNull());
});

describe("responseDurationMs", () => {
  it("prefers the recorded durationMs", () => {
    expect(responseDurationMs({ timestamp: 1000, durationMs: 400 }, 9000)).toBe(400);
  });
  it("falls back to the span from the request start", () => {
    expect(responseDurationMs({ timestamp: 1000 }, 3500)).toBe(2500);
  });
  it("is 0 without a start time or a valid end time", () => {
    expect(responseDurationMs({}, 3500)).toBe(0);
    expect(responseDurationMs({ timestamp: 1000 }, Number.NaN)).toBe(0);
  });
});

// ── formatCwd ─────────────────────────────────────────────────────────────────

describe("formatCwd", () => {
  it("shows the last two segments", () => expect(formatCwd("/a/b/c/project")).toBe("c/project"));
  it("handles a directory directly under the root", () => expect(formatCwd("/tmp")).toBe("/tmp"));
  it("handles the root itself", () => expect(formatCwd("/")).toBe("/"));
});

// ── joinLeftRight ─────────────────────────────────────────────────────────────

describe("joinLeftRight", () => {
  it("pads between left and right to fill the width", () => {
    expect(joinLeftRight("left", "right", 15)).toBe("left      right");
  });

  it("truncates the left part first when space is short", () => {
    const line = joinLeftRight("a long left part", "right", 14);
    expect(line.endsWith(" right")).toBe(true);
    expect(visibleWidth(line)).toBe(14);
  });

  it("truncates the right part only when it alone overflows", () => {
    const line = joinLeftRight("left", "a very long right part", 10);
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    expect(line.startsWith("a very")).toBe(true);
  });
});

// ── formatStatuses ────────────────────────────────────────────────────────────

describe("formatStatuses", () => {
  it("joins the statuses in key order", () => {
    const statuses = new Map([
      ["zeta", "Z"],
      ["alpha", "A"],
      ["mid", "M"],
    ]);
    expect(formatStatuses(statuses, " | ")).toBe("A | M | Z");
  });

  it("replaces newlines and tabs with one space and trims the text", () => {
    const statuses = new Map([["a", "  one\ntwo\r\n\tthree   four "]]);
    expect(formatStatuses(statuses, " | ")).toBe("one two three four");
  });

  it("drops empty and blank statuses", () => {
    const statuses = new Map([
      ["a", "A"],
      ["b", ""],
      ["c", " \n "],
      ["d", "D"],
    ]);
    expect(formatStatuses(statuses, " | ")).toBe("A | D");
  });

  it("returns an empty string when there are no statuses", () => {
    expect(formatStatuses(new Map(), " | ")).toBe("");
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("readStatusSettings", () => {
  const defaults = { extensionStatuses: true, hiddenStatusKeys: new Set() };

  it.each([
    ["no settings", {}],
    ["no pi-pure settings", { theme: "dark" }],
    ["no status settings", { "pi-pure": {} }],
    ["settings that are not an object", "settings"],
    ["pi-pure settings that are an array", { "pi-pure": [] }],
    ["status settings that are null", { "pi-pure": { status: null } }],
  ])("gives the defaults for %s", (_name, settings) => {
    expect(readStatusSettings(settings)).toEqual(defaults);
  });

  it("reads the settings", () => {
    const settings = {
      "pi-pure": { status: { extensionStatuses: false, hiddenStatusKeys: ["mcp"] } },
    };
    expect(readStatusSettings(settings)).toEqual({
      extensionStatuses: false,
      hiddenStatusKeys: new Set(["mcp"]),
    });
  });

  it.each([
    ["a string", "no", "mcp"],
    ["a number", 0, 0],
    ["null", null, null],
  ])("gives the defaults for values that are %s", (_name, extensionStatuses, hiddenStatusKeys) => {
    const settings = { "pi-pure": { status: { extensionStatuses, hiddenStatusKeys } } };
    expect(readStatusSettings(settings)).toEqual(defaults);
  });

  it("ignores hidden keys that are not strings", () => {
    const settings = { "pi-pure": { status: { hiddenStatusKeys: ["mcp", 1, null, "lint"] } } };
    expect(readStatusSettings(settings).hiddenStatusKeys).toEqual(new Set(["mcp", "lint"]));
  });
});

describe("shownStatuses", () => {
  const statuses = new Map([
    ["lint", "ok"],
    ["mcp", "2 servers"],
  ]);

  it("shows all statuses by default", () => {
    expect(shownStatuses(statuses, readStatusSettings({}))).toEqual(statuses);
  });

  it("shows no statuses when extension statuses are off", () => {
    const settings = { extensionStatuses: false, hiddenStatusKeys: new Set<string>() };
    expect(shownStatuses(statuses, settings).size).toBe(0);
  });

  it("removes the hidden keys", () => {
    const settings = { extensionStatuses: true, hiddenStatusKeys: new Set(["mcp"]) };
    expect([...shownStatuses(statuses, settings)]).toEqual([["lint", "ok"]]);
  });
});
