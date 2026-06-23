import { describe, expect, it } from "vitest";
import { findGeminiSendControl, isGeminiSendDisabled } from "../src/gemini.js";

describe("Gemini send control", () => {
  it("detects upload-disabled send container", () => {
    const control = {
      classList: { contains: (name: string) => name === "disabled" },
      getAttribute: () => null,
      querySelector: () => null
    } as unknown as HTMLElement;

    expect(isGeminiSendDisabled(control)).toBe(true);
  });

  it("detects aria-disabled gem-icon-button", () => {
    const control = {
      classList: { contains: () => false },
      getAttribute: (name: string) => name === "aria-disabled" ? "true" : null,
      querySelector: () => null
    } as unknown as HTMLElement;

    expect(isGeminiSendDisabled(control)).toBe(true);
  });

  it("prefers the inner enabled gem-icon-button over the send container", () => {
    const icon = {
      getAttribute: () => null
    } as unknown as HTMLElement;
    const container = {
      querySelector(selector: string) {
        return selector.includes("gem-icon-button") ? icon : null;
      }
    } as unknown as ParentNode;

    expect(findGeminiSendControl(container)).toBe(icon);
  });
});
