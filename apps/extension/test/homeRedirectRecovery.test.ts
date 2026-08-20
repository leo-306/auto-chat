import { describe, expect, it } from "vitest";
import {
  hasGptUnavailableContentMessage,
  isGptConversationPath,
  isGptHomeUrl,
  normalizeGptConversationUrl,
  shouldReloadCapturedConversation,
  shouldRetryOpenedGptImageConversation,
  shouldRestoreGptConversation
} from "../src/homeRedirectRecovery.js";

describe("isGptConversationPath", () => {
  it("recognizes a conversation path", () => {
    expect(isGptConversationPath("/c/12345678-1234-1234-1234-123456789abc")).toBe(true);
    expect(isGptConversationPath("/c/WEB:12345678-1234-1234-1234-123456789abc")).toBe(true);
  });

  it("rejects the home path", () => {
    expect(isGptConversationPath("/")).toBe(false);
  });
});

describe("normalizeGptConversationUrl", () => {
  it("removes ChatGPT's internal WEB prefix before a conversation is persisted", () => {
    expect(normalizeGptConversationUrl("https://chatgpt.com/c/WEB:12345678-1234-1234-1234-123456789abc"))
      .toBe("https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc");
  });

  it("rejects non-conversation and foreign URLs", () => {
    expect(normalizeGptConversationUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeGptConversationUrl("https://example.com/c/12345678-1234-1234-1234-123456789abc")).toBeNull();
  });
});

describe("shouldReloadCapturedConversation", () => {
  it("reloads when a conversation url was captured but the page is back on home", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
      currentPathname: "/"
    })).toBe(true);
  });

  it("does not reload when the page is still on the conversation", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
      currentPathname: "/c/12345678-1234-1234-1234-123456789abc"
    })).toBe(false);
  });

  it("does not reload when no conversation url was ever captured", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: null,
      currentPathname: "/"
    })).toBe(false);
  });
});

describe("shouldRestoreGptConversation", () => {
  it("restores the recorded conversation in the current tab after a home redirect", () => {
    expect(shouldRestoreGptConversation({
      conversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
      currentUrl: "https://chatgpt.com/"
    })).toBe(true);
    expect(isGptHomeUrl("https://chatgpt.com/")).toBe(true);
  });

  it("does not restore for a non-home redirect or an invalid recorded URL", () => {
    expect(shouldRestoreGptConversation({
      conversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
      currentUrl: "https://chatgpt.com/auth/login"
    })).toBe(false);
    expect(shouldRestoreGptConversation({
      conversationUrl: "https://chatgpt.com/",
      currentUrl: "https://chatgpt.com/"
    })).toBe(false);
    expect(shouldRestoreGptConversation({
      conversationUrl: "not-a-url",
      currentUrl: "https://chatgpt.com/"
    })).toBe(false);
  });
});

describe("shouldRetryOpenedGptImageConversation", () => {
  const conversationUrl = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc";
  const unavailableText = "This content is unavailable or could not be found.";

  it("reopens a recorded GPT image conversation only after the unavailable home redirect", () => {
    expect(hasGptUnavailableContentMessage(unavailableText)).toBe(true);
    expect(shouldRetryOpenedGptImageConversation({
      platform: "gpt",
      mode: "image",
      conversationUrl,
      currentUrl: "https://chatgpt.com/",
      hasUnavailableContent: true
    })).toBe(true);
  });

  it("does not apply the recovery to other jobs or ordinary ChatGPT pages", () => {
    const base = {
      platform: "gpt" as const,
      mode: "image" as const,
      conversationUrl,
      currentUrl: "https://chatgpt.com/",
      hasUnavailableContent: true
    };

    expect(shouldRetryOpenedGptImageConversation({ ...base, mode: "text" })).toBe(false);
    expect(shouldRetryOpenedGptImageConversation({ ...base, platform: "gemini" })).toBe(false);
    expect(shouldRetryOpenedGptImageConversation({ ...base, currentUrl: conversationUrl })).toBe(false);
    expect(shouldRetryOpenedGptImageConversation({ ...base, hasUnavailableContent: false })).toBe(false);
    expect(shouldRetryOpenedGptImageConversation({ ...base, conversationUrl: "https://chatgpt.com/" })).toBe(false);
    expect(hasGptUnavailableContentMessage("Copy\nRetry\nShare")).toBe(false);
  });
});
