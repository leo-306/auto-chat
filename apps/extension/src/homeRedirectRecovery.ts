export function isGptConversationPath(pathname: string): boolean {
  return pathname.startsWith("/c/");
}

export function shouldReloadCapturedConversation(input: {
  capturedUrl: string | null;
  currentPathname: string;
}): boolean {
  return Boolean(input.capturedUrl) && !isGptConversationPath(input.currentPathname);
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
  try {
    return isGptConversationPath(new URL(input.conversationUrl).pathname);
  } catch {
    return false;
  }
}
