/**
 * Tests for pure-editor: the exported pure functions and the PureEditor
 * component rendered through a real base Editor.
 */

import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import pureEditor, {
  BOTTOM_MARKER,
  boxBorder,
  LEFT_GUTTER,
  LINE_OVERHEAD,
  MIN_BOX_WIDTH,
  PROMPT,
  PROMPT_WIDTH,
  PureEditor,
  splitBaseRender,
  toBaseMouseEvent,
  wrapInBox,
} from "../extensions/pure-editor.ts";
import type { EditorFrame } from "../extensions/pure-editor.ts";
import { createHarness, stubEditorTheme, stubKeybindings, stubTui } from "./harness.ts";

/** Identity border color (no-op) for testing */
const bc = (s: string) => s;

/** No prompt color for testing */
const noColor = "";

/** Strip ANSI codes and the cursor marker for easier assertions */
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replaceAll(/\u001B\[[0-9;]*m|\u001B_[^\u0007]*\u0007/gu, "");

function frame(overrides: Partial<EditorFrame> = {}): EditorFrame {
  return {
    contentLines: ["hello"],
    autocompleteLines: [],
    hiddenAbove: 0,
    hiddenBelow: 0,
    ...overrides,
  };
}

function mouse(overrides: Partial<TuiMouseEvent>): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 40,
    height: 3,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

function makeEditor(rows = 40) {
  return new PureEditor(stubTui(rows), stubEditorTheme(), stubKeybindings(), () => "");
}

// ─────────────────────────────────────────────────────────────────────────────
// splitBaseRender
// ─────────────────────────────────────────────────────────────────────────────

describe("splitBaseRender", () => {
  it("splits content and autocomplete around the bottom marker", () => {
    const lines = ["", "a", "b", BOTTOM_MARKER, "ac-1", "ac-2"];
    expect(splitBaseRender(lines, 2, 3)).toEqual({
      contentLines: ["a", "b"],
      autocompleteLines: ["ac-1", "ac-2"],
      hiddenAbove: 2,
      hiddenBelow: 3,
    });
  });

  it("returns null when the marker is missing", () => {
    expect(splitBaseRender(["───", "a", "───"], 0, 0)).toBeNull();
  });

  it("returns null when the marker is on the first line", () => {
    expect(splitBaseRender([BOTTOM_MARKER, "a"], 0, 0)).toBeNull();
  });

  it("does not treat content that looks like a border as the bottom border", () => {
    const lines = ["", "───── ↓ 3 more ─────", BOTTOM_MARKER];
    expect(splitBaseRender(lines, 0, 0)?.contentLines).toEqual(["───── ↓ 3 more ─────"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boxBorder
// ─────────────────────────────────────────────────────────────────────────────

describe("boxBorder", () => {
  it("draws a plain border when nothing is hidden", () => {
    expect(boxBorder("╭", "╮", 10, "↑", 0)).toBe("╭────────╮");
  });

  it("centres the scroll label when lines are hidden", () => {
    const border = boxBorder("╰", "╯", 30, "↓", 3);
    expect(border).toHaveLength(30);
    expect(border).toContain(" ↓ 3 more ");
    const [before, after] = border.slice(1, -1).split(" ↓ 3 more ");
    expect(Math.abs(before.length - after.length)).toBeLessThanOrEqual(1);
  });

  it("drops the label when it does not fit", () => {
    expect(boxBorder("╭", "╮", 12, "↑", 3)).toBe("╭" + "─".repeat(10) + "╮");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wrapInBox
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapInBox", () => {
  it("wraps content in a rounded box of the full width", () => {
    const width = 20;
    const stripped = wrapInBox(frame(), width, bc, noColor).map(strip);

    expect(stripped).toHaveLength(3);
    expect(stripped[0]).toMatch(/^╭─+╮$/u);
    expect(stripped[1]).toMatch(/^│ /u);
    expect(stripped[1]).toContain(PROMPT);
    expect(stripped[1]).toContain("hello");
    expect(stripped[1]).toMatch(/ │$/u);
    expect(stripped[2]).toMatch(/^╰─+╯$/u);
    for (const line of stripped) {
      expect(visibleWidth(line)).toBe(width);
    }
  });

  it("shows the prompt on a blank line when there is no content", () => {
    const stripped = wrapInBox(frame({ contentLines: [] }), 20, bc, noColor).map(strip);
    expect(stripped).toHaveLength(3);
    expect(stripped[1]).toContain(PROMPT);
  });

  it("applies border color function to box characters", () => {
    const colorBc = (s: string) => `[C]${s}[/C]`;
    const result = wrapInBox(frame({ contentLines: ["text"] }), 20, colorBc, noColor);

    expect(result[0]).toMatch(/^\[C\]╭─+╮\[\/C\]$/u);
    expect(result.at(-1)).toMatch(/^\[C\]╰─+╯\[\/C\]$/u);
    expect(result[1]).toMatch(/^\[C\]│\[\/C\]/u);
    expect(result[1]).toMatch(/\[C\]│\[\/C\]$/u);
  });

  it("applies prompt color to the ❱ symbol", () => {
    const result = wrapInBox(frame({ contentLines: ["hi"] }), 20, bc, "\u001B[36m");
    expect(result[1]).toContain("\u001B[36m" + PROMPT);
  });

  it("uses continuation indent (no prompt) on subsequent lines", () => {
    const lines = ["line one", "line two", "line three"];
    const stripped = wrapInBox(frame({ contentLines: lines }), 30, bc, noColor).map(strip);

    expect(stripped[1]).toContain(PROMPT);
    expect(stripped[2]).not.toContain(PROMPT);
    expect(stripped[3]).not.toContain(PROMPT);
    const expectedIndent = "│" + " ".repeat(1 + PROMPT_WIDTH);
    expect(stripped[2].startsWith(expectedIndent)).toBe(true);
  });

  it("puts scroll indicators in the box borders", () => {
    const stripped = wrapInBox(frame({ hiddenAbove: 2, hiddenBelow: 5 }), 40, bc, noColor).map(
      strip,
    );
    expect(stripped[0]).toContain("↑ 2 more");
    expect(stripped.at(-1)).toContain("↓ 5 more");
    expect(visibleWidth(stripped[0])).toBe(40);
    expect(visibleWidth(stripped.at(-1) ?? "")).toBe(40);
  });

  it("keeps autocomplete items after the box, padded to the full width", () => {
    const width = 20;
    const result = wrapInBox(
      frame({ autocompleteLines: ["autocomplete-1", "autocomplete-2"] }),
      width,
      bc,
      noColor,
    );

    expect(result.at(-2)).toBe("autocomplete-1".padEnd(width));
    expect(result.at(-1)).toBe("autocomplete-2".padEnd(width));
    expect(strip(result.at(-3) ?? "")).toMatch(/^╰─+╯$/u);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toBaseMouseEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("toBaseMouseEvent", () => {
  it("shifts text rows left past the gutter", () => {
    const mapped = toBaseMouseEvent(mouse({ x: LEFT_GUTTER + 3, y: 1 }), 2);
    expect(mapped.x).toBe(3);
  });

  it("clamps clicks in the gutter to column 0", () => {
    expect(toBaseMouseEvent(mouse({ x: 1, y: 1 }), 1).x).toBe(0);
  });

  it("leaves rows outside the text area unshifted", () => {
    expect(toBaseMouseEvent(mouse({ x: 5, y: 0 }), 2).x).toBe(5);
    expect(toBaseMouseEvent(mouse({ x: 5, y: 4 }), 2).x).toBe(5);
  });

  it("reports the content width the base editor rendered at", () => {
    expect(toBaseMouseEvent(mouse({ width: 40 }), 1).width).toBe(40 - LINE_OVERHEAD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PureEditor
// ─────────────────────────────────────────────────────────────────────────────

describe("PureEditor", () => {
  it("renders typed text inside the box", () => {
    const editor = makeEditor();
    editor.setText("hello world");
    const stripped = editor.render(40).map(strip);

    expect(stripped).toHaveLength(3);
    expect(stripped[0]).toMatch(/^╭─+╮$/u);
    expect(stripped[1].startsWith(`│ ${PROMPT} hello world`)).toBe(true);
    expect(stripped[2]).toMatch(/^╰─+╯$/u);
    for (const line of stripped) {
      expect(visibleWidth(line)).toBe(40);
    }
  });

  it("keeps padding at 0 when pi applies the user's editorPaddingX", () => {
    const editor = makeEditor();
    editor.setPaddingX(3);
    expect(editor.getPaddingX()).toBe(0);
    editor.setText("x");
    expect(strip(editor.render(40)[1]).startsWith(`│ ${PROMPT} x`)).toBe(true);
  });

  it("shows hidden-line counts in the box borders when scrolled", () => {
    // 10 terminal rows → the base editor shows at most 5 text lines.
    const editor = makeEditor(10);
    editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    const stripped = editor.render(40).map(strip);

    expect(stripped).toHaveLength(7);
    expect(stripped[0]).toContain("↑ 7 more");
    expect(stripped.at(-1)).toMatch(/^╰─+╯$/u);
  });

  it("falls back to the base editor below the minimum box width", () => {
    const editor = makeEditor();
    editor.setText("hi");
    const stripped = editor.render(MIN_BOX_WIDTH - 1).map(strip);
    expect(stripped[0]).toMatch(/^─+$/u);
    expect(stripped.join("\n")).not.toContain("╭");
  });

  it("places the cursor at the clicked text column", () => {
    const editor = makeEditor();
    editor.setText("hello world");
    editor.render(40);

    const result = editor.handleMouse(mouse({ x: LEFT_GUTTER + 6, y: 1, width: 40, height: 3 }));

    expect(result?.handled).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("pure-editor extension", () => {
  it("installs a PureEditor on session_start", async () => {
    const h = createHarness();
    pureEditor(h.api);
    await h.fireEvent("session_start");

    const editor = h.editor();
    expect(editor).toBeInstanceOf(PureEditor);
    expect(strip(editor.render(30)[0])).toMatch(/^╭─+╮$/u);
  });
});
