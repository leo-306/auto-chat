import { describe, expect, it } from "vitest";
import {
  GPT_IMAGE_RENDER_STALL_MIN_MS,
  selectGptErrorRefresh,
  selectMonitorStallRecovery,
  shouldCompleteImageJob
} from "../src/monitor.js";

describe("monitor stall recovery", () => {
  it("prioritizes a complete image result even when the page retains an error banner", () => {
    expect(shouldCompleteImageJob({
      mode: "image",
      loadedImageCount: 1,
      expectedImageCount: 1
    })).toBe(true);
    expect(shouldCompleteImageJob({
      mode: "image",
      loadedImageCount: 1,
      expectedImageCount: 2
    })).toBe(false);
  });

  it("refreshes the first GPT error before retrying it in the page", () => {
    expect(selectGptErrorRefresh({
      platform: "gpt",
      refreshCount: 0,
      maxRefreshPerJob: 2
    })).toMatchObject({
      recoveryMode: "retry_after_refresh",
      errorMessage: expect.stringContaining("refreshing")
    });
  });

  it("does not refresh a GPT error again after the refresh budget is used", () => {
    expect(selectGptErrorRefresh({
      platform: "gpt",
      refreshCount: 2,
      maxRefreshPerJob: 2
    })).toBeNull();
    expect(selectGptErrorRefresh({
      platform: "gemini",
      refreshCount: 0,
      maxRefreshPerJob: 2
    })).toBeNull();
  });

  it("refreshes a non-generating task after the configured stall timeout", () => {
    expect(selectMonitorStallRecovery({
      platform: "gpt",
      mode: "image",
      isGenerating: false,
      idleMs: 120_001,
      stallTimeoutMs: 120_000
    })).toMatchObject({ recoveryMode: "monitor_only" });
  });

  it("refreshes a GPT image placeholder that remains generating without visible progress", () => {
    const recovery = selectMonitorStallRecovery({
      platform: "gpt",
      mode: "image",
      isGenerating: true,
      idleMs: GPT_IMAGE_RENDER_STALL_MIN_MS + 1,
      stallTimeoutMs: 120_000
    });

    expect(recovery).toMatchObject({
      recoveryMode: "monitor_only",
      errorMessage: expect.stringContaining("refreshing")
    });
  });

  it("does not refresh an actively generating GPT image too early", () => {
    expect(selectMonitorStallRecovery({
      platform: "gpt",
      mode: "image",
      isGenerating: true,
      idleMs: GPT_IMAGE_RENDER_STALL_MIN_MS - 1,
      stallTimeoutMs: 120_000
    })).toBeNull();
  });

  it("does not apply the GPT render workaround to other task types", () => {
    expect(selectMonitorStallRecovery({
      platform: "gemini",
      mode: "image",
      isGenerating: true,
      idleMs: 600_000,
      stallTimeoutMs: 120_000
    })).toBeNull();
    expect(selectMonitorStallRecovery({
      platform: "gpt",
      mode: "text",
      isGenerating: true,
      idleMs: 600_000,
      stallTimeoutMs: 120_000
    })).toBeNull();
  });
});
