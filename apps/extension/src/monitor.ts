import type { Job, JobPlatform } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

export const GPT_IMAGE_RENDER_STALL_MIN_MS = 180_000;

export type MonitorStallRecovery = {
  errorMessage: string;
  recoveryMode: EmptyAssistantRecoveryMode;
};

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
  if (!input.isGenerating && input.idleMs > input.stallTimeoutMs) {
    return {
      errorMessage: "No visible progress before stall timeout.",
      recoveryMode: "monitor_only"
    };
  }

  return null;
}
