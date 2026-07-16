export function isGptConversationPath(pathname: string): boolean {
  return pathname.startsWith("/c/");
}

export function shouldReloadCapturedConversation(input: {
  capturedUrl: string | null;
  currentPathname: string;
}): boolean {
  return Boolean(input.capturedUrl) && !isGptConversationPath(input.currentPathname);
}
