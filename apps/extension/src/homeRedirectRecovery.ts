import type { JobMode, JobPlatform } from "auto-chat-shared";

const GPT_CONVERSATION_ID = /^(?:WEB:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GPT_UNAVAILABLE_CONTENT_PATTERN = /This\s+content\s+is\s+unavailable\s+or\s+could\s+not\s+be\s+found\.?/i;

function gptConversationId(pathname: string): string | null {
  const candidate = pathname.match(/^\/c\/([^/]+)$/)?.[1] ?? "";
  return GPT_CONVERSATION_ID.exec(candidate)?.[1] ?? null;
}

export function isGptConversationPath(pathname: string): boolean {
  return gptConversationId(pathname) !== null;
}

// ChatGPT may briefly expose a WEB:<uuid> client-side route while creating a
// conversation. Persist the user-facing route instead of that internal form.
export function normalizeGptConversationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com") return null;
    const id = gptConversationId(url.pathname);
    return id ? `https://chatgpt.com/c/${id}` : null;
  } catch {
    return null;
  }
}

export function shouldReloadCapturedConversation(input: {
  capturedUrl: string | null;
  currentPathname: string;
}): boolean {
  return normalizeGptConversationUrl(input.capturedUrl) !== null && !isGptConversationPath(input.currentPathname);
}

export function isGptHomeUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "chatgpt.com" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

export function shouldRestoreGptConversation(input: {
  conversationUrl: string | null;
  currentUrl: string | undefined;
}): boolean {
  if (!input.conversationUrl || !isGptHomeUrl(input.currentUrl)) return false;
  return normalizeGptConversationUrl(input.conversationUrl) !== null;
}

export function hasGptUnavailableContentMessage(text: string): boolean {
  return GPT_UNAVAILABLE_CONTENT_PATTERN.test(text);
}

// This is intentionally narrower than the generic home-redirect recovery.
// It protects only a newly opened, recorded GPT image conversation before
// the first START_JOB message is sent, so a retry/continuation still submits
// its pending prompt after the original conversation URL is reopened.
export function shouldRetryOpenedGptImageConversation(input: {
  platform: JobPlatform;
  mode: JobMode;
  conversationUrl: string | null;
  currentUrl: string | undefined;
  hasUnavailableContent: boolean;
}): boolean {
  return input.platform === "gpt" &&
    input.mode === "image" &&
    input.hasUnavailableContent &&
    shouldRestoreGptConversation({
      conversationUrl: input.conversationUrl,
      currentUrl: input.currentUrl
    });
}
