import type { Job, JobPlatform } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

export const GPT_IMAGE_RENDER_STALL_MIN_MS = 180_000;

export type MonitorStallRecovery = {
  errorMessage: string;
  recoveryMode: EmptyAssistantRecoveryMode;
};

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

  const renderStallTimeoutMs = Math.max(input.stallTimeoutMs, GPT_IMAGE_RENDER_STALL_MIN_MS);
  if (
    input.platform === "gpt" &&
    input.mode === "image" &&
    input.isGenerating &&
    input.idleMs > renderStallTimeoutMs
  ) {
    return {
      errorMessage: "GPT image generation made no visible rendering progress; refreshing to load the completed image.",
      recoveryMode: "monitor_only"
    };
  }

  return null;
}
