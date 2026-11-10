/**
 * RFC 2119: uppercase requirement keywords in user messages.
 *
 * Changes lowercase and mixed-case RFC 2119 keywords to uppercase, so the
 * model gives them their RFC 2119 weight:
 *
 *   "you must not do X"  ->  "you MUST NOT do X"
 *   "this should work"   ->  "this SHOULD work"
 *
 * Literal text is left unchanged: fenced code blocks, inline code, and words
 * that are part of a path, URL, identifier, or hyphenated word.
 *
 * Usage: pi -e extensions/rfc2119.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The ten RFC 2119 keywords, plus "NEVER" (not in the RFC; a stronger
// "MUST NOT"). Multi-word keywords come first so that "MUST NOT" matches
// before "MUST".
const KEYWORDS = [
  "MUST NOT",
  "SHALL NOT",
  "SHOULD NOT",
  "NOT RECOMMENDED",
  "MUST",
  "SHALL",
  "SHOULD",
  "REQUIRED",
  "RECOMMENDED",
  "MAY",
  "OPTIONAL",
  "NEVER",
] as const;

// A keyword is a whole word that is not part of a path, URL, identifier, or
// hyphenated word. Sentence punctuation after it ("required.", "must,") is
// allowed, but a dot followed by a word character ("must.ts") is not.
const BEFORE_WORD = String.raw`(?<![\p{L}\p{N}_./\\:=@#$-])`;
const AFTER_WORD = String.raw`(?![\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}_])`;
const KEYWORD = `${BEFORE_WORD}(?<keyword>${KEYWORDS.map((k) => k.replaceAll(" ", String.raw`\s+`)).join("|")})${AFTER_WORD}`;

// A fenced code block runs to its closing fence, or to the end of the text.
const FENCED_CODE = String.raw`(?<=^|\n)[ ]{0,3}(?<fence>\x60{3,}|~{3,})[\s\S]*?(?:\n[ ]{0,3}\k<fence>[\x60~]*[ \t]*(?=\n|$)|$)`;
// Inline code opens with a whole backtick run and closes with a run of the
// same length in the same paragraph. Matching whole runs only, and stopping
// at a blank line, keeps unclosed runs from making the search slow.
const INLINE_CODE = String.raw`(?<!\x60)(?<ticks>\x60+)(?!\x60)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!\x60)\k<ticks>(?!\x60)`;

// One pass: code spans match first and are kept as they are.
const RFC2119_RE = new RegExp(`${FENCED_CODE}|${INLINE_CODE}|${KEYWORD}`, "giu");

/** Uppercase the RFC 2119 keywords in `text`, outside code spans. */
export function applyRfc2119(text: string): string {
  return text.replaceAll(RFC2119_RE, (match: string, ...args: unknown[]) => {
    const groups = args.at(-1) as { keyword?: string };
    return groups.keyword === undefined ? match : match.toUpperCase();
  });
}

export default function rfc2119(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    // Leave messages that other extensions send unchanged.
    if (event.source === "extension") {
      return;
    }
    const text = applyRfc2119(event.text);
    // Images are kept when the result does not set them.
    return text === event.text ? undefined : { action: "transform", text };
  });
}
