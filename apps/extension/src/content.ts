import type { AppConfig, Job } from "@wechat-topic/shared";
import type { DebugInspectMessage, DebugInspectResult, JobProgressMessage, StartJobMessage } from "./types.js";

let activeJob: Job | null = null;
let config: AppConfig | null = null;
let monitorAbort: AbortController | null = null;
const ERROR_TEXT_PATTERN = /Something went wrong|Retry|Try again|出错|重试/i;
const GENERATING_TEXT_PATTERN = /Thinking|Generating a more detailed image|hang tight|正在生成|生成中/i;
const INTERRUPTED_TEXT_PATTERN = /Connection interrupted|Waiting for the complete answer|连接中断|等待完整回答/i;
const MONITOR_INTERVAL_MS = 5000;

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

  const existing = findJobAssistant(job.id);
  if (existing) {
    void monitorJob(job, nextConfig, monitorAbort.signal);
    return;
  }

  await report(job.id, "waiting_chat_ready");
  await waitForComposer();
  await report(job.id, "uploading");
  await uploadSources(job);
  await report(job.id, "sending_prompt");
  await fillPromptAndSend(job.prompt);
  await report(job.id, "waiting_generation");
  void monitorJob(job, nextConfig, monitorAbort.signal);
}

async function monitorJob(job: Job, appConfig: AppConfig, signal: AbortSignal): Promise<void> {
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
      if (Date.now() - maybeDoneAt > 3000) {
        await sendProgress({
          type: "JOB_PROGRESS",
          jobId: job.id,
          status: "done",
          signature: state.signature,
          text: await collectTextResponse(job.id)
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
      if (Date.now() - maybeDoneAt > 8000) {
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
      isGenerating: GENERATING_TEXT_PATTERN.test(text),
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
    GENERATING_TEXT_PATTERN.test(text) ||
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
      isGenerating: GENERATING_TEXT_PATTERN.test(document.body.innerText),
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
  const matches = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user'], section[data-turn='user']")]
    .map(node => (node.innerText || "").match(/JOB_ID:\s*([^\s]+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return matches.at(-1) ?? null;
}

function findJobAssistant(jobId: string): HTMLElement | null {
  const userTurn = findJobUserTurn(jobId);
  if (!userTurn) return null;

  const turns = findConversationTurns();
  for (const turn of turns) {
    if (isAfter(turn, userTurn) && isAssistantTurn(turn)) return turn;
  }
  return null;
}

function findJobScopedImages(jobId: string): HTMLImageElement[] {
  const user = findJobUserTurn(jobId);
  if (!user) return [];

  const nextUser = findNextUserTurn(user);
  return findLoadedImages(document).filter(img =>
    isAfter(img, user) && (!nextUser || isBefore(img, nextUser))
  );
}

function findJobScopeText(jobId: string): string {
  const user = findJobUserTurn(jobId);
  if (!user) return "";

  const turns = findConversationTurns();
  const nextUser = findNextUserTurn(user);
  const scopedTurns = turns.filter(node =>
    (node === user || isAfter(node, user)) &&
    (!nextUser || node === nextUser || isBefore(node, nextUser)) &&
    node !== nextUser
  );

  return scopedTurns.map(node => node.innerText || "").join("\n");
}

function findNextUserTurn(user: HTMLElement): HTMLElement | undefined {
  return findConversationTurns().find(node =>
    node !== user &&
    isUserTurn(node) &&
    isAfter(node, user)
  );
}

function findLoadedImages(root: ParentNode): HTMLImageElement[] {
  return uniqueImages([...findGeneratedImagesInOrder(root), ...findGeneratedImageElements(root)]);
}

function findGeneratedImagesInOrder(root: ParentNode): HTMLImageElement[] {
  const cards = [...root.querySelectorAll<HTMLElement>(".group\\/imagegen-image, [id^='image-']")];
  const images = cards
    .map(card => findGeneratedImageElements(card)[0])
    .filter((image): image is HTMLImageElement => Boolean(image));
  return uniqueImages(images);
}

function findGeneratedImageElements(root: ParentNode): HTMLImageElement[] {
  return [...root.querySelectorAll("img")]
    .filter(img => {
      const naturalLargeEnough = img.naturalWidth > 100 && img.naturalHeight > 100;
      const hasGeneratedSource = /\/backend-api\/estuary\/content|Generated image/i.test(`${img.currentSrc || img.src} ${img.alt}`);
      return img.complete && naturalLargeEnough && hasGeneratedSource && Boolean(img.currentSrc || img.src);
    });
}

function extractAssistantText(assistant: HTMLElement): string {
  const message = assistant.querySelector<HTMLElement>("[data-message-author-role='assistant']");
  return (message?.innerText || assistant.innerText || "").trim();
}

async function collectTextResponse(jobId: string): Promise<string> {
  const assistant = findJobAssistant(jobId);
  if (!assistant) throw new Error("Assistant response was not found.");
  const copyButton = findCopyResponseButton(assistant);
  if (!copyButton) throw new Error("Copy response button was not found.");
  copyButton.click();
  await sleep(300);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const text = await navigator.clipboard.readText();
    if (text.trim()) return text;
    await sleep(200);
  }
  throw new Error("Copy response produced empty clipboard text.");
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
    return isVisible(button) && /copy response/i.test(label);
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
  const message = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user']")]
    .find(node => (node.innerText || "").includes(`JOB_ID: ${jobId}`));
  return message?.closest<HTMLElement>("section[data-turn='user'], [data-turn='user'], [data-testid^='conversation-turn']") ?? message ?? null;
}

function findConversationTurns(): HTMLElement[] {
  const sectionTurns = [...document.querySelectorAll<HTMLElement>("section[data-turn]")];
  if (sectionTurns.length > 0) return sectionTurns;
  return [...document.querySelectorAll<HTMLElement>("[data-message-author-role]")];
}

function isUserTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "user" ||
    node.getAttribute("data-message-author-role") === "user" ||
    Boolean(node.querySelector("[data-message-author-role='user']"));
}

function isAssistantTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "assistant" ||
    node.getAttribute("data-message-author-role") === "assistant" ||
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
  throw new Error("ChatGPT composer was not found.");
}

async function uploadSources(job: Job): Promise<void> {
  if (job.sourceImages.length === 0) return;
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("File input was not found.");
  const files = await Promise.all(job.sourceImages.map((source, index) => sourceToFile(source, index)));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(1500);
}

async function fillPromptAndSend(prompt: string): Promise<void> {
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
  await sleep(300);
  const sendButton = findSendButton();
  if (sendButton) {
    sendButton.click();
  } else {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }
  await waitForPromptSubmitted(prompt);
}

function findComposer(): HTMLElement | HTMLTextAreaElement | null {
  return findVisibleElement<HTMLElement>('[contenteditable="true"][role="textbox"]') ||
    findVisibleElement<HTMLElement>('[contenteditable="true"]') ||
    findVisibleElement<HTMLTextAreaElement>("textarea");
}

function findSendButton(): HTMLButtonElement | null {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  return buttons.find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    const testId = button.getAttribute("data-testid") ?? "";
    return isVisible(button) &&
      !button.disabled &&
      (/send|发送/i.test(label) || testId.includes("send")) &&
      !/stop/i.test(label) &&
      testId !== "stop-button";
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

async function waitForPromptSubmitted(prompt: string): Promise<void> {
  const jobId = prompt.match(/JOB_ID:\s*([^\s]+)/)?.[1];
  if (!jobId) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (findJobUserTurn(jobId)) return;
    await sleep(500);
  }
  throw new Error("Prompt was filled but no submitted ChatGPT user turn appeared.");
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
