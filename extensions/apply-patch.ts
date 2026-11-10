/**
 * apply_patch: a tool that changes files with a patch in the OpenAI Codex
 * apply_patch format.
 *
 * - One patch can add, delete, update, and move many files.
 * - Update hunks find their lines with matching that gets looser in steps:
 *   exact, then without trailing whitespace, then trimmed, then with
 *   Unicode punctuation normalized.
 * - The tool computes the whole patch in memory before it writes a file, so
 *   a patch that fails leaves every file unchanged.
 * - Updated files keep their line endings and byte order mark.
 * - Paths are resolved through symbolic links, so two paths to one file
 *   change the same content. Deleting or moving a link removes the link.
 * - The tool uses pi's file mutation queue, so it does not race with edit,
 *   write, or other apply_patch calls on the same files.
 *
 * Usage: pi -e extensions/apply-patch.ts
 */

import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  renderDiff,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Patch format
// ---------------------------------------------------------------------------

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
// Models sometimes write a unified diff range ("@@ -1,3 +1,4 @@") where the
// format expects "@@" or "@@ <context line>".
const UNIFIED_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u;

export interface UpdateHunk {
  /** The text after "@@ ": a line that comes before the change. */
  context?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: UpdateHunk[] };

function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parseError(lineIndex: number, message: string): Error {
  return new Error(`Parse error at line ${lineIndex + 1}: ${message}`);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** The index of the next line that is not blank, or `end`. */
function skipBlankLines(lines: readonly string[], start: number, end: number): number {
  let i = start;
  while (i < end && isBlank(lines[i])) {
    i++;
  }
  return i;
}

/**
 * Parse the "+" lines of an Add File operation. A blank line is an empty
 * content line when more "+" lines follow it; otherwise it ends the content.
 */
function parseAddedContent(
  lines: readonly string[],
  start: number,
  end: number,
): { contents: string; next: number } {
  const content: string[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.startsWith("+")) {
      content.push(line.slice(1));
      i++;
    } else if (isBlank(line)) {
      const next = skipBlankLines(lines, i, end);
      if (next === end || !lines[next].startsWith("+")) {
        break;
      }
      for (; i < next; i++) {
        content.push("");
      }
    } else if (line.trim().startsWith("*** ")) {
      break;
    } else {
      throw parseError(i, `an Add File line must start with '+', got: '${line}'`);
    }
  }
  return { contents: content.length > 0 ? `${content.join("\n")}\n` : "", next: i };
}

function parseUpdateHunk(
  lines: readonly string[],
  start: number,
  end: number,
  allowMissingContext: boolean,
): { hunk: UpdateHunk; next: number } {
  let i = start;
  let context: string | undefined;
  const header = lines[i].trimEnd();

  if (header === "@@" || UNIFIED_RANGE.test(header)) {
    i++;
  } else if (header.startsWith("@@ ")) {
    context = header.slice(3);
    i++;
  } else if (!allowMissingContext) {
    throw parseError(i, `expected an '@@' line, got: '${lines[i]}'`);
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;

  while (i < end) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed === END_OF_FILE) {
      if (oldLines.length === 0 && newLines.length === 0) {
        throw parseError(i, `the hunk has no lines before '${END_OF_FILE}'`);
      }
      isEndOfFile = true;
      i++;
      break;
    }
    if (trimmed.startsWith("*** ")) {
      break;
    }
    const hasLines = oldLines.length > 0 || newLines.length > 0;
    if (hasLines && trimmed.startsWith("@@")) {
      break;
    }

    if (line === "") {
      // An empty line is an empty context line, unless only blank lines come
      // before the next file operation or the end of the patch.
      const next = skipBlankLines(lines, i, end);
      if (next === end || lines[next].trim().startsWith("*** ")) {
        i = next;
        break;
      }
      oldLines.push("");
      newLines.push("");
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (hasLines) {
      break;
    } else {
      throw parseError(i, `a hunk line must start with ' ', '-', or '+', got: '${line}'`);
    }
    i++;
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    throw parseError(i, "the update hunk has no lines");
  }
  return { hunk: { context, oldLines, newLines, isEndOfFile }, next: i };
}

