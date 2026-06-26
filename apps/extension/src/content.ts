import { buildGeminiOutputPrompt, findLatestJobConversationScope } from "auto-chat-shared";
import type { AppConfig, ConversationTurnRole, Job } from "auto-chat-shared";
import { findGeminiSendControl, isGeminiSendDisabled } from "./gemini.js";
import { hasGeneratingText } from "./inspect.js";
import { submitPromptWithFallback } from "./submit.js";
import type { DebugInspectMessage, DebugInspectResult, JobProgressMessage, StartJobMessage } from "./types.js";

let activeJob: Job | null = null;
let config: AppConfig | null = null;
let monitorAbort: AbortController | null = null;
const ERROR_TEXT_PATTERN = /Something went wrong|Retry|Try again|出错|重试/i;
const INTERRUPTED_TEXT_PATTERN = /Connection interrupted|Waiting for the complete answer|连接中断|等待完整回答/i;
const MONITOR_INTERVAL_MS = 5000;
const TEXT_DONE_STABLE_MS = 1000;
const IMAGE_DONE_STABLE_MS = 2000;
const GEMINI_SINGLE_IMAGE_DONE_STABLE_MS = 2000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const typed = message as StartJobMessage | DebugInspectMessage;
  if (typed.type === "START_JOB") {
    const start = typed;
    void startJob(start.job, start.config)
      .then(() => sendResponse({ ok: true }))
      .catch(async error => {
        await report(start.job.id, "needs_manual", String(error));
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }
  if (typed.type === "DEBUG_INSPECT") {
    void debugInspect(typed.jobId).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  return false;
});

async function startJob(job: Job, nextConfig: AppConfig): Promise<void> {
  activeJob = job;
  config = nextConfig;
  monitorAbort?.abort();
  monitorAbort = new AbortController();

  if (isReloadOnly(job)) {
    await report(job.id, "waiting_generation");
    void monitorJob(job, nextConfig, monitorAbort.signal);
    return;
  }

  const existing = findJobAssistant(job.id);
  if (existing) {
    void monitorJob(job, nextConfig, monitorAbort.signal);
    return;
  }

  if (job.platform === "gemini" && job.mode === "image") {
    void runGeminiImageJob(job, nextConfig, monitorAbort.signal);
    return;
  }

  await report(job.id, "waiting_chat_ready");
  await waitForComposer();
  if (job.platform === "gpt") {
    await report(job.id, "uploading");
    await uploadSources(job);
    await report(job.id, "sending_prompt");
    await fillPromptAndSendGpt(job);
  } else {
    await fillPromptPasteSourcesAndSendGemini(job, job.prompt);
  }
  await report(job.id, "waiting_generation");
  void monitorJob(job, nextConfig, monitorAbort.signal);
}

async function runGeminiImageJob(job: Job, appConfig: AppConfig, signal: AbortSignal): Promise<void> {
  const images: Array<{ index: number; sourceId: string; dataUrl: string; contentType: string }> = [];
  const total = Math.max(1, job.expectedImageCount);

  try {
    for (let outputIndex = 1; outputIndex <= total; outputIndex += 1) {
      if (signal.aborted) return;
      if (outputIndex > 1) await startGeminiNewChat(appConfig);

      const prompt = total > 1
        ? buildGeminiOutputPrompt(job.prompt, outputIndex, geminiPrompts(job))
        : job.prompt;
      await report(job.id, "waiting_chat_ready");
      await waitForComposer();
      await fillPromptPasteSourcesAndSendGemini(job, prompt);
      await report(job.id, "waiting_generation");

      const image = await waitForGeminiSingleImage(job, appConfig, signal);
      images.push({ ...image, index: outputIndex - 1 });
      await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", images: [...images] });
    }

    await sendProgress({
      type: "JOB_PROGRESS",
      jobId: job.id,
      status: "done",
      images
    });
  } catch (error) {
    await report(job.id, "failed_retryable", String(error));
  }
}

function geminiPrompts(job: Job): string[] | undefined {
  const value = job.metadata.geminiPrompts;
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
  return value;
}

function isReloadOnly(job: Job): boolean {
  return job.metadata.autoChatReloadOnly === true;
}

async function waitForGeminiSingleImage(
  job: Job,
  appConfig: AppConfig,
  signal: AbortSignal
): Promise<{ index: number; sourceId: string; dataUrl: string; contentType: string }> {
  const startedAt = Date.now();
  let lastSignature = "";
  let lastChangedAt = Date.now();
  let maybeDoneAt = 0;

  while (!signal.aborted) {
    const state = await inspectJob(job.id);
    if (state.signature !== lastSignature) {
      lastSignature = state.signature;
      lastChangedAt = Date.now();
      maybeDoneAt = 0;
    }

    if (state.hasError) throw new Error(state.errorText || "Gemini returned an error.");
    if (state.isInterrupted) throw new Error(state.interruptedText || "Gemini response was interrupted.");
    if (Date.now() - startedAt > appConfig.hardTimeoutMs) throw new Error("Job exceeded hard timeout.");
    if (Date.now() - lastChangedAt > appConfig.stallTimeoutMs) throw new Error("No visible progress before stall timeout.");

    if (state.loadedImages.length >= 1 && !state.isGenerating) {
      if (!maybeDoneAt) {
        maybeDoneAt = Date.now();
        await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", signature: state.signature });
      }
      if (Date.now() - maybeDoneAt > GEMINI_SINGLE_IMAGE_DONE_STABLE_MS) {
        const [image] = await collectImages(state.loadedImages.slice(0, 1));
        if (!image) throw new Error("Gemini image was visible but could not be collected.");
        return image;
      }
    }

    await sleep(MONITOR_INTERVAL_MS);
  }

  throw new Error("Gemini job was aborted.");
}

async function startGeminiNewChat(appConfig: AppConfig): Promise<void> {
  const newChat = findVisibleElement<HTMLAnchorElement>('a[aria-label="New chat"], a[data-test-id="side-nav-sparkle-button"], a[href="/app"]');
  if (newChat) {
    newChat.click();
  } else if (!location.href.startsWith(appConfig.geminiUrl)) {
    location.href = appConfig.geminiUrl;
  } else {
    history.pushState(null, "", "/app");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  await sleep(1500);
  await waitForComposer();
}

async function monitorJob(job: Job, appConfig: AppConfig, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let lastSignature = "";
  let lastChangedAt = Date.now();
  let maybeDoneAt = 0;

  try {
    while (!signal.aborted) {
      const state = await inspectJob(job.id);
      if (state.signature !== lastSignature) {
        lastSignature = state.signature;
        lastChangedAt = Date.now();
        maybeDoneAt = 0;
      }

      if (state.hasError) {
        await report(job.id, "failed_retryable", state.errorText);
        return;
      }

      if (state.isInterrupted) {
        await report(job.id, "stalled", state.interruptedText || "Connection interrupted while waiting for the complete answer.");
        return;
      }

      if (Date.now() - startedAt > appConfig.hardTimeoutMs) {
        await report(job.id, "needs_manual", "Job exceeded hard timeout.");
        return;
      }

      if (Date.now() - lastChangedAt > appConfig.stallTimeoutMs) {
        await report(job.id, "stalled", "No visible progress before stall timeout.");
        return;
      }

      if (job.mode === "text" && state.assistantText.trim() && !state.isGenerating) {
        if (!maybeDoneAt) {
          maybeDoneAt = Date.now();
          await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", signature: state.signature });
        }
        if (Date.now() - maybeDoneAt > TEXT_DONE_STABLE_MS) {
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "done",
            signature: state.signature,
            text: await collectTextResponse(job.id, state.assistantText)
          });
          return;
        }
      }

      const enoughImages = state.loadedImages.length >= job.expectedImageCount;
      if (job.mode === "image" && enoughImages && !state.isGenerating) {
        if (!maybeDoneAt) {
          maybeDoneAt = Date.now();
          await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", signature: state.signature });
        }
        if (Date.now() - maybeDoneAt > IMAGE_DONE_STABLE_MS) {
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "done",
            signature: state.signature,
            images: await collectImages(state.loadedImages.slice(0, job.expectedImageCount))
          });
          return;
        }
      }

      await sleep(MONITOR_INTERVAL_MS);
    }
  } catch (error) {
    await report(job.id, "failed_retryable", String(error));
  }
}

