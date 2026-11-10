import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ExtensionToolContext,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import applyPatch, {
  type FileContent,
  type PathInfo,
  operationPaths,
  parsePatch,
  planPatch,
} from "../extensions/apply-patch.js";
import { createHarness, stubTheme } from "./harness.js";

const CWD = "/work";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** A patch with the given lines between the begin and end markers. */
function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

/**
 * Plan a patch against in-memory files (relative path -> content) and
 * symbolic links (relative link path -> relative target path).
 */
function plan(
  text: string,
  files: Record<string, FileContent> = {},
  links: Record<string, string> = {},
) {
  const operations = parsePatch(text);
  const paths = new Map<string, PathInfo>();
  const contents = new Map<string, FileContent>();
  for (const location of operationPaths(operations, CWD)) {
    const link = links[path.relative(CWD, location)];
    const target = link === undefined ? location : path.join(CWD, link);
    paths.set(location, { location, target });
    contents.set(target, files[path.relative(CWD, target)] ?? null);
    if (link !== undefined) {
      contents.set(location, null);
    }
  }
  return planPatch(operations, CWD, { paths, contents });
}

/** The planned content of a file: null to delete it, undefined when unchanged. */
function planned(result: ReturnType<typeof plan>, file: string): FileContent | undefined {
  return result.writes.get(path.join(CWD, file));
}

