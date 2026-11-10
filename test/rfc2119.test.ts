import { describe, expect, it } from "vitest";

import rfc2119, { applyRfc2119 } from "../extensions/rfc2119.js";
import { createHarness } from "./harness.js";

describe("applyRfc2119", () => {
  // ── Basic uppercasing ──────────────────────────────────────────────────

  it("uppercases 'must'", () => {
    expect(applyRfc2119("you must not do this")).toBe("you MUST NOT do this");
  });

  it("uppercases all keywords including never", () => {
    const input =
      "must shall should required recommended may optional never must not shall not should not";
    const out = applyRfc2119(input);
    expect(out).toBe(
      "MUST SHALL SHOULD REQUIRED RECOMMENDED MAY OPTIONAL NEVER MUST NOT SHALL NOT SHOULD NOT",
    );
  });

  it("uppercases 'never'", () => {
    expect(applyRfc2119("you should never do this")).toBe("you SHOULD NEVER do this");
  });

  it("does not match 'never' inside 'nevertheless'", () => {
    expect(applyRfc2119("nevertheless it works")).toBe("nevertheless it works");
  });

  it("handles mixed case", () => {
    expect(applyRfc2119("You Must use HTTPS")).toBe("You MUST use HTTPS");
    expect(applyRfc2119("This Should Not happen")).toBe("This SHOULD NOT happen");
  });

  it("already-uppercase keywords are unchanged", () => {
    const s = "you MUST NOT skip this";
    expect(applyRfc2119(s)).toBe(s);
  });

  it("returns text unchanged when no keywords present", () => {
    const s = "just a normal sentence without any keywords";
    expect(applyRfc2119(s)).toBe(s);
  });

  it("handles empty string", () => {
    expect(applyRfc2119("")).toBe("");
  });

  // ── Word boundary: no false positives ─────────────────────────────────

  it("does not match 'may' inside 'maybe'", () => {
    expect(applyRfc2119("maybe this works")).toBe("maybe this works");
  });

  it("does not match 'must' inside 'mustard'", () => {
    expect(applyRfc2119("add mustard to the recipe")).toBe("add mustard to the recipe");
  });

  it("matches 'shall not' as one keyword", () => {
    expect(applyRfc2119("you shall not pass")).toBe("you SHALL NOT pass");
  });

  it("does not match 'optional' inside 'optionally'", () => {
    expect(applyRfc2119("optionally add sugar")).toBe("optionally add sugar");
  });

  it("does not match 'required' inside 'requirements'", () => {
    expect(applyRfc2119("check the requirements doc")).toBe("check the requirements doc");
  });

  it("does not match 'recommended' inside 'recommendations'", () => {
    expect(applyRfc2119("see recommendations")).toBe("see recommendations");
  });

  // ── Two-word keywords take priority over one-word ──────────────────────

  it("'must not' matches as a unit, not 'must' + 'not'", () => {
    const out = applyRfc2119("you must not proceed");
    expect(out).toBe("you MUST NOT proceed");
    // Ensure it's one contiguous MUST NOT, not MUST not
    expect(out).toContain("MUST NOT");
    expect(out).not.toContain("MUST not");
  });

  it("'should not' matches as a unit", () => {
    expect(applyRfc2119("this should not be ignored")).toBe("this SHOULD NOT be ignored");
  });

  it("'shall not' matches as a unit", () => {
    expect(applyRfc2119("it shall not be done")).toBe("it SHALL NOT be done");
  });

  // ── Real-world sentences ───────────────────────────────────────────────

  it("handles a realistic requirement sentence", () => {
    expect(applyRfc2119("the server must return a 200 status and should include a body")).toBe(
      "the server MUST return a 200 status and SHOULD include a body",
    );
  });

  it("handles multiple keywords in one message", () => {
    const input =
      "implementations must support TLS and should use TLS 1.3; older versions may be supported but are not recommended";
    const out = applyRfc2119(input);
    expect(out).toContain("MUST support");
    expect(out).toContain("SHOULD use");
    expect(out).toContain("MAY be supported");
    expect(out).toContain("NOT RECOMMENDED");
  });

  it("handles keyword at start of sentence", () => {
    expect(applyRfc2119("Must the server respond?")).toBe("MUST the server respond?");
  });

  it("handles keyword at end of sentence", () => {
    expect(applyRfc2119("this field is required")).toBe("this field is REQUIRED");
  });

  it("handles keyword next to punctuation", () => {
    expect(applyRfc2119("it is required, and must be present")).toBe(
      "it is REQUIRED, and MUST be present",
    );
  });

  // ── Spacing and RFC 2119 phrases ───────────────────────────────────────

  it("matches multi-word keywords across extra spaces and line breaks", () => {
    expect(applyRfc2119("you must  not do this")).toBe("you MUST  NOT do this");
    expect(applyRfc2119("you should\nnot do this")).toBe("you SHOULD\nNOT do this");
  });

  it("uppercases 'not recommended' as one keyword", () => {
    expect(applyRfc2119("this is not recommended")).toBe("this is NOT RECOMMENDED");
  });

  it("handles non-ASCII letters next to a keyword", () => {
    expect(applyRfc2119("mustée may")).toBe("mustée MAY");
  });

  // ── Literal text is left unchanged ─────────────────────────────────────

  it("leaves inline code unchanged", () => {
    expect(applyRfc2119("you must set `required: true` here")).toBe(
      "you MUST set `required: true` here",
    );
    expect(applyRfc2119("use ``a ` must`` and must")).toBe("use ``a ` must`` and MUST");
  });

  it("treats an unclosed backtick as plain text", () => {
    expect(applyRfc2119("a ` must stay")).toBe("a ` MUST stay");
  });

  it("ends unclosed inline code at a blank line", () => {
    expect(applyRfc2119("a ` b\n\nmust go ` here")).toBe("a ` b\n\nMUST go ` here");
  });

  it("stays fast with many unclosed backtick runs", () => {
    // Runs of different lengths never close. A regex that tries shorter runs
    // did not finish this input.
    const input = Array.from({ length: 300 }, (_, i) => `${"`".repeat(i + 1)} must `).join("");
    const start = performance.now();
    applyRfc2119(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("leaves fenced code blocks unchanged", () => {
    const input = "you must run:\n```ts\nif (opts.required) may();\n```\nit should pass";
    expect(applyRfc2119(input)).toBe(
      "you MUST run:\n```ts\nif (opts.required) may();\n```\nit SHOULD pass",
    );
  });

  it("leaves an unclosed fenced code block unchanged to the end of the text", () => {
    expect(applyRfc2119("you must see\n~~~\nmust stay")).toBe("you MUST see\n~~~\nmust stay");
  });

  it("leaves paths, URLs, and skill names unchanged", () => {
    expect(applyRfc2119("open src/must.ts")).toBe("open src/must.ts");
    expect(applyRfc2119("see https://example.com/required")).toBe(
      "see https://example.com/required",
    );
    expect(applyRfc2119("/skill:required must run")).toBe("/skill:required MUST run");
    expect(applyRfc2119("/may now")).toBe("/may now");
  });

  it("leaves identifiers and hyphenated words unchanged", () => {
    expect(applyRfc2119("call expect(x).should.equal(1)")).toBe("call expect(x).should.equal(1)");
    expect(applyRfc2119("set flag=optional")).toBe("set flag=optional");
    expect(applyRfc2119("a must-have, non-optional step")).toBe("a must-have, non-optional step");
  });

  it("uppercases keywords before sentence punctuation", () => {
    expect(applyRfc2119("it is required. It may: fail; you must!")).toBe(
      "it is REQUIRED. It MAY: fail; you MUST!",
    );
    expect(applyRfc2119('(optional) "never"')).toBe('(OPTIONAL) "NEVER"');
  });
});

describe("rfc2119 input handler", () => {
  async function input(event: Record<string, unknown>) {
    const h = createHarness();
    rfc2119(h.api);
    const [result] = await h.fireEvent("input", event);
    return result;
  }

  it("transforms typed input that has keywords", async () => {
    await expect(input({ text: "you must", source: "interactive" })).resolves.toEqual({
      action: "transform",
      text: "you MUST",
    });
  });

  it("keeps the images by leaving them out of the result", async () => {
    const images = [{ type: "image", data: "", mimeType: "image/png" }];
    const result = await input({ text: "you must", images, source: "rpc" });
    expect(result).not.toHaveProperty("images");
  });

  it("does nothing when the input has no keywords", async () => {
    await expect(input({ text: "hello", source: "interactive" })).resolves.toBeUndefined();
  });

  it("does nothing for messages from other extensions", async () => {
    await expect(input({ text: "you must", source: "extension" })).resolves.toBeUndefined();
  });
});
