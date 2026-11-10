/**
 * Pure Editor — Rounded box input editor with theme-aware border colors
 *
 * ╭─────────────────────────────────────────╮
 * │ ❱ input text here                       │
 * │   continuation lines                    │
 * ╰─────────────────────────────────────────╯
 *
 * - Border color follows thinking level (set by the framework via editor.borderColor)
 * - The ❱ prompt uses the borderAccent theme token
 * - Scroll indicators ("↑ 3 more") are drawn centred in the box borders
 * - Autocomplete items are preserved below the box
 *
 * Usage: pi -e extensions/pure-editor.ts
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

const RST = "\u001B[0m";

// Box drawing characters
const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const H = "─";
const V = "│";

/** Prompt symbol shown on the first content line */
export const PROMPT = "❱";

/** Width of the prompt plus its trailing space */
export const PROMPT_WIDTH = visibleWidth(PROMPT + " ");

/** Columns before the text on each content line: "│ " + prompt + " " */
export const LEFT_GUTTER = 2 + PROMPT_WIDTH;

/** Overhead per content line: left gutter + " │" */
export const LINE_OVERHEAD = LEFT_GUTTER + 2;

/** Below this width the box is dropped and the base editor renders as-is. */
export const MIN_BOX_WIDTH = 10;

/**
 * Line the subclass returns from renderBottomBorder while framing. The base
 * editor emits it verbatim, so its index separates content from autocomplete
 * lines without parsing the base editor's border format.
 */
export const BOTTOM_MARKER = "\u0000pure-editor:bottom-border\u0000";

/** The parts of a base editor render that the box is built from. */
export interface EditorFrame {
  /** Visible text lines, between the base editor's top and bottom borders. */
  contentLines: string[];
  /** Autocomplete list lines, after the base editor's bottom border. */
  autocompleteLines: string[];
  /** Lines scrolled out of view above the visible text. */
  hiddenAbove: number;
  /** Lines scrolled out of view below the visible text. */
  hiddenBelow: number;
}

/**
 * Split a base editor render into its frame parts.
 *
 * Expects line 0 to be the top border and one line to equal BOTTOM_MARKER.
 * Returns null when the marker is missing (the base render layout changed).
 */
export function splitBaseRender(
  lines: readonly string[],
  hiddenAbove: number,
  hiddenBelow: number,
): EditorFrame | null {
  const bottomIdx = lines.indexOf(BOTTOM_MARKER);
  if (bottomIdx < 1) {
    return null;
  }
  return {
    contentLines: lines.slice(1, bottomIdx),
    autocompleteLines: lines.slice(bottomIdx + 1),
    hiddenAbove,
    hiddenBelow,
  };
}

/**
 * Build one horizontal box border (without color) of total `width`.
 * A non-zero `hidden` count is shown as a centred " ↑ N more " label when it fits.
 */
export function boxBorder(
  left: string,
  right: string,
  width: number,
  arrow: "↑" | "↓",
  hidden: number,
): string {
  const innerW = Math.max(0, width - 2);
  const label = ` ${arrow} ${hidden} more `;
  const labelW = visibleWidth(label);
  if (hidden <= 0 || labelW + 2 > innerW) {
    return left + H.repeat(innerW) + right;
  }
  const before = Math.floor((innerW - labelW) / 2);
  return left + H.repeat(before) + label + H.repeat(innerW - before - labelW) + right;
}

/**
 * Wrap the parts of a base editor render in a rounded box with colored
 * borders and a prompt.
 *
 * @param frame     - Content, autocomplete and scroll state from the base render
 * @param width     - Total available width
 * @param bc        - Border color function (from editor.borderColor)
 * @param promptFg  - ANSI foreground code for the ❱ prompt
 * @returns Rendered lines with box frame
 */
export function wrapInBox(
  frame: EditorFrame,
  width: number,
  bc: (s: string) => string,
  promptFg: string,
): string[] {
  const contentWidth = Math.max(1, width - LINE_OVERHEAD);
  const prompt = promptFg + PROMPT + " " + RST;
  const indent = " ".repeat(PROMPT_WIDTH);
  const boxLine = (lead: string, text: string) => {
    const pad = Math.max(0, contentWidth - visibleWidth(text));
    return bc(V) + " " + lead + text + " ".repeat(pad) + " " + bc(V);
  };

  // An empty editor still renders one text line; keep the prompt visible regardless.
  const contentLines = frame.contentLines.length > 0 ? frame.contentLines : [""];

  return [
    bc(boxBorder(TL, TR, width, "↑", frame.hiddenAbove)),
    ...contentLines.map((line, i) => boxLine(i === 0 ? prompt : indent, line)),
    bc(boxBorder(BL, BR, width, "↓", frame.hiddenBelow)),
    // The base renders autocomplete at the content width; pad it to the full width.
    ...frame.autocompleteLines.map(
      (line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))),
    ),
  ];
}

/**
 * Map a mouse event on the boxed editor to the coordinates the base editor
 * expects. Text rows (1…contentRows) are shifted left past the gutter; every
 * row sees the content width the base editor rendered at.
 */
export function toBaseMouseEvent(event: TuiMouseEvent, contentRows: number): TuiMouseEvent {
  const isTextRow = event.y >= 1 && event.y <= contentRows;
  return {
    ...event,
    x: isTextRow ? Math.max(0, event.x - LEFT_GUTTER) : event.x,
    width: Math.max(1, event.width - LINE_OVERHEAD),
  };
}

export class PureEditor extends CustomEditor {
  /** Returns the ANSI foreground code for the prompt; read on every render to follow theme changes. */
  private readonly promptFg: () => string;
  /** True while render() is collecting a base render to frame. */
  private framing = false;
  private hiddenAbove = 0;
  private hiddenBelow = 0;
  /** Text rows in the last boxed render, or null when the last render was not boxed. */
  private boxedContentRows: number | null = null;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    promptFg: () => string,
  ) {
    super(tui, theme, keybindings);
    this.promptFg = promptFg;
    this.setPaddingX(0);
  }

  /**
   * The box supplies its own spacing. pi copies the user's editorPaddingX
   * setting onto custom editors, so padding is pinned to 0 here.
   */
  override setPaddingX(_padding: number): void {
    super.setPaddingX(0);
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.framing) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    this.hiddenAbove = hiddenLineCount;
    return "";
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (!this.framing) {
      return super.renderBottomBorder(width, hiddenLineCount);
    }
    this.hiddenBelow = hiddenLineCount;
    return BOTTOM_MARKER;
  }

  override render(width: number): string[] {
    this.boxedContentRows = null;
    if (width < MIN_BOX_WIDTH) {
      return super.render(width);
    }

    this.framing = true;
    let lines: string[];
    try {
      lines = super.render(Math.max(1, width - LINE_OVERHEAD));
    } finally {
      this.framing = false;
    }

    const frame = splitBaseRender(lines, this.hiddenAbove, this.hiddenBelow);
    if (!frame) {
      return super.render(width);
    }
    const boxed = wrapInBox(frame, width, this.borderColor, this.promptFg());
    this.boxedContentRows = boxed.length - 2 - frame.autocompleteLines.length;
    return boxed;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.boxedContentRows === null) {
      return super.handleMouse(event);
    }
    return super.handleMouse(toBaseMouseEvent(event, this.boxedContentRows));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new PureEditor(tui, theme, keybindings, () => ctx.ui.theme.getFgAnsi("borderAccent")),
    );
  });
}
