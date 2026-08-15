import { describe, expect, it } from "vitest";
import {
  GPT_IMAGE_RENDER_STALL_MIN_MS,
  selectGptErrorRefresh,
  selectMonitorStallRecovery,
  shouldCompleteImageJob,
  shouldResubmitEmptyGptImage,
  shouldStopGptImageGeneration
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

  it("stops a GPT response only after all expected images are available", () => {
    expect(shouldStopGptImageGeneration({
      platform: "gpt",
      isGenerating: true,
      imageJobComplete: true
    })).toBe(true);
    expect(shouldStopGptImageGeneration({
      platform: "gpt",
      isGenerating: true,
      imageJobComplete: false
    })).toBe(false);
    expect(shouldStopGptImageGeneration({
      platform: "gemini",
      isGenerating: true,
      imageJobComplete: true
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

  it("keeps an active GPT image placeholder waiting past the render timeout", () => {
    expect(selectMonitorStallRecovery({
      platform: "gpt",
      mode: "image",
      isGenerating: true,
      idleMs: GPT_IMAGE_RENDER_STALL_MIN_MS + 1,
      stallTimeoutMs: 120_000
    })).toBeNull();
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

  it("identifies the empty GPT image response that must refresh before one resend", () => {
    const snapshot = {
      platform: "gpt" as const,
      mode: "image" as const,
      sourceImageCount: 0,
      assistantExists: true,
      assistantText: "",
      loadedImageCount: 0,
      isGenerating: false,
      composerInteractive: true,
      hasOnlyResponseActionMenu: true
    };

    expect(shouldResubmitEmptyGptImage(snapshot)).toBe(true);
    expect(shouldResubmitEmptyGptImage({ ...snapshot, isGenerating: true })).toBe(false);
    expect(shouldResubmitEmptyGptImage({ ...snapshot, hasOnlyResponseActionMenu: false })).toBe(false);
    expect(shouldResubmitEmptyGptImage({ ...snapshot, sourceImageCount: 1 })).toBe(false);
    expect(shouldResubmitEmptyGptImage({ ...snapshot, loadedImageCount: 1 })).toBe(false);
  });
});
