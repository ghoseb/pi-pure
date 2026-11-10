/**
 * Integration tests for pure-status.ts — the footer installed on session_start,
 * driven through the harness.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import pureStatus from "../extensions/pure-status.ts";
import { assistantEntry, usageEntry } from "./fixtures.ts";
import { createHarness } from "./harness.ts";
import type { HarnessOptions } from "./harness.ts";

async function setup(opts: HarnessOptions = {}) {
  const h = createHarness({ model: { name: "test-model" }, contextPercent: 25, ...opts });
  pureStatus(h.api);
  await h.fireEvent("session_start");
  const footer = h.footer();
  return { h, footer, line: (width = 120) => footer.render(width)[0] };
}

function assistantMessage(output: number, durationMs?: number) {
  return {
    role: "assistant",
    content: [],
    usage: { output, cost: { total: 0 } },
    timestamp: Date.now() - 1000,
    durationMs,
  };
}

describe("pure-status extension", () => {
  it("registers its handlers once", () => {
    const h = createHarness();
    pureStatus(h.api);
    expect(h.handlers.get("session_start")).toHaveLength(1);
    expect(h.handlers.get("message_end")).toHaveLength(1);
    expect(h.handlers.has("turn_end")).toBe(false);
  });

  it("renders model, cwd, branch, cost and context usage", async () => {
    const { line } = await setup({ cwd: "/home/user/project", gitBranch: "main" });
    const text = line();
    expect(text).toContain("test-model");
    expect(text).toContain("user/project main");
    expect(text).toContain("$0.00");
    expect(text).toContain("25%");
  });

  it("shows ?% when context usage is unknown", async () => {
    const { line } = await setup({ contextPercent: null });
    expect(line()).toContain(" ?% ");
  });

  it("separates the session pill from the model with one space", async () => {
    const { line } = await setup({ sessionName: "refactor" });
    expect(line()).toContain("[ refactor ] test-model");
  });

  it("shows the thinking level only for reasoning models", async () => {
    const plain = await setup({ thinkingLevel: "max" });
    expect(plain.line()).not.toContain("max");
    const reasoning = await setup({ model: { name: "m", reasoning: true }, thinkingLevel: "max" });
    expect(reasoning.line()).toContain(" m max · ");
  });

  it("keeps the right side when the terminal is narrow", async () => {
    const { line } = await setup({ cwd: "/a/very/long/path/to/some/project" });
    const text = line(40);
    expect(visibleWidth(text)).toBe(40);
    expect(text).toContain("25%");
  });

  it("counts cost across all session entries, including usage entries", async () => {
    const { h, line } = await setup({
      session: {
        sessionId: "s1",
        leafId: "a",
        entries: [assistantEntry({ cost: 1 }), usageEntry(0.5)],
        branch: [],
      },
    });
    expect(line()).toContain("$1.50");

    h.session.entries.push(assistantEntry({ cost: 0.25 }));
    h.session.leafId = "b";
    expect(line()).toContain("$1.75");

    // Navigating back to an earlier leaf keeps the cost of the other branch.
    h.session.leafId = "a";
    expect(line()).toContain("$1.75");
  });

  it("measures tok/s from message_end using durationMs", async () => {
    const { h, line } = await setup();
    await h.fireEvent("message_end", { message: assistantMessage(100, 2000) });
    expect(line()).toContain("50 τ/s");
  });

  it("ignores non-assistant messages for tok/s", async () => {
    const { h, line } = await setup();
    await h.fireEvent("message_end", { message: { role: "user", content: "hi", timestamp: 0 } });
    expect(line()).not.toContain("τ/s");
  });

  it("preloads tok/s from session history", async () => {
    const { line } = await setup({
      session: {
        sessionId: "s1",
        leafId: "c",
        entries: [
          assistantEntry({ output: 100, durationMs: 1000 }),
          assistantEntry({ output: 300, startMs: 10_000, endMs: 13_000 }),
          assistantEntry({ output: 600, durationMs: 2000 }),
        ],
      },
    });
    // samples: 100, 100, 300 → median 100
    expect(line()).toContain("100 τ/s");
  });

  it("resets tok/s on a new session", async () => {
    const { h } = await setup();
    await h.fireEvent("message_end", { message: assistantMessage(100, 2000) });
    await h.fireEvent("session_start");
    expect(h.footer().render(120)[0]).not.toContain("τ/s");
  });

  it("redraws on git branch changes and unsubscribes on dispose", async () => {
    const { h, footer } = await setup();
    h.changeGitBranch();
    expect(h.renderRequests()).toBe(1);
    footer.dispose?.();
    expect(h.hasGitBranchListener()).toBe(false);
  });
});
