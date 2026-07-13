export type StableReadinessOptions = {
  inspect: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stablePolls?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STABLE_POLLS = 3;

export async function waitForStableReadiness(
  options: StableReadinessOptions
): Promise<"ready" | "timeout"> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stablePolls = options.stablePolls ?? DEFAULT_STABLE_POLLS;
  const deadline = now() + timeoutMs;
  let consecutiveReadyPolls = 0;

  while (now() < deadline) {
    if (options.inspect()) {
      consecutiveReadyPolls += 1;
      if (consecutiveReadyPolls >= stablePolls) return "ready";
    } else {
      consecutiveReadyPolls = 0;
    }

    await options.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }

  return "timeout";
}