describe("parsePatch", () => {
  it("parses add, delete, update, and move operations", () => {
    const ops = parsePatch(
      patch(
        "*** Add File: new.txt",
        "+hello",
        "*** Delete File: old.txt",
        "*** Update File: a.txt",
        "*** Move to: b.txt",
        "@@ function foo() {",
        " keep",
        "-old",
        "+new",
      ),
    );
    expect(ops).toEqual([
      { kind: "add", path: "new.txt", contents: "hello\n" },
      { kind: "delete", path: "old.txt" },
      {
        kind: "update",
        path: "a.txt",
        moveTo: "b.txt",
        hunks: [
          {
            context: "function foo() {",
            oldLines: ["keep", "old"],
            newLines: ["keep", "new"],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  it("accepts a move without hunks", () => {
    expect(parsePatch(patch("*** Update File: a.txt", "*** Move to: b.txt"))).toEqual([
      { kind: "update", path: "a.txt", moveTo: "b.txt", hunks: [] },
    ]);
  });

  it("parses an empty Add File as an empty file", () => {
    expect(parsePatch(patch("*** Add File: empty.txt"))).toEqual([
      { kind: "add", path: "empty.txt", contents: "" },
    ]);
  });

  it("reads a blank line inside Add File content as an empty line", () => {
    const [op] = parsePatch(patch("*** Add File: a.txt", "+one", "", "+three"));
    expect(op).toEqual({ kind: "add", path: "a.txt", contents: "one\n\nthree\n" });
  });

  it("ignores blank lines after Add File content", () => {
    const ops = parsePatch(
      patch("*** Add File: a.txt", "+one", "", "", "*** Add File: b.txt", "+x"),
    );
    expect(ops.map((op) => op.kind === "add" && op.contents)).toEqual(["one\n", "x\n"]);
  });

  it("ignores blank lines after an update hunk", () => {
    const [op] = parsePatch(
      patch("*** Update File: a.txt", "@@", "-one", "+ONE", "", "", "*** Delete File: b.txt"),
    );
    expect(op.kind === "update" && op.hunks[0].oldLines).toEqual(["one"]);
  });

  it("reads an empty line inside a hunk as an empty context line", () => {
    const [op] = parsePatch(patch("*** Update File: a.txt", "@@", " one", "", "-two", "+TWO"));
    expect(op.kind === "update" && op.hunks[0]).toMatchObject({
      oldLines: ["one", "", "two"],
      newLines: ["one", "", "TWO"],
    });
  });

  it("ignores a unified diff range header", () => {
    const [op] = parsePatch(patch("*** Update File: a.txt", "@@ -1,3 +1,3 @@", "-one", "+ONE"));
    expect(op.kind === "update" && op.hunks[0].context).toBeUndefined();
  });

  it("parses several hunks and an End of File marker", () => {
    const [op] = parsePatch(
      patch("*** Update File: a.txt", "@@", "-a", "+A", "@@ x", "-b", "+B", "*** End of File"),
    );
    expect(op.kind === "update" && op.hunks.map((h) => [h.context, h.isEndOfFile])).toEqual([
      [undefined, false],
      ["x", true],
    ]);
  });

  it("accepts CRLF line endings and surrounding whitespace in the patch", () => {
    const ops = parsePatch(
      `\n  ${patch("*** Add File: a.txt", "+x").replaceAll("\n", "\r\n")}\n\n`,
    );
    expect(ops).toEqual([{ kind: "add", path: "a.txt", contents: "x\n" }]);
  });

  it.each([
    ["no begin marker", "*** Add File: a.txt\n+x\n*** End Patch", "expected '*** Begin Patch'"],
    ["no end marker", "*** Begin Patch\n*** Add File: a.txt\n+x", "expected '*** End Patch'"],
    ["only the begin marker", "*** Begin Patch", "expected '*** End Patch'"],
    ["no operations", patch(), "contains no file operations"],
    ["an unknown header", patch("*** Rename File: a.txt"), "is not a file operation"],
    ["an add line without '+'", patch("*** Add File: a.txt", "x"), "must start with '+'"],
    ["an update without hunks", patch("*** Update File: a.txt"), "has no hunks"],
    [
      "a hunk line without a marker",
      patch("*** Update File: a.txt", "@@", "x"),
      "must start with ' ', '-', or '+'",
    ],
    [
      "a second hunk without '@@'",
      patch("*** Update File: a.txt", "@@", "-a", "+b", "*** End of File", "-c"),
      "expected an '@@' line",
    ],
    [
      "End of File with no lines",
      patch("*** Update File: a.txt", "@@", "*** End of File"),
      "no lines before '*** End of File'",
    ],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parsePatch(text)).toThrow(message);
  });
});

describe("planPatch", () => {
  it("adds a file", () => {
    const result = plan(patch("*** Add File: a.txt", "+hello"));
    expect(planned(result, "a.txt")).toBe("hello\n");
    expect(result.summary).toEqual(["Added a.txt"]);
  });

  it("replaces an existing file and says so", () => {
    const result = plan(patch("*** Add File: a.txt", "+new"), { "a.txt": "old\n" });
    expect(planned(result, "a.txt")).toBe("new\n");
    expect(result.summary).toEqual(["Replaced a.txt"]);
  });

  it("deletes a file", () => {
    const result = plan(patch("*** Delete File: a.txt"), { "a.txt": "x\n" });
    expect(planned(result, "a.txt")).toBeNull();
    expect(result.summary).toEqual(["Deleted a.txt"]);
  });

  it.each([
    ["delete", patch("*** Delete File: a.txt")],
    ["update", patch("*** Update File: a.txt", "@@", "-x", "+y")],
    ["move", patch("*** Update File: a.txt", "*** Move to: b.txt")],
  ])("fails to %s a file that does not exist", (_kind, text) => {
    expect(() => plan(text)).toThrow("a.txt: the file does not exist");
  });

  it("updates a file", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", " one", "-two", "+TWO", " three"), {
      "a.txt": "one\ntwo\nthree\n",
    });
    expect(planned(result, "a.txt")).toBe("one\nTWO\nthree\n");
    expect(result.summary).toEqual(["Updated a.txt"]);
    expect(result.diffs).toEqual([{ path: "a.txt", diff: expect.stringContaining("+2 TWO") }]);
  });

  it("keeps CRLF line endings, also for new lines", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", " one", "-two", "+TWO", "+extra"), {
      "a.txt": "one\r\ntwo\r\nthree\r\n",
    });
    expect(planned(result, "a.txt")).toBe("one\r\nTWO\r\nextra\r\nthree\r\n");
  });

  it("keeps the line ending of each unchanged line", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-two", "+TWO"), {
      "a.txt": "one\r\ntwo\nthree\r\n",
    });
    expect(planned(result, "a.txt")).toBe("one\r\nTWO\nthree\r\n");
  });

  it("gives appended lines the line ending of the file", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "+four"), {
      "a.txt": "one\r\nthree\r\n",
    });
    expect(planned(result, "a.txt")).toBe("one\r\nthree\r\nfour\r\n");
  });

  it("keeps a byte order mark when the first line changes", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-one", "+ONE"), {
      "a.txt": "\uFEFFone\ntwo\n",
    });
    expect(planned(result, "a.txt")).toBe("\uFEFFONE\ntwo\n");
  });

  it("adds a final line ending to a file without one", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-one", "+ONE"), {
      "a.txt": "one\r\ntwo",
    });
    expect(planned(result, "a.txt")).toBe("ONE\r\ntwo\r\n");
  });

  it("updates file contents read as bytes", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-é", "+e"), {
      "a.txt": Buffer.from("é\n"),
    });
    expect(planned(result, "a.txt")).toBe("e\n");
  });

  it.each([
    ["trailing whitespace", "value = 1;   ", "value = 1;"],
    ["indentation", "    value = 1;", "value = 1;"],
    ["Unicode punctuation", "say “hi” – now", 'say "hi" - now'],
  ])("matches lines that differ in %s", (_name, fileLine, patchLine) => {
    const result = plan(patch("*** Update File: a.txt", "@@", `-${patchLine}`, "+changed"), {
      "a.txt": `first\n${fileLine}\n`,
    });
    expect(planned(result, "a.txt")).toBe("first\nchanged\n");
  });

  it("prefers an exact match to an earlier fuzzy match", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-x", "+X"), {
      "a.txt": "  x\nx\n",
    });
    expect(planned(result, "a.txt")).toBe("  x\nX\n");
  });

  it("finds the lines after the @@ context line", () => {
    const result = plan(
      patch("*** Update File: a.txt", "@@ function b() {", "-  return 1;", "+  return 2;"),
      {
        "a.txt": "function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n",
      },
    );
    expect(planned(result, "a.txt")).toBe(
      "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n",
    );
  });

  it("inserts lines after the @@ context line", () => {
    const result = plan(patch("*** Update File: a.txt", "@@ two", "+inserted"), {
      "a.txt": "one\ntwo\nthree\n",
    });
    expect(planned(result, "a.txt")).toBe("one\ntwo\ninserted\nthree\n");
  });

  it("appends lines when a hunk has only added lines and no context", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "+three"), { "a.txt": "one\n" });
    expect(planned(result, "a.txt")).toBe("one\nthree\n");
  });

  it("anchors an End of File hunk to the end of the file", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-x", "+X", "*** End of File"), {
      "a.txt": "x\ny\nx\n",
    });
    expect(planned(result, "a.txt")).toBe("x\ny\nX\n");
  });

  it("applies several hunks in one file", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-a", "+A", "@@", "-c", "+C"), {
      "a.txt": "a\nb\nc\n",
    });
    expect(planned(result, "a.txt")).toBe("A\nb\nC\n");
  });

  it("drops a trailing empty context line that does not match", () => {
    const result = plan(patch("*** Update File: a.txt", "@@", "-two", "+TWO", " "), {
      "a.txt": "one\ntwo\n",
    });
    expect(planned(result, "a.txt")).toBe("one\nTWO\n");
  });

  it("rejects overlapping hunks", () => {
    // An End of File hunk searches only the end, even before an earlier hunk.
    expect(() =>
      plan(
        patch(
          "*** Update File: a.txt",
          "@@",
          "-a",
          "-b",
          "+X",
          "@@",
          "-b",
          "+Y",
          "*** End of File",
        ),
        {
          "a.txt": "a\nb\n",
        },
      ),
    ).toThrow("Overlapping hunks: lines 1-2 overlap the hunk at line 2");
  });

  it("reports lines that it cannot find", () => {
    expect(() =>
      plan(patch("*** Update File: a.txt", "@@", "-missing", "+x"), { "a.txt": "one\n" }),
    ).toThrow("Failed to find expected lines in a.txt:\nmissing");
  });

  it("reports a context line that it cannot find", () => {
    expect(() =>
      plan(patch("*** Update File: a.txt", "@@ nope", "-one", "+x"), { "a.txt": "one\n" }),
    ).toThrow("Failed to find context 'nope' in a.txt");
  });

  it("moves a file and changes it", () => {
    const result = plan(
      patch("*** Update File: a.txt", "*** Move to: dir/b.txt", "@@", "-one", "+ONE"),
      { "a.txt": "one\n" },
    );
    expect(planned(result, "a.txt")).toBeNull();
    expect(planned(result, "dir/b.txt")).toBe("ONE\n");
    expect(result.summary).toEqual(["Updated and moved a.txt to dir/b.txt"]);
    expect(result.diffs.map((d) => d.path)).toEqual(["dir/b.txt"]);
  });

  it("moves a file without hunks and keeps its bytes", () => {
    const bytes = Uint8Array.from([0, 255, 1]);
    const result = plan(patch("*** Update File: a.bin", "*** Move to: b.bin"), { "a.bin": bytes });
    expect(planned(result, "b.bin")).toBe(bytes);
    expect(result.summary).toEqual(["Moved a.bin to b.bin"]);
  });

  it("says when a move replaces an existing file", () => {
    const result = plan(patch("*** Update File: a.txt", "*** Move to: b.txt"), {
      "a.txt": "a\n",
      "b.txt": "b\n",
    });
    expect(result.summary).toEqual(["Moved a.txt to b.txt (replaced the existing b.txt)"]);
  });

  it("applies operations in order", () => {
    const result = plan(
      patch("*** Add File: a.txt", "+one", "*** Update File: a.txt", "@@", "-one", "+two"),
    );
    expect(planned(result, "a.txt")).toBe("two\n");
  });

  describe("with symbolic links", () => {
    const links = { "link.txt": "real.txt" };

    it("updates the target of a link", () => {
      const result = plan(
        patch("*** Update File: link.txt", "@@", "-one", "+ONE"),
        { "real.txt": "one\n" },
        links,
      );
      expect([...result.writes]).toEqual([[path.join(CWD, "real.txt"), "ONE\n"]]);
      expect(result.removedLinks).toEqual([]);
      expect(result.summary).toEqual(["Updated link.txt"]);
    });

    it("applies changes through a link and the real path to the same content", () => {
      const result = plan(
        patch(
          "*** Update File: link.txt",
          "@@",
          "-one",
          "+ONE",
          "*** Update File: real.txt",
          "@@",
          "-two",
          "+TWO",
        ),
        { "real.txt": "one\ntwo\n" },
        links,
      );
      expect([...result.writes]).toEqual([[path.join(CWD, "real.txt"), "ONE\nTWO\n"]]);
    });

    it("replaces the target of a link with Add File", () => {
      const result = plan(patch("*** Add File: link.txt", "+new"), { "real.txt": "old\n" }, links);
      expect(planned(result, "real.txt")).toBe("new\n");
      expect(result.summary).toEqual(["Replaced link.txt"]);
    });

    it("deletes the link and keeps its target", () => {
      const result = plan(patch("*** Delete File: link.txt"), { "real.txt": "x\n" }, links);
      expect(result.removedLinks).toEqual([path.join(CWD, "link.txt")]);
      expect(result.writes.size).toBe(0);
      expect(result.summary).toEqual(["Deleted the symbolic link link.txt"]);
    });

    it("fails to delete a broken link", () => {
      expect(() => plan(patch("*** Delete File: link.txt"), {}, links)).toThrow(
        "link.txt: the file does not exist",
      );
    });

    it("moves the content of a link and removes the link", () => {
      const result = plan(
        patch("*** Update File: link.txt", "*** Move to: moved.txt", "@@", "-x", "+X"),
        { "real.txt": "x\n" },
        links,
      );
      expect(result.removedLinks).toEqual([path.join(CWD, "link.txt")]);
      expect([...result.writes]).toEqual([[path.join(CWD, "moved.txt"), "X\n"]]);
      expect(result.summary).toEqual([
        "Updated and moved link.txt to moved.txt (removed the symbolic link link.txt; its target is kept)",
      ]);
    });

    it("writes into the target of a link that is the destination of a move", () => {
      const result = plan(
        patch("*** Update File: a.txt", "*** Move to: link.txt"),
        { "a.txt": "a\n", "real.txt": "r\n" },
        links,
      );
      expect(planned(result, "a.txt")).toBeNull();
      expect(planned(result, "real.txt")).toBe("a\n");
      expect(result.summary).toEqual(["Moved a.txt to link.txt (replaced the existing link.txt)"]);
    });

    it("adds a new file in the place of a deleted link", () => {
      const result = plan(
        patch("*** Delete File: link.txt", "*** Add File: link.txt", "+new"),
        { "real.txt": "x\n" },
        links,
      );
      expect(result.removedLinks).toEqual([path.join(CWD, "link.txt")]);
      expect([...result.writes]).toEqual([[path.join(CWD, "link.txt"), "new\n"]]);
      expect(result.summary).toEqual(["Deleted the symbolic link link.txt", "Added link.txt"]);
    });
  });

  it("strips a leading @ from paths", () => {
    const result = plan(patch("*** Add File: @a.txt", "+x"));
    expect(planned(result, "a.txt")).toBe("x\n");
  });
});

