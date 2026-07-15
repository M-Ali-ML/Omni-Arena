import { describe, expect, it } from "vitest";
import { calculateMarkdownDensity, estimateTokenCount } from "./style.js";

describe("style feature capture", () => {
  it("counts lexical tokens and punctuation deterministically", () => {
    expect(estimateTokenCount("Hello, well-made world!")).toBe(5);
    expect(estimateTokenCount("   ")).toBe(0);
  });

  it("reports markdown marker density in the zero-to-one range", () => {
    expect(calculateMarkdownDensity("Plain text only")).toBe(0);
    expect(calculateMarkdownDensity("# Heading\n\n- one\n- two")).toBeGreaterThan(
      0,
    );
    expect(calculateMarkdownDensity("")).toBe(0);
  });
});
