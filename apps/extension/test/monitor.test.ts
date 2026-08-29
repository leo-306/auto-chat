import { describe, expect, it } from "vitest";
import {
  DOUBAO_IMAGE_RENDER_GRACE_MS,
  GPT_IMAGE_RENDER_STALL_MIN_MS,
  GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS,
  hasExplicitGenerationError,
  selectGptErrorRefresh,
  selectMonitorStallRecovery,
  selectStuckGptImageStopRecovery,
  shouldCompleteImageJob,
  shouldFailCompletedDoubaoImageJob,
  shouldGiveUpOnMissingDoubaoImages,
  shouldRetryGptImageGenerationInPage,
  shouldResubmitEmptyGptImage,
  shouldStopGptImageGeneration
} from "../src/monitor.js";

describe("monitor stall recovery", () => {
  it("does not mistake ordinary Retry controls for an explicit generation error", () => {
    expect(hasExplicitGenerationError("Copy\nRetry\nShare")).toBe(false);
    expect(hasExplicitGenerationError("重试\n复制\n分享")).toBe(false);
    expect(hasExplicitGenerationError("Something went wrong. Retry")).toBe(true);
    expect(hasExplicitGenerationError("Image generation failed\nTry again")).toBe(true);
    expect(hasExplicitGenerationError("生成失败，请稍后再试")).toBe(true);
  });

  it("prefers the scoped Try again button for a failed GPT image generation", () => {
    const snapshot = {
      platform: "gpt" as const,
      mode: "image" as const,
      errorText: "Image generation failed",
      retriedInPage: false,
      hasRetryButton: true
    };

    expect(shouldRetryGptImageGenerationInPage(snapshot)).toBe(true);
    expect(shouldRetryGptImageGenerationInPage({ ...snapshot, hasRetryButton: false })).toBe(false);
    expect(shouldRetryGptImageGenerationInPage({ ...snapshot, retriedInPage: true })).toBe(false);
    expect(shouldRetryGptImageGenerationInPage({ ...snapshot, errorText: "Something went wrong" })).toBe(false);
    expect(shouldRetryGptImageGenerationInPage({ ...snapshot, mode: "text" })).toBe(false);
    expect(shouldRetryGptImageGenerationInPage({ ...snapshot, platform: "gemini" })).toBe(false);
  });

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

  it("fails a completed Doubao image response that has no image", () => {
    const snapshot = {
      platform: "doubao" as const,
      mode: "image" as const,
      assistantExists: true,
      assistantText: "你这条指令没有明确的画面内容。",
      loadedImageCount: 0,
      isGenerating: false
    };

    expect(shouldFailCompletedDoubaoImageJob(snapshot)).toBe(true);
    expect(shouldFailCompletedDoubaoImageJob({ ...snapshot, platform: "gpt" })).toBe(false);
    expect(shouldFailCompletedDoubaoImageJob({ ...snapshot, isGenerating: true })).toBe(false);
    expect(shouldFailCompletedDoubaoImageJob({ ...snapshot, assistantText: "" })).toBe(false);
    expect(shouldFailCompletedDoubaoImageJob({ ...snapshot, loadedImageCount: 1 })).toBe(false);
    expect(shouldFailCompletedDoubaoImageJob({ ...snapshot, mode: "text" })).toBe(false);
  });

  // 豆包先结束文字回复、图片卡片晚一步渲染，短宽限期会误杀成功任务。
  it("gives Doubao a long grace period before declaring the images missing", () => {
    const completedWithoutImagesAt = 1_000_000;

    expect(shouldGiveUpOnMissingDoubaoImages({ completedWithoutImagesAt, now: completedWithoutImagesAt + 6_000 })).toBe(false);
    expect(shouldGiveUpOnMissingDoubaoImages({
      completedWithoutImagesAt,
      now: completedWithoutImagesAt + DOUBAO_IMAGE_RENDER_GRACE_MS - 1
    })).toBe(false);
    expect(shouldGiveUpOnMissingDoubaoImages({
      completedWithoutImagesAt,
      now: completedWithoutImagesAt + DOUBAO_IMAGE_RENDER_GRACE_MS
    })).toBe(true);
    // 还没进入「回复已完成但没图」状态时不能判失败。
    expect(shouldGiveUpOnMissingDoubaoImages({ completedWithoutImagesAt: 0, now: completedWithoutImagesAt })).toBe(false);
    expect(DOUBAO_IMAGE_RENDER_GRACE_MS).toBeGreaterThanOrEqual(60_000);
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

  it("refreshes a completed GPT image when its stop control keeps loading for four seconds", () => {
    const snapshot = {
      platform: "gpt" as const,
      imageJobComplete: true,
      isGenerating: true,
      stopRequestedAt: 10_000
    };

    expect(selectStuckGptImageStopRecovery({
      ...snapshot,
      now: 10_000 + GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS - 1
    })).toBeNull();
    expect(selectStuckGptImageStopRecovery({
      ...snapshot,
      now: 10_000 + GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS
    })).toMatchObject({ recoveryMode: "monitor_only" });
    expect(selectStuckGptImageStopRecovery({
      ...snapshot,
      platform: "gemini",
      now: 10_000 + GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS
    })).toBeNull();
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

  it("refreshes an active GPT image placeholder at the three-minute render timeout", () => {
    expect(selectMonitorStallRecovery({
      platform: "gpt",
      mode: "image",
      isGenerating: true,
      idleMs: GPT_IMAGE_RENDER_STALL_MIN_MS,
      stallTimeoutMs: 120_000
    })).toMatchObject({ recoveryMode: "resubmit_if_prompt_missing_after_refresh" });
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
