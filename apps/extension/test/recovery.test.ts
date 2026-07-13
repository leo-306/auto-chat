import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectEmptyAssistantRecovery,
  shouldCheckEmptyAssistantRecovery,
  shouldMonitorWithoutSubmit,
  shouldRetryReloadWithoutJobTurn,
  waitForEmptyAssistantRecovery
} from "../src/recovery.js";

describe("GPT empty assistant recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks exactly once 15 seconds after submission", async () => {
    vi.useFakeTimers();
    const inspect = vi.fn(async () => ({
      assistantExists: false,
      assistantText: "",
      imageCount: 0
    }));
    const controller = new AbortController();

    const pending = waitForEmptyAssistantRecovery({
      platform: "gpt",
      signal: controller.signal,
      inspect
    });

    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("monitor_only");
    expect(inspect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("does not inspect an aborted task", async () => {
    vi.useFakeTimers();
    const inspect = vi.fn(async () => ({
      assistantExists: false,
      assistantText: "",
      imageCount: 0
    }));
    const controller = new AbortController();
    const pending = waitForEmptyAssistantRecovery({
      platform: "gpt",
      signal: controller.signal,
      inspect
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses monitor-only recovery when the assistant is missing", () => {
    expect(selectEmptyAssistantRecovery({
      platform: "gpt",
      assistantExists: false,
      assistantText: "",
      imageCount: 1
    })).toBe("monitor_only");
  });

  it("never resubmits merely because an existing assistant is empty", () => {
    expect(selectEmptyAssistantRecovery({
      platform: "gpt",
      assistantExists: true,
      assistantText: "",
      imageCount: 0
    })).toBe("monitor_only");
  });

  it("does not recover when the assistant has text or an image", () => {
    const base = {
      platform: "gpt" as const,
      assistantExists: true
    };

    expect(selectEmptyAssistantRecovery({
      ...base,
      assistantText: "Thinking",
      imageCount: 0
    })).toBeNull();
    expect(selectEmptyAssistantRecovery({
      ...base,
      assistantText: "",
      imageCount: 1
    })).toBeNull();
  });

  it("does not run the GPT recovery check for Gemini", async () => {
    const inspect = vi.fn(async () => ({
      assistantExists: false,
      assistantText: "",
      imageCount: 0
    }));

    await expect(waitForEmptyAssistantRecovery({
      platform: "gemini",
      signal: new AbortController().signal,
      inspect
    })).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("monitors without submitting after empty-assistant recovery", () => {
    expect(shouldMonitorWithoutSubmit({
      recoveryMode: "monitor_only",
      reloadOnly: false,
      hasExistingAssistant: false
    })).toBe(true);
  });

  it("only runs the 15-second empty-assistant check for GPT text jobs", () => {
    expect(shouldCheckEmptyAssistantRecovery("gpt", "text")).toBe(true);
    expect(shouldCheckEmptyAssistantRecovery("gpt", "image")).toBe(false);
    expect(shouldCheckEmptyAssistantRecovery("gemini", "text")).toBe(false);
    expect(shouldCheckEmptyAssistantRecovery("gemini", "image")).toBe(false);
  });

  it("preserves existing reload-only and existing-assistant behavior", () => {
    expect(shouldMonitorWithoutSubmit({
      reloadOnly: true,
      hasExistingAssistant: false
    })).toBe(true);
    expect(shouldMonitorWithoutSubmit({
      reloadOnly: false,
      hasExistingAssistant: true
    })).toBe(true);
    expect(shouldMonitorWithoutSubmit({
      reloadOnly: false,
      hasExistingAssistant: false
    })).toBe(false);
  });

  it("retries reload-only recovery when the job user turn is missing", () => {
    expect(shouldRetryReloadWithoutJobTurn({
      reloadOnly: true,
      hasJobUserTurn: false
    })).toBe(true);
    expect(shouldRetryReloadWithoutJobTurn({
      reloadOnly: true,
      hasJobUserTurn: true
    })).toBe(false);
    expect(shouldRetryReloadWithoutJobTurn({
      reloadOnly: false,
      hasJobUserTurn: false
    })).toBe(false);
  });
});
