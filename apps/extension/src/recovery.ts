import type { JobMode, JobPlatform } from "auto-chat-shared";

export const GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS = 15_000;

export type EmptyAssistantRecoveryMode = "monitor_only";

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
  hasExistingAssistant: boolean;
}): boolean {
  if (input.recoveryMode === "monitor_only") return true;
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