async function inspectJob(jobId: string): Promise<{
  hasError: boolean;
  errorText: string;
  isInterrupted: boolean;
  interruptedText: string;
  isGenerating: boolean;
  assistantText: string;
  loadedImages: HTMLImageElement[];
  scopedImages: HTMLImageElement[];
  pageImages: HTMLImageElement[];
  signature: string;
}> {
  const assistant = findJobAssistant(jobId);
  const scopedImages = findJobScopedImages(jobId);
  const pageImages = findLoadedImages(document);
  if (!assistant) {
    const text = document.body.innerText;
    const jobText = findJobScopeText(jobId);
    const hasError = ERROR_TEXT_PATTERN.test(jobText);
    const isInterrupted = INTERRUPTED_TEXT_PATTERN.test(jobText);
    return {
      hasError,
      errorText: hasError ? jobText.slice(0, 500) : "",
      isInterrupted,
      interruptedText: isInterrupted ? jobText.slice(0, 500) : "",
      isGenerating: hasGeneratingText(text),
      assistantText: "",
      loadedImages: scopedImages,
      scopedImages,
      pageImages,
      signature: `no-assistant:${text.length}:${scopedImages.length}:${pageImages.length}`
    };
  }

  const text = assistant.innerText || "";
  const jobText = findJobScopeText(jobId);
  const hasError = ERROR_TEXT_PATTERN.test(`${text}\n${jobText}`);
  const isInterrupted = INTERRUPTED_TEXT_PATTERN.test(`${text}\n${jobText}`);
  const isGenerating =
    hasGeneratingText(text) ||
    Boolean(assistant.querySelector('[aria-busy="true"], [data-testid*="loading"], .animate-pulse'));
  const assistantImages = findGeneratedImagesInOrder(assistant);
  const loadedImages = uniqueImages([...assistantImages, ...scopedImages]);
  return {
    hasError,
    errorText: hasError ? text.slice(0, 500) : "",
    isInterrupted,
    interruptedText: isInterrupted ? jobText.slice(0, 500) : "",
    isGenerating,
    assistantText: extractAssistantText(assistant),
    loadedImages,
    scopedImages,
    pageImages,
    signature: `${text.length}:${loadedImages.length}:${scopedImages.length}:${pageImages.length}:${isGenerating}:${assistant.querySelectorAll("button,a").length}`
  };
}

