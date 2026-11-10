/**
 * Status Line — Clean single-line footer
 *
 * Left:  [session] model thinking · cwd branch
 * Right: $cost ████▋▒▒▒▒▒▒▒▒▒▒▒ 28% · 42 τ/s
 *
 * Usage: pi -e extensions/pure-status.ts
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import path from "node:path";

// ── Bar rendering ────────────────────────────────────────────────────────────

/** Sub-character left-fill blocks, index = eighths (0=skip, 1=▏ … 7=▉) */
const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * Build a progress bar string with sub-character resolution.
 *
 * Filled cells use █, empty cells use ▒. A fractional partial-block character
 * (▏…▉) is inserted between filled and empty for 1/8-cell resolution.
 *
 * @param pct    Context usage 0–100
 * @param width  Total bar width in characters
 */
export function renderBar(pct: number, width: number): string {
  const exact = Math.min(width, (Math.max(0, pct) / 100) * width);
  const full = Math.floor(exact);
  const eighths = Math.floor((exact - full) * 8);
  const empty = width - full - (eighths > 0 ? 1 : 0);

  const filled = "█".repeat(full);
  const partial = PARTIAL[eighths];
  const rest = "▒".repeat(Math.max(0, empty));

  return filled + partial + rest;
}

/**
 * Map context usage percentage to a theme color token.
 * green (low) → yellow (medium) → red (high)
 */
export function barColor(pct: number): "success" | "warning" | "error" {
  if (pct < 50) {
    return "success";
  }
  if (pct < 80) {
    return "warning";
  }
  return "error";
}

/** Context usage label; null means pi does not know the token count (e.g. right after compaction). */
export function formatContextPct(pct: number | null): string {
  return pct === null ? "?%" : `${Math.round(pct)}%`;
}

// ── Session statistics ───────────────────────────────────────────────────────

/** The model usage an entry records, if any. */
function entryUsage(entry: SessionEntry) {
  switch (entry.type) {
    case "usage":
    case "compaction":
    case "branch_summary": {
      return entry.usage;
    }
    case "message": {
      const { message } = entry;
      return message.role === "assistant" || message.role === "toolResult"
        ? message.usage
        : undefined;
    }
    default: {
      return;
    }
  }
}

/**
 * Total cost of every model call recorded in the session, summed the same way
 * as pi's built-in footer: assistant messages, usage entries, tool results
 * that report their own usage, and the summaries stored on compaction and
 * branch-summary entries. Counts all branches.
 */
export function sessionCost(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entryUsage(entry)?.cost?.total ?? 0;
  }
  return total;
}

/** Median of a list of numbers; 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Responses shorter than this are too noisy to measure throughput from. */
const MIN_SAMPLE_MS = 100;

/**
 * Output throughput of one response in tokens per second, or null when the
 * response is too short or produced no output.
 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (outputTokens <= 0 || durationMs <= MIN_SAMPLE_MS) {
    return null;
  }
  return outputTokens / (durationMs / 1000);
}

/**
 * How long an assistant response took. Prefers the monotonic `durationMs`
 * pi records; falls back to the wall-clock span from the request start to
 * `fallbackEndMs` for messages that lack it.
 */
