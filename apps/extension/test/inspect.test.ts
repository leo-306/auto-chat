import { describe, expect, it } from "vitest";
import { hasGeneratingText } from "../src/inspect.js";

describe("generation state detection", () => {
  it("does not treat stopped thinking as active generation", () => {
    expect(hasGeneratingText("Stopped thinking")).toBe(false);
  });

  it("still treats thinking as active generation", () => {
    expect(hasGeneratingText("Thinking")).toBe(true);
  });
});