async function debugInspect(jobId?: string): Promise<DebugInspectResult> {
  const resolvedJobId = jobId ?? activeJob?.id ?? findLatestJobId();
  const pageJobId = findLatestJobId();
  if (!resolvedJobId) {
    return {
      ok: true,
      jobId: null,
      pageJobId,
      url: location.href,
      hasJobAssistant: false,
      hasError: false,
      isInterrupted: false,
      isGenerating: hasGeneratingText(document.body.innerText),
      loadedImages: findLoadedImages(document).length,
      scopedImages: 0,
      pageImages: findLoadedImages(document).length,
      expectedImages: activeJob?.expectedImageCount ?? null,
      signature: `no-job:${document.body.innerText.length}`
    };
  }

  const state = await inspectJob(resolvedJobId);
  return {
    ok: true,
    jobId: resolvedJobId,
    pageJobId,
    url: location.href,
    hasJobAssistant: Boolean(findJobAssistant(resolvedJobId)),
    hasError: state.hasError,
    isInterrupted: state.isInterrupted,
    isGenerating: state.isGenerating,
    loadedImages: state.loadedImages.length,
    scopedImages: state.scopedImages.length,
    pageImages: state.pageImages.length,
    expectedImages: activeJob?.id === resolvedJobId ? activeJob.expectedImageCount : null,
    signature: state.signature,
    errorText: state.errorText
  };
}