export function responseDurationMs(
  message: { timestamp?: number; durationMs?: number },
  fallbackEndMs: number,
): number {
  if (message.durationMs !== undefined) {
    return message.durationMs;
  }
  const start = message.timestamp ?? 0;
  return start > 0 && Number.isFinite(fallbackEndMs) ? fallbackEndMs - start : 0;
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Last two path segments ("parent/dir"), or the path itself near the root. */
export function formatCwd(cwd: string): string {
  const dirName = path.basename(cwd);
  const parent = path.dirname(cwd);
  if (dirName === "" || parent === cwd) {
    return cwd;
  }
  const parentName = path.basename(parent);
  return parentName === "" ? `/${dirName}` : `${parentName}/${dirName}`;
}

/**
 * Join left and right parts into one line of exactly-or-less `width`.
 * The right part has priority: the left part is truncated first.
 */
export function joinLeftRight(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const leftRoom = width - rightW - 1;
  if (leftRoom <= 0) {
    return truncateToWidth(right, width);
  }
  const fittedLeft = truncateToWidth(left, leftRoom);
  const pad = " ".repeat(width - visibleWidth(fittedLeft) - rightW);
  return fittedLeft + pad + right;
}

// ── Extension ────────────────────────────────────────────────────────────────

/** Rolling window size for the tok/s median. */
const TPS_WINDOW = 5;

const BAR_WIDTH = 16;

export default function (pi: ExtensionAPI) {
  // State is hoisted so handlers are registered once. session_start fires on
  // startup, reload, new, resume, and fork — nesting pi.on inside it would stack
  // listeners across session changes.
  const tpsSamples: number[] = [];

  function addTpsSample(sample: number | null) {
    if (sample === null) {
      return;
    }
    tpsSamples.push(sample);
    if (tpsSamples.length > TPS_WINDOW) {
      tpsSamples.shift();
    }
  }

  // message_end, not turn_end: turn_end fires after tool execution, which
  // would count tool run time as generation time.
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") {
      return;
    }
    addTpsSample(tokensPerSecond(msg.usage?.output ?? 0, responseDurationMs(msg, Date.now())));
  });

  pi.on("session_start", (_event, ctx) => {
    // Reset per-session state — same handlers are reused across session changes.
    tpsSamples.length = 0;

    // Preload tok/s window from existing session history.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        continue;
      }
      const msg = entry.message;
      const duration = responseDurationMs(msg, Date.parse(entry.timestamp));
      addTpsSample(tokensPerSecond(msg.usage?.output ?? 0, duration));
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      // Redraw when the git branch shown on the left changes.
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

      // Summing the cost scans every entry, and the footer renders on every frame.
      // Entries are append-only and every append moves the leaf to a new id, so
      // any change to the entries also changes this key.
      let costKey = "";
      let cost = 0;
      function currentCost(): number {
        const sm = ctx.sessionManager;
        const key = `${sm.getSessionId()}:${sm.getLeafId() ?? ""}`;
        if (key !== costKey) {
          costKey = key;
          cost = sessionCost(sm.getEntries());
        }
        return cost;
      }

      return {
        dispose: unsubscribeBranch,
        // Values are read live each frame; the only cache is keyed on session state.
        invalidate() {},
        render(width: number): string[] {
          // ── Left ──────────────────────────────────────────
          const sessionName = pi.getSessionName()?.trim();
          const sessionPill = sessionName
            ? theme.fg("borderMuted", "[") +
              theme.fg("warning", ` ${truncateToWidth(sessionName, 24)} `) +
              theme.fg("borderMuted", "]")
            : "";

          const model = ctx.model?.name ?? "no-model";
          const branch = footerData.getGitBranch();

          // Thinking level — only shown when model supports reasoning
          const level = pi.getThinkingLevel();
          const thinkingStr = ctx.model?.reasoning
            ? theme.getThinkingBorderColor(level)(` ${level}`)
            : "";

          const left =
            sessionPill +
            theme.fg("accent", ` ${model}`) +
            thinkingStr +
            theme.fg("dim", " · ") +
            theme.fg("text", formatCwd(ctx.cwd)) +
            (branch ? theme.fg("dim", ` ${branch}`) : "");

          // ── Right ─────────────────────────────────────────
          const pct = ctx.getContextUsage()?.percent ?? null;
          const barPct = pct ?? 0;
          const tps = median(tpsSamples);
          const tpsStr = tps > 0 ? theme.fg("dim", `· ${Math.round(tps)} τ/s `) : "";

          const right =
            theme.fg("dim", `$${currentCost().toFixed(2)} `) +
            theme.fg(barColor(barPct), renderBar(barPct, BAR_WIDTH)) +
            theme.fg("dim", ` ${formatContextPct(pct)} `) +
            tpsStr;

          return [joinLeftRight(left, right, width)];
        },
      };
    });
  });
}
