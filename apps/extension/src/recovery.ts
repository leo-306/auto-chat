import type { JobMode, JobPlatform } from "auto-chat-shared";

export const GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS = 15_000;

export type EmptyAssistantRecoveryMode =
  | "monitor_only"
  | "retry_after_refresh"
  | "resubmit_after_refresh"
  | "resubmit_if_prompt_missing_after_refresh";

export type PostRefreshPromptAction = "monitor" | "resubmit";

export type EmptyAssistantSnapshot = {
  assistantExists: boolean;
  assistantText: string;
  imageCount: number;
};

export function selectEmptyAssistantRecovery(input: EmptyAssistantSnapshot & {
  platform: JobPlatform;
}): EmptyAssistantRecoveryMode | null {
  if (input.platform !== "gpt") return null;

  const isEmpty = !input.assistantExists ||
    (!input.assistantText.trim() && input.imageCount === 0);
  if (!isEmpty) return null;

  return "monitor_only";
}

export function shouldCheckEmptyAssistantRecovery(platform: JobPlatform, mode: JobMode): boolean {
  return platform === "gpt" && mode === "text";
}

export async function waitForEmptyAssistantRecovery(options: {
  platform: JobPlatform;
  signal: AbortSignal;
  inspect: () => Promise<EmptyAssistantSnapshot>;
}): Promise<EmptyAssistantRecoveryMode | null> {
  if (options.platform !== "gpt") return null;

  await delay(GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS);
  if (options.signal.aborted) return null;

  const snapshot = await options.inspect();
  return selectEmptyAssistantRecovery({
    platform: options.platform,
    ...snapshot
  });
}

export function shouldMonitorWithoutSubmit(input: {
  recoveryMode?: EmptyAssistantRecoveryMode;
  reloadOnly: boolean;
  resubmit?: boolean;
  hasExistingAssistant: boolean;
  isGeminiMultiImage: boolean;
}): boolean {
  // A Gemini multi-image job accumulates one image per freshly-started
  // conversation (see runGeminiImageJob), so the generic monitor's "loaded
  // images >= expectedImageCount" completion check can never be satisfied
  // by any single conversation — it would wait forever for images that will
  // never all appear in one turn, until the stall timeout retries itself
  // into needs_manual. These jobs must always go back through the
  // per-image flow instead of being monitored in place.
  if (input.isGeminiMultiImage) return false;
  // An empty GPT image response must refresh the conversation first, then
  // submit exactly once from the stable post-refresh page. The stale empty
  // assistant turn would otherwise make this look like monitor-only work.
  if (
    input.recoveryMode === "resubmit_after_refresh" ||
    input.recoveryMode === "resubmit_if_prompt_missing_after_refresh"
  ) return false;
  if (input.recoveryMode) return true;
  if (input.reloadOnly) return true;
  // An explicit retry re-sends the prompt into the same conversation, so the
  // previous attempt's assistant turn must not be mistaken for work in
  // progress. Without this a retry would silently degrade into a reload:
  // reopen the old conversation, watch the stale answer, fail the same way.
  if (input.resubmit) return false;
  return input.hasExistingAssistant;
}

export function selectPostRefreshPromptAction(input: {
  recoveryMode?: EmptyAssistantRecoveryMode;
  hasJobUserTurn: boolean;
}): PostRefreshPromptAction | null {
  if (input.recoveryMode !== "resubmit_if_prompt_missing_after_refresh") return null;
  return input.hasJobUserTurn ? "monitor" : "resubmit";
}

export function shouldRetryReloadWithoutJobTurn(input: {
  reloadOnly: boolean;
  hasJobUserTurn: boolean;
}): boolean {
  return input.reloadOnly && !input.hasJobUserTurn;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
