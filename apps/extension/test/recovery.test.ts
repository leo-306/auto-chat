import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectEmptyAssistantRecovery,
  shouldMonitorWithoutSubmit,
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
      beforeSendUrl: "https://chatgpt.com/",
      signal: controller.signal,
      inspect,
      currentUrl: () => "https://chatgpt.com/c/example"
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
      beforeSendUrl: "https://chatgpt.com/",
      signal: controller.signal,
      inspect,
      currentUrl: () => "https://chatgpt.com/c/example"
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses monitor-only recovery when the assistant is missing and the URL changed", () => {
    expect(selectEmptyAssistantRecovery({
      platform: "gpt",
      beforeSendUrl: "https://chatgpt.com/",
      currentUrl: "https://chatgpt.com/c/example",
      assistantExists: false,
      assistantText: "",
      imageCount: 1
    })).toBe("monitor_only");
  });

  it("uses resubmit recovery when an existing assistant is empty and the URL did not change", () => {
    expect(selectEmptyAssistantRecovery({
      platform: "gpt",
      beforeSendUrl: "https://chatgpt.com/",
      currentUrl: "https://chatgpt.com/",
      assistantExists: true,
      assistantText: "",
      imageCount: 0
    })).toBe("resubmit");
  });

  it("does not recover when the assistant has text or an image", () => {
    const base = {
      platform: "gpt" as const,
      beforeSendUrl: "https://chatgpt.com/",
      currentUrl: "https://chatgpt.com/c/example",
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
      beforeSendUrl: "https://gemini.google.com/app",
      signal: new AbortController().signal,
      inspect,
      currentUrl: () => "https://gemini.google.com/app/example"
    })).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("monitors without submitting after a changed-URL recovery", () => {
    expect(shouldMonitorWithoutSubmit({
      recoveryMode: "monitor_only",
      reloadOnly: false,
      hasExistingAssistant: false
    })).toBe(true);
  });

  it("resubmits after an unchanged-URL recovery even if an assistant exists", () => {
    expect(shouldMonitorWithoutSubmit({
      recoveryMode: "resubmit",
      reloadOnly: false,
      hasExistingAssistant: true
    })).toBe(false);
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
});
