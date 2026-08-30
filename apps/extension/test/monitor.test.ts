import { describe, expect, it } from "vitest";
import {
  DOUBAO_IMAGE_RENDER_GRACE_MS,
  DOUBAO_VIDEO_CONFIRM_MAX_CLICKS,
  GPT_IMAGE_RENDER_STALL_MIN_MS,
  GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS,
  MEDIA_BLOCK_STABLE_MS,
  VIDEO_WAIT_MIN_MS,
  hasExplicitGenerationError,
  classifyMediaBlockText,
  detectMediaBlock,
  selectGptErrorRefresh,
  selectMonitorStallRecovery,
  selectStuckGptImageStopRecovery,
  shouldClickDoubaoVideoConfirm,
  shouldCompleteImageJob,
  shouldCompleteVideoJob,
  shouldFailCompletedDoubaoImageJob,
  shouldGiveUpOnMediaBlock,
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

  // 视频生成是异步的：提交后页面整段时间一动不动，通用停滞超时会把它当成卡死。
  it("keeps waiting on a pending video past the generic stall timeout", () => {
    expect(selectMonitorStallRecovery({
      platform: "doubao",
      mode: "video",
      isGenerating: false,
      idleMs: 300_001,
      stallTimeoutMs: 300_000
    })).toBeNull();
    expect(selectMonitorStallRecovery({
      platform: "gemini",
      mode: "video",
      isGenerating: false,
      idleMs: 300_001,
      stallTimeoutMs: 300_000
    })).toBeNull();
    expect(selectMonitorStallRecovery({
      platform: "doubao",
      mode: "video",
      isGenerating: false,
      idleMs: VIDEO_WAIT_MIN_MS + 1,
      stallTimeoutMs: 300_000
    })).toMatchObject({ recoveryMode: "monitor_only" });
    // 图片模式不受影响。
    expect(selectMonitorStallRecovery({
      platform: "doubao",
      mode: "image",
      isGenerating: false,
      idleMs: 300_001,
      stallTimeoutMs: 300_000
    })).toMatchObject({ recoveryMode: "monitor_only" });
  });

  // 豆包偶尔要求二次确认：不点「确认生成 →」就永远不会开始生成。
  it("clicks the Doubao video confirmation button until the video appears", () => {
    const snapshot = {
      platform: "doubao" as const,
      mode: "video" as const,
      hasConfirmButton: true,
      loadedVideoCount: 0,
      isGenerating: false,
      confirmClickCount: 0
    };

    expect(shouldClickDoubaoVideoConfirm(snapshot)).toBe(true);
    expect(shouldClickDoubaoVideoConfirm({ ...snapshot, hasConfirmButton: false })).toBe(false);
    // 已经在生成 / 已经出片，就别再点了。
    expect(shouldClickDoubaoVideoConfirm({ ...snapshot, isGenerating: true })).toBe(false);
    expect(shouldClickDoubaoVideoConfirm({ ...snapshot, loadedVideoCount: 1 })).toBe(false);
    expect(shouldClickDoubaoVideoConfirm({ ...snapshot, mode: "image" })).toBe(false);
    expect(shouldClickDoubaoVideoConfirm({ ...snapshot, platform: "gpt" })).toBe(false);
    // 按钮一直不消失时有次数上限兜底。
    expect(shouldClickDoubaoVideoConfirm({
      ...snapshot,
      confirmClickCount: DOUBAO_VIDEO_CONFIRM_MAX_CLICKS
    })).toBe(false);
  });

  it("completes a video job as soon as one video card is present", () => {
    expect(shouldCompleteVideoJob({ mode: "video", loadedVideoCount: 1 })).toBe(true);
    expect(shouldCompleteVideoJob({ mode: "video", loadedVideoCount: 0 })).toBe(false);
    expect(shouldCompleteVideoJob({ mode: "image", loadedVideoCount: 1 })).toBe(false);
    expect(shouldCompleteVideoJob({ mode: "text", loadedVideoCount: 1 })).toBe(false);
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

describe("media block", () => {
  const blocked = {
    mode: "video" as const,
    assistantExists: true,
    assistantText: "我无法制作这类视频。我可以帮你做其他事情吗？",
    isGenerating: false,
    loadedImageCount: 0,
    loadedVideoCount: 0
  };

  it("认出中英文的拒绝话术", () => {
    expect(classifyMediaBlockText("我无法制作这类视频。我可以帮你做其他事情吗？")).toBe("refusal");
    expect(classifyMediaBlockText("抱歉，我不能帮你生成这样的内容。")).toBe("refusal");
    expect(classifyMediaBlockText("我做不了这个视频")).toBe("refusal");
    expect(classifyMediaBlockText("I can't create that video.")).toBe("refusal");
    expect(classifyMediaBlockText("Sorry, I'm unable to generate this image.")).toBe("refusal");
  });

  it("把并发/配额上限单独归成可重试的一类", () => {
    expect(classifyMediaBlockText("你目前有 2 个视频生成请求正在运行中，已经达到一次可以处理的请求上限。"))
      .toBe("capacity");
    expect(classifyMediaBlockText("今日视频额度已用完，请明天再试。")).toBe("capacity");
    expect(classifyMediaBlockText("You have reached the limit for video generation.")).toBe("capacity");
    // 两类话术同时出现时按可重试处理，别让人工去改一条本来没问题的 prompt。
    expect(classifyMediaBlockText("已达到请求上限，暂时无法生成视频。")).toBe("capacity");
  });

  it("不把正常回复和排队提示当失败", () => {
    expect(classifyMediaBlockText("视频生成已提交，大约需要 1-3 分钟，请稍等。")).toBeNull();
    expect(classifyMediaBlockText("好的，正在为你生成视频。")).toBeNull();
    expect(classifyMediaBlockText("Here is your video.")).toBeNull();
    expect(classifyMediaBlockText("")).toBeNull();
  });

  it("长文里出现「无法保证」不算失败", () => {
    const long = `这是一段很长的说明。${"我会尽量还原参考图里的服饰细节与光线氛围。".repeat(12)}我无法保证每一帧都完全一致。`;
    expect(long.length).toBeGreaterThan(240);
    expect(classifyMediaBlockText(long)).toBeNull();
  });

  it("只在没有产出且回复已结束时判失败", () => {
    expect(detectMediaBlock(blocked)).toBe("refusal");
    expect(detectMediaBlock({ ...blocked, mode: "image" })).toBe("refusal");
    expect(detectMediaBlock({ ...blocked, mode: "text" })).toBeNull();
    expect(detectMediaBlock({ ...blocked, isGenerating: true })).toBeNull();
    expect(detectMediaBlock({ ...blocked, assistantExists: false })).toBeNull();
    expect(detectMediaBlock({ ...blocked, loadedVideoCount: 1 })).toBeNull();
    expect(detectMediaBlock({ ...blocked, loadedImageCount: 1 })).toBeNull();
    // Gemini 成功那次也是先回一句排队提示、11 分钟后才渲染视频卡片，不能因此判失败。
    expect(detectMediaBlock({ ...blocked, assistantText: "视频生成中，请稍候。" })).toBeNull();
  });

  it("稳定几秒后才收工", () => {
    const blockedAt = 1_000_000;
    expect(shouldGiveUpOnMediaBlock({ blockedAt, now: blockedAt + 1_000 })).toBe(false);
    expect(shouldGiveUpOnMediaBlock({ blockedAt, now: blockedAt + MEDIA_BLOCK_STABLE_MS })).toBe(true);
    expect(shouldGiveUpOnMediaBlock({ blockedAt: 0, now: blockedAt })).toBe(false);
  });
});
