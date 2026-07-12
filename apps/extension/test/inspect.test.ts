import { describe, expect, it } from "vitest";
import { hasGeneratingText, isGenerationStopControl } from "../src/inspect.js";

describe("generation state detection", () => {
  it("does not treat stopped thinking as active generation", () => {
    expect(hasGeneratingText("Stopped thinking")).toBe(false);
  });

  it("still treats thinking as active generation", () => {
    expect(hasGeneratingText("Thinking")).toBe(true);
  });

  it("recognizes the ChatGPT stop button as active generation", () => {
    expect(isGenerationStopControl("stop-button", "")).toBe(true);
    expect(isGenerationStopControl(null, "Stop generating")).toBe(true);
    expect(isGenerationStopControl(null, "停止生成")).toBe(true);
    expect(isGenerationStopControl(null, "Start Voice")).toBe(false);
  });
});
