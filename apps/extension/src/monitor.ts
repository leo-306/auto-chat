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

  if (!input.isGenerating && input.idleMs > input.stallTimeoutMs) {
    return {
      errorMessage: "No visible progress before stall timeout.",
      recoveryMode: "monitor_only"
    };
  }

  return null;
}
