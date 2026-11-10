/**
 * Minimal test harness for the pi-pure extensions.
 *
 * Provides a mock ExtensionAPI and ExtensionContext that capture event
 * handlers and the footer/editor factories the extensions install, so tests
 * can fire events and render the installed components without a real pi.
 *
 * Only the members these extensions use are implemented; the mocks are cast
 * to the full pi types.
 *
 * Usage:
 *   const h = createHarness();
 *   myExtension(h.api);
 *   await h.fireEvent("session_start", {}, h.ctx());
 *   const footer = h.footer();
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
  KeybindingsManager,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
type FooterFactory = Parameters<ExtensionUIContext["setFooter"]>[0];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Theme that passes strings through unmodified and emits no ANSI codes. */
export function stubTheme(): Theme {
  return {
    fg: (_token: string, s: string) => s,
    bold: (s: string) => s,
    getFgAnsi: () => "",
    getThinkingBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

/** Editor theme with no-op styling. */
export function stubEditorTheme(): EditorTheme {
  const id = (s: string) => s;
  return {
    borderColor: id,
    selectList: {
      selectedPrefix: id,
      selectedText: id,
      description: id,
      scrollInfo: id,
      noMatch: id,
    },
  };
}

/** TUI with a fixed terminal height; enough for Editor.render(). */
export function stubTui(rows = 40): TUI {
  return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

/** Keybindings stub; the tests do not send key input. */
export function stubKeybindings(): KeybindingsManager {
  return { matches: () => false } as unknown as KeybindingsManager;
}

interface SessionState {
  sessionId: string;
  leafId: string | null;
  entries: SessionEntry[];
  /** Entries on the current branch; defaults to all entries. */
  branch?: SessionEntry[];
}

export interface HarnessOptions {
  cwd?: string;
  model?: { name: string; reasoning?: boolean };
  sessionName?: string;
  thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  contextPercent?: number | null;
  gitBranch?: string | null;
  /** pi's effective settings, as `pi.getSettings()` returns them. */
  settings?: Record<string, unknown>;
  /** Extension status texts, as set with `ctx.ui.setStatus()`. */
  statuses?: Record<string, string>;
  session?: SessionState;
}

export function createHarness(opts: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const theme = stubTheme();
  const session: SessionState = opts.session ?? { sessionId: "s1", leafId: null, entries: [] };
  let footerFactory: FooterFactory;
  let editorFactory: EditorFactory | undefined;
  let gitBranchListener: (() => void) | undefined;
  let renderRequests = 0;
  const statuses = new Map(Object.entries(opts.statuses ?? {}));

  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    getSessionName: () => opts.sessionName,
    getThinkingLevel: () => opts.thinkingLevel ?? "off",
    getSettings: () => structuredClone(opts.settings ?? {}),
  } as unknown as ExtensionAPI;

  const ui = {
    theme,
    setFooter: (factory: FooterFactory) => {
      footerFactory = factory;
    },
    setEditorComponent: (factory: EditorFactory | undefined) => {
      editorFactory = factory;
    },
  } as unknown as ExtensionUIContext;

  const sessionManager = {
    getSessionId: () => session.sessionId,
    getLeafId: () => session.leafId,
    getEntries: () => [...session.entries],
    getBranch: () => [...(session.branch ?? session.entries)],
  };

  function ctx(): ExtensionContext {
    return {
      ui,
      hasUI: true,
      cwd: opts.cwd ?? "/home/user/project",
      sessionManager,
      model: opts.model,
      getContextUsage: () =>
        opts.contextPercent === undefined ? undefined : { percent: opts.contextPercent },
    } as unknown as ExtensionContext;
  }

  async function fireEvent(name: string, event: Record<string, unknown> = {}, c = ctx()) {
    const results: unknown[] = [];
    for (const fn of handlers.get(name) ?? []) {
      results.push(await fn({ type: name, ...event }, c));
    }
    return results;
  }

  /** Instantiate the footer installed by the extension. */
  function footer(): Component & { dispose?(): void } {
    if (!footerFactory) {
      throw new Error("no footer installed");
    }
    const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
    const footerData = {
      getGitBranch: () => opts.gitBranch ?? null,
      getExtensionStatuses: () => statuses,
      onBranchChange: (cb: () => void) => {
        gitBranchListener = cb;
        return () => {
          gitBranchListener = undefined;
        };
      },
    } as unknown as Parameters<NonNullable<FooterFactory>>[2];
    return footerFactory(tui, theme, footerData);
  }

  /** Instantiate the editor installed by the extension. */
  function editor(rows = 40) {
    if (!editorFactory) {
      throw new Error("no editor installed");
    }
    return editorFactory(stubTui(rows), stubEditorTheme(), stubKeybindings());
  }

  return {
    api,
    handlers,
    tools,
    session,
    ctx,
    fireEvent,
    footer,
    editor,
    /** Simulate a git branch change notification. */
    changeGitBranch: () => gitBranchListener?.(),
    /** Whether a git branch listener is currently subscribed. */
    hasGitBranchListener: () => gitBranchListener !== undefined,
    renderRequests: () => renderRequests,
    /** Extension status texts; change them to simulate `ctx.ui.setStatus()`. */
    statuses,
  };
}
