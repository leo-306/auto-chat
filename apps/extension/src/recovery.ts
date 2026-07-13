import type { JobPlatform } from "auto-chat-shared";

export const GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS = 15_000;

export type EmptyAssistantRecoveryMode = "monitor_only" | "resubmit";

export type EmptyAssistantSnapshot = {
  assistantExists: boolean;
  assistantText: string;
  imageCount: number;
};

export function selectEmptyAssistantRecovery(input: EmptyAssistantSnapshot & {
  platform: JobPlatform;
  beforeSendUrl: string;
  currentUrl: string;
}): EmptyAssistantRecoveryMode | null {
  if (input.platform !== "gpt") return null;

  const isEmpty = !input.assistantExists ||
    (!input.assistantText.trim() && input.imageCount === 0);
  if (!isEmpty) return null;

  return input.currentUrl === input.beforeSendUrl ? "resubmit" : "monitor_only";
}

export async function waitForEmptyAssistantRecovery(options: {
  platform: JobPlatform;
  beforeSendUrl: string;
  signal: AbortSignal;
  inspect: () => Promise<EmptyAssistantSnapshot>;
  currentUrl: () => string;
}): Promise<EmptyAssistantRecoveryMode | null> {
  if (options.platform !== "gpt") return null;

  await delay(GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS);
  if (options.signal.aborted) return null;

  const snapshot = await options.inspect();
  return selectEmptyAssistantRecovery({
    platform: options.platform,
    beforeSendUrl: options.beforeSendUrl,
    currentUrl: options.currentUrl(),
    ...snapshot
  });
}

export function shouldMonitorWithoutSubmit(input: {
  recoveryMode?: EmptyAssistantRecoveryMode;
  reloadOnly: boolean;
  hasExistingAssistant: boolean;
}): boolean {
  if (input.recoveryMode === "monitor_only") return true;
  if (input.recoveryMode === "resubmit") return false;
  return input.reloadOnly || input.hasExistingAssistant;
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
