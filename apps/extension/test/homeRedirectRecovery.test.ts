import { describe, expect, it } from "vitest";
import {
  isGptConversationPath,
  isGptHomeUrl,
  normalizeGptConversationUrl,
  shouldReloadCapturedConversation,
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