/** Parse a patch into file operations. Throws on a syntax error. */
export function parsePatch(patchText: string): PatchOperation[] {
  const lines = normalizeToLF(patchText).trim().split("\n");
  const first = lines[0].trim();
  const last = lines.at(-1)?.trim();
  if (first !== BEGIN_PATCH) {
    throw parseError(0, `expected '${BEGIN_PATCH}', got: '${lines[0]}'`);
  }
  if (lines.length < 2 || last !== END_PATCH) {
    throw parseError(lines.length - 1, `expected '${END_PATCH}', got: '${lines.at(-1)}'`);
  }

  const end = lines.length - 1;
  const operations: PatchOperation[] = [];
  let i = skipBlankLines(lines, 1, end);

  while (i < end) {
    const line = lines[i].trim();

    if (line.startsWith(ADD_FILE)) {
      const added = parseAddedContent(lines, i + 1, end);
      operations.push({ kind: "add", path: line.slice(ADD_FILE.length), contents: added.contents });
      i = added.next;
    } else if (line.startsWith(DELETE_FILE)) {
      operations.push({ kind: "delete", path: line.slice(DELETE_FILE.length) });
      i++;
    } else if (line.startsWith(UPDATE_FILE)) {
      const filePath = line.slice(UPDATE_FILE.length);
      i++;
      let moveTo: string | undefined;
      if (i < end && lines[i].trim().startsWith(MOVE_TO)) {
        moveTo = lines[i].trim().slice(MOVE_TO.length);
        i++;
      }
      const hunks: UpdateHunk[] = [];
      for (i = skipBlankLines(lines, i, end); i < end; i = skipBlankLines(lines, i, end)) {
        if (lines[i].trim().startsWith("*** ")) {
          break;
        }
        const parsed = parseUpdateHunk(lines, i, end, hunks.length === 0);
        hunks.push(parsed.hunk);
        i = parsed.next;
      }
      if (hunks.length === 0 && moveTo === undefined) {
        throw new Error(`Parse error: the update of '${filePath}' has no hunks`);
      }
      operations.push({ kind: "update", path: filePath, moveTo, hunks });
    } else {
      throw parseError(
        i,
        `'${line}' is not a file operation. Expected '${ADD_FILE.trim()}', '${DELETE_FILE.trim()}', or '${UPDATE_FILE.trim()}'`,
      );
    }
    i = skipBlankLines(lines, i, end);
  }

  if (operations.length === 0) {
    throw new Error("The patch contains no file operations");
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Text files: lines with their own line endings
// ---------------------------------------------------------------------------

const BOM = "\uFEFF";

interface TextFile {
  bom: string;
  lines: string[];
  /** The line ending of each line: "\n", "\r\n", or "" for a last line without one. */
  endings: string[];
}

function decodeText(raw: string): TextFile {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const parts = raw.slice(bom.length).split(/(?<ending>\r\n|\n)/u);
  const lines: string[] = [];
  const endings: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    endings.push(parts[i + 1] ?? "");
  }
  // Text that ends with a line ending splits into a last empty part.
  if (lines.at(-1) === "" && endings.at(-1) === "") {
    lines.pop();
    endings.pop();
  }
  return { bom, lines, endings };
}

function defaultEnding(file: TextFile): string {
  return file.endings.find((ending) => ending !== "") ?? "\n";
}

/** Join the lines. Every line gets a line ending, the last line too. */
function encodeText(file: TextFile): string {
  const eol = defaultEnding(file);
  return file.bom + file.lines.map((line, i) => line + (file.endings[i] || eol)).join("");
}

/** The text with LF line endings and no byte order mark, for diffs. */
function displayText(file: TextFile): string {
  return file.lines.map((line) => `${line}\n`).join("");
}

// ---------------------------------------------------------------------------
// Hunk application
// ---------------------------------------------------------------------------

function normalizeForFuzzyMatch(line: string): string {
  return line
    .trim()
    .replaceAll(/[\u2010-\u2015\u2212]/gu, "-")
    .replaceAll(/[\u2018-\u201B]/gu, "'")
    .replaceAll(/[\u201C-\u201F]/gu, '"')
    .replaceAll(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

const MATCH_PASSES: ((a: string, b: string) => boolean)[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalizeForFuzzyMatch(a) === normalizeForFuzzyMatch(b),
];

/**
 * Find `pattern` in `lines` at or after `start`. Each pass searches the whole
 * range before the next, looser pass. With `atEnd`, only the end of the file
 * is searched.
 */
function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  atEnd: boolean,
): number | undefined {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return undefined;
  }
  const last = lines.length - pattern.length;
  const first = atEnd ? last : start;
  for (const equal of MATCH_PASSES) {
    for (let i = first; i <= last; i++) {
      if (pattern.every((line, p) => equal(lines[i + p], line))) {
        return i;
      }
    }
  }
  return undefined;
}

interface Replacement {
  start: number;
  oldLength: number;
  newLines: string[];
}

function findReplacements(
  lines: readonly string[],
  hunks: readonly UpdateHunk[],
  displayPath: string,
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const contextIndex = seekSequence(lines, [hunk.context], lineIndex, false);
      if (contextIndex === undefined) {
        throw new Error(`Failed to find context '${hunk.context}' in ${displayPath}`);
      }
      lineIndex = contextIndex;
    }

    if (hunk.oldLines.length === 0) {
      // A pure insertion goes after the context line, or at the end of the file.
      const start = hunk.context === undefined ? lines.length : lineIndex + 1;
      replacements.push({ start, oldLength: 0, newLines: hunk.newLines });
      lineIndex = start;
      continue;
    }

    let { oldLines, newLines } = hunk;
    let found = seekSequence(lines, oldLines, lineIndex, hunk.isEndOfFile);
    if (found === undefined && oldLines.at(-1) === "") {
      // A trailing empty context line is often a blank line at the end of the hunk.
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") {
        newLines = newLines.slice(0, -1);
      }
      found = seekSequence(lines, oldLines, lineIndex, hunk.isEndOfFile);
    }
    if (found === undefined) {
      throw new Error(
        `Failed to find expected lines in ${displayPath}:\n${hunk.oldLines.join("\n")}`,
      );
    }
    replacements.push({ start: found, oldLength: oldLines.length, newLines });
    lineIndex = found + oldLines.length;
  }
  return replacements;
}