function findLatestJobId(): string | null {
  const matches = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user'], section[data-turn='user'], user-query")]
    .map(node => (node.innerText || "").match(/JOB_ID:\s*([^\s]+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return matches.at(-1) ?? null;
}

function findJobAssistant(jobId: string): HTMLElement | null {
  return findJobConversationScope(jobId)?.assistant ?? null;
}

function findJobScopedImages(jobId: string): HTMLImageElement[] {
  const scope = findJobConversationScope(jobId);
  if (!scope) return [];

  return findLoadedImages(document).filter(img =>
    isAfter(img, scope.user) && (!scope.nextUser || isBefore(img, scope.nextUser))
  );
}

function findJobScopeText(jobId: string): string {
  const scope = findJobConversationScope(jobId);
  if (!scope) return "";

  const turns = findConversationTurns();
  const scopedTurns = turns.filter(node =>
    (node === scope.user || isAfter(node, scope.user)) &&
    (!scope.nextUser || node === scope.nextUser || isBefore(node, scope.nextUser)) &&
    node !== scope.nextUser
  );

  return scopedTurns.map(node => node.innerText || "").join("\n");
}

function findJobConversationScope(jobId: string): { user: HTMLElement; assistant: HTMLElement | null; nextUser: HTMLElement | null } | null {
  const turns = findConversationTurns();
  const scope = findLatestJobConversationScope(turns.map(turn => ({
    role: conversationTurnRole(turn),
    text: turn.innerText || ""
  })), jobId);
  if (!scope) return null;

  return {
    user: turns[scope.userIndex]!,
    assistant: scope.assistantIndex === null ? null : turns[scope.assistantIndex]!,
    nextUser: scope.nextUserIndex === null ? null : turns[scope.nextUserIndex]!
  };
}

function conversationTurnRole(node: HTMLElement): ConversationTurnRole {
  if (isUserTurn(node)) return "user";
  if (isAssistantTurn(node)) return "assistant";
  return "other";
}

function findLoadedImages(root: ParentNode): HTMLImageElement[] {
  return uniqueImages([...findGeneratedImagesInOrder(root), ...findGeneratedImageElements(root)]);
}

function findGeneratedImagesInOrder(root: ParentNode): HTMLImageElement[] {
  const cards = [...root.querySelectorAll<HTMLElement>(".group\\/imagegen-image, [id^='image-'], generated-image, single-image")];
  const images = cards
    .map(card => findGeneratedImageElements(card)[0])
    .filter((image): image is HTMLImageElement => Boolean(image));
  return uniqueImages(images);
}

function findGeneratedImageElements(root: ParentNode): HTMLImageElement[] {
  return [...root.querySelectorAll("img")]
    .filter(img => {
      const src = img.currentSrc || img.src;
      const attrWidth = Number(img.getAttribute("width") ?? 0);
      const attrHeight = Number(img.getAttribute("height") ?? 0);
      const width = img.naturalWidth || attrWidth || img.width;
      const height = img.naturalHeight || attrHeight || img.height;
      const largeEnough = width > 100 && height > 100;
      const hasEstuarySource = /\/backend-api\/estuary\/content/i.test(src);
      const hasGeminiBlob = /^blob:https:\/\/gemini\.google\.com\//i.test(src);
      const hasGeneratedAlt = /Generated image/i.test(img.alt);
      const hasGeminiGeneratedAlt = /AI generated/i.test(img.alt);
      const isDecorative = /gstatic\.com\/lamda\/images\/gemini|googleusercontent\.com\/a\//i.test(src);
      return Boolean(src) && !isDecorative && (hasEstuarySource || hasGeminiBlob || ((hasGeneratedAlt || hasGeminiGeneratedAlt) && largeEnough));
    });
}

function extractAssistantText(assistant: HTMLElement): string {
  const message = assistant.querySelector<HTMLElement>("[data-message-author-role='assistant']");
  const geminiMessage = assistant.querySelector<HTMLElement>("message-content .markdown, .model-response-text .markdown");
  const markdown = message?.querySelector<HTMLElement>(".markdown") ?? geminiMessage;
  return (
    (markdown ? serializeRichText(markdown) : "") ||
    message?.innerText ||
    assistant.innerText ||
    ""
  ).trim();
}

function serializeRichText(root: HTMLElement): string {
  return [...root.childNodes]
    .map(node => serializeBlock(node))
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function serializeBlock(node: Node, listIndex?: number): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeInline(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "pre") return serializeCodeBlock(node);
  if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${serializeInlineChildren(node)}`.trim();
  if (tag === "blockquote") {
    return serializeRichText(node)
      .split("\n")
      .map(line => line ? `> ${line}` : ">")
      .join("\n");
  }
  if (tag === "ul" || tag === "ol") return serializeList(node, tag === "ol");
  if (tag === "li") {
    const marker = listIndex === undefined ? "-" : `${listIndex}.`;
    return `${marker} ${serializeInlineChildren(node)}`.trim();
  }
  if (tag === "table") return serializeTable(node);
  if (tag === "p") return serializeInlineChildren(node);

  return isBlockElement(node) ? serializeRichText(node) : serializeInlineNode(node);
}

function serializeList(list: HTMLElement, ordered: boolean): string {
  return [...list.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === "li")
    .map((item, index) => serializeBlock(item, ordered ? index + 1 : undefined))
    .filter(Boolean)
    .join("\n");
}

function serializeCodeBlock(pre: HTMLElement): string {
  const code = pre.querySelector<HTMLElement>("code");
  const text = (code?.innerText || pre.innerText || "").replace(/\n+$/g, "");
  return `\`\`\`\n${text}\n\`\`\``;
}

function serializeTable(table: HTMLElement): string {
  const rows = [...table.querySelectorAll("tr")]
    .map(row => [...row.children].map(cell => normalizeInline((cell as HTMLElement).innerText || "")).join(" | "))
    .filter(Boolean);
  return rows.join("\n");
}

function serializeInlineChildren(element: HTMLElement): string {
  return [...element.childNodes].map(serializeInlineNode).join("").replace(/[ \t]+\n/g, "\n").trim();
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeInline(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "code" && node.closest("pre") === null) return `\`${node.innerText.trim()}\``;
  if (tag === "a") {
    const text = serializeInlineChildren(node) || node.innerText.trim();
    const href = node.getAttribute("href");
    return href && text && href !== text ? `${text} (${href})` : text;
  }
  if (tag === "ul" || tag === "ol" || tag === "pre" || tag === "table" || isBlockElement(node)) {
    return `\n${serializeBlock(node)}\n`;
  }
  return serializeInlineChildren(node);
}

function isBlockElement(element: HTMLElement): boolean {
  return /^(article|aside|div|figure|figcaption|footer|header|main|nav|section)$/.test(element.tagName.toLowerCase());
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function collectTextResponse(jobId: string, fallbackText: string): Promise<string> {
  const assistant = findJobAssistant(jobId);
  if (!assistant) throw new Error("Assistant response was not found.");
  const copyButton = findCopyResponseButton(assistant);
  if (copyButton) {
    copyButton.click();
    await sleep(300);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const text = await readClipboardText();
      if (text?.trim() && !isAutoChatClipboardText(text)) return text;
      await sleep(200);
    }
  }

  throw new Error(copyButton ? "Copy response produced empty clipboard text." : "Copy response button was not found.");
}

function isAutoChatClipboardText(text: string): boolean {
  return /^auto-chat(?:\s|$)/i.test(text.trim());
}

async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function findCopyResponseButton(assistant: HTMLElement): HTMLButtonElement | null {
  const buttons = [...assistant.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    return isVisible(button) &&
      button.getAttribute("data-testid") === "copy-turn-action-button" &&
      /copy response/i.test(label);
  }) ?? buttons.find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    return isVisible(button) && /copy response|copy/i.test(label) && !/copy image|copy prompt/i.test(label);
  }) ?? null;
}

