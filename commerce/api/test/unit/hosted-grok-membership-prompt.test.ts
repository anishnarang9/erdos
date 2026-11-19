import { describe, expect, it } from "vitest";
import { DRAFT_SYSTEM_PROMPT } from "../../src/grok.ts";

describe("reference membership prompt", () => {
  it("distinguishes an unknown-key rejection from a missing-row rule failure", () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain("an unknown reference key must reject");
    expect(DRAFT_SYSTEM_PROMPT).toContain("use `lookup` keyed on that reference ID");
    expect(DRAFT_SYSTEM_PROMPT).toContain("a missing reference row must give verdict 0");
    expect(DRAFT_SYSTEM_PROMPT).toContain("use `all` over reference rows with `any` over output rows");
    expect(DRAFT_SYSTEM_PROMPT).not.toContain("Do not use `lookup` to test presence");
    expect(DRAFT_SYSTEM_PROMPT).toContain("A lookup returns a value, not a Boolean rule");
    expect(DRAFT_SYSTEM_PROMPT).toContain("A lookup key uses the current collection scope");
    expect(DRAFT_SYSTEM_PROMPT).toContain("A lookup does not add a record scope");
  });
});