/**
 * Apply the replacements. Unchanged lines keep their line endings; new lines
 * get the line ending of the line they replace or follow.
 */
function applyReplacements(file: TextFile, replacements: readonly Replacement[]): TextFile {
  // Stable sort: pure insertions at the same line stay in patch order.
  const sorted = replacements.toSorted((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    if (previous.oldLength > 0 && previous.start + previous.oldLength > sorted[i].start) {
      throw new Error(
        `Overlapping hunks: lines ${previous.start + 1}-${previous.start + previous.oldLength} overlap the hunk at line ${sorted[i].start + 1}`,
      );
    }
  }

  const eol = defaultEnding(file);
  const lines = [...file.lines];
  const endings = [...file.endings];
  // Splice from the end, so earlier indices stay valid.
  for (const { start, oldLength, newLines } of sorted.toReversed()) {
    const ending = file.endings[start] || file.endings[start - 1] || eol;
    lines.splice(start, oldLength, ...newLines);
    endings.splice(start, oldLength, ...newLines.map(() => ending));
  }
  return { bom: file.bom, lines, endings };
}

// ---------------------------------------------------------------------------
// Planning: compute every change in memory
// ---------------------------------------------------------------------------

/** File contents: bytes as read from disk, text as computed, or null for no file. */
export type FileContent = Uint8Array | string | null;

/** Where a patch path is on disk. */
export interface PathInfo {
  /** The real path of the directory entry: the real parent directory and the file name. */
  location: string;
  /** The real path of the file: the link target when the entry is a symbolic link, else `location`. */
  target: string;
}

/** The state of the file system that a patch starts from. */
export interface FileSnapshot {
  /** Where each path of `operationPaths` is. */
  paths: ReadonlyMap<string, PathInfo>;
  /** The content at each location and target in `paths`. A symbolic link's location has null. */
  contents: ReadonlyMap<string, FileContent>;
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface PatchPlan {
  /** The new content of each changed file, by real path. Null deletes the file. */
  writes: Map<string, FileContent>;
  /** The locations of the symbolic links that the patch deletes or moves. */
  removedLinks: string[];
  /** One line for each operation. */
  summary: string[];
  diffs: FileDiff[];
}

/** Resolve a patch path against `cwd`. Models sometimes add a leading "@". */
export function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim().replace(/^@/u, "");
  if (trimmed === "") {
    throw new Error("A patch path cannot be empty");
  }
  return path.resolve(cwd, trimmed);
}

/** The absolute paths of all files that the operations read or write. */
export function operationPaths(operations: readonly PatchOperation[], cwd: string): string[] {
  const paths = operations.flatMap((op) =>
    op.kind === "update" && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path],
  );
  return [...new Set(paths.map((p) => resolvePatchPath(cwd, p)))];
}