function uniqueImages(images: HTMLImageElement[]): HTMLImageElement[] {
  const seen = new Set<string>();
  const unique: HTMLImageElement[] = [];
  for (const image of images) {
    const key = imageKey(image);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(image);
  }
  return unique;
}

function imageKey(image: HTMLImageElement): string {
  const src = image.currentSrc || image.src;
  try {
    const url = new URL(src, location.href);
    return url.searchParams.get("id") ?? src;
  } catch {
    return src;
  }
}

function findJobUserTurn(jobId: string): HTMLElement | null {
  const message = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user'], user-query")]
    .find(node => (node.innerText || "").includes(`JOB_ID: ${jobId}`));
  return message?.closest<HTMLElement>("section[data-turn='user'], [data-turn='user'], [data-testid^='conversation-turn'], user-query") ?? message ?? null;
}

function findConversationTurns(): HTMLElement[] {
  const sectionTurns = [...document.querySelectorAll<HTMLElement>("section[data-turn]")];
  if (sectionTurns.length > 0) return sectionTurns;
  const geminiTurns = [...document.querySelectorAll<HTMLElement>("user-query, model-response")];
  if (geminiTurns.length > 0) return geminiTurns;
  return [...document.querySelectorAll<HTMLElement>("[data-message-author-role]")];
}

function isUserTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "user" ||
    node.getAttribute("data-message-author-role") === "user" ||
    node.tagName.toLowerCase() === "user-query" ||
    Boolean(node.querySelector("[data-message-author-role='user']"));
}

function isAssistantTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "assistant" ||
    node.getAttribute("data-message-author-role") === "assistant" ||
    node.tagName.toLowerCase() === "model-response" ||
    Boolean(node.querySelector("[data-message-author-role='assistant'], .agent-turn"));
}

function isAfter(node: Node, reference: Node): boolean {
  return Boolean(reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function isBefore(node: Node, reference: Node): boolean {
  return Boolean(reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
}

async function waitForComposer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (findComposer()) return;
    await sleep(500);
  }
  throw new Error(`${activeJob?.platform === "gemini" ? "Gemini" : "ChatGPT"} composer was not found.`);
}

async function uploadSources(job: Job): Promise<void> {
  if (job.sourceImages.length === 0) return;
  let input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input && job.platform === "gemini") {
    findUploadMenuButton()?.click();
    await sleep(500);
    input = document.querySelector<HTMLInputElement>('input[type="file"]');
  }
  if (!input) throw new Error("File input was not found.");
  const files = await Promise.all(job.sourceImages.map((source, index) => sourceToFile(source, index)));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(1500);
}

async function pasteGeminiSources(job: Job, composer: HTMLElement | HTMLTextAreaElement): Promise<void> {
  if (job.sourceImages.length === 0) return;
  const files = await Promise.all(job.sourceImages.map((source, index) => sourceToFile(source, index)));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: transfer
  });
  composer.focus();
  composer.dispatchEvent(event);
  await sleep(500);
}

async function fillPromptAndSendGpt(job: Job): Promise<void> {
  const { prompt } = job;
  const composer = fillPrompt(prompt);
  await sleep(300);
  const sendButton = findSendButton();
  if (await submitPromptWithFallback({
    composer,
    sendButton,
    getSendButton: findSendButton,
    isSubmitted: () => isPromptSubmitted(prompt),
    onWaitingForSubmitReady: () => report(job.id, "waiting_upload_ready"),
    sleep
  })) return;

  throw new Error(`Prompt was filled but no submitted ${activeJob?.platform === "gemini" ? "Gemini" : "ChatGPT"} user turn appeared.`);
}

async function fillPromptAndSendOriginal(prompt: string): Promise<void> {
  const composer = fillPrompt(prompt);
  await sleep(300);
  const sendButton = findSendButton();
  if (sendButton) {
    sendButton.click();
  } else {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }
  await waitForPromptSubmitted(prompt);
}

async function fillPromptPasteSourcesAndSendGemini(job: Job, prompt: string): Promise<void> {
  await report(job.id, "sending_prompt");
  const composer = fillPrompt(prompt);
  if (job.sourceImages.length > 0) {
    await report(job.id, "uploading");
    await pasteGeminiSources(job, composer);
    await waitForGeminiUploadReady(job.id);
  }

  if (await submitGeminiPromptWithFallback(job, composer, prompt)) return;
  if (job.sourceImages.length > 0) {
    throw new Error("Gemini send control was not ready after image upload.");
  }

  throw new Error(`Prompt was filled but no submitted Gemini user turn appeared.`);
}

async function submitGeminiPromptWithFallback(
  job: Job,
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string
): Promise<boolean> {
  let reportedWaiting = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sendControl = findGeminiSendControl();
    if (sendControl && !isGeminiSendDisabled(sendControl)) {
      clickGeminiSendControl(sendControl);
      if (await waitForSubmittedPrompt(prompt, 4, 250)) return true;
    } else if (!reportedWaiting) {
      reportedWaiting = true;
      await report(job.id, "waiting_upload_ready");
    }

    dispatchGeminiEnter(composer);
    if (await waitForSubmittedPrompt(prompt, 2, 250)) return true;
    await sleep(250);
  }

  return false;
}