// ---------------------------------------------------------------------------
// The tool, on a real file system
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-pure-apply-patch-"));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }),
  );
  return dir;
}

function tool(): ToolDefinition {
  const h = createHarness();
  applyPatch(h.api);
  const registered = h.tools.get("apply_patch");
  if (!registered) {
    throw new Error("apply_patch was not registered");
  }
  return registered;
}

function run(cwd: string, text: string, signal?: AbortSignal) {
  return tool().execute("call-1", { patch: text }, signal, undefined, {
    cwd,
  } as ExtensionToolContext);
}

const read = (cwd: string, file: string) => readFile(path.join(cwd, file), "utf-8");

describe("apply_patch tool", () => {
  it("applies a patch to several files and reports each operation", async () => {
    const cwd = await workspace({ "a.txt": "one\n", "old.txt": "x\n", "m.txt": "m\n" });
    const result = await run(
      cwd,
      patch(
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Add File: nested/new.txt",
        "+new",
        "*** Delete File: old.txt",
        "*** Update File: m.txt",
        "*** Move to: moved/m.txt",
      ),
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Applied the patch:\n1. Updated a.txt\n2. Added nested/new.txt\n3. Deleted old.txt\n4. Moved m.txt to moved/m.txt",
      },
    ]);
    expect(await read(cwd, "a.txt")).toBe("ONE\n");
    expect(await read(cwd, "nested/new.txt")).toBe("new\n");
    expect(await read(cwd, "moved/m.txt")).toBe("m\n");
    expect((await readdir(cwd)).toSorted()).toEqual(["a.txt", "moved", "nested"]);
  });

  it("changes no file when one operation fails", async () => {
    const cwd = await workspace({ "a.txt": "one\n" });
    await expect(
      run(
        cwd,
        patch("*** Update File: a.txt", "@@", "-one", "+ONE", "*** Delete File: missing.txt"),
      ),
    ).rejects.toThrow("missing.txt: the file does not exist");
    expect(await read(cwd, "a.txt")).toBe("one\n");
  });

  it("keeps the bytes of a moved binary file", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0xff, 0x00, 0xc3]);
    const cwd = await workspace({ "a.bin": bytes });
    await run(cwd, patch("*** Update File: a.bin", "*** Move to: b.bin"));
    expect(new Uint8Array(await readFile(path.join(cwd, "b.bin")))).toEqual(bytes);
  });

  it("keeps both changes when two patches change one file at the same time", async () => {
    const cwd = await workspace({ "a.txt": "one\ntwo\nthree\n" });
    await Promise.all([
      run(cwd, patch("*** Update File: a.txt", "@@", "-one", "+ONE")),
      run(cwd, patch("*** Update File: a.txt", "@@", "-three", "+THREE")),
    ]);
    expect(await read(cwd, "a.txt")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("does not deadlock when two patches lock the same files in a different order", async () => {
    const cwd = await workspace({ "a.txt": "a\n", "b.txt": "b\n" });
    await Promise.all([
      run(cwd, patch("*** Update File: a.txt", "@@", "+a1", "*** Update File: b.txt", "@@", "+b1")),
      run(cwd, patch("*** Update File: b.txt", "@@", "+b2", "*** Update File: a.txt", "@@", "+a2")),
    ]);
    expect(await read(cwd, "a.txt")).toBe("a\na1\na2\n");
    expect(await read(cwd, "b.txt")).toBe("b\nb1\nb2\n");
  });

  it("changes nothing when the call is already aborted", async () => {
    const cwd = await workspace({ "a.txt": "one\n" });
    await expect(
      run(cwd, patch("*** Update File: a.txt", "@@", "-one", "+ONE"), AbortSignal.abort()),
    ).rejects.toThrow("Operation aborted");
    expect(await read(cwd, "a.txt")).toBe("one\n");
  });

  it("rejects a patch with a syntax error before it reads files", async () => {
    const cwd = await workspace();
    await expect(run(cwd, "not a patch")).rejects.toThrow("Parse error at line 1");
  });
});

const ANSI = /\u001B\[[0-9;]*m/gu;

describe("apply_patch tool with symbolic links", () => {
  const isLink = async (cwd: string, file: string) =>
    (await lstat(path.join(cwd, file))).isSymbolicLink();

  async function linkedWorkspace(): Promise<string> {
    const cwd = await workspace({ "real/a.txt": "one\ntwo\n" });
    await symlink("real", path.join(cwd, "dir-link"));
    await symlink("real/a.txt", path.join(cwd, "file-link.txt"));
    return cwd;
  }

  it("updates the target of a link and keeps the link", async () => {
    const cwd = await linkedWorkspace();
    await run(cwd, patch("*** Update File: file-link.txt", "@@", "-one", "+ONE"));
    expect(await read(cwd, "real/a.txt")).toBe("ONE\ntwo\n");
    expect(await isLink(cwd, "file-link.txt")).toBe(true);
  });

  it("applies changes through three paths to one file", async () => {
    const cwd = await linkedWorkspace();
    await run(
      cwd,
      patch(
        "*** Update File: file-link.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: dir-link/a.txt",
        "@@",
        "-two",
        "+TWO",
        "*** Update File: real/a.txt",
        "@@",
        "+three",
      ),
    );
    expect(await read(cwd, "real/a.txt")).toBe("ONE\nTWO\nthree\n");
  });

  it("treats a new file in a linked directory as the same file as its real path", async () => {
    const cwd = await linkedWorkspace();
    await run(
      cwd,
      patch(
        "*** Add File: dir-link/new.txt",
        "+new",
        "*** Update File: real/new.txt",
        "@@",
        "-new",
        "+NEW",
      ),
    );
    expect(await read(cwd, "real/new.txt")).toBe("NEW\n");
  });

  it("resolves a linked directory above a missing directory", async () => {
    const cwd = await linkedWorkspace();
    await run(
      cwd,
      patch(
        "*** Add File: dir-link/sub/new.txt",
        "+new",
        "*** Update File: real/sub/new.txt",
        "@@",
        "-new",
        "+NEW",
      ),
    );
    expect(await read(cwd, "real/sub/new.txt")).toBe("NEW\n");
  });

  it("keeps both changes when two patches change one file through different paths", async () => {
    const cwd = await linkedWorkspace();
    await Promise.all([
      run(cwd, patch("*** Update File: file-link.txt", "@@", "-one", "+ONE")),
      run(cwd, patch("*** Update File: dir-link/a.txt", "@@", "-two", "+TWO")),
    ]);
    expect(await read(cwd, "real/a.txt")).toBe("ONE\nTWO\n");
  });

  it("deletes a link and keeps its target", async () => {
    const cwd = await linkedWorkspace();
    await run(cwd, patch("*** Delete File: file-link.txt"));
    expect(await readdir(cwd)).not.toContain("file-link.txt");
    expect(await read(cwd, "real/a.txt")).toBe("one\ntwo\n");
  });

  it("moves a link: writes a regular file and keeps the target", async () => {
    const cwd = await linkedWorkspace();
    await run(
      cwd,
      patch("*** Update File: file-link.txt", "*** Move to: moved.txt", "@@", "-one", "+ONE"),
    );
    expect(await readdir(cwd)).not.toContain("file-link.txt");
    expect(await isLink(cwd, "moved.txt")).toBe(false);
    expect(await read(cwd, "moved.txt")).toBe("ONE\ntwo\n");
    expect(await read(cwd, "real/a.txt")).toBe("one\ntwo\n");
  });

  it("deletes a file through a linked directory", async () => {
    const cwd = await linkedWorkspace();
    await run(cwd, patch("*** Delete File: dir-link/a.txt"));
    expect(await readdir(path.join(cwd, "real"))).toEqual([]);
    expect(await isLink(cwd, "dir-link")).toBe(true);
  });

  it("replaces a deleted link with a regular file", async () => {
    const cwd = await linkedWorkspace();
    await run(cwd, patch("*** Delete File: file-link.txt", "*** Add File: file-link.txt", "+new"));
    expect(await isLink(cwd, "file-link.txt")).toBe(false);
    expect(await read(cwd, "file-link.txt")).toBe("new\n");
    expect(await read(cwd, "real/a.txt")).toBe("one\ntwo\n");
  });

  it("writes a new file through a broken link", async () => {
    const cwd = await workspace();
    await symlink("missing.txt", path.join(cwd, "broken.txt"));
    await run(cwd, patch("*** Add File: broken.txt", "+x"));
    expect(await read(cwd, "missing.txt")).toBe("x\n");
    expect(await isLink(cwd, "broken.txt")).toBe(true);
  });
});

describe("apply_patch rendering", () => {
  const theme = stubTheme();
  // pi's renderDiff colors lines with pi's own theme.
  beforeAll(() => initTheme("dark", false));
  function renderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
    return {
      lastComponent: undefined,
      isError: false,
      keyHint: (_key: string, description: string) => `ctrl+o ${description}`,
      ...overrides,
    } as ToolRenderContext;
  }

  it("lists the targets of the patch in the call line", () => {
    const text = patch(
      "*** Add File: a.txt",
      "+x",
      "*** Delete File: b.txt",
      "*** Update File: c.txt",
      "*** Move to: d.txt",
    );
    const component = tool().renderCall?.({ patch: text }, theme, renderContext());
    expect(component?.render(200)[0]?.trimEnd()).toBe(
      "apply_patch a.txt, b.txt (delete), c.txt → d.txt",
    );
  });

  it("shows the title only while the patch has no targets", () => {
    const component = tool().renderCall?.({}, theme, renderContext());
    expect(component?.render(200).map((l) => l.trimEnd())).toEqual(["apply_patch"]);
  });

  function renderResult(
    details: unknown,
    options: { expanded?: boolean; isPartial?: boolean } = {},
    context = renderContext(),
  ): string[] {
    const result = {
      content: [{ type: "text", text: "Applied the patch:\n1. Updated a.txt" }],
      details,
    };
    const component = tool().renderResult?.(
      result as never,
      { expanded: false, isPartial: false, ...options },
      theme,
      context,
    );
    return component?.render(200).map((l) => l.replaceAll(ANSI, "").trimEnd()) ?? [];
  }

  const longDiff = Array.from({ length: 30 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");

  it("shows the diff of each file, collapsed to a preview", () => {
    const lines = renderResult({ diffs: [{ path: "a.txt", diff: longDiff }] });
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("a.txt");
    expect(lines.at(-1)).toBe("... 11 more lines (ctrl+o to expand)");
  });

  it("shows the whole diff when expanded", () => {
    const lines = renderResult({ diffs: [{ path: "a.txt", diff: longDiff }] }, { expanded: true });
    expect(lines).toHaveLength(31);
  });

  it("shows the summary when there is no diff", () => {
    expect(renderResult({ diffs: [] })).toEqual(["Applied the patch:", "1. Updated a.txt"]);
  });

  it("shows a progress message while the patch runs", () => {
    expect(renderResult(undefined, { isPartial: true })).toEqual(["Applying patch..."]);
  });

  it("shows the error message of a failed call", () => {
    expect(renderResult(undefined, {}, renderContext({ isError: true }))).toEqual([
      "Applied the patch:",
      "1. Updated a.txt",
    ]);
  });
});