function asText(content: Uint8Array | string): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
}

/**
 * Apply the operations in order to the files in `snapshot`. Throws when an
 * operation cannot be applied; nothing is written.
 *
 * Paths are resolved to real paths, so two paths to one file change the same
 * content. Content changes go to the target of a symbolic link. Deleting or
 * moving a symbolic link removes the link and keeps its target, like rm and mv.
 */
export function planPatch(
  operations: readonly PatchOperation[],
  cwd: string,
  snapshot: FileSnapshot,
): PatchPlan {
  const files = new Map(snapshot.contents);
  const writes = new Map<string, FileContent>();
  const removedLinks: string[] = [];
  const summary: string[] = [];
  const diffs: FileDiff[] = [];

  const infoOf = (patchPath: string): PathInfo => {
    const info = snapshot.paths.get(resolvePatchPath(cwd, patchPath));
    if (info === undefined) {
      throw new Error(`Internal error: ${patchPath} was not located`);
    }
    return info;
  };
  const isLink = (info: PathInfo): boolean =>
    info.target !== info.location && !removedLinks.includes(info.location);
  /** The real path of the file that a patch path refers to now. */
  const fileOf = (info: PathInfo): string => (isLink(info) ? info.target : info.location);
  const contentOf = (file: string): FileContent => {
    const content = files.get(file);
    if (content === undefined) {
      throw new Error(`Internal error: ${file} was not read`);
    }
    return content;
  };
  const write = (file: string, content: FileContent): void => {
    files.set(file, content);
    writes.set(file, content);
  };
  /** Remove the directory entry of a path: the symbolic link, or else the file. */
  const remove = (info: PathInfo): void => {
    if (isLink(info)) {
      removedLinks.push(info.location);
    } else {
      write(info.location, null);
    }
  };

  for (const op of operations) {
    const source = infoOf(op.path);
    const file = fileOf(source);
    const current = contentOf(file);

    if (op.kind === "add") {
      const before = current === null ? "" : displayText(decodeText(asText(current)));
      write(file, op.contents);
      summary.push(current === null ? `Added ${op.path}` : `Replaced ${op.path}`);
      diffs.push({ path: op.path, diff: generateDiffString(before, op.contents).diff });
      continue;
    }

    if (current === null) {
      throw new Error(`Cannot ${op.kind} ${op.path}: the file does not exist`);
    }
    const sourceIsLink = isLink(source);

    if (op.kind === "delete") {
      remove(source);
      summary.push(sourceIsLink ? `Deleted the symbolic link ${op.path}` : `Deleted ${op.path}`);
      continue;
    }

    let updated: FileContent = current;
    if (op.hunks.length > 0) {
      const text = decodeText(asText(current));
      const next = applyReplacements(text, findReplacements(text.lines, op.hunks, op.path));
      updated = encodeText(next);
      diffs.push({
        path: op.moveTo ?? op.path,
        diff: generateDiffString(displayText(text), displayText(next)).diff,
      });
    }

    if (op.moveTo === undefined) {
      write(file, updated);
      summary.push(`Updated ${op.path}`);
      continue;
    }

    remove(source);
    const destination = fileOf(infoOf(op.moveTo));
    const replaced = destination !== file && contentOf(destination) !== null;
    write(destination, updated);
    const notes = [
      ...(sourceIsLink ? [`removed the symbolic link ${op.path}; its target is kept`] : []),
      ...(replaced ? [`replaced the existing ${op.moveTo}`] : []),
    ];
    const action = op.hunks.length > 0 ? "Updated and moved" : "Moved";
    summary.push(
      `${action} ${op.path} to ${op.moveTo}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
    );
  }

  return { writes, removedLinks, summary, diffs };
}

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real path, or for a missing path, the real path of its nearest existing parent and the rest. */
async function canonicalPath(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

async function isSymbolicLink(absolute: string): Promise<boolean> {
  try {
    const stats = await lstat(absolute);
    return stats.isSymbolicLink();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

/** Find the real location of a path and, for a symbolic link, the real target. */
export async function locatePath(absolute: string): Promise<PathInfo> {
  const parent = path.dirname(absolute);
  const location =
    parent === absolute
      ? absolute
      : path.join(await canonicalPath(parent), path.basename(absolute));
  if (!(await isSymbolicLink(location))) {
    return { location, target: location };
  }
  try {
    return { location, target: await realpath(location) };
  } catch (error) {
    // A broken link: writes go through the link, as with any other tool.
    if (isMissingFileError(error)) {
      return { location, target: location };
    }
    throw error;
  }
}

/** The key that pi's file mutation queue uses for a path. */
async function mutationQueueKey(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error) {
    if (isMissingFileError(error)) {
      return absolute;
    }
    throw error;
  }
}

/**
 * Run `fn` while holding pi's file mutation lock for every path. The locks
 * are taken in sorted order, so two patches cannot wait for each other.
 * Paths with the same queue key are locked once, because a second lock on
 * the same key would wait for the first forever.
 */
async function withFileLocks<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map(mutationQueueKey)))].toSorted();
  let locked = fn;
  for (const key of keys.toReversed()) {
    const inner = locked;
    locked = () => withFileMutationQueue(key, inner);
  }
  return locked();
}

async function readFileOrNull(absolute: string): Promise<Uint8Array | null> {
  try {
    return await readFile(absolute);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/** Read the content at each location and link target. */
async function readContents(
  paths: ReadonlyMap<string, PathInfo>,
): Promise<Map<string, FileContent>> {
  const entries = await Promise.all(
    [...paths.values()].flatMap(({ location, target }) =>
      location === target
        ? [(async () => [location, await readFileOrNull(location)] as const)()]
        : [
            (async () => [target, await readFileOrNull(target)] as const)(),
            Promise.resolve([location, null] as const),
          ],
    ),
  );
  return new Map(entries);
}

/** Remove the deleted links first, so a new file can take the place of a link. */
async function writePlan(plan: PatchPlan): Promise<void> {
  await Promise.all(plan.removedLinks.map((link) => rm(link, { force: true })));
  await Promise.all(
    [...plan.writes].map(async ([file, content]) => {
      if (content === null) {
        await rm(file, { force: true });
      } else {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const TOOL_INSTRUCTIONS = `apply_patch uses the following patch format:

\`\`\`
*** Begin Patch
[one or more file operations]
*** End Patch
\`\`\`

File operations:
- \`*** Add File: <path>\` — create a file; every following line starts with \`+\`. An existing file is replaced.
- \`*** Delete File: <path>\` — delete a file; no lines follow.
- \`*** Update File: <path>\` — change a file with hunks. Put \`*** Move to: <new path>\` on the next line to also rename it.

Update hunks:
\`\`\`
@@ optional context line
 context line (space prefix = unchanged)
-old line (removed)
+new line (added)
\`\`\`

Rules:
- Every line in a hunk must start with \` \` (space), \`-\`, or \`+\`
- Include 3 lines of context above and below each change
- Use \`@@\` with a class/function name when 3 lines of context isn't enough to uniquely locate the change
- The text after \`@@\` must be a complete line from the file, not a fragment
- Use \`*** End of File\` to anchor a hunk at the end of the file
- Paths are relative to the working directory`;

const PREVIEW_LINES = 20;

const applyPatchParameters = Type.Object({
  patch: Type.String({
    description: "The whole patch, from '*** Begin Patch' to '*** End Patch'.",
  }),
});

interface ApplyPatchDetails {
  diffs: FileDiff[];
}

/** The targets named in the file operation headers, for the call line. */
function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const raw of patch.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(ADD_FILE)) {
      targets.push(line.slice(ADD_FILE.length));
    } else if (line.startsWith(UPDATE_FILE)) {
      targets.push(line.slice(UPDATE_FILE.length));
    } else if (line.startsWith(DELETE_FILE)) {
      targets.push(`${line.slice(DELETE_FILE.length)} (delete)`);
    } else if (line.startsWith(MOVE_TO) && targets.length > 0) {
      targets.push(`${targets.pop()} → ${line.slice(MOVE_TO.length)}`);
    }
  }
  return targets;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export default function applyPatch(pi: ExtensionAPI): void {
  pi.registerTool<typeof applyPatchParameters, ApplyPatchDetails>({
    name: "apply_patch",
    label: "apply_patch",
    description: `Apply a patch to add, delete, update, or move files. One patch can change many files. ${TOOL_INSTRUCTIONS}`,
    promptSnippet:
      "Add, delete, update, or move files with a patch. Handles single and multi-file edits.",
    promptGuidelines: [
      "Use apply_patch to add, delete, or move files, and for edits that change several places or files",
      "Use the built-in edit tool for simple single-file text replacements where oldText/newText is straightforward",
      "Every line in an apply_patch hunk MUST start with ' ' (space), '-', or '+' — do not omit the leading space on context lines",
    ],
    parameters: applyPatchParameters,

    async execute(_toolCallId, { patch }, signal, _onUpdate, ctx) {
      const operations = parsePatch(patch);
      const paths = new Map(
        await Promise.all(
          operationPaths(operations, ctx.cwd).map(async (p) => [p, await locatePath(p)] as const),
        ),
      );
      // pi keys its lock by real path, but by the path as given for a missing
      // file. Lock all three forms, so a write to a new file through any of
      // them waits for this patch.
      const lockPaths = [...paths].flatMap(([p, { location, target }]) => [p, location, target]);

      return await withFileLocks(lockPaths, async () => {
        // Abort only between file system steps, never during a write.
        throwIfAborted(signal);
        const contents = await readContents(paths);
        throwIfAborted(signal);
        const plan = planPatch(operations, ctx.cwd, { paths, contents });
        await writePlan(plan);

        const summary = plan.summary.map((line, i) => `${i + 1}. ${line}`).join("\n");
        return {
          content: [{ type: "text", text: `Applied the patch:\n${summary}` }],
          details: { diffs: plan.diffs },
        };
      });
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const targets = typeof args.patch === "string" ? patchTargets(args.patch) : [];
      const title = theme.fg("toolTitle", theme.bold("apply_patch"));
      text.setText(
        targets.length > 0 ? `${title} ${theme.fg("accent", targets.join(", "))}` : title,
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
      }
      const first = result.content[0];
      const message = first?.type === "text" ? first.text : "";
      if (context.isError) {
        return new Text(theme.fg("error", message || "apply_patch failed"), 0, 0);
      }

      const lines = (result.details?.diffs ?? []).flatMap((file) =>
        file.diff === ""
          ? []
          : [theme.fg("accent", file.path), ...renderDiff(file.diff).split("\n")],
      );
      if (lines.length === 0) {
        return new Text(theme.fg("success", message), 0, 0);
      }
      if (!expanded && lines.length > PREVIEW_LINES) {
        const hidden = lines.length - PREVIEW_LINES;
        const hint = context.keyHint("app.tools.expand", "to expand");
        lines.splice(
          PREVIEW_LINES,
          hidden,
          theme.fg("muted", `... ${hidden} more lines (${hint})`),
        );
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
