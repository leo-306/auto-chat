import { describe, expect, it } from "vitest";
import { isGptConversationPath, shouldReloadCapturedConversation } from "../src/homeRedirectRecovery.js";

describe("isGptConversationPath", () => {
  it("recognizes a conversation path", () => {
    expect(isGptConversationPath("/c/1234-uuid")).toBe(true);
  });

  it("rejects the home path", () => {
    expect(isGptConversationPath("/")).toBe(false);
  });
});

describe("shouldReloadCapturedConversation", () => {
  it("reloads when a conversation url was captured but the page is back on home", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: "https://chatgpt.com/c/1234-uuid",
      currentPathname: "/"
    })).toBe(true);
  });

  it("does not reload when the page is still on the conversation", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: "https://chatgpt.com/c/1234-uuid",
      currentPathname: "/c/1234-uuid"
    })).toBe(false);
  });

  it("does not reload when no conversation url was ever captured", () => {
    expect(shouldReloadCapturedConversation({
      capturedUrl: null,
      currentPathname: "/"
    })).toBe(false);
  });
});