function clickGeminiSendControl(control: HTMLElement): void {
  const target = control.querySelector<HTMLElement>("button:not([disabled]), [role='button']:not([aria-disabled='true'])") ?? control;
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.click();
}

function dispatchGeminiEnter(composer: HTMLElement | HTMLTextAreaElement): void {
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  composer.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
}

async function waitForSubmittedPrompt(prompt: string, attempts: number, delayMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isPromptSubmitted(prompt)) return true;
    await sleep(delayMs);
  }
  return false;
}

async function waitForGeminiUploadReady(jobId: string): Promise<void> {
  await report(jobId, "waiting_upload_ready");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const sendControl = findGeminiSendControl();
    if (sendControl && !isGeminiSendDisabled(sendControl)) return;
    await sleep(500);
  }
  throw new Error("Gemini image upload did not finish before timeout.");
}

function fillPrompt(prompt: string): HTMLElement | HTMLTextAreaElement {
  const composer = findComposer();
  if (!composer) throw new Error("Composer was not found.");
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    composer.value = prompt;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    selectEditableContents(composer);
    if (!document.execCommand("insertText", false, prompt)) {
      composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    }
  }
  return composer;
}

function findComposer(): HTMLElement | HTMLTextAreaElement | null {
  return findVisibleElement<HTMLElement>('[contenteditable="true"][aria-label="Enter a prompt for Gemini"]') ||
    findVisibleElement<HTMLElement>("rich-textarea .ql-editor[role='textbox']") ||
    findVisibleElement<HTMLElement>('[contenteditable="true"][role="textbox"]') ||
    findVisibleElement<HTMLElement>('[contenteditable="true"]') ||
    findVisibleElement<HTMLTextAreaElement>("textarea");
}

function findSendButton(): HTMLButtonElement | null {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    const testId = button.getAttribute("data-testid") ?? "";
    return isVisible(button) &&
      (/send|submit|发送/i.test(label) || testId.includes("send")) &&
      !/stop|microphone|麦克风/i.test(label) &&
      testId !== "stop-button";
  }) ?? null;
}

function findUploadMenuButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => {
      const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
      return isVisible(button) && /upload and tools|上传/i.test(label);
    }) ?? null;
}

function selectEditableContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findVisibleElement<T extends HTMLElement>(selector: string): T | null {
  return [...document.querySelectorAll<T>(selector)].find(isVisible) ?? null;
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0";
}

async function isPromptSubmitted(prompt: string): Promise<boolean> {
  const jobId = prompt.match(/JOB_ID:\s*([^\s]+)/)?.[1];
  return !jobId || Boolean(findJobUserTurn(jobId));
}

async function waitForPromptSubmitted(prompt: string): Promise<void> {
  const jobId = prompt.match(/JOB_ID:\s*([^\s]+)/)?.[1];
  if (!jobId) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (findJobUserTurn(jobId)) return;
    await sleep(500);
  }
  throw new Error(`Prompt was filled but no submitted ${activeJob?.platform === "gemini" ? "Gemini" : "ChatGPT"} user turn appeared.`);
}

async function sourceToFile(source: string, index: number): Promise<File> {
  const response = await fetch(source);
  const blob = await response.blob();
  const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
  return new File([blob], `source-${index + 1}.${ext}`, { type: blob.type || "image/png" });
}

async function collectImages(images: HTMLImageElement[]): Promise<Array<{ index: number; sourceId: string; dataUrl: string; contentType: string }>> {
  const result = [];
  for (const [index, image] of images.entries()) {
    const response = await fetch(image.currentSrc || image.src);
    const blob = await response.blob();
    result.push({
      index,
      sourceId: imageKey(image),
      contentType: blob.type || "image/png",
      dataUrl: await blobToDataUrl(blob)
    });
  }
  return result;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function report(jobId: string, status: JobProgressMessage["status"], errorMessage?: string): Promise<void> {
  await sendProgress({ type: "JOB_PROGRESS", jobId, status, errorMessage });
}

async function sendProgress(message: JobProgressMessage): Promise<void> {
  await chrome.runtime.sendMessage(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
