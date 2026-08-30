import type { Job, JobPlatform } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

export const GPT_IMAGE_RENDER_STALL_MIN_MS = 180_000;
export const GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS = 4_000;
const EXPLICIT_GENERATION_ERROR_PATTERN =
  /Image generation failed|Something went wrong|There was a problem generating|Failed to generate|rate limit|too many requests|try again later|出了点问题|生成失败|请求过多|稍后再试/i;
const GPT_IMAGE_GENERATION_FAILED_PATTERN = /Image generation failed/i;

export type MonitorStallRecovery = {
  errorMessage: string;
  recoveryMode: EmptyAssistantRecoveryMode;
};

// Chat interfaces keep Retry/Redo controls on ordinary completed responses.
// Only match an explicit error sentence when deciding to consume a refresh.
export function hasExplicitGenerationError(text: string): boolean {
  return EXPLICIT_GENERATION_ERROR_PATTERN.test(text);
}

export function shouldRetryGptImageGenerationInPage(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  errorText: string;
  retriedInPage: boolean;
  hasRetryButton: boolean;
}): boolean {
  return input.platform === "gpt" &&
    input.mode === "image" &&
    !input.retriedInPage &&
    input.hasRetryButton &&
    GPT_IMAGE_GENERATION_FAILED_PATTERN.test(input.errorText);
}

export function shouldCompleteImageJob(input: {
  mode: Job["mode"];
  loadedImageCount: number;
  expectedImageCount: number;
}): boolean {
  return input.mode === "image" && input.loadedImageCount >= input.expectedImageCount;
}

export function shouldCompleteVideoJob(input: {
  mode: Job["mode"];
  loadedVideoCount: number;
}): boolean {
  return input.mode === "video" && input.loadedVideoCount >= 1;
}

// 豆包视频是异步生成的：助手先回一句「视频生成已提交…大约需要 1-3 分钟」并把
// isGenerating 置回 false，之后才追加一条带视频卡片的消息。这段等待期页面签名毫无变化，
// 会被通用停滞超时（默认 5 分钟）误判成卡死，所以视频任务用一个更长的空闲下限，
// 上限仍由 hardTimeoutMs（默认 15 分钟）兜住。
export const DOUBAO_VIDEO_WAIT_MIN_MS = 720_000;

// 豆包视频还可能插一步二次确认：助手先回一段授权声明 + 一个「确认生成 →」按钮，
// 点了才真正开始排队生成。点击后按钮通常就消失，这里仍留一个次数上限兜底，
// 避免按钮一直留在页面上时被无限点击。
export const DOUBAO_VIDEO_CONFIRM_MAX_CLICKS = 3;

export function shouldClickDoubaoVideoConfirm(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  hasConfirmButton: boolean;
  loadedVideoCount: number;
  isGenerating: boolean;
  confirmClickCount: number;
}): boolean {
  return input.platform === "doubao" &&
    input.mode === "video" &&
    input.hasConfirmButton &&
    !input.isGenerating &&
    input.loadedVideoCount === 0 &&
    input.confirmClickCount < DOUBAO_VIDEO_CONFIRM_MAX_CLICKS;
}

// 豆包可能在图片没有渲染出来时先结束助手回复。对图片任务来说，
// 已完成的非空回复不能被当作成功，避免一直等待到通用停滞超时。
export function shouldFailCompletedDoubaoImageJob(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  assistantExists: boolean;
  assistantText: string;
  loadedImageCount: number;
  isGenerating: boolean;
}): boolean {
  return input.platform === "doubao" &&
    input.mode === "image" &&
    input.assistantExists &&
    Boolean(input.assistantText.trim()) &&
    input.loadedImageCount === 0 &&
    !input.isGenerating;
}

// 豆包会先把文字回复标成完成（isGenerating 转 false），图片卡片晚一步才渲染。
// 原来这里共用 2 秒的图片稳定期，加一次 5 秒轮询也就 6 秒就判失败，
// 线上实测会把图片确实生成成功的任务误杀，所以单独给一个长得多的等待窗口。
export const DOUBAO_IMAGE_RENDER_GRACE_MS = 120_000;

export function shouldGiveUpOnMissingDoubaoImages(input: {
  completedWithoutImagesAt: number;
  now: number;
}): boolean {
  return input.completedWithoutImagesAt > 0 &&
    input.now - input.completedWithoutImagesAt >= DOUBAO_IMAGE_RENDER_GRACE_MS;
}

export function shouldStopGptImageGeneration(input: {
  platform: JobPlatform;
  isGenerating: boolean;
  imageJobComplete: boolean;
}): boolean {
  return input.platform === "gpt" && input.isGenerating && input.imageJobComplete;
}

export function selectStuckGptImageStopRecovery(input: {
  platform: JobPlatform;
  imageJobComplete: boolean;
  isGenerating: boolean;
  stopRequestedAt: number;
  now: number;
}): MonitorStallRecovery | null {
  if (
    input.platform !== "gpt" ||
    !input.imageJobComplete ||
    !input.isGenerating ||
    !input.stopRequestedAt ||
    input.now - input.stopRequestedAt < GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS
  ) {
    return null;
  }

  return {
    errorMessage: "ChatGPT stop control remained loading for 4 seconds after a complete image was found; refreshing the conversation before collecting the image.",
    recoveryMode: "monitor_only"
  };
}

export function shouldResubmitEmptyGptImage(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  sourceImageCount: number;
  assistantExists: boolean;
  assistantText: string;
  loadedImageCount: number;
  isGenerating: boolean;
  composerInteractive: boolean;
  hasOnlyResponseActionMenu: boolean;
}): boolean {
  return input.platform === "gpt" &&
    input.mode === "image" &&
    input.sourceImageCount === 0 &&
    input.assistantExists &&
    !input.assistantText.trim() &&
    input.loadedImageCount === 0 &&
    !input.isGenerating &&
    input.composerInteractive &&
    input.hasOnlyResponseActionMenu;
}

export function selectGptErrorRefresh(input: {
  platform: JobPlatform;
  refreshCount: number;
  maxRefreshPerJob: number;
}): MonitorStallRecovery | null {
  if (input.platform !== "gpt" || input.refreshCount >= input.maxRefreshPerJob) return null;

  return {
    errorMessage: "ChatGPT reported an error; refreshing the submitted conversation before retrying.",
    recoveryMode: "retry_after_refresh"
  };
}

export function selectMonitorStallRecovery(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  isGenerating: boolean;
  idleMs: number;
  stallTimeoutMs: number;
}): MonitorStallRecovery | null {
  if (
    input.platform === "gpt" &&
    input.mode === "image" &&
    input.isGenerating &&
    input.idleMs >= GPT_IMAGE_RENDER_STALL_MIN_MS
  ) {
    return {
      errorMessage: "ChatGPT image generation showed no visible progress for 3 minutes; refreshing the conversation and checking whether the submitted prompt remains.",
      recoveryMode: "resubmit_if_prompt_missing_after_refresh"
    };
  }

  if (!input.isGenerating && input.idleMs > effectiveStallTimeoutMs(input)) {
    return {
      errorMessage: "No visible progress before stall timeout.",
      recoveryMode: "monitor_only"
    };
  }

  return null;
}

function effectiveStallTimeoutMs(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  stallTimeoutMs: number;
}): number {
  if (input.platform === "doubao" && input.mode === "video") {
    return Math.max(input.stallTimeoutMs, DOUBAO_VIDEO_WAIT_MIN_MS);
  }
  return input.stallTimeoutMs;
}
