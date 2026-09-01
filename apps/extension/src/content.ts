import { buildGeminiOutputPrompt, findLatestJobConversationScope } from "auto-chat-shared";
import type { AppConfig, ConversationTurnRole, Job, JobPlatform } from "auto-chat-shared";
import { findGeminiSendControl, isGeminiSendDisabled } from "./gemini.js";
import {
  isGeminiModelApplied,
  isGeminiModelTriggerLabel,
  matchGeminiModelOption,
  readGeminiModel
} from "./geminiModel.js";
import {
  isGeminiVideoModeChipLabel,
  isGeminiVideoPlaceholder,
  isGeminiVideoRatioApplied,
  isGeminiVideoReferenceButtonLabel,
  isGeminiVideoToolLabel,
  matchGeminiVideoRatioOption,
  readGeminiVideoRatio
} from "./geminiVideo.js";
import { answerGptImagePreferenceComparisons } from "./gptPreference.js";
import {
  doubaoModelTriggerName,
  isDoubaoModelSelected,
  matchDoubaoModelOption,
  readDoubaoModel
} from "./doubaoModel.js";
import {
  clampDurationSeconds,
  DOUBAO_VIDEO_MIN_DURATION_SECONDS,
  isDoubaoAttachButtonLabel,
  isDoubaoAttachControlKey,
  isDoubaoVideoConfirmLabel,
  isDoubaoVideoParamsApplied,
  matchDoubaoVideoRatioOption,
  parseDoubaoVideoParamsTrigger,
  readDoubaoVideoDurationSeconds,
  readDoubaoVideoRatio
} from "./doubaoVideo.js";
import {
  DOUBAO_FALLBACK_API_MESSAGE,
  DOUBAO_VIDEO_DIAG_MESSAGE,
  isAllowedFallbackApiUrl,
  matchResolvedVideo,
  videoIdOf,
  videoObjectIdOf
} from "./doubaoVideoWatermark.js";
import type { DoubaoResolvedVideo, DoubaoVideoMatch, DoubaoVideoTarget } from "./doubaoVideoWatermark.js";
import {
  hasGptUnavailableContentMessage,
  isGptConversationPath,
  normalizeGptConversationUrl,
  shouldReloadCapturedConversation
} from "./homeRedirectRecovery.js";
import {
  DOUBAO_BRAND_BLUE,
  DOUBAO_PREVIEW_MARKER_SELECTOR,
  hasDoubaoDownloadIcon,
  hasDoubaoVideoDownloadIcon,
  isDoubaoDownloadControl
} from "./imageDownload.js";
import { hasGeneratingText, isGenerationStopControl } from "./inspect.js";
import {
  detectMediaBlock,
  hasExplicitGenerationError,
  MEDIA_BLOCK_MAX_TEXT_LENGTH,
  selectGptErrorRefresh,
  selectMonitorStallRecovery,
  selectStuckGptImageStopRecovery,
  shouldCompleteImageJob,
  shouldCompleteVideoJob,
  shouldClickDoubaoVideoConfirm,
  shouldFailCompletedDoubaoImageJob,
  shouldGiveUpOnMediaBlock,
  shouldGiveUpOnMissingDoubaoImages,
  shouldRetryGptImageGenerationInPage,
  shouldResubmitEmptyGptImage,
  shouldStopGptImageGeneration
} from "./monitor.js";
import {
  selectPostRefreshPromptAction,
  shouldCheckEmptyAssistantRecovery,
  shouldMonitorWithoutSubmit,
  shouldRetryReloadWithoutJobTurn,
  waitForEmptyAssistantRecovery
} from "./recovery.js";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";
import { waitForStableReadiness } from "./readiness.js";
import { submitPromptWithFallback } from "./submit.js";
import type {
  DebugInspectMessage,
  DebugInspectResult,
  GptExistingConversationRedirectCheckMessage,
  GptExistingConversationRedirectCheckResult,
  JobProgressMessage,
  JobTraceMessage,
  StartJobMessage
} from "./types.js";

let activeJob: Job | null = null;
let config: AppConfig | null = null;
let monitorAbort: AbortController | null = null;
const INTERRUPTED_TEXT_PATTERN = /Connection interrupted|Waiting for the complete answer|连接中断|等待完整回答/i;
const MONITOR_INTERVAL_MS = 5000;
const TEXT_DONE_STABLE_MS = 1000;
const IMAGE_DONE_STABLE_MS = 2000;
const VIDEO_DONE_STABLE_MS = 2000;
const GEMINI_SINGLE_IMAGE_DONE_STABLE_MS = 2000;
const EMPTY_GPT_IMAGE_RECOVERY_DELAY_MS = 10_000;
// Gemini can take longer than the generic stall threshold to render a
// single image, so its dedicated loop keeps a larger lower bound.
const GEMINI_IMAGE_STALL_MIN_MS = 480_000;
const answeredGptImagePreferenceComparisons = new WeakSet<HTMLElement>();

type CollectedImage = {
  index: number;
  sourceId: string;
  dataUrl: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  acquisition: "gpt_direct" | "gpt_share_sheet" | "gemini_download" | "doubao_download" | "element_url";
};

type CollectedVideo = {
  index: number;
  sourceId: string;
  dataUrl: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  acquisition: "doubao_video_download" | "doubao_video_unwatermarked" | "gemini_video_download";
};

type DownloadedVideo = { blob: Blob; acquisition: CollectedVideo["acquisition"] };

// 无水印视频要用的 fallback_api 地址只有主世界看得到（在 doubaoWatermarkPage.ts 里从接口
// 响应里收集），通过 postMessage 递到这里。一条聊天记录里往前翻会有好几条视频，所以顺序
// 不当依据：收齐之后交给 background 全部解成元信息，用的时候按宽高/时长对号。
const doubaoFallbackApis: string[] = [];
const DOUBAO_FALLBACK_API_LIMIT = 64;
// 每条候选是从哪个钩子来的（json_parse / fetch_body / fetch_request / xhr_* / inline_script），
// 候选收不全时这是唯一能指向「哪条采集路径没生效」的线索。
const doubaoFallbackApiSources = new Map<string, string>();
// 每条候选在响应里归属的消息 id。DOM 卡片祖先上挂的 data-message-id 和它同源，
// 是唯一能精确对号的钥匙，宽高/时长/objectId 都只是间接指纹。
const doubaoFallbackApiMessageIds = new Map<string, string>();
// 主世界看见的相关请求概况，只进日志。
const doubaoVideoDiag: Record<string, unknown>[] = [];
const DOUBAO_VIDEO_DIAG_LIMIT = 40;
// background 解好的候选元信息（不含直链），手动点下载时要在同一个事件里查表，所以必须先备好。
let doubaoResolvedVideos: DoubaoResolvedVideo[] = [];
let doubaoResolveTimer = 0;

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data as { type?: unknown; url?: unknown; source?: unknown; messageId?: unknown } | null;
  if (!data) return;
  if (data.type === DOUBAO_VIDEO_DIAG_MESSAGE) {
    const { type: _type, ...detail } = data as Record<string, unknown>;
    if (doubaoVideoDiag.length < DOUBAO_VIDEO_DIAG_LIMIT) doubaoVideoDiag.push(detail);
    return;
  }
  if (data.type !== DOUBAO_FALLBACK_API_MESSAGE || typeof data.url !== "string") return;
  // 主世界的消息任何页面脚本都能伪造，域名白名单必须在这边再走一遍。
  if (!isAllowedFallbackApiUrl(data.url)) return;
  const messageId = typeof data.messageId === "string" ? data.messageId : "";
  if (doubaoFallbackApis.includes(data.url)) {
    // 同一条地址被另一条采集路径又看见一次，这回认出了 message_id：只补 id，不重复解析。
    if (!messageId || doubaoFallbackApiMessageIds.get(data.url)) return;
    doubaoFallbackApiMessageIds.set(data.url, messageId);
    for (const video of doubaoResolvedVideos) {
      if (video.fallbackApi === data.url) video.messageId = messageId;
    }
    return;
  }
  doubaoFallbackApis.push(data.url);
  doubaoFallbackApiSources.set(data.url, typeof data.source === "string" ? data.source : "");
  if (messageId) doubaoFallbackApiMessageIds.set(data.url, messageId);
  if (doubaoFallbackApis.length > DOUBAO_FALLBACK_API_LIMIT) {
    const dropped = doubaoFallbackApis.shift();
    if (dropped) {
      doubaoFallbackApiSources.delete(dropped);
      doubaoFallbackApiMessageIds.delete(dropped);
    }
  }
  scheduleDoubaoVideoResolve();
});

// 一条消息里的候选是一串一串到的，等它们到齐再一次性解，省掉重复请求。
function scheduleDoubaoVideoResolve(): void {
  window.clearTimeout(doubaoResolveTimer);
  doubaoResolveTimer = window.setTimeout(() => {
    void resolveDoubaoVideos();
  }, 800);
}

async function resolveDoubaoVideos(): Promise<DoubaoResolvedVideo[]> {
  if (!isExtensionContextAlive() || doubaoFallbackApis.length === 0) return doubaoResolvedVideos;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RESOLVE_DOUBAO_VIDEOS",
      fallbackApis: [...doubaoFallbackApis]
    }) as { ok?: boolean; videos?: DoubaoResolvedVideo[]; failures?: string[] } | undefined;
    if (response?.ok && Array.isArray(response.videos)) {
      // messageId 只有这一侧知道（background 拿到的只是地址列表），按 fallbackApi 补回去。
      doubaoResolvedVideos = response.videos.map(video => ({
        ...video,
        messageId: doubaoFallbackApiMessageIds.get(video.fallbackApi) ?? ""
      }));
    }
    void debugLog("doubaoVideosResolved", {
      collected: doubaoFallbackApis.length,
      resolved: doubaoResolvedVideos.length,
      withMessageId: doubaoResolvedVideos.filter(video => video.messageId).length,
      failures: response?.failures ?? []
    });
  } catch {
    // 解不出来只是少一条无水印路径，下载仍然走页面自己那条。
  }
  return doubaoResolvedVideos;
}

class RetryableJobError extends Error {}

// 在 chrome://extensions 里重新加载插件后，页面上那份老的 content script 并不会被卸载，
// 它还在跑自己的轮询；一旦碰到任何 chrome.* 调用就抛 "Extension context invalidated."，
// 在控制台堆成一片和业务无关的红色报错（新脚本会在下次注入时接手，老脚本已经无事可做）。
// 所以这里统一：检测到扩展上下文已失效就静默中止循环，并吃掉这一类未捕获的 rejection。
function isExtensionContextAlive(): boolean {
  return Boolean(chrome.runtime?.id);
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return /Extension context invalidated|message port closed/i.test(String(error));
}

window.addEventListener("unhandledrejection", event => {
  if (!isExtensionContextInvalidated(event.reason)) return;
  event.preventDefault();
  monitorAbort?.abort();
});

function platformLabel(): string {
  if (activeJob?.platform === "gemini") return "Gemini";
  if (activeJob?.platform === "doubao") return "豆包";
  return "ChatGPT";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const typed = message as StartJobMessage | DebugInspectMessage | GptExistingConversationRedirectCheckMessage;
  if (typed.type === "START_JOB") {
    const start = typed;
    void startJob(start.job, start.config, start.recoveryMode)
      .then(() => sendResponse({ ok: true }))
      .catch(async error => {
        await report(start.job.id, error instanceof RetryableJobError ? "failed_retryable" : "needs_manual", String(error));
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
  if (typed.type === "CHECK_GPT_EXISTING_CONVERSATION_REDIRECT") {
    const result: GptExistingConversationRedirectCheckResult = {
      hasUnavailableContent: hasGptUnavailableContentMessage(document.body?.innerText ?? "")
    };
    sendResponse(result);
    return false;
  }
  return false;
});

async function startJob(
  job: Job,
  nextConfig: AppConfig,
  recoveryMode?: EmptyAssistantRecoveryMode
): Promise<void> {
  activeJob = job;
  config = nextConfig;
  monitorAbort?.abort();
  const controller = new AbortController();
  monitorAbort = controller;
  await traceJob(job.id, "content_start", {
    platform: job.platform,
    mode: job.mode,
    expectedImageCount: job.expectedImageCount,
    recoveryMode: recoveryMode ?? "initial",
    reloadOnly: isReloadOnly(job)
  });

  if (isReloadOnly(job)) {
    const hasJobUserTurn = await waitForReloadConversation(job.id);
    if (shouldRetryReloadWithoutJobTurn({ reloadOnly: true, hasJobUserTurn })) {
      await report(
        job.id,
        "failed_retryable",
        `Reload-only recovery could not find the submitted user turn for JOB_ID ${job.id}. The prompt may not have been submitted. Run auto-chat retry ${job.id}; do not use auto-chat reload for this failure.`
      );
      return;
    }
  }
  const postRefreshPromptAction = selectPostRefreshPromptAction({
    recoveryMode,
    hasJobUserTurn: recoveryMode === "resubmit_if_prompt_missing_after_refresh"
      ? await waitForReloadConversation(job.id)
      : false
  });
  if (postRefreshPromptAction === "monitor") {
    await traceJob(job.id, "post_refresh_prompt_found", { recoveryMode });
    await report(job.id, "waiting_generation");
    void monitorJob(job, nextConfig, controller.signal);
    return;
  }
  if (postRefreshPromptAction === "resubmit") {
    await traceJob(job.id, "post_refresh_prompt_missing", { recoveryMode });
  }
  const existing = findJobAssistant(job.id);
  const isGeminiMultiImage = job.platform === "gemini" && job.mode === "image" && job.expectedImageCount > 1;
  if (shouldMonitorWithoutSubmit({
    recoveryMode,
    reloadOnly: isReloadOnly(job),
    hasExistingAssistant: Boolean(existing),
    isGeminiMultiImage
  })) {
    await traceJob(job.id, "monitor_only_selected", {
      recoveryMode: recoveryMode ?? "existing_conversation",
      hasExistingAssistant: Boolean(existing)
    });
    if (recoveryMode || isReloadOnly(job)) {
      await report(job.id, "waiting_generation");
    }
    void monitorJob(job, nextConfig, controller.signal, recoveryMode === "retry_after_refresh");
    return;
  }

  if (job.platform === "gemini" && job.mode === "image") {
    await traceJob(job.id, "gemini_image_flow_selected", {
      recoveryMode: recoveryMode ?? "initial",
      startFromFreshChat: Boolean(recoveryMode) && Boolean(existing)
    });
    // A restart triggered by recovery (stall/unexpected-reload) can land back
    // here mid-conversation, with a previous attempt's image still on the
    // page. runGeminiImageJob always starts counting from output 1 without
    // clearing the chat first, so without this the resubmitted first prompt
    // would land in the same conversation as the stale image instead of a
    // fresh one.
    void runGeminiImageJob(job, nextConfig, controller.signal, Boolean(recoveryMode) && Boolean(existing));
    return;
  }

  await report(job.id, "waiting_chat_ready");
  await waitForComposer();
  await waitForConversationPageReady(job);
  if (job.platform === "gpt") {
    if (recoveryMode === "resubmit_after_refresh") {
      // A refresh can reveal a late image or a real response. Only resend
      // when the stable page still has the exact empty-turn failure shape.
      const state = await inspectJob(job.id, job.platform);
      if (!shouldResubmitEmptyGptImage({
        platform: job.platform,
        mode: job.mode,
        sourceImageCount: job.sourceImages.length,
        assistantExists: state.assistantExists,
        assistantText: state.assistantText,
        loadedImageCount: state.loadedImages.length,
        isGenerating: state.isGenerating,
        composerInteractive: isComposerReadyForNextPrompt(),
        hasOnlyResponseActionMenu: hasOnlyResponseActionMenu(job.id)
      })) {
        await report(job.id, "waiting_generation");
        void monitorJob(job, nextConfig, controller.signal).finally(() => controller.abort());
        return;
      }
    }
    await report(job.id, "uploading");
    await uploadSources(job);
    await report(job.id, "sending_prompt");
    await fillPromptAndSendGpt(
      job,
      recoveryMode === "resubmit_after_refresh" || postRefreshPromptAction === "resubmit"
    );
  } else if (job.platform === "doubao") {
    // 视频模式的参考图要等切进「视频生成」之后再挂：切模式会重建输入框，
    // 提前上传的附件会被清掉。视频那条路在 fillPromptAndSendDoubao 里按人工顺序处理。
    if (job.sourceImages.length > 0 && job.mode !== "video") {
      await report(job.id, "uploading");
      await uploadSources(job);
      await waitForDoubaoUploadReady(job.id);
    }
    await report(job.id, "sending_prompt");
    await fillPromptAndSendDoubao(job);
  } else {
    await fillPromptPasteSourcesAndSendGemini(job, job.prompt);
  }
  await traceJob(job.id, "prompt_submitted", {
    platform: job.platform,
    mode: job.mode,
    recoveryMode: recoveryMode ?? "initial"
  });
  await report(job.id, "waiting_generation");
  void monitorJob(job, nextConfig, controller.signal).finally(() => controller.abort());
  if (shouldCheckEmptyAssistantRecovery(job.platform, job.mode)) {
    void recoverEmptyGptAssistant(job, controller);
  }
}

async function recoverEmptyGptAssistant(
  job: Job,
  controller: AbortController
): Promise<void> {
  try {
    const recoveryMode = await waitForEmptyAssistantRecovery({
      platform: job.platform,
      signal: controller.signal,
      inspect: async () => {
        const state = await inspectJob(job.id, job.platform);
        return {
          assistantExists: state.assistantExists,
          assistantText: state.assistantText,
          imageCount: state.loadedImages.length
        };
      }
    });
    if (!recoveryMode || controller.signal.aborted) return;

    controller.abort();
    await sendProgress({
      type: "JOB_PROGRESS",
      jobId: job.id,
      status: "stalled",
      recoveryMode,
      errorMessage: "GPT assistant remained empty 15 seconds after prompt submission."
    });
  } catch (error) {
    if (!controller.signal.aborted) await report(job.id, "failed_retryable", String(error));
  }
}

async function runGeminiImageJob(
  job: Job,
  appConfig: AppConfig,
  signal: AbortSignal,
  startFromFreshChat = false
): Promise<void> {
  const images: Array<{ index: number; sourceId: string; dataUrl: string; contentType: string }> = [];
  const total = Math.max(1, job.expectedImageCount);

  try {
    for (let outputIndex = 1; outputIndex <= total; outputIndex += 1) {
      if (signal.aborted) return;
      await traceJob(job.id, "gemini_image_turn_started", { outputIndex, total });
      if (outputIndex > 1 || startFromFreshChat) await startGeminiNewChat(appConfig);

      const prompt = total > 1
        ? buildGeminiOutputPrompt(job.prompt, outputIndex, geminiPrompts(job))
        : job.prompt;
      await report(job.id, "waiting_chat_ready");
      await waitForComposer();
      await waitForConversationPageReady(job, outputIndex === 1 && !startFromFreshChat && hasRecordedConversation(job));
      await fillPromptPasteSourcesAndSendGemini(job, prompt);
      await report(job.id, "waiting_generation");

      const image = await waitForGeminiSingleImage(job, appConfig, signal);
      images.push({ ...image, index: outputIndex - 1 });
      await traceJob(job.id, "gemini_image_turn_collected", { outputIndex, total });
      await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", images: [...images] });
    }

    await sendProgress({
      type: "JOB_PROGRESS",
      jobId: job.id,
      status: "done",
      images
    });
  } catch (error) {
    await traceJob(job.id, "gemini_image_flow_failed", { message: String(error) });
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

async function waitForReloadConversation(jobId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const turn = findJobUserTurn(jobId);
    if (turn) {
      turn.scrollIntoView({ block: "center" });
      await sleep(500);
      return true;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await sleep(500);
  }
  return false;
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
  let retriedInPage = false;

  while (!signal.aborted) {
    const state = await inspectJob(job.id, "gemini");
    if (state.signature !== lastSignature) {
      lastSignature = state.signature;
      lastChangedAt = Date.now();
      maybeDoneAt = 0;
    }

    if (state.hasError) {
      if (!retriedInPage) {
        retriedInPage = true;
        const retryButton = findJobScopeRetryButton(job.id, "gemini");
        if (retryButton) {
          retryButton.click();
          lastChangedAt = Date.now();
          maybeDoneAt = 0;
          await sleep(MONITOR_INTERVAL_MS);
          continue;
        }
      }
      throw new Error(state.errorText || "Gemini returned an error.");
    }
    if (state.isInterrupted) throw new Error(state.interruptedText || "Gemini response was interrupted.");
    if (Date.now() - startedAt > appConfig.hardTimeoutMs) throw new Error("Job exceeded hard timeout.");
    const stallTimeoutMs = Math.max(appConfig.stallTimeoutMs, GEMINI_IMAGE_STALL_MIN_MS);
    if (!state.isGenerating && Date.now() - lastChangedAt > stallTimeoutMs) {
      throw new Error("No visible progress before stall timeout.");
    }

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
  // Clicking "New chat" or reassigning location.href navigates the tab, which
  // background's chrome.tabs.onUpdated listener would otherwise treat as an
  // unexpected reload and re-trigger startJob mid-run, aborting this job's
  // in-flight AbortController. Mark the navigation as expected around it so
  // that recovery path is skipped for this self-initiated jump.
  await setExpectingNavigation(true);
  try {
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
  } finally {
    await setExpectingNavigation(false);
  }
}

async function monitorJob(
  job: Job,
  appConfig: AppConfig,
  signal: AbortSignal,
  retryAfterRefresh = false
): Promise<void> {
  const startedAt = Date.now();
  let lastSignature = "";
  let lastChangedAt = Date.now();
  let maybeDoneAt = 0;
  let retriedInPage = false;
  let gptStopRequestedAt = 0;
  let capturedGptImages: CollectedImage[] | null = null;
  let doubaoNoImageDoneAt = 0;
  let doubaoVideoConfirmClicks = 0;
  let tracedDoubaoVideoControls = false;
  let resubmittedEmptyGptImage = hasResubmittedEmptyGptImage(job.id);
  let lastTraceSignature = "";
  let mediaBlockedAt = 0;
  await traceJob(job.id, "monitor_started", {
    platform: job.platform,
    mode: job.mode,
    retryAfterRefresh,
    stallTimeoutMs: appConfig.stallTimeoutMs,
    hardTimeoutMs: appConfig.hardTimeoutMs
  });

  try {
    while (!signal.aborted) {
      // 插件被重新加载后这份脚本已经是孤儿，继续轮询只会刷报错。
      if (!isExtensionContextAlive()) return;
      if (job.platform === "gpt" && dismissRateLimitModal()) {
        await traceJob(job.id, "rate_limit_modal_detected", { platform: job.platform });
        await report(job.id, "rate_limited");
        return;
      }

      if (job.platform === "gpt" && job.mode === "image" && answerGptImagePreferences(job.id)) {
        await traceJob(job.id, "gpt_image_preference_answered", { platform: job.platform });
        lastChangedAt = Date.now();
        maybeDoneAt = 0;
        await sleep(1000);
        continue;
      }

      const state = await inspectJob(job.id, job.platform);
      if (state.signature !== lastSignature) {
        lastSignature = state.signature;
        lastChangedAt = Date.now();
        maybeDoneAt = 0;
        doubaoNoImageDoneAt = 0;
      }
      if (state.signature !== lastTraceSignature) {
        lastTraceSignature = state.signature;
        await traceJob(job.id, "monitor_snapshot", monitorSnapshot(job, state));
      }

      const visibleEnoughImages = shouldCompleteImageJob({
        mode: job.mode,
        loadedImageCount: state.loadedImages.length,
        expectedImageCount: job.expectedImageCount
      });
      if (
        visibleEnoughImages &&
        !capturedGptImages &&
        job.platform === "gpt" &&
        state.isGenerating
      ) {
        // Stopping an in-progress GPT response can remove its assistant turn.
        // Fetch the assistant's completed image before requesting that stop.
        capturedGptImages = await collectImages(state.loadedImages.slice(0, job.expectedImageCount));
        await traceJob(job.id, "gpt_image_captured_before_stop", { imageCount: capturedGptImages.length });
      }
      const enoughImages = visibleEnoughImages || capturedGptImages !== null;
      // ChatGPT can render a complete image turn while retaining a stale
      // error banner for the preceding user turn. The scoped images are the
      // authoritative result, so finish collecting them before error UI.
      if (enoughImages) {
        await traceJob(job.id, "expected_images_detected", monitorSnapshot(job, state));
        if (!gptStopRequestedAt && shouldStopGptImageGeneration({
          platform: job.platform,
          isGenerating: state.isGenerating,
          imageJobComplete: enoughImages
        })) {
          // Record the request even if ChatGPT has already replaced its active
          // stop control with a disabled spinner. That state must settle within
          // four seconds; otherwise the next prompt cannot be submitted.
          stopActiveGptGeneration();
          gptStopRequestedAt = Date.now();
          await traceJob(job.id, "gpt_stop_requested_after_image", monitorSnapshot(job, state));
          maybeDoneAt = 0;
          await sleep(500);
          continue;
        }
        const stuckStopRecovery = selectStuckGptImageStopRecovery({
          platform: job.platform,
          imageJobComplete: enoughImages,
          isGenerating: state.isGenerating,
          stopRequestedAt: gptStopRequestedAt,
          now: Date.now()
        });
        if (stuckStopRecovery) {
          await traceJob(job.id, "monitor_recovery_selected", {
            ...monitorSnapshot(job, state),
            reason: stuckStopRecovery.errorMessage,
            recoveryMode: stuckStopRecovery.recoveryMode
          });
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "stalled",
            recoveryMode: stuckStopRecovery.recoveryMode,
            errorMessage: stuckStopRecovery.errorMessage
          });
          return;
        }
        if (gptStopRequestedAt && state.isGenerating) {
          await sleep(500);
          continue;
        }
        if (!maybeDoneAt) {
          maybeDoneAt = Date.now();
          await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", signature: state.signature });
        }
        if (Date.now() - maybeDoneAt > IMAGE_DONE_STABLE_MS) {
          await traceJob(job.id, "image_collection_started", monitorSnapshot(job, state));
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "done",
            signature: state.signature,
            images: capturedGptImages ?? await collectImages(state.loadedImages.slice(0, job.expectedImageCount))
          });
          return;
        }
        await sleep(MONITOR_INTERVAL_MS);
        continue;
      }

      // 豆包视频可能要求二次确认：助手先回一段授权声明和一个「确认生成 →」按钮，
      // 不点它页面就一直停在这里，直到被当成停滞。
      if (job.platform === "doubao" && job.mode === "video") {
        const confirmButton = findDoubaoVideoConfirmButton(job.id);
        if (!confirmButton && !tracedDoubaoVideoControls && state.assistantExists) {
          tracedDoubaoVideoControls = true;
          await traceJob(job.id, "doubao_video_scope_controls", { controls: describeJobScopeControls(job.id) });
        }
        if (shouldClickDoubaoVideoConfirm({
          platform: job.platform,
          mode: job.mode,
          hasConfirmButton: Boolean(confirmButton),
          loadedVideoCount: state.loadedVideos.length,
          isGenerating: state.isGenerating,
          confirmClickCount: doubaoVideoConfirmClicks
        })) {
          doubaoVideoConfirmClicks += 1;
          clickDoubaoControl(confirmButton!);
          await traceJob(job.id, "doubao_video_confirm_clicked", {
            ...monitorSnapshot(job, state),
            confirmClickCount: doubaoVideoConfirmClicks
          });
          lastChangedAt = Date.now();
          maybeDoneAt = 0;
          await sleep(MONITOR_INTERVAL_MS);
          continue;
        }
      }

      // 豆包视频：卡片一出现就算生成完成（此时 isGenerating 往往已经是 false，
      // 因为「视频生成已提交」那条回复早就结束了），稳定 2 秒后再走下载。
      if (shouldCompleteVideoJob({ mode: job.mode, loadedVideoCount: state.loadedVideos.length })) {
        if (!maybeDoneAt) {
          maybeDoneAt = Date.now();
          await sendProgress({ type: "JOB_PROGRESS", jobId: job.id, status: "maybe_done", signature: state.signature });
        }
        if (Date.now() - maybeDoneAt > VIDEO_DONE_STABLE_MS) {
          await traceJob(job.id, "video_collection_started", monitorSnapshot(job, state));
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "done",
            signature: state.signature,
            videos: await collectVideos(state.loadedVideos.slice(0, 1))
          });
          return;
        }
        await sleep(MONITOR_INTERVAL_MS);
        continue;
      }

      // ChatGPT can show a transient error banner while the response below it
      // still says "Thinking / Generating a more detailed image" and exposes
      // the stop control. That is active work, not a failed generation: keep
      // this tab and monitor until the platform stops generating.
      if (state.isGenerating) {
        const renderStallRecovery = selectMonitorStallRecovery({
          platform: job.platform,
          mode: job.mode,
          isGenerating: state.isGenerating,
          idleMs: Date.now() - lastChangedAt,
          stallTimeoutMs: appConfig.stallTimeoutMs
        });
        if (renderStallRecovery) {
          await traceJob(job.id, "monitor_recovery_selected", {
            ...monitorSnapshot(job, state),
            reason: renderStallRecovery.errorMessage,
            recoveryMode: renderStallRecovery.recoveryMode
          });
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "stalled",
            recoveryMode: renderStallRecovery.recoveryMode,
            errorMessage: renderStallRecovery.errorMessage
          });
          return;
        }
        await sleep(MONITOR_INTERVAL_MS);
        continue;
      }

      // 目标是图片/视频，模型却只回了一段「不会有产出」的文字并结束回答
      // （「我无法制作这类视频」「已达到请求上限」）：再等只会等到停滞或硬超时，
      // 直接收工并把原文当失败原因带回去。上限类按可重试上报，拒绝类交人工。
      const mediaBlock = detectMediaBlock({
        mode: job.mode,
        assistantExists: state.assistantExists,
        assistantText: state.assistantText,
        isGenerating: state.isGenerating,
        loadedImageCount: state.loadedImages.length,
        loadedVideoCount: state.loadedVideos.length
      });
      if (mediaBlock) {
        const blockText = state.assistantText.replace(/\s+/g, " ").trim().slice(0, MEDIA_BLOCK_MAX_TEXT_LENGTH);
        if (!mediaBlockedAt) {
          mediaBlockedAt = Date.now();
          await traceJob(job.id, "media_block_detected", {
            ...monitorSnapshot(job, state),
            blockKind: mediaBlock,
            blockText
          });
        }
        if (shouldGiveUpOnMediaBlock({ blockedAt: mediaBlockedAt, now: Date.now() })) {
          if (mediaBlock === "capacity") {
            await report(job.id, "failed_retryable", `平台暂时无法接单：${blockText}`);
          } else {
            await report(job.id, "needs_manual", `模型拒绝生成：${blockText}`);
          }
          return;
        }
        await sleep(MONITOR_INTERVAL_MS);
        continue;
      }
      mediaBlockedAt = 0;

      if (state.hasError) {
        await traceJob(job.id, "explicit_error_detected", monitorSnapshot(job, state));
        const retryButton = job.platform === "gpt" && job.mode === "image"
          ? findJobScopeRetryButton(job.id, job.platform)
          : null;
        if (shouldRetryGptImageGenerationInPage({
          platform: job.platform,
          mode: job.mode,
          errorText: state.errorText,
          retriedInPage,
          hasRetryButton: Boolean(retryButton)
        })) {
          retriedInPage = true;
          await traceJob(job.id, "gpt_retry_button_clicked", {
            errorText: state.errorText.slice(0, 200)
          });
          retryButton!.click();
          lastChangedAt = Date.now();
          maybeDoneAt = 0;
          await sleep(MONITOR_INTERVAL_MS);
          continue;
        }
        const errorRecovery = retryAfterRefresh ? null : selectGptErrorRefresh({
          platform: job.platform,
          refreshCount: job.refreshCount,
          maxRefreshPerJob: appConfig.maxRefreshPerJob
        });
        if (errorRecovery) {
          await traceJob(job.id, "monitor_recovery_selected", {
            ...monitorSnapshot(job, state),
            reason: errorRecovery.errorMessage,
            recoveryMode: errorRecovery.recoveryMode
          });
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "stalled",
            recoveryMode: errorRecovery.recoveryMode,
            errorMessage: errorRecovery.errorMessage
          });
          return;
        }
        if ((job.platform === "gpt" || job.platform === "gemini") && !retriedInPage) {
          retriedInPage = true;
          const retryButton = findJobScopeRetryButton(job.id, job.platform);
          if (retryButton) {
            retryButton.click();
            lastChangedAt = Date.now();
            maybeDoneAt = 0;
            await sleep(MONITOR_INTERVAL_MS);
            continue;
          }
        }
        await report(job.id, "failed_retryable", state.errorText);
        return;
      }

      if (state.isInterrupted) {
        await traceJob(job.id, "interrupted_response_detected", monitorSnapshot(job, state));
        await report(job.id, "stalled", state.interruptedText || "Connection interrupted while waiting for the complete answer.");
        return;
      }

      if (shouldFailCompletedDoubaoImageJob({
        platform: job.platform,
        mode: job.mode,
        assistantExists: state.assistantExists,
        assistantText: state.assistantText,
        loadedImageCount: state.loadedImages.length,
        isGenerating: state.isGenerating
      })) {
        if (!doubaoNoImageDoneAt) {
          doubaoNoImageDoneAt = Date.now();
          await sendProgress({
            type: "JOB_PROGRESS",
            jobId: job.id,
            status: "maybe_done",
            signature: state.signature
          });
        }
        if (shouldGiveUpOnMissingDoubaoImages({ completedWithoutImagesAt: doubaoNoImageDoneAt, now: Date.now() })) {
          const errorMessage = "豆包会话已结束，但未检测到生成图片。";
          await traceJob(job.id, "doubao_image_missing_after_completed_response", {
            ...monitorSnapshot(job, state),
            waitedMs: Date.now() - doubaoNoImageDoneAt,
            reason: errorMessage
          });
          await report(job.id, "failed_retryable", errorMessage);
          return;
        }
        await sleep(MONITOR_INTERVAL_MS);
        continue;
      }

      if (
        !resubmittedEmptyGptImage &&
        Date.now() - lastChangedAt >= EMPTY_GPT_IMAGE_RECOVERY_DELAY_MS &&
        shouldResubmitEmptyGptImage({
          platform: job.platform,
          mode: job.mode,
          sourceImageCount: job.sourceImages.length,
          assistantExists: state.assistantExists,
          assistantText: state.assistantText,
          loadedImageCount: state.loadedImages.length,
          isGenerating: state.isGenerating,
          composerInteractive: isComposerReadyForNextPrompt(),
          hasOnlyResponseActionMenu: hasOnlyResponseActionMenu(job.id)
        })
      ) {
        resubmittedEmptyGptImage = true;
        markEmptyGptImageResubmitted(job.id);
        await traceJob(job.id, "monitor_recovery_selected", {
          ...monitorSnapshot(job, state),
          reason: "GPT returned an empty image response.",
          recoveryMode: "resubmit_after_refresh"
        });
        await sendProgress({
          type: "JOB_PROGRESS",
          jobId: job.id,
          status: "stalled",
          recoveryMode: "resubmit_after_refresh",
          errorMessage: "GPT returned an empty image response; refreshing the conversation before one resubmission."
        });
        return;
      }

      if (Date.now() - startedAt > appConfig.hardTimeoutMs) {
        await traceJob(job.id, "hard_timeout", monitorSnapshot(job, state));
        await report(job.id, "needs_manual", "Job exceeded hard timeout.");
        return;
      }

      const stallRecovery = selectMonitorStallRecovery({
        platform: job.platform,
        mode: job.mode,
        isGenerating: state.isGenerating,
        idleMs: Date.now() - lastChangedAt,
        stallTimeoutMs: appConfig.stallTimeoutMs
      });
      if (stallRecovery) {
        await traceJob(job.id, "monitor_recovery_selected", {
          ...monitorSnapshot(job, state),
          reason: stallRecovery.errorMessage,
          recoveryMode: stallRecovery.recoveryMode
        });
        await sendProgress({
          type: "JOB_PROGRESS",
          jobId: job.id,
          status: "stalled",
          recoveryMode: stallRecovery.recoveryMode,
          errorMessage: stallRecovery.errorMessage
        });
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

      await sleep(MONITOR_INTERVAL_MS);
    }
  } catch (error) {
    await traceJob(job.id, "monitor_failed", { message: String(error) });
    await report(job.id, "failed_retryable", String(error));
  }
}

function answerGptImagePreferences(jobId: string): boolean {
  const assistant = findJobAssistant(jobId);
  if (!assistant) return false;
  return answerGptImagePreferenceComparisons(assistant, answeredGptImagePreferenceComparisons);
}

async function inspectJob(jobId: string, platform?: JobPlatform): Promise<{
  assistantExists: boolean;
  hasError: boolean;
  errorText: string;
  isInterrupted: boolean;
  interruptedText: string;
  isGenerating: boolean;
  assistantText: string;
  loadedImages: HTMLImageElement[];
  scopedImages: HTMLImageElement[];
  pageImages: HTMLImageElement[];
  loadedVideos: HTMLElement[];
  signature: string;
}> {
  const assistant = findJobAssistant(jobId);
  const scopedImages = findJobScopedImages(jobId);
  const pageImages = findLoadedImages(document);
  // 豆包视频卡片挂在「视频生成好了」那条独立的助手消息里，不一定是 scope.assistant，
  // 所以按整段任务范围找，而不是只在 assistant 元素里找。
  const loadedVideos = platform === "doubao" || platform === "gemini"
    ? findJobScopedVideoCards(jobId, platform)
    : [];
  if (!assistant) {
    const text = document.body.innerText;
    const jobText = findJobScopeText(jobId);
    const hasError = hasExplicitGenerationError(jobText);
    const isInterrupted = INTERRUPTED_TEXT_PATTERN.test(jobText);
    return {
      assistantExists: false,
      hasError,
      errorText: hasError ? jobText.slice(0, 500) : "",
      isInterrupted,
      interruptedText: isInterrupted ? jobText.slice(0, 500) : "",
      isGenerating: hasGeneratingText(text) || hasActiveGenerationControl(),
      assistantText: "",
      loadedImages: scopedImages,
      scopedImages,
      pageImages,
      loadedVideos,
      signature: `no-assistant:${text.length}:${scopedImages.length}:${pageImages.length}:${loadedVideos.length}`
    };
  }

  const text = assistant.innerText || "";
  const jobText = findJobScopeText(jobId);
  const hasError = hasExplicitGenerationError(`${text}\n${jobText}`);
  const isInterrupted = INTERRUPTED_TEXT_PATTERN.test(`${text}\n${jobText}`);
  const isGenerating =
    hasGeneratingText(text) ||
    Boolean(assistant.querySelector('[aria-busy="true"], [data-testid*="loading"], .animate-pulse, [class*="dot-flashing"], [class*="loading-container"]')) ||
    Boolean(assistant.querySelector('[data-streaming="true"]')) ||
    hasActiveGenerationControl();
  const assistantImages = findGeneratedImagesInOrder(assistant).filter(image => !isNonFirstDualResponseChoice(image));
  const loadedImages = uniqueImages([...assistantImages, ...scopedImages]);
  return {
    assistantExists: true,
    hasError,
    errorText: hasError ? text.slice(0, 500) : "",
    isInterrupted,
    interruptedText: isInterrupted ? jobText.slice(0, 500) : "",
    isGenerating,
    assistantText: extractAssistantText(assistant),
    loadedImages,
    scopedImages,
    pageImages,
    loadedVideos,
    signature: `${text.length}:${loadedImages.length}:${scopedImages.length}:${pageImages.length}:${loadedVideos.length}:${isGenerating}:${assistant.querySelectorAll("button,a").length}`
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
      loadedVideos: 0,
      expectedImages: activeJob?.expectedImageCount ?? null,
      signature: `no-job:${document.body.innerText.length}`
    };
  }

  const state = await inspectJob(resolvedJobId, activeJob?.platform);
  return {
    ok: true,
    jobId: resolvedJobId,
    pageJobId,
    url: location.href,
    hasJobAssistant: state.assistantExists,
    hasError: state.hasError,
    isInterrupted: state.isInterrupted,
    isGenerating: state.isGenerating,
    loadedImages: state.loadedImages.length,
    scopedImages: state.scopedImages.length,
    pageImages: state.pageImages.length,
    loadedVideos: state.loadedVideos.length,
    expectedImages: activeJob?.id === resolvedJobId ? activeJob.expectedImageCount : null,
    signature: state.signature,
    errorText: state.errorText
  };
}

function findLatestJobId(): string | null {
  const matches = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user'], section[data-turn='user'], user-query, [data-message-id]")]
    .map(node => (node.innerText || "").match(/JOB_ID:\s*([^\s]+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return matches.at(-1) ?? null;
}

function findJobAssistant(jobId: string): HTMLElement | null {
  return findJobConversationScope(jobId)?.assistant ?? null;
}

function countJobUserTurns(jobId: string): number {
  return findConversationTurns()
    .filter(isUserTurn)
    .filter(turn => (turn.innerText || "").includes(`JOB_ID: ${jobId}`))
    .length;
}

function emptyGptImageResubmitKey(jobId: string): string {
  return `auto-chat:empty-gpt-image-resubmit:${jobId}`;
}

function hasResubmittedEmptyGptImage(jobId: string): boolean {
  return sessionStorage.getItem(emptyGptImageResubmitKey(jobId)) === "1";
}

function markEmptyGptImageResubmitted(jobId: string): void {
  sessionStorage.setItem(emptyGptImageResubmitKey(jobId), "1");
}

function findJobScopedImages(jobId: string): HTMLImageElement[] {
  const scope = findJobConversationScope(jobId);
  if (!scope) return [];

  return findLoadedImages(document).filter(img =>
    !scope.user.contains(img) &&
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

function dismissRateLimitModal(): boolean {
  const modal = document.getElementById("modal-conversation-history-rate-limit");
  if (!modal || !isVisible(modal)) return false;

  const dismissButton = [...modal.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => isVisible(button) && /got it/i.test(button.innerText));
  dismissButton?.click();
  return true;
}

function findJobScopeRetryButton(jobId: string, platform?: JobPlatform): HTMLElement | null {
  const scope = findJobConversationScope(jobId);
  if (!scope) return null;

  // Gemini's retry control isn't always a plain <button> — e.g. its
  // gem-icon-button custom element wraps one — so this must match the same
  // broader selector the reference implementation uses, not just "button".
  const buttons = [...document.querySelectorAll<HTMLElement>("button,[role='button'],gem-icon-button")].filter(button =>
    isAfter(button, scope.user) && (!scope.nextUser || isBefore(button, scope.nextUser))
  );
  // Gemini's own regenerate control is always labeled "Redo", not
  // "retry"/"regenerate"/重试 like the error-recovery retry prompts on
  // other platforms — e.g. after the user (or the page itself) stops a
  // response mid-generation, the only way back is this "Redo" button, and
  // its aria-label never varies by locale. Scoped to Gemini only since
  // "redo" is common enough English wording that GPT/豆包 could plausibly
  // use it for something unrelated (e.g. an actual undo/redo control).
  const retryPattern = platform === "gemini"
    ? /retry|try again|regenerate|redo|重试|重新生成/i
    : /retry|try again|regenerate|重试|重新生成/i;
  const byLabel = buttons.find(button => {
    const label = `${button.innerText ?? ""} ${button.getAttribute("aria-label") ?? ""} ${button.title ?? ""}`;
    return isVisible(button) && retryPattern.test(label);
  });
  if (byLabel) return byLabel;

  // ChatGPT's guardrail-refusal turn reuses the "Switch model" button slot (no
  // matching aria-label) to render the retry icon, so fall back to position:
  // the button right after "Copy response"/"Share" inside the actions group.
  const actionsGroup = buttons.find(button => button.getAttribute("aria-label") === "Share")
    ?.closest('[aria-label="Response actions"]');
  if (!actionsGroup) return null;
  const groupButtons = [...actionsGroup.querySelectorAll<HTMLButtonElement>("button")].filter(isVisible);
  const shareIndex = groupButtons.findIndex(button => button.getAttribute("aria-label") === "Share");
  return shareIndex >= 0 ? groupButtons[shareIndex + 1] ?? null : null;
}

// 二次确认按钮就渲染在本次任务那条助手回复里，所以按会话作用域筛选，
// 避免点到历史消息里同样文案的按钮。豆包这个「确认生成 →」不一定是 <button>，
// 实测也可能是带 cursor:pointer 的 div，所以按文案找最内层的可点击元素，
// 再回退到它最近的 button/role=button 祖先。
function findDoubaoVideoConfirmButton(jobId: string): HTMLElement | null {
  const scope = findJobConversationScope(jobId);
  if (!scope) return null;

  const matches = [...document.querySelectorAll<HTMLElement>("button,[role='button'],a,div,span")].filter(element =>
    isAfter(element, scope.user) &&
    (!scope.nextUser || isBefore(element, scope.nextUser)) &&
    isPresentInLayout(element) &&
    isLikelyClickable(element) &&
    isDoubaoVideoConfirmLabel(elementLabel(element))
  );
  const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
  const target = innermost[innermost.length - 1] ?? null;
  return target?.closest<HTMLElement>("button,[role='button']") ?? target;
}

function isLikelyClickable(element: HTMLElement): boolean {
  if (element.tagName === "BUTTON" || element.tagName === "A") return true;
  if (element.getAttribute("role") === "button") return true;
  return getComputedStyle(element).cursor === "pointer";
}

function elementLabel(element: HTMLElement): string {
  return `${element.innerText ?? ""} ${element.getAttribute("aria-label") ?? ""}`.replace(/\s+/g, " ").trim();
}

// 豆包的回复里会插各种平台按钮（二次确认、追问建议…），文案和结构都在变。
// 没找到确认按钮时把这条回复里的可点击元素记一遍，便于事后对照 trace 排查。
function describeJobScopeControls(jobId: string): string[] {
  const scope = findJobConversationScope(jobId);
  if (!scope) return [];

  const candidates = scope.assistant
    ? [...scope.assistant.querySelectorAll<HTMLElement>("*")]
    : [...document.querySelectorAll<HTMLElement>("button,[role='button'],a")].filter(element =>
      isAfter(element, scope.user) && (!scope.nextUser || isBefore(element, scope.nextUser)));
  const clickable = candidates.filter(element => isPresentInLayout(element) && isLikelyClickable(element));
  return clickable
    .filter(element => !clickable.some(other => other !== element && element.contains(other)))
    .slice(0, 24)
    .map(element => `${element.tagName.toLowerCase()}:${elementLabel(element).slice(0, 40)}`);
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
  return uniqueImages([...findGeneratedImagesInOrder(root), ...findGeneratedImageElements(root)])
    .filter(image => !isNonFirstDualResponseChoice(image));
}

function findGeneratedImagesInOrder(root: ParentNode): HTMLImageElement[] {
  const cards = [...root.querySelectorAll<HTMLElement>(".group\\/imagegen-image, [id^='image-'], generated-image, single-image")];
  const images = cards
    .map(card => findGeneratedImageElements(card)[0])
    .filter((image): image is HTMLImageElement => Boolean(image));
  return uniqueImages(images);
}

// When Gemini runs an A/B response-quality comparison, dual-model-response
// renders two full candidate answers side by side, each with its own
// generated image. Without a human picking a winner, only the first
// candidate (Choice A) is treated as this turn's actual output — the second
// candidate's image must not be counted or collected alongside it.
function isNonFirstDualResponseChoice(image: HTMLImageElement): boolean {
  const dualResponse = image.closest("dual-model-response");
  if (!dualResponse) return false;
  const panel = image.closest("response-selection-panel");
  if (!panel) return false;
  const panels = dualResponse.querySelectorAll("response-selection-panel");
  return panels[0] !== panel;
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
      const hasDoubaoGenSource = /imagex-sign\.byteimg\.com\/.*rc_gen_image/i.test(src);
      const hasGeneratedAlt = /Generated image/i.test(img.alt);
      const hasGeminiGeneratedAlt = /AI generated/i.test(img.alt);
      const isDecorative = /gstatic\.com\/lamda\/images\/gemini|googleusercontent\.com\/a\//i.test(src);
      const inGeneratedContainer = Boolean(img.closest(".group\\/imagegen-image, [id^='image-'], generated-image, single-image"));
      return Boolean(src) && !isDecorative &&
        (hasEstuarySource || hasGeminiBlob || hasDoubaoGenSource || inGeneratedContainer || ((hasGeneratedAlt || hasGeminiGeneratedAlt) && largeEnough));
    });
}

function monitorSnapshot(
  job: Pick<Job, "platform" | "mode" | "expectedImageCount">,
  state: Awaited<ReturnType<typeof inspectJob>>
): Record<string, unknown> {
  return {
    platform: job.platform,
    mode: job.mode,
    expectedImageCount: job.expectedImageCount,
    assistantExists: state.assistantExists,
    loadedImageCount: state.loadedImages.length,
    scopedImageCount: state.scopedImages.length,
    pageImageCount: state.pageImages.length,
    loadedVideoCount: state.loadedVideos.length,
    isGenerating: state.isGenerating,
    hasError: state.hasError,
    errorText: state.errorText || null,
    isInterrupted: state.isInterrupted,
    interruptedText: state.interruptedText || null,
    assistantTextLength: state.assistantText.length,
    signature: state.signature
  };
}

function extractAssistantText(assistant: HTMLElement): string {
  const content = assistant.cloneNode(true) as HTMLElement;
  content.querySelectorAll('[aria-label="Response actions"], h4.sr-only, button, [role="button"]')
    .forEach(control => control.remove());
  const message = content.querySelector<HTMLElement>("[data-message-author-role='assistant']");
  const geminiMessage = content.querySelector<HTMLElement>("message-content .markdown, .model-response-text .markdown");
  const markdown = message?.querySelector<HTMLElement>(".markdown") ?? geminiMessage;
  return (
    (markdown ? serializeRichText(markdown) : "") ||
    message?.innerText ||
    content.innerText ||
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

  if (fallbackText.trim()) return fallbackText;
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
  return buttons.find(button =>
    button.getAttribute("data-testid") === "copy-turn-action-button"
  ) ?? buttons.find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    return /copy response/i.test(label) && !/copy image|copy prompt/i.test(label);
  }) ?? findDoubaoCopyButton(assistant);
}

function findDoubaoCopyButton(assistant: HTMLElement): HTMLButtonElement | null {
  if (!assistant.hasAttribute("data-message-id")) return null;
  return assistant.parentElement?.querySelector<HTMLButtonElement>('[class*="message-action-bar"] button:first-child') ?? null;
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
  const message = [...document.querySelectorAll<HTMLElement>("[data-message-author-role='user'], user-query, [data-message-id]")]
    .find(node => (node.innerText || "").includes(`JOB_ID: ${jobId}`));
  return message?.closest<HTMLElement>("section[data-turn='user'], [data-turn='user'], [data-testid^='conversation-turn'], user-query, [data-message-id]") ?? message ?? null;
}

function findConversationTurns(): HTMLElement[] {
  const sectionTurns = [...document.querySelectorAll<HTMLElement>("section[data-turn]")];
  if (sectionTurns.length > 0) return sectionTurns;
  // dual-model-response appears in place of model-response when Gemini runs
  // an A/B response-quality comparison ("Which response is more helpful?"),
  // rendering two full candidate answers (each with its own image) side by
  // side instead of one.
  const geminiTurns = [...document.querySelectorAll<HTMLElement>("user-query, model-response, dual-model-response")];
  if (geminiTurns.length > 0) return geminiTurns;
  const doubaoTurns = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => (row.innerText || "").trim());
  if (doubaoTurns.length > 0) return doubaoTurns;
  return [...document.querySelectorAll<HTMLElement>("[data-message-author-role]")];
}

function isUserTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "user" ||
    node.getAttribute("data-message-author-role") === "user" ||
    node.tagName.toLowerCase() === "user-query" ||
    Boolean(node.querySelector("[data-message-author-role='user']")) ||
    (node.hasAttribute("data-message-id") && /JOB_ID:/.test(node.innerText || ""));
}

function isAssistantTurn(node: HTMLElement): boolean {
  return node.getAttribute("data-turn") === "assistant" ||
    node.getAttribute("data-message-author-role") === "assistant" ||
    node.tagName.toLowerCase() === "model-response" ||
    node.tagName.toLowerCase() === "dual-model-response" ||
    Boolean(node.querySelector("[data-message-author-role='assistant'], .agent-turn")) ||
    (node.hasAttribute("data-message-id") && !isUserTurn(node));
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
  throw new Error(`${platformLabel()} composer was not found.`);
}

async function waitForConversationPageReady(
  job: Job,
  requireConversationContent = hasRecordedConversation(job)
): Promise<void> {
  const readiness = await waitForStableReadiness({
    inspect: () => {
      const composer = findComposer();
      return document.readyState === "complete" &&
        Boolean(composer && isComposerInteractive(composer)) &&
        (!requireConversationContent || findConversationTurns().length > 0);
    },
    sleep
  });
  if (readiness === "timeout") {
    throw new RetryableJobError(`${platformLabel()} conversation did not become stable before prompt submission.`);
  }
}

function hasRecordedConversation(job: Job): boolean {
  return Boolean(job.conversationUrl || job.parentJobId);
}

function isComposerInteractive(composer: HTMLElement | HTMLTextAreaElement): boolean {
  if (!composer.isConnected || !isVisible(composer)) return false;
  if (composer.getAttribute("aria-disabled") === "true" || composer.getAttribute("aria-busy") === "true") return false;
  if (composer instanceof HTMLTextAreaElement) return !composer.disabled && !composer.readOnly;
  return composer.getAttribute("contenteditable") !== "false";
}

function isComposerReadyForNextPrompt(): boolean {
  const composer = findComposer();
  return Boolean(composer && isComposerInteractive(composer));
}

async function uploadSources(job: Job): Promise<void> {
  if (job.sourceImages.length === 0) return;
  let input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input && job.platform === "gemini") {
    findUploadMenuButton()?.click();
    await sleep(500);
    input = document.querySelector<HTMLInputElement>('input[type="file"]');
  }
  if (!input && job.platform === "doubao") {
    for (let attempt = 0; attempt < 10 && !input; attempt += 1) {
      await sleep(300);
      input = document.querySelector<HTMLInputElement>('input[type="file"]');
    }
    // 聊天模式下 input 一直在，走不到这里；视频生成模式重建了输入框，
    // 就得先点一下「+」把 input 挂出来。
    if (!input) {
      const attach = findDoubaoAttachButton();
      await traceJob(job.id, "doubao_attach_button_lookup", {
        mode: job.mode,
        found: Boolean(attach),
        attachLabel: attach ? elementLabel(attach).slice(0, 40) : null,
        actionbarControls: describeDoubaoActionbarControls()
      });
      if (attach) {
        clickDoubaoControl(attach);
        input = await waitUntilTruthy(
          () => document.querySelector<HTMLInputElement>('input[type="file"]'),
          5_000
        );
      }
    }
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

async function fillPromptAndSendGpt(job: Job, requireNewUserTurn = false): Promise<void> {
  const { prompt } = job;
  const isNewConversation = !hasRecordedConversation(job);
  const capture = isNewConversation ? startGptConversationUrlCapture() : null;
  const existingUserTurnCount = requireNewUserTurn ? countJobUserTurns(job.id) : 0;

  try {
    const composer = fillPrompt(prompt);
    await sleep(300);
    const sendButton = findSendButton();
    if (await submitPromptWithFallback({
      composer,
      sendButton,
      getSendButton: findSendButton,
      isSubmitted: async () => requireNewUserTurn
        ? countJobUserTurns(job.id) > existingUserTurnCount
        : isPromptSubmitted(prompt),
      onWaitingForSubmitReady: () => report(job.id, "waiting_upload_ready"),
      sleep
    })) return;

    const capturedUrl = capture?.getUrl() ?? null;
    if (shouldReloadCapturedConversation({ capturedUrl, currentPathname: location.pathname })) {
      location.href = capturedUrl as string;
      if (await waitForReloadConversation(job.id)) return;
    }

    throw new RetryableJobError(`Prompt was filled but no submitted ${platformLabel()} user turn appeared.`);
  } finally {
    capture?.stop();
  }
}

function startGptConversationUrlCapture(): { getUrl: () => string | null; stop: () => void } {
  let capturedUrl: string | null = null;
  const capture = () => {
    const normalizedUrl = normalizeGptConversationUrl(location.href);
    if (!capturedUrl && normalizedUrl && isGptConversationPath(location.pathname)) capturedUrl = normalizedUrl;
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    originalPushState(...args);
    capture();
  }) as History["pushState"];
  history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    originalReplaceState(...args);
    capture();
  }) as History["replaceState"];

  let stopped = false;
  return {
    getUrl: () => {
      capture();
      return capturedUrl;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    }
  };
}

async function fillPromptAndSendDoubao(job: Job): Promise<void> {
  const { prompt } = job;
  const isNewConversation = !hasRecordedConversation(job);
  const capture = isNewConversation ? startGptConversationUrlCapture() : null;

  try {
    if (job.mode === "image") {
      await enterDoubaoImageMode();
      const model = readDoubaoModel(job.metadata);
      if (model) await selectDoubaoModel(model, DOUBAO_MODEL_TRIGGER_SELECTOR);
    }

    if (job.mode === "video") {
      await enterDoubaoVideoMode();
      // 顺序照人工来：先挂参考图，再挑模型和比例/时长。
      // 反过来的话，附件把比例锁成「自动」这类情况会让先设好的参数被悄悄改掉，
      // 而现在这个顺序下参数回读断言就能直接把它暴露成报错。
      if (job.sourceImages.length > 0) {
        await uploadDoubaoVideoReferences(job);
        await report(job.id, "sending_prompt");
      }
      const model = readDoubaoModel(job.metadata);
      if (model) await selectDoubaoModel(model, DOUBAO_VIDEO_MODEL_TRIGGER_SELECTOR);
      await applyDoubaoVideoParams(job);
    }

    const composer = fillPrompt(prompt);
    await sleep(300);
    const sendButton = findDoubaoSendButton();
    if (await submitPromptWithFallback({
      composer,
      sendButton,
      getSendButton: findDoubaoSendButton,
      isSubmitted: () => isPromptSubmitted(prompt),
      onWaitingForSubmitReady: () => report(job.id, "waiting_upload_ready"),
      sleep
    })) return;

    const capturedUrl = capture?.getUrl() ?? null;
    if (shouldReloadCapturedConversation({ capturedUrl, currentPathname: location.pathname })) {
      location.href = capturedUrl as string;
      if (await waitForReloadConversation(job.id)) return;
    }

    throw new RetryableJobError("Prompt was filled but no submitted 豆包 user turn appeared.");
  } finally {
    capture?.stop();
  }
}

async function enterDoubaoImageMode(): Promise<void> {
  if (isDoubaoImageModeActive()) return;

  const button = findDoubaoToolbarButton("图像生成");
  if (!button) throw new Error("豆包「图像生成」按钮未找到。");
  button.click();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isDoubaoImageModeActive()) return;
    await sleep(300);
  }
  throw new Error("点击「图像生成」后未能进入图片生成模式。");
}

function isDoubaoImageModeActive(): boolean {
  const placeholderEl = document.querySelector("[data-placeholder]");
  return placeholderEl?.getAttribute("data-placeholder") === "描述你想要的图片";
}

async function enterDoubaoVideoMode(): Promise<void> {
  if (isDoubaoVideoModeActive()) return;

  const button = findDoubaoToolbarButton("视频生成");
  if (!button) throw new Error("豆包「视频生成」按钮未找到。");
  button.click();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isDoubaoVideoModeActive()) return;
    await sleep(300);
  }
  throw new Error("点击「视频生成」后未能进入视频生成模式。");
}

function isDoubaoVideoModeActive(): boolean {
  const placeholderEl = document.querySelector("[data-placeholder]");
  return placeholderEl?.getAttribute("data-placeholder") === "描述你想要的视频";
}

// 豆包 actionbar 上的控件是 radix dropdown，data-* 属性比 class 稳定得多。
const DOUBAO_MODEL_TRIGGER_SELECTOR = "[data-input-engine-actionbar-control-key='model']";
// 视频模式的模型下拉是另一个 control-key，菜单结构和图片模式完全一致。
const DOUBAO_VIDEO_MODEL_TRIGGER_SELECTOR = "[data-input-engine-actionbar-control-key='video-model']";
const DOUBAO_VIDEO_PARAMS_TRIGGER_SELECTOR =
  "[data-input-engine-actionbar-render-entry-key='video-generation-params-panel']";
const DOUBAO_VIDEO_PARAMS_PANEL_SELECTOR =
  "[data-slot='dropdown-menu-content'][data-creation-params-panel-id]";
const DOUBAO_MENU_SELECTOR = "[role='menu'][data-slot='dropdown-menu-content']";
const DOUBAO_MENU_ITEM_SELECTOR = "[role='menuitem'][data-slot='dropdown-menu-item']";

// 「比例 · 时长」面板：比例是一排 button，时长是一个 radix slider。
// 触发按钮上的文字就是当前生效值（例如 "16:9 · 4s"），拿它做回读断言。
async function applyDoubaoVideoParams(job: Job): Promise<void> {
  const ratio = readDoubaoVideoRatio(job.metadata);
  const seconds = readDoubaoVideoDurationSeconds(job.metadata);
  if (!ratio && seconds === undefined) return;

  const trigger = document.querySelector<HTMLElement>(DOUBAO_VIDEO_PARAMS_TRIGGER_SELECTOR);
  if (!trigger) throw new Error("豆包视频「比例 · 时长」按钮未找到，可能不在视频生成模式。");
  if (isDoubaoVideoParamsApplied(trigger.innerText ?? "", { ratio, seconds })) return;

  clickDoubaoControl(trigger);
  const panel = await waitUntilTruthy(() => {
    const element = document.querySelector<HTMLElement>(DOUBAO_VIDEO_PARAMS_PANEL_SELECTOR);
    return element && isPresentInLayout(element) ? element : null;
  }, 5_000);
  if (!panel) throw new Error("点击「比例 · 时长」后参数面板未出现。");

  try {
    if (ratio) await selectDoubaoVideoRatio(panel, ratio);
    if (seconds !== undefined) await setDoubaoVideoDuration(panel, seconds);
  } catch (error) {
    closeDoubaoDropdown();
    throw error;
  }
  closeDoubaoDropdown();

  const applied = await waitUntilTruthy(() => {
    const current = document.querySelector<HTMLElement>(DOUBAO_VIDEO_PARAMS_TRIGGER_SELECTOR);
    return current && isDoubaoVideoParamsApplied(current.innerText ?? "", { ratio, seconds }) ? current : null;
  }, 5_000);
  if (!applied) {
    const current = document.querySelector<HTMLElement>(DOUBAO_VIDEO_PARAMS_TRIGGER_SELECTOR)?.innerText ?? "";
    const parsed = parseDoubaoVideoParamsTrigger(current);
    const wanted = [ratio ?? "（不改）", seconds === undefined ? "（不改）" : `${seconds}s`].join(" · ");
    const durationHint = seconds !== undefined && parsed && parsed.seconds !== seconds
      ? `当前模型实际接受 ${parsed.seconds}s。`
      : "";
    throw new Error(
      `豆包视频参数未设置成「${wanted}」，当前是「${parsed ? `${parsed.ratio} · ${parsed.seconds}s` : current.trim() || "未知"}」。${durationHint}`
    );
  }
}

async function selectDoubaoVideoRatio(panel: HTMLElement, ratio: string): Promise<void> {
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>("div.grid button")]
    .filter(button => isPresentInLayout(button));
  const match = matchDoubaoVideoRatioOption(buttons.map(button => button.innerText ?? ""), ratio);
  if ("errorMessage" in match) throw new Error(match.errorMessage);
  buttons[match.index]!.click();
  await sleep(200);
}

// 时长 slider 用键盘驱动最稳：拖拽要算像素，而 ArrowLeft/ArrowRight 每次正好动 1 格。
// 面板打开时 actionbar 仍保留旧值，所以调节过程中读滑块自身的 aria-valuenow；
// 面板关闭后再由调用方读取 actionbar，确认参数确实提交给豆包。超出当前模型上限时，
// 豆包会在关闭面板后回弹到可用值。
async function setDoubaoVideoDuration(panel: HTMLElement, seconds: number): Promise<void> {
  const thumb = panel.querySelector<HTMLElement>("[data-slot='slider-thumb'][role='slider']");
  if (!thumb) throw new Error("豆包视频时长滑块未找到。");

  const wanted = clampDurationSeconds(seconds);
  const wantedSliderValue = wanted - DOUBAO_VIDEO_MIN_DURATION_SECONDS;
  thumb.focus();

  for (let guard = 0; guard < 32; guard += 1) {
    const current = Number(thumb.getAttribute("aria-valuenow"));
    if (!Number.isFinite(current)) throw new Error("豆包视频时长滑块没有 aria-valuenow。");
    if (current === wantedSliderValue) return;

    const key = current > wantedSliderValue ? "ArrowLeft" : "ArrowRight";
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    thumb.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));

    const moved = await waitUntilTruthy(() => {
      const next = Number(thumb.getAttribute("aria-valuenow"));
      return Number.isFinite(next) && next !== current ? next : null;
    }, 600);
    if (moved === null) {
      const currentSeconds = current + DOUBAO_VIDEO_MIN_DURATION_SECONDS;
      throw new Error(`豆包视频时长卡在 ${currentSeconds}s，调不到 ${wanted}s。`);
    }
  }
  throw new Error(`豆包视频时长未能调到 ${wanted}s，仍是 ${readAppliedDoubaoVideoSeconds() ?? "未知"}s。`);
}

// 触发按钮上的「比例 · 时长」才是真正生效的参数，滑块只是面板里的临时状态。
function readAppliedDoubaoVideoSeconds(): number | undefined {
  const text = document.querySelector<HTMLElement>(DOUBAO_VIDEO_PARAMS_TRIGGER_SELECTOR)?.innerText ?? "";
  return parseDoubaoVideoParamsTrigger(text)?.seconds;
}

async function selectDoubaoModel(model: string, triggerSelector: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(triggerSelector);
  if (!trigger) throw new Error("豆包「模型」按钮未找到，可能不在对应的生成模式。");
  if (isDoubaoModelSelected(trigger.innerText ?? "", model)) return;

  clickDoubaoControl(trigger);
  const menu = await waitUntilTruthy(() => {
    const element = document.querySelector<HTMLElement>(DOUBAO_MENU_SELECTOR);
    return element && isPresentInLayout(element) ? element : null;
  }, 5_000);
  if (!menu) throw new Error("点击「模型」后下拉菜单未出现。");

  try {
    const options = [...menu.querySelectorAll<HTMLElement>(DOUBAO_MENU_ITEM_SELECTOR)];
    const match = matchDoubaoModelOption(options.map(option => option.innerText ?? ""), model);
    if ("errorMessage" in match) throw new Error(match.errorMessage);
    clickDoubaoControl(options[match.index]);
  } catch (error) {
    closeDoubaoDropdown();
    throw error;
  }

  // 收费模型（例如带「升级」角标的 5.0 Pro）点了也可能选不上，
  // 所以必须以触发按钮的回显为准，而不是以点击成功为准。
  const applied = await waitUntilTruthy(() => {
    const current = document.querySelector<HTMLElement>(triggerSelector);
    return current && isDoubaoModelSelected(current.innerText ?? "", model) ? current : null;
  }, 5_000);
  if (!applied) {
    closeDoubaoDropdown();
    const current = doubaoModelTriggerName(
      document.querySelector<HTMLElement>(triggerSelector)?.innerText ?? ""
    );
    throw new Error(`豆包模型未切换到「${model}」，当前仍是「${current || "未知"}」，可能需要更高权益。`);
  }
}

// radix 的 trigger/menuitem 只监听 pointerdown/mouseup，单纯 .click() 不会展开。
function clickDoubaoControl(element: HTMLElement): void {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  element.click();
}

function closeDoubaoDropdown(): void {
  if (!document.querySelector(`${DOUBAO_MENU_SELECTOR},${DOUBAO_VIDEO_PARAMS_PANEL_SELECTOR}`)) return;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

function findDoubaoToolbarButton(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => isVisible(button) && button.innerText?.trim() === label) ?? null;
}

function findDoubaoSendButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => isVisible(button) && getComputedStyle(button).backgroundColor === DOUBAO_BRAND_BLUE) ?? null;
}

const DOUBAO_ACTIONBAR_KEY_ATTRS = [
  "data-input-engine-actionbar-control-key",
  "data-input-engine-actionbar-render-entry-key"
] as const;

const DOUBAO_ACTIONBAR_SELECTOR = DOUBAO_ACTIONBAR_KEY_ATTRS.map(attr => `[${attr}]`).join(",");

function doubaoActionbarControls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(DOUBAO_ACTIONBAR_SELECTOR)]
    .filter(element => isPresentInLayout(element));
}

// 输入框那一行的容器：从第一个已知控件往上走，直到这个祖先把所有控件都包住。
// 「+」自己不一定带 data-key，只能靠这个范围把它和侧栏的「+」区分开。
function findDoubaoActionbarRoot(): HTMLElement | null {
  const controls = doubaoActionbarControls();
  let root = controls[0]?.parentElement ?? null;
  while (root && !controls.every(control => root!.contains(control))) root = root.parentElement;
  return root;
}

// 附件入口先按 actionbar 的 data-key 认（upload/attach/file），
// 再在同一行里按文案退一步找，绝不扫全页面——侧栏的「新建对话 +」长得一样。
function findDoubaoAttachButton(): HTMLElement | null {
  const byKey = doubaoActionbarControls().find(element =>
    DOUBAO_ACTIONBAR_KEY_ATTRS.some(attr => isDoubaoAttachControlKey(element.getAttribute(attr) ?? "")));
  if (byKey) return byKey;

  const root = findDoubaoActionbarRoot();
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("button,[role='button']")]
    .find(element => isPresentInLayout(element) && isDoubaoAttachButtonLabel(elementLabel(element))) ?? null;
}

// 认不出附件入口时把整行控件记进 trace，下次直接照着 key/文案补匹配规则。
function describeDoubaoActionbarControls(): string[] {
  const keyed = doubaoActionbarControls().map(element => {
    const key = DOUBAO_ACTIONBAR_KEY_ATTRS.map(attr => element.getAttribute(attr)).find(Boolean) ?? "";
    return `key=${key}:${elementLabel(element).slice(0, 24)}`;
  });
  const root = findDoubaoActionbarRoot();
  const plain = root
    ? [...root.querySelectorAll<HTMLElement>("button,[role='button']")]
      .filter(element => isPresentInLayout(element))
      .map(element => `btn:${elementLabel(element).slice(0, 24)}`)
    : [];
  return [...keyed, ...plain].slice(0, 32);
}

async function waitForDoubaoUploadReady(jobId: string): Promise<void> {
  await report(jobId, "waiting_upload_ready");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (findDoubaoSendButton()) return;
    await sleep(500);
  }
  throw new Error("豆包图片上传未在超时前完成。");
}

// 视频模式的参考图：和图片模式共用 file input，但就绪信号只有「发送按钮变蓝」这一个，
// 而视频模式此时输入框还是空的，蓝按钮不一定会亮。超时就把 actionbar 记进 trace 再报错，
// 不吞掉——否则会发出一条没带参考图的提示词，看起来还像成功了。
async function uploadDoubaoVideoReferences(job: Job): Promise<void> {
  await report(job.id, "uploading");
  await uploadSources(job);
  try {
    await waitForDoubaoUploadReady(job.id);
  } catch {
    await traceJob(job.id, "doubao_video_reference_upload_timeout", {
      sourceImageCount: job.sourceImages.length,
      actionbarControls: describeDoubaoActionbarControls()
    });
    throw new Error(
      `豆包视频参考图（${job.sourceImages.length} 张）上传后未等到可发送状态，已中止，避免发出不带参考图的提示词。`
    );
  }
  await traceJob(job.id, "doubao_video_reference_uploaded", { sourceImageCount: job.sourceImages.length });
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
  // 顺序有讲究：先切到视频模式（输入框会重排、模型和尺寸下拉才挂上去），
  // 再选模型（聊天模式也有这个下拉，所以放在 if 外面），最后设尺寸。
  if (job.mode === "video") await enterGeminiVideoMode(job);
  await applyGeminiModel(job);
  if (job.mode === "video") await applyGeminiVideoRatio(job);

  await report(job.id, "sending_prompt");
  const composer = fillPrompt(prompt);
  if (job.sourceImages.length > 0) {
    await report(job.id, "uploading");
    // 视频模式的参考图有独立入口，往输入框贴图不一定被当成参考图。
    if (job.mode === "video") await uploadGeminiVideoReferences(job, composer);
    else await pasteGeminiSources(job, composer);
    await waitForGeminiUploadReady(job.id);
  }

  if (await submitGeminiPromptWithFallback(job, composer, prompt)) return;
  if (job.sourceImages.length > 0) {
    throw new RetryableJobError("Gemini send control was not ready after image upload.");
  }

  throw new RetryableJobError(`Prompt was filled but no submitted Gemini user turn appeared.`);
}

// Gemini 的视频生成入口在输入框的「+」菜单里（Create video），点完输入框上会多出
// 一个「Videos」chip 和一个尺寸下拉。这些控件都没有稳定的 class/data-*，
// 所以统一按「输入框附近的可见按钮 + 文案」找，找不到时把实际读到的文案写进 trace，
// 下次改选择器不用再靠猜。
function geminiComposerScope(): ParentNode {
  const composer = findComposer();
  if (!(composer instanceof HTMLElement)) return document;
  let scope: HTMLElement = composer;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = scope.parentElement;
    if (!parent || parent === document.body) break;
    scope = parent;
  }
  return scope;
}

function geminiScopeButtons(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button,[role='button'],[role='combobox']")]
    .filter(isPresentInLayout);
}

function isGeminiVideoModeActive(): boolean {
  const placeholder = [...document.querySelectorAll<HTMLElement>("[data-placeholder],[aria-label],[placeholder]")]
    .filter(isPresentInLayout)
    .some(element => isGeminiVideoPlaceholder(
      `${element.getAttribute("data-placeholder") ?? ""} ${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("aria-label") ?? ""}`
    ));
  if (placeholder) return true;
  return geminiScopeButtons(geminiComposerScope()).some(button => isGeminiVideoModeChipLabel(elementLabel(button)));
}

function findGeminiToolsMenuButton(): HTMLElement | null {
  const buttons = geminiScopeButtons(geminiComposerScope());
  const labelled = buttons.find(button =>
    /upload and tools|upload files|add files|tools|上传|工具|添加/i.test(elementAccessibleLabel(button)));
  if (labelled) return labelled;
  // 「+」按钮有时只有图标没有任何文案，退一步认输入框旁边那个开菜单的无文案按钮。
  const iconOnly = buttons.find(button => button.getAttribute("aria-haspopup") === "menu" && !elementLabel(button));
  return iconOnly ?? findUploadMenuButton();
}

function findGeminiOverlayItems(): HTMLElement[] {
  const selector = [
    "[role='menu'] [role='menuitem']",
    "[role='menu'] [role='menuitemradio']",
    "[role='menu'] button",
    "[role='listbox'] [role='option']",
    ".mat-mdc-menu-panel button",
    ".cdk-overlay-pane [role='menuitem']"
  ].join(",");
  const items = [...document.querySelectorAll<HTMLElement>(selector)].filter(isPresentInLayout);
  // 取最内层命中，避免同一项既匹配 [role=menuitem] 又匹配里面的 button 时重复。
  return items.filter(item => !items.some(other => other !== item && item.contains(other)));
}

function closeGeminiOverlay(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

async function enterGeminiVideoMode(job: Job): Promise<void> {
  if (isGeminiVideoModeActive()) {
    await traceJob(job.id, "gemini_video_mode_already_active", {});
    return;
  }

  const menuButton = findGeminiToolsMenuButton();
  if (!menuButton) {
    await traceJob(job.id, "gemini_video_tools_button_missing", {
      buttons: geminiScopeButtons(geminiComposerScope()).slice(0, 24).map(button => elementAccessibleLabel(button).slice(0, 40))
    });
    throw new Error("Gemini 输入框上的「+」工具菜单按钮未找到。");
  }
  menuButton.click();

  const entry = await waitUntilTruthy(() => {
    const items = findGeminiOverlayItems();
    return items.find(item => isGeminiVideoToolLabel(elementLabel(item))) ?? null;
  }, 5_000);
  if (!entry) {
    const labels = findGeminiOverlayItems().map(item => elementLabel(item).slice(0, 40));
    await traceJob(job.id, "gemini_video_menu_probe", { items: labels.slice(0, 24) });
    closeGeminiOverlay();
    throw new Error(`Gemini「+」菜单里没找到「Create video」。读到的菜单项：${labels.filter(Boolean).join("、") || "（未读到）"}`);
  }
  // 切模式可能带一次 SPA 跳转，先告诉 background 这次 reload 是预期的，
  // 否则它的「意外刷新」恢复逻辑会把任务判失败（和 startGeminiNewChat 一致）。
  await setExpectingNavigation(true);
  try {
    entry.click();
    const active = await waitUntilTruthy(() => (isGeminiVideoModeActive() ? true : null), 15_000);
    if (!active) throw new Error("点击「Create video」后未能进入 Gemini 视频生成模式。");
  } finally {
    await setExpectingNavigation(false);
  }
  await traceJob(job.id, "gemini_video_mode_entered", {});
}

// 尺寸下拉的触发按钮上写着当前生效值（例如 "Landscape (16:9)"），拿它做回读断言。
function findGeminiVideoRatioTrigger(): HTMLElement | null {
  const buttons = geminiScopeButtons(geminiComposerScope())
    .filter(button => !isGeminiVideoModeChipLabel(elementLabel(button)));
  return buttons.find(button => {
    const label = elementLabel(button);
    return /\d+\s*[:：]\s*\d+/.test(label) || /landscape|portrait|横屏|竖屏/i.test(label);
  }) ?? null;
}

async function applyGeminiVideoRatio(job: Job): Promise<void> {
  const ratio = readGeminiVideoRatio(job.metadata);
  if (!ratio) return;

  const trigger = await waitUntilTruthy(findGeminiVideoRatioTrigger, 8_000);
  if (!trigger) {
    await traceJob(job.id, "gemini_video_ratio_trigger_missing", {
      buttons: geminiScopeButtons(geminiComposerScope()).slice(0, 24).map(button => elementLabel(button).slice(0, 40))
    });
    throw new Error("Gemini 视频尺寸下拉未找到，可能没进入视频生成模式。");
  }
  if (isGeminiVideoRatioApplied(elementLabel(trigger), ratio)) {
    await traceJob(job.id, "gemini_video_ratio_already_applied", { ratio });
    return;
  }

  trigger.click();
  const options = await waitUntilTruthy(() => {
    const items = findGeminiOverlayItems();
    return items.length > 0 ? items : null;
  }, 5_000);
  if (!options) throw new Error("点击 Gemini 视频尺寸后下拉没有出现。");

  const match = matchGeminiVideoRatioOption(options.map(elementLabel), ratio);
  if ("errorMessage" in match) {
    await traceJob(job.id, "gemini_video_ratio_probe", { wanted: ratio, options: options.map(item => elementLabel(item).slice(0, 40)) });
    closeGeminiOverlay();
    throw new Error(match.errorMessage);
  }
  options[match.index]!.click();

  const applied = await waitUntilTruthy(() => {
    const current = findGeminiVideoRatioTrigger();
    return current && isGeminiVideoRatioApplied(elementLabel(current), ratio) ? current : null;
  }, 5_000);
  if (!applied) {
    closeGeminiOverlay();
    const current = findGeminiVideoRatioTrigger();
    throw new Error(`Gemini 视频尺寸未设置成「${ratio}」，当前是「${current ? elementLabel(current) : "未知"}」。`);
  }
  await traceJob(job.id, "gemini_video_ratio_applied", { ratio, trigger: elementLabel(applied) });
}

// 模型下拉在输入框右下角，按钮上写着当前模型的短名（"Flash" / "Pro"），
// 下拉项则是「3.7 Flash + 一句说明」，所以匹配走 geminiModel.ts 的系列 + 版本逻辑。
function findGeminiModelTrigger(): HTMLElement | null {
  return geminiScopeButtons(geminiComposerScope())
    .find(button => isGeminiModelTriggerLabel(elementLabel(button))) ?? null;
}

async function applyGeminiModel(job: Job): Promise<void> {
  const model = readGeminiModel(job.metadata);
  if (!model) return;

  const trigger = await waitUntilTruthy(findGeminiModelTrigger, 8_000);
  if (!trigger) {
    await traceJob(job.id, "gemini_model_trigger_missing", {
      buttons: geminiScopeButtons(geminiComposerScope()).slice(0, 24).map(button => elementLabel(button).slice(0, 40))
    });
    throw new Error("Gemini 模型下拉未找到。");
  }
  if (isGeminiModelApplied(elementLabel(trigger), model)) {
    await traceJob(job.id, "gemini_model_already_applied", { model, trigger: elementLabel(trigger) });
    return;
  }

  trigger.click();
  const options = await waitUntilTruthy(() => {
    const items = findGeminiOverlayItems();
    return items.length > 0 ? items : null;
  }, 5_000);
  if (!options) throw new Error("点击 Gemini 模型下拉后没有出现选项。");

  const match = matchGeminiModelOption(options.map(elementLabel), model);
  if ("errorMessage" in match) {
    await traceJob(job.id, "gemini_model_probe", { wanted: model, options: options.map(item => elementLabel(item).slice(0, 60)) });
    closeGeminiOverlay();
    throw new Error(match.errorMessage);
  }
  options[match.index]!.click();

  const applied = await waitUntilTruthy(() => {
    const current = findGeminiModelTrigger();
    return current && isGeminiModelApplied(elementLabel(current), model) ? current : null;
  }, 5_000);
  if (!applied) {
    closeGeminiOverlay();
    const current = findGeminiModelTrigger();
    throw new Error(`Gemini 模型未切到「${model}」，当前是「${current ? elementLabel(current) : "未知"}」。`);
  }
  await traceJob(job.id, "gemini_model_applied", { model, trigger: elementLabel(applied) });
}

// 视频模式的参考图：尺寸下拉左边有个「图片+」图标按钮。
// 不去点那个按钮本身（可能直接唤起系统文件对话框，那会把浏览器卡住），
// 只借它/「+」菜单把 Angular 里那个隐藏 input[type=file] 渲染出来，再往里塞文件。
function findGeminiVideoReferenceButton(): HTMLElement | null {
  return geminiScopeButtons(geminiComposerScope())
    .find(button => isGeminiVideoReferenceButtonLabel(elementAccessibleLabel(button))) ?? null;
}

function findGeminiImageFileInput(): HTMLInputElement | null {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  return inputs.find(input => /image|\.png|\.jpe?g|\.webp/i.test(input.accept)) ?? inputs.at(-1) ?? null;
}

// 附件数量：传上去的参考图会在输入框里变成缩略图卡片，卡片上带一个删除按钮。
// 两种数法取大的那个，缩略图还在转圈时至少删除按钮已经在了。
function countGeminiComposerAttachments(): number {
  const scope = geminiComposerScope();
  const thumbnails = [...scope.querySelectorAll<HTMLImageElement>("img")]
    .filter(image => isPresentInLayout(image) && /^(blob:|data:)/.test(image.getAttribute("src") ?? "")).length;
  const removals = geminiScopeButtons(scope)
    .filter(button => /remove|delete|移除|删除/i.test(elementAccessibleLabel(button))).length;
  return Math.max(thumbnails, removals);
}

async function waitForGeminiAttachmentCount(target: number, timeoutMs: number): Promise<number | null> {
  return waitUntilTruthy(() => {
    const count = countGeminiComposerAttachments();
    return count >= target ? count : null;
  }, timeoutMs);
}

function assignFilesToInput(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function materializeGeminiFileInput(job: Job): Promise<{ input: HTMLInputElement; via: string } | null> {
  const existing = findGeminiImageFileInput();
  if (existing) return { input: existing, via: "existing" };

  // 「+」工具菜单一展开，隐藏的 file input 就跟着渲染出来了（和聊天模式上传同一条路）。
  for (const [via, button] of [["tools_menu", findGeminiToolsMenuButton()], ["reference_button", findGeminiVideoReferenceButton()]] as const) {
    if (!button) continue;
    button.click();
    const input = await waitUntilTruthy(findGeminiImageFileInput, 2_000);
    closeGeminiOverlay();
    if (input) return { input, via };
    await traceJob(job.id, "gemini_video_reference_input_missing", { via });
  }
  return null;
}

async function uploadGeminiVideoReferences(
  job: Job,
  composer: HTMLElement | HTMLTextAreaElement
): Promise<void> {
  const files = await Promise.all(job.sourceImages.map((source, index) => sourceToFile(source, index)));
  const before = countGeminiComposerAttachments();
  const target = await materializeGeminiFileInput(job);
  if (!target) {
    // 实在找不到 file input 就退回聊天模式那条「往输入框贴图」的老路，
    // 别让任务直接死掉；到底认不认参考图，看后面的 accepted 数。
    await traceJob(job.id, "gemini_video_reference_fallback_paste", {
      buttons: geminiScopeButtons(geminiComposerScope()).slice(0, 24)
        .map(button => elementAccessibleLabel(button).slice(0, 40))
    });
    await pasteGeminiSources(job, composer);
  } else if (target.input.multiple || files.length === 1) {
    assignFilesToInput(target.input, files);
  } else {
    // 单选 input 只能一张一张来，每张都等缩略图出现再传下一张。
    for (const [index, file] of files.entries()) {
      const input = index === 0 ? target.input : (await materializeGeminiFileInput(job))?.input;
      if (!input) throw new Error(`Gemini 参考图第 ${index + 1} 张没找到可用的文件输入框。`);
      assignFilesToInput(input, [file]);
      await waitForGeminiAttachmentCount(before + index + 1, 30_000);
    }
  }

  const accepted = (await waitForGeminiAttachmentCount(before + files.length, 30_000))
    ?? countGeminiComposerAttachments();
  await traceJob(job.id, "gemini_video_reference_uploaded", {
    requested: files.length,
    accepted: accepted - before,
    multiple: target?.input.multiple ?? null,
    via: target?.via ?? "paste"
  });
  if (accepted <= before) {
    throw new Error(`Gemini 视频参考图没传上去（输入框里没出现缩略图，请求 ${files.length} 张）。`);
  }
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

function hasOnlyResponseActionMenu(jobId: string): boolean {
  const assistant = findJobAssistant(jobId);
  if (!assistant) return false;
  const actions = [...assistant.querySelectorAll<HTMLButtonElement>('[aria-label="Response actions"] button')]
    .filter(isVisible);
  return actions.length === 1 && actions[0]?.getAttribute("aria-haspopup") === "menu";
}

function hasActiveGenerationControl(): boolean {
  return Boolean(findActiveGenerationControl());
}

function stopActiveGptGeneration(): boolean {
  const button = findActiveGenerationControl();
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  button.click();
  return true;
}

function findActiveGenerationControl(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => {
    const label = `${button.innerText} ${button.ariaLabel ?? ""} ${button.title ?? ""}`;
    return isVisible(button) && isGenerationStopControl(button.getAttribute("data-testid"), label);
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
  throw new Error(`Prompt was filled but no submitted ${platformLabel()} user turn appeared.`);
}

async function sourceToFile(source: string, index: number): Promise<File> {
  const response = await fetch(source);
  const blob = await response.blob();
  const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
  return new File([blob], `source-${index + 1}.${ext}`, { type: blob.type || "image/png" });
}

async function collectImages(images: HTMLImageElement[]): Promise<CollectedImage[]> {
  const result = [];
  for (const [index, image] of images.entries()) {
    const { blob, acquisition } = await fetchBestImageBlob(image);
    const sourceId = imageKey(image);
    const sha256 = await sha256Blob(blob);
    const contentType = blob.type || "image/png";
    if (activeJob) {
      await traceJob(activeJob.id, "image_asset_collected", {
        index: index + 1,
        sourceId,
        acquisition,
        byteLength: blob.size,
        contentType,
        sha256
      });
    }
    result.push({
      index,
      sourceId,
      contentType,
      byteLength: blob.size,
      sha256,
      acquisition,
      dataUrl: await blobToDataUrl(blob)
    });
  }
  return result;
}

async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// <img src> is often a resized/cropped preview render, not the original
// generated image. On Gemini specifically, the full-size asset is only
// reachable by actually clicking the page's own "Download full-sized
// image" button and letting background.ts capture the resulting browser
// download (that button exposes no fetchable URL at all — no href, no
// data-* attribute). There is no reliable fallback for Gemini: falling
// back to the cropped/downsized <img> source would silently ship a lower-
// quality image without any signal that the real download failed, so a
// failed capture here must fail the job instead of being masked.
//
// Doubao, like Gemini, exposes a per-image download action. The generated
// image URL is only a rendered page resource, so every requested output
// must go through that action. Do not fall back to fetch() here: that would
// make a task look successful while exporting a preview instead of the
// downloaded image.
//
// On GPT, by contrast, the rendered <img src> is the same
// /backend-api/estuary/content URL the Share-sheet's Download button uses
// (confirmed by inspecting both), so there's no quality difference between
// them — going through the real download flow is about parity with
// Gemini's approach, not fixing a quality bug. A failed capture here can
// safely fall back to the existing fetch(img.src) path instead of failing
// the job.
async function fetchBestImageBlob(image: HTMLImageElement): Promise<{
  blob: Blob;
  acquisition: "gpt_direct" | "gpt_share_sheet" | "gemini_download" | "doubao_download" | "element_url";
}> {
  if (activeJob?.platform === "gemini") {
    return { blob: await downloadGeminiFullSizeImage(image), acquisition: "gemini_download" };
  }
  if (activeJob?.platform === "doubao") {
    return { blob: await downloadDoubaoImage(image), acquisition: "doubao_download" };
  }
  if (activeJob?.platform === "gpt") {
    try {
      const blob = await fetchImageElementBlob(image);
      await debugLog("fetchBestImageBlob:gpt direct image fetch succeeded", { sourceId: imageKey(image), size: blob.size, type: blob.type });
      return { blob, acquisition: "gpt_direct" };
    } catch (error) {
      await debugLog("fetchBestImageBlob:gpt direct image fetch failed, trying share sheet", { sourceId: imageKey(image), error: String(error) });
    }
    try {
      const blob = await downloadGptFullSizeImage(image);
      await debugLog("fetchBestImageBlob:gpt share sheet download succeeded", { sourceId: imageKey(image), size: blob.size, type: blob.type });
      return { blob, acquisition: "gpt_share_sheet" };
    } catch (error) {
      await debugLog("fetchBestImageBlob:gpt share sheet download failed, falling back", { sourceId: imageKey(image), error: String(error) });
    }
  }

  return { blob: await fetchImageElementBlob(image), acquisition: "element_url" };
}

async function fetchImageElementBlob(image: HTMLImageElement): Promise<Blob> {
  for (const source of imageCandidates(image)) {
    try {
      const response = await fetch(source);
      if (!response.ok && !source.startsWith("blob:") && !source.startsWith("data:")) continue;
      const blob = await response.blob();
      if (blob.size > 0) return blob;
    } catch {
      // try the next candidate
    }
  }
  const response = await fetch(image.currentSrc || image.src);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("Image element source returned an empty response.");
  return blob;
}

// A programmatic HTMLElement.click() does not carry the browser's
// "transient user activation" that these download handlers apparently
// require to actually trigger a save-to-disk (observed empirically on
// Gemini: it reliably works for the first image in a tab but
// intermittently — and increasingly, for later images — times out with no
// browser download ever starting, despite the click event visibly reaching
// the button). A synthetic click can't manufacture that activation; only an
// OS-level input event can, which content scripts have no access to.
// background.ts uses chrome.debugger (the same CDP the reference Electron
// implementation relies on) to dispatch a trusted mouse click at the given
// on-screen point instead — that's why this hands off coordinates rather
// than clicking directly.
//
// A plain chrome.runtime.sendMessage() only resolves once background.ts has
// finished the ENTIRE capture (including waiting for the download to
// complete) — there's no way to tell from it when background's
// chrome.downloads.onCreated listener actually got armed. Requesting the
// click immediately after firing sendMessage() would race that listener
// attaching (message delivery to the service worker is never synchronous),
// risking the resulting download firing before anyone is listening for it.
// A long-lived port gets background to explicitly ack "listening now"
// before asking it to click, then deliver the final result as a second
// message once the download has actually been captured.
async function requestTrustedClickDownload(point: { x: number; y: number }, failureLabel: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "image-download-capture" });
    let settled = false;
    const finishOk = (blob: Blob) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      resolve(blob);
    };
    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(new Error(message));
    };

    port.onMessage.addListener((message: { type: string; ok?: boolean; contentType?: string; base64?: string; error?: string }) => {
      if (message.type === "RESULT") {
        if (message.ok && message.contentType && message.base64) {
          finishOk(base64ToBlob(message.base64, message.contentType));
        } else {
          finishError(message.error || `${failureLabel} failed for an unknown reason.`);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      finishError("Connection to the extension background script was lost before the download completed.");
    });
    port.postMessage({ type: "REQUEST_IMAGE_DOWNLOAD", point });
  });
}

// 豆包视频卡片的下载按钮只在鼠标真的悬停在卡片上时才出现，而 debugger 一 attach
// 又会因为调试提示栏改变视口高度，让 attach 之前量的坐标失效。所以把「量坐标」这一步
// 交给 background：它先用 CDP 把真实指针挪到卡片上，再回一个 HOVER_READY，
// 我们在那个状态下现场找按钮、回传坐标，最后由它在同一次 attach 里点下去。
async function requestHoverClickDownload(
  hoverPoint: { x: number; y: number },
  measureClickPoint: () => Promise<{ x: number; y: number } | null>,
  failureLabel: string
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "image-download-capture" });
    let settled = false;
    const finishOk = (blob: Blob) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      resolve(blob);
    };
    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(new Error(message));
    };

    port.onMessage.addListener((message: { type: string; ok?: boolean; contentType?: string; base64?: string; error?: string }) => {
      if (message.type === "HOVER_READY") {
        void measureClickPoint()
          .then(point => port.postMessage({ type: "CLICK_AT", point }))
          .catch(() => port.postMessage({ type: "CLICK_AT", point: null }));
        return;
      }
      if (message.type === "RESULT") {
        if (message.ok && message.contentType && message.base64) {
          finishOk(base64ToBlob(message.base64, message.contentType));
        } else {
          finishError(message.error || `${failureLabel} failed for an unknown reason.`);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      finishError("Connection to the extension background script was lost before the download completed.");
    });
    port.postMessage({ type: "REQUEST_HOVER_DOWNLOAD", hoverPoint });
  });
}

function elementCenterPoint(element: HTMLElement): { x: number; y: number } | null {
  element.scrollIntoView({ block: "center", inline: "center" });
  return elementViewportPoint(element);
}

// 已经悬停/已经滚到位时只量不滚：scrollIntoView 会把元素挪到指针底下之外去。
function elementViewportPoint(element: HTMLElement): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function downloadGeminiFullSizeImage(image: HTMLImageElement): Promise<Blob> {
  const button = findGeminiDownloadButton(image);
  if (!button) throw new Error("Gemini's \"Download full-sized image\" button was not found for this image.");
  const point = elementCenterPoint(button);
  if (!point) throw new Error("Gemini's \"Download full-sized image\" button has no on-screen position to click.");
  return requestTrustedClickDownload(point, "Gemini full-size image download");
}

async function downloadDoubaoImage(image: HTMLImageElement): Promise<Blob> {
  image.scrollIntoView({ block: "center", inline: "center" });
  image.click();
  const saveButton = await waitUntilTruthy(findDoubaoPreviewSaveButton, 5_000);
  await debugLog("findDoubaoPreviewSaveButton", {
    found: Boolean(saveButton),
    previewOpen: isDoubaoImagePreviewOpen(),
    byIcon: saveButton ? hasDoubaoDownloadIcon(saveButton) : false
  });
  if (!saveButton) throw new Error("Doubao's image preview save button was not found.");

  try {
    const point = elementCenterPoint(saveButton);
    await debugLog("doubaoPreviewSaveButtonPoint", { point });
    if (!point) throw new Error("Doubao's image preview save button has no on-screen position to click.");
    const blob = await requestTrustedClickDownload(point, "Doubao image download");
    await debugLog("fetchBestImageBlob:doubao real download succeeded", { size: blob.size, type: blob.type });
    return blob;
  } finally {
    closeDoubaoImagePreview();
  }
}

// 豆包视频卡片：完成的视频渲染成一张封面图 + 播放按钮，真正的 <video>（xgplayer）
// 只在鼠标悬停时才挂载，下载入口也只在悬停后出现。整卡的选择器是 block-video-<hash>，
// hash 每次发版都会变，所以只匹配前缀。
const DOUBAO_VIDEO_CARD_SELECTOR = "[class*='block-video-']";
const DOUBAO_VIDEO_HOVER_GROUP_SELECTOR = "[class*='video-hover-button-group-']";

function findDoubaoVideoCards(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(DOUBAO_VIDEO_CARD_SELECTOR)]
    .filter(card => isPresentInLayout(card))
    // 生成中的占位卡没有封面图，只有出了封面才算真的有产物。
    .filter(card => Boolean(card.querySelector("img[class*='cover-']")));
}

// Gemini 的视频产物是一个内嵌 <video> 的播放卡片：生成中只有进度占位，
// 拿到 src 才算真的有产物。整卡的 class 每次发版都会变，所以从 <video> 往上找容器。
const GEMINI_VIDEO_CONTAINER_SELECTOR = "video-player,generated-video,[data-test-id*='video'],[class*='video-player']";

function findGeminiVideoCards(root: ParentNode): HTMLElement[] {
  const cards = [...root.querySelectorAll<HTMLVideoElement>("video")]
    .filter(video => isPresentInLayout(video))
    .filter(video => Boolean(video.currentSrc || video.getAttribute("src") || video.querySelector("source[src]")))
    .map(video => video.closest<HTMLElement>(GEMINI_VIDEO_CONTAINER_SELECTOR) ?? video.parentElement ?? video);
  // 两个 <video> 落在同一个容器里时只算一张卡。
  return cards.filter((card, index) => cards.indexOf(card) === index);
}

function findJobScopedVideoCards(jobId: string, platform: JobPlatform): HTMLElement[] {
  const scope = findJobConversationScope(jobId);
  if (!scope) return [];

  const cards = platform === "gemini" ? findGeminiVideoCards(document) : findDoubaoVideoCards(document);
  return cards.filter(card =>
    !scope.user.contains(card) &&
    isAfter(card, scope.user) && (!scope.nextUser || isBefore(card, scope.nextUser))
  );
}

async function collectVideos(cards: HTMLElement[]): Promise<CollectedVideo[]> {
  const isGemini = activeJob?.platform === "gemini";
  const result: CollectedVideo[] = [];
  for (const [index, card] of cards.entries()) {
    const { blob, acquisition } = isGemini
      ? { blob: await downloadGeminiVideo(card), acquisition: "gemini_video_download" as const }
      // fallback_api 是整页共享的，认不出哪条对应哪张卡片，所以只有一条视频时才敢走无水印。
      : await downloadDoubaoVideo(card, cards.length === 1);
    // 从 Downloads 读回来的文件如果扩展名认不出来会是 application/octet-stream，
    // 直接用它会让 background 按图片规则存成 .png，所以非视频类型统一按 mp4 记。
    const contentType = blob.type.startsWith("video/") ? blob.type : "video/mp4";
    const sha256 = await sha256Blob(blob);
    const sourceId = card.querySelector<HTMLImageElement>("img[class*='cover-']")?.currentSrc || `video-${index + 1}`;
    if (activeJob) {
      await traceJob(activeJob.id, "video_asset_collected", {
        index: index + 1,
        sourceId,
        acquisition,
        byteLength: blob.size,
        contentType,
        sha256
      });
    }
    result.push({
      index,
      sourceId,
      contentType,
      byteLength: blob.size,
      sha256,
      acquisition,
      dataUrl: await blobToDataUrl(blob)
    });
  }
  return result;
}

// Gemini 视频卡片：mp4 在 Google 的 CDN 上，<video> 的 src 可能是 https 直链，
// 也可能是页面自己造的 blob:。直链优先（少了量坐标、可信点击这些会飘的环节），
// 取不到才退回「点卡片上的下载入口 + chrome.downloads 捕获」这条和图片一致的老路。
async function downloadGeminiVideo(card: HTMLElement): Promise<Blob> {
  const direct = await fetchGeminiVideoBySource(card);
  if (direct) return direct;

  const action = await waitForGeminiVideoDownloadAction(card, 10_000);
  await debugLog("findGeminiVideoDownloadAction", { found: Boolean(action) });
  if (!action) {
    if (activeJob) await traceJob(activeJob.id, "gemini_video_card_probe", describeGeminiVideoCard(card));
    throw new Error("Gemini 视频卡片的下载入口未找到。");
  }

  await sleep(300);
  const point = elementCenterPoint(action);
  await debugLog("geminiVideoDownloadActionPoint", { point, action: describeNodeForTrace(action) });
  if (!point) throw new Error("Gemini 视频下载按钮没有可点击的屏幕坐标。");
  const blob = await requestTrustedClickDownload(point, "Gemini video download");
  if (blob.size === 0) throw new Error("Gemini 视频下载得到的是空文件。");
  return blob;
}

async function fetchGeminiVideoBySource(card: HTMLElement): Promise<Blob | null> {
  const src = await waitUntilTruthy(() => {
    const video = card.querySelector("video") ?? (card instanceof HTMLVideoElement ? card : null);
    const candidate = video?.currentSrc || video?.getAttribute("src") ||
      video?.querySelector("source[src]")?.getAttribute("src") || "";
    return candidate || null;
  }, 6_000);
  const described = src ? describeMediaUrl(src) : null;
  await debugLog("geminiVideoSource", { found: Boolean(src), scheme: src?.split(":")[0] ?? null, ...described });
  if (!src) return null;

  // blob: 是页面自己造的地址，同源，内容脚本能直接 fetch；
  // 但走 MSE 播放时它指向 MediaSource 而不是 Blob，fetch 会直接抛，那就退回下载按钮。
  const blob = src.startsWith("blob:") ? await fetchBlobUrl(src) : await fetchMediaThroughBackground(src);
  if (!blob || blob.size === 0) return null;
  if (activeJob) {
    await traceJob(activeJob.id, "gemini_video_direct_source_used", { ...described, byteLength: blob.size });
  }
  return blob;
}

async function fetchBlobUrl(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith("video/") ? blob : new Blob([await blob.arrayBuffer()], { type: "video/mp4" });
  } catch (error) {
    await debugLog("geminiVideoBlobFetchFailed", { error: String(error) });
    return null;
  }
}

// 卡片上的下载入口有两种形态：直接一个下载按钮，或者藏在「More options」菜单里。
// 先找现成的按钮，没有就点一次卡片上的菜单按钮，再去浮层里找。
const GEMINI_VIDEO_DOWNLOAD_LABEL_PATTERN = /download|save video|下载|保存视频/i;

function geminiVideoActionScope(card: HTMLElement): HTMLElement {
  return card.closest<HTMLElement>("message-content,model-response,response-container,[class*='response-container']") ??
    card.parentElement ??
    card;
}

function geminiVideoActionCandidates(card: HTMLElement): HTMLElement[] {
  return [...geminiVideoActionScope(card).querySelectorAll<HTMLElement>("button,[role='button'],a")]
    .filter(isPresentInLayout);
}

function findGeminiVideoDownloadAction(card: HTMLElement): HTMLElement | null {
  const inOverlay = findGeminiOverlayItems()
    .find(item => GEMINI_VIDEO_DOWNLOAD_LABEL_PATTERN.test(elementAccessibleLabel(item)));
  if (inOverlay) return inOverlay;
  return geminiVideoActionCandidates(card)
    .find(element => GEMINI_VIDEO_DOWNLOAD_LABEL_PATTERN.test(elementAccessibleLabel(element))) ?? null;
}

function findGeminiVideoMoreButton(card: HTMLElement): HTMLElement | null {
  return geminiVideoActionCandidates(card).find(element =>
    /more options|more actions|更多/i.test(elementAccessibleLabel(element)) ||
    element.getAttribute("aria-haspopup") === "menu") ?? null;
}

async function waitForGeminiVideoDownloadAction(card: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  let openedMenu = false;
  while (Date.now() < deadline) {
    const action = findGeminiVideoDownloadAction(card);
    if (action) return action;
    if (!openedMenu) {
      const more = findGeminiVideoMoreButton(card);
      if (more) {
        openedMenu = true;
        await debugLog("geminiVideoMoreButtonClicked", { button: describeNodeForTrace(more) });
        more.click();
      }
    }
    await sleep(300);
  }
  return findGeminiVideoDownloadAction(card);
}

// 找不到下载入口时把卡片周围的可点击元素记进 trace，改选择器时不用靠猜。
function describeGeminiVideoCard(card: HTMLElement): Record<string, unknown> {
  const video = card.querySelector("video") ?? (card instanceof HTMLVideoElement ? card : null);
  return {
    cardTag: card.tagName.toLowerCase(),
    cardClass: elementClassName(card).slice(0, 120),
    hasVideoElement: Boolean(video),
    srcScheme: (video?.currentSrc || video?.getAttribute("src") || "").split(":")[0] || null,
    clickable: geminiVideoActionCandidates(card).slice(0, 24)
      .map(element => `${describeNodeForTrace(element)}|${elementAccessibleLabel(element).slice(0, 32)}`),
    overlayItems: findGeminiOverlayItems().slice(0, 16).map(item => elementLabel(item).slice(0, 32))
  };
}

async function fetchMediaThroughBackground(src: string): Promise<Blob | null> {
  const response = await chrome.runtime.sendMessage({ type: "FETCH_MEDIA", url: src }) as
    { ok?: boolean; contentType?: string; base64?: string; error?: string } | undefined;
  if (!response?.ok || !response.base64) {
    await debugLog("geminiVideoSourceFetchFailed", { error: response?.error ?? "no_response" });
    return null;
  }
  const contentType = response.contentType?.startsWith("video/") ? response.contentType : "video/mp4";
  return base64ToBlob(response.base64, contentType);
}

// mp4 本体在 ByteDance 的 CDN 上（例如 v26-default.douyin.com），地址是 hover 出来的
// <video> 上那条带签名的临时直链：页面里 fetch 会被 CORS 拦，但 background 配了
// host 权限就能直接取，所以优先走直链，取不到才退回「页面自己下载 + chrome.downloads
// 捕获」这条和图片、Gemini 一致的老路。
//
// 但直链和页面下载拿到的都是带台标的转码流，所以最先试的是无水印那条：拿接口响应里
// 收集到的 fallback_api 换个 logo_type 再问一次，服务端会给同一条视频的干净转码流。
async function downloadDoubaoVideo(card: HTMLElement, allowUnwatermarked: boolean): Promise<DownloadedVideo> {
  // 先悬停量一次：<video> 上的原生宽高和时长是无水印那条路对号用的依据，
  // 顺手也就拿到了退回直链下载要用的地址，省掉后面再悬停一遍。
  const source = await readDoubaoVideoSource(card);
  const clean = allowUnwatermarked ? await fetchDoubaoUnwatermarkedVideo(source?.target ?? null) : null;
  if (clean) return { blob: clean, acquisition: "doubao_video_unwatermarked" };

  // 直链是带签名的临时地址，页面里 fetch 会被 CORS 拦，但 background 有对应 host 权限，
  // 能直接取字节。这条路比「量坐标 → 可信点击 → 捕获 chrome.downloads」少了一堆会飘的
  // 环节，取不到（例如 MSE 播放时 src 是 blob:）才退回点下载按钮那条路。
  const direct = source ? await fetchDoubaoVideoBySource(source) : null;
  if (direct) return { blob: direct, acquisition: "doubao_video_download" };

  const hoverPoint = elementCenterPoint(card);
  if (!hoverPoint) throw new Error("豆包视频卡片没有可悬停的屏幕坐标。");
  await sleep(200);

  // 这条兜底路会真的点一次页面自己的下载按钮，得先把上面那个点击拦截关掉。
  suppressDoubaoVideoClickIntercept = true;
  let blob: Blob;
  try {
    blob = await requestHoverClickDownload(hoverPoint, async () => {
      // 到这里真实指针已经压在卡片上，悬停条才真的出现，坐标也只有这时候量才是准的。
      hoverDoubaoVideoCard(card);
      const action = await waitForDoubaoVideoDownloadAction(card, 8_000);
      await debugLog("findDoubaoVideoDownloadAction", { found: Boolean(action) });
      if (!action) {
        if (activeJob) {
          await traceJob(activeJob.id, "doubao_video_card_probe", describeDoubaoVideoCard(card));
        }
        return null;
      }
      // scrollIntoView 会把卡片挪走、把指针甩出悬停区，所以这里只量不滚。
      const point = elementViewportPoint(action);
      // 上一轮就是「按钮找到了、点了、但没有任何下载开始」，所以要知道这个坐标上
      // 最顶层到底是不是这个按钮 —— 如果被播放器蒙层盖住，可信点击就打在蒙层上了。
      const hit = point ? document.elementFromPoint(point.x, point.y) : null;
      await debugLog("doubaoVideoDownloadActionPoint", {
        point,
        action: describeNodeForTrace(action),
        hit: hit instanceof HTMLElement ? describeNodeForTrace(hit) : null,
        hitIsAction: Boolean(hit && (action.contains(hit) || hit.contains(action)))
      });
      return point;
    }, "Doubao video download");
  } finally {
    suppressDoubaoVideoClickIntercept = false;
  }

  await debugLog("downloadDoubaoVideo succeeded", { size: blob.size, type: blob.type });
  if (blob.size === 0) throw new Error("豆包视频下载得到的是空文件。");
  return { blob, acquisition: "doubao_video_download" };
}

// 无水印路径：把收集到的 fallback_api 交给 background（它有 host 权限，页面里请求会被
// CORS 拦），由它解出每条候选的宽高/时长，再和页面上这条视频对号，只取对上的那条字节。
// 对不上号就返回 null，退回页面自己那条带台标的下载 —— 存错视频比带水印严重得多。
async function fetchDoubaoUnwatermarkedVideo(target: DoubaoVideoTarget | null): Promise<Blob | null> {
  // 视频卡片渲染出来时消息响应一般已经解析过了，这里再等一小会儿只是为了容忍时序抖动。
  const ready = await waitUntilTruthy(() => doubaoFallbackApis.length > 0 ? true : null, 3_000);
  if (!ready) {
    await debugLog("doubaoUnwatermarkedVideoNoCandidate", {});
    return null;
  }

  const candidates = [...doubaoFallbackApis];
  const response = await chrome.runtime.sendMessage({
    type: "FETCH_DOUBAO_UNWATERMARKED_VIDEO",
    fallbackApis: candidates,
    ...(target ? { target } : {})
  }) as {
    ok?: boolean;
    base64?: string;
    contentType?: string;
    host?: string;
    path?: string;
    width?: number;
    height?: number;
    bitrate?: number;
    duration?: number;
    matchReason?: string;
    candidates?: unknown;
    error?: string;
  } | undefined;

  if (!response?.ok || !response.base64) {
    await debugLog("doubaoUnwatermarkedVideoFailed", {
      candidates: candidates.length,
      target,
      resolved: response?.candidates ?? null,
      error: response?.error ?? "no_response"
    });
    return null;
  }

  const contentType = response.contentType?.startsWith("video/") ? response.contentType : "video/mp4";
  const blob = base64ToBlob(response.base64, contentType);
  if (blob.size === 0) {
    await debugLog("doubaoUnwatermarkedVideoEmpty", { host: response.host ?? null });
    return null;
  }
  const detail = {
    host: response.host ?? null,
    path: response.path ?? null,
    width: response.width ?? null,
    height: response.height ?? null,
    bitrate: response.bitrate ?? null,
    duration: response.duration ?? null,
    matchReason: response.matchReason ?? null,
    byteLength: blob.size
  };
  await debugLog("doubaoUnwatermarkedVideoFetched", detail);
  if (activeJob) await traceJob(activeJob.id, "doubao_video_unwatermarked_used", detail);
  return blob;
}

// 手动点卡片上那个下载按钮时，豆包并不会再去问一次「视频信息」接口 —— 它直接存播放用的
// 那条带台标转码流，所以没有可以在请求发出前改写的东西（试过，一次都没触发）。这里改成在
// 捕获阶段拦下这一次点击：只有当已经解好的候选里能按指纹（对象 id / 宽高 / 时长）对上这张
// 卡片时才接手，自己取无水印字节并用 <a download> 存盘；对不上号就原样放行给豆包，
// 宁可带水印也不能存错视频（之前照顺序猜，存下来的是历史里另一条视频）。
//
// 只对视频卡片生效，图片那条路完全不经过这里。
// 存盘刻意不用 chrome.downloads：background 在跑任务时会捕获并删掉下载项。
let suppressDoubaoVideoClickIntercept = false;

document.addEventListener("click", event => {
  // 我们自己发的可信点击（任务里的兜底下载）不能被自己拦下来。
  if (suppressDoubaoVideoClickIntercept) return;
  // 插件刚重载时旧的 content script 还挂在页面上，这时候拦下来只会让点击白掉。
  if (!isExtensionContextAlive()) return;
  if (!(event.target instanceof Element)) return;
  const card = event.target.closest<HTMLElement>(DOUBAO_VIDEO_CARD_SELECTOR);
  if (!card) return;
  const action = findDoubaoVideoDownloadAction(card);
  if (!action || !(action.contains(event.target) || event.target.contains(action))) return;

  // 决定要不要接手必须在这一个事件里同步做完，所以候选是页面早先就解好的。
  const video = card.querySelector("video");
  // 没悬停播放过就没有 <video>，量不到宽高时长；但卡片上的 message_id 一直都在，
  // 单靠它也足够对号，所以这种情况仍然造一个只带 message_id 的目标。
  const cardMessageId = doubaoCardMessageId(card);
  const target = video
    ? doubaoVideoTargetOf(video)
    : cardMessageId ? { width: 0, height: 0, duration: 0, objectId: "", messageId: cardMessageId } : null;
  const matched = matchResolvedVideo(doubaoResolvedVideos, target);
  if (!matched) {
    // 刷新页面后马上点下载会撞上一个空窗期：fallback_api 已经收到了，但 background 还在
    // 逐条请求 video_info 解元信息（防抖 800ms + 并发 3 次网络往返）。这时候放行就白白
    // 退回带水印的那条，所以先拦下来等解析完 —— 等不出结果再把点击补回去。
    const pending = pendingDoubaoFallbackApis(target?.messageId ?? "");
    if (pending.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void waitForDoubaoVideoThenSave(target, action, pending.length);
      return;
    }
    // 上一轮日志只有候选指纹，看出「候选压根不是这条视频」之后就不够用了：
    // 还要能区分是采集根本没收到这条视频的 fallback_api，还是收到了但解析失败。
    void debugLog("doubaoManualVideoNoMatch", {
      target,
      videoSrc: (video?.currentSrc || video?.getAttribute("src") || "").slice(0, 160),
      messageIds: doubaoMessageIdsOf(card),
      collected: doubaoFallbackApis.map(url => ({
        videoId: videoIdOf(url),
        source: doubaoFallbackApiSources.get(url) ?? "",
        messageId: doubaoFallbackApiMessageIds.get(url) ?? ""
      })),
      candidates: doubaoResolvedVideos.map(candidate => ({
        width: candidate.width,
        height: candidate.height,
        duration: candidate.duration,
        objectId: candidate.objectId,
        objectIds: candidate.objectIds ?? [],
        messageId: candidate.messageId ?? ""
      })),
      diag: doubaoVideoDiag
    });
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  void debugLog("doubaoManualVideoMatched", {
    reason: matched.reason,
    messageId: matched.video.messageId ?? "",
    width: matched.video.width,
    height: matched.video.height,
    duration: matched.video.duration
  });
  void saveDoubaoUnwatermarkedVideo(matched, action);
}, true);

// 已经采集到、但 background 还没解出元信息的候选。卡片上没有 message_id 时一律不拦：
// 分不清那些待解析的候选是不是这条视频，拦了反而可能存错。
function pendingDoubaoFallbackApis(messageId: string): string[] {
  if (!messageId) return [];
  return doubaoFallbackApis.filter(url =>
    doubaoFallbackApiMessageIds.get(url) === messageId &&
    !doubaoResolvedVideos.some(video => video.fallbackApi === url));
}

// 同一条消息正在等的时候再点，只提示，不重复发起。
const doubaoVideoWaiting = new Set<string>();

async function waitForDoubaoVideoThenSave(
  target: DoubaoVideoTarget | null,
  action: HTMLElement,
  pendingCount: number
): Promise<void> {
  const messageId = target?.messageId ?? "";
  if (doubaoVideoWaiting.has(messageId)) {
    showDoubaoNotice("正在取无水印视频，请稍候…", 1_600);
    return;
  }
  doubaoVideoWaiting.add(messageId);
  showDoubaoNotice("正在取无水印视频…", 0);
  try {
    await resolveDoubaoVideos();
    const matched = matchResolvedVideo(doubaoResolvedVideos, target);
    await debugLog("doubaoManualVideoWaited", {
      messageId,
      pendingCount,
      reason: matched?.reason ?? "",
      resolved: doubaoResolvedVideos.length
    });
    if (!matched) {
      showDoubaoNotice("没认出这条视频，已按豆包原样下载（带水印）");
      replayDoubaoDownloadClick(action);
      return;
    }
    await saveDoubaoUnwatermarkedVideo(matched, action);
  } catch {
    // 极罕见：走到这儿说明存盘过程本身出错了。不补点击 —— 那一步可能已经存下无水印的了，
    // 再放行会多出一个带水印的文件；提示一下让用户自己决定要不要再点。
    showDoubaoNotice("取无水印出错，可以再点一次下载");
  } finally {
    doubaoVideoWaiting.delete(messageId);
  }
}

// 右下角的一行提示。豆包页面自己的 CSS 会命中裸标签选择器，样式全部写成 inline 的。
// holdMs 传 0 表示常驻，直到下一次调用把它换掉。
let doubaoNoticeElement: HTMLDivElement | null = null;
let doubaoNoticeTimer = 0;

function showDoubaoNotice(text: string, holdMs = 2_400): void {
  window.clearTimeout(doubaoNoticeTimer);
  if (!doubaoNoticeElement?.isConnected) {
    const element = document.createElement("div");
    element.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "max-width:280px", "padding:10px 14px", "border-radius:10px",
      "background:rgba(24,24,27,.92)", "color:#fff",
      "font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.24)", "pointer-events:none"
    ].join(";");
    (document.body ?? document.documentElement).append(element);
    doubaoNoticeElement = element;
  }
  doubaoNoticeElement.textContent = text;
  // holdMs 传 0 是「等结果出来再换掉」，但仍留个兜底上限：中间万一抛了异常，
  // 提示不能一直挂在页面上。
  doubaoNoticeTimer = window.setTimeout(() => {
    doubaoNoticeElement?.remove();
    doubaoNoticeElement = null;
  }, holdMs > 0 ? holdMs : 30_000);
}

// 拦下点击之后由我们负责把文件存下来。取字节失败就把点击补回去，让豆包按它自己那条路存，
// 免得用户点了一下什么都没发生。
async function saveDoubaoUnwatermarkedVideo(
  matched: DoubaoVideoMatch<DoubaoResolvedVideo>,
  action: HTMLElement
): Promise<void> {
  // 一条视频十几二十兆，取字节要几秒，这段时间页面上什么都不会动，必须有反馈。
  showDoubaoNotice("正在取无水印视频…", 0);
  const response = await chrome.runtime.sendMessage({
    type: "FETCH_DOUBAO_UNWATERMARKED_VIDEO",
    fallbackApis: [matched.video.fallbackApi]
  }).catch(() => undefined) as
    { ok?: boolean; base64?: string; contentType?: string; host?: string; path?: string; error?: string }
    | undefined;

  if (!response?.ok || !response.base64) {
    await debugLog("doubaoManualVideoFailed", { error: response?.error ?? "no_response" });
    showDoubaoNotice("取无水印失败，已按豆包原样下载（带水印）");
    replayDoubaoDownloadClick(action);
    return;
  }
  const contentType = response.contentType?.startsWith("video/") ? response.contentType : "video/mp4";
  const blob = base64ToBlob(response.base64, contentType);
  if (blob.size === 0) {
    await debugLog("doubaoManualVideoFailed", { error: "empty_blob" });
    showDoubaoNotice("取无水印失败，已按豆包原样下载（带水印）");
    replayDoubaoDownloadClick(action);
    return;
  }
  saveBlobAsFile(blob, `doubao-video-${fileTimestamp()}.mp4`);
  showDoubaoNotice(`已保存无水印视频 · ${(blob.size / 1_048_576).toFixed(1)}MB`);
  await debugLog("doubaoManualVideoSaved", {
    host: response.host ?? null,
    path: response.path ?? null,
    matchReason: matched.reason,
    byteLength: blob.size
  });
}

function replayDoubaoDownloadClick(action: HTMLElement): void {
  suppressDoubaoVideoClickIntercept = true;
  try {
    action.click();
  } finally {
    suppressDoubaoVideoClickIntercept = false;
  }
}

function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Chrome 要把 blob 读完才落盘，立刻 revoke 会存出空文件。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileTimestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

type DoubaoVideoSource = { src: string; target: DoubaoVideoTarget };

// 悬停后 xgplayer 会把 <video> 挂上来：地址是带签名的临时直链，元素上的原生宽高和时长
// 就是这条视频的指纹，无水印候选靠它们对号。
async function readDoubaoVideoSource(card: HTMLElement): Promise<DoubaoVideoSource | null> {
  const video = await waitUntilTruthy(() => {
    // <video> 只在悬停时才挂上来，每轮都补一次合成悬停。
    hoverDoubaoVideoCard(card);
    const element = card.querySelector("video");
    const candidate = element?.currentSrc || element?.getAttribute("src") || "";
    return element && candidate.startsWith("http") ? element : null;
  }, 6_000);
  if (!video) {
    await debugLog("doubaoVideoSource", { found: false });
    return null;
  }
  // 宽高和时长要等 metadata 到位才有值，等不到就退化成只按对象 id 对号。
  await waitUntilTruthy(() => video.videoWidth > 0 && Number.isFinite(video.duration) ? true : null, 3_000);
  const source = { src: video.currentSrc || video.getAttribute("src") || "", target: doubaoVideoTargetOf(video) };
  await debugLog("doubaoVideoSource", { found: true, ...describeMediaUrl(source.src), ...source.target });
  return source;
}

function doubaoVideoTargetOf(video: HTMLVideoElement): DoubaoVideoTarget {
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    objectId: videoObjectIdOf(video.currentSrc || video.getAttribute("src") || ""),
    messageId: doubaoCardMessageId(video)
  };
}

// 卡片祖先上挂着 data-message-id，和接口响应里 fallback_api 所属的 message_id 同源。
function doubaoCardMessageId(node: Element): string {
  const holder = node.closest<HTMLElement>("[data-message-id],[data-msg-id]");
  if (!holder) return "";
  const value = holder.getAttribute("data-message-id") ?? holder.getAttribute("data-msg-id") ?? "";
  return value.trim();
}

// 参考实现是按 message_id 把 fallback_api 归到具体消息上的。如果 DOM 上也挂着同一个 id，
// 那它比宽高/时长这些间接指纹可靠得多 —— 先探一探卡片祖先上到底有没有这种属性。
function doubaoMessageIdsOf(card: HTMLElement): string[] {
  const found: string[] = [];
  let node: HTMLElement | null = card;
  for (let depth = 0; node && depth < 12; depth += 1) {
    for (const attribute of node.attributes) {
      if (!/mess?age|msg/i.test(attribute.name)) continue;
      const value = attribute.value.trim();
      if (!value || value.length > 40 || found.includes(`${attribute.name}=${value}`)) continue;
      found.push(`${attribute.name}=${value}`);
    }
    node = node.parentElement;
  }
  return found.slice(0, 8);
}

async function fetchDoubaoVideoBySource(source: DoubaoVideoSource): Promise<Blob | null> {
  const described = describeMediaUrl(source.src);
  const response = await chrome.runtime.sendMessage({ type: "FETCH_MEDIA", url: source.src }) as
    { ok?: boolean; contentType?: string; base64?: string; error?: string } | undefined;
  if (!response?.ok || !response.base64) {
    await debugLog("doubaoVideoSourceFetchFailed", { error: response?.error ?? "no_response" });
    return null;
  }
  const contentType = response.contentType?.startsWith("video/") ? response.contentType : "video/mp4";
  const blob = base64ToBlob(response.base64, contentType);
  await debugLog("doubaoVideoSourceFetched", { size: blob.size, type: blob.type });
  if (blob.size === 0) return null;
  if (activeJob) {
    await traceJob(activeJob.id, "doubao_video_direct_source_used", { ...described, byteLength: blob.size });
  }
  return blob;
}

// 只记域名和路径，签名参数不进日志。
function describeMediaUrl(raw: string): Record<string, unknown> {
  try {
    const url = new URL(raw);
    return { host: url.host, path: url.pathname.slice(0, 120) };
  } catch {
    return { host: null, path: null };
  }
}


async function waitForDoubaoVideoDownloadAction(card: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 卡片可能刚重新挂载，每轮都补一次合成悬停事件（React 的 onMouseEnter 吃这个）。
    hoverDoubaoVideoCard(card);
    const action = findDoubaoVideoDownloadAction(card);
    if (action) return action;
    await sleep(300);
  }
  return findDoubaoVideoDownloadAction(card);
}

// 卡片是靠 React 的 onMouseEnter 挂播放器和悬停条的，合成事件就够；
// 但必须带上 clientX/clientY，否则组件按 (0,0) 判断指针位置会立刻又收起来。
function hoverDoubaoVideoCard(card: HTMLElement): void {
  const rect = card.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  };
  card.dispatchEvent(new PointerEvent("pointerover", init));
  card.dispatchEvent(new MouseEvent("mouseover", init));
  card.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false }));
  card.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
  card.dispatchEvent(new PointerEvent("pointermove", init));
  card.dispatchEvent(new MouseEvent("mousemove", init));
}

// 悬停条里的按钮没有 aria-label / title / 文案，主要靠下载图标的 path 认；
// 图标 path 每次发版都可能换，所以再兜两层：图片预览那条下载图标，以及 class/outerHTML
// 里带 download/保存 字样的小图标按钮（限定 ≤64px 且自带 svg，避免选中整张卡片）。
const DOUBAO_VIDEO_ACTION_MAX_SIZE_PX = 64;

function findDoubaoVideoDownloadAction(card: HTMLElement): HTMLElement | null {
  const scopes = [
    ...card.querySelectorAll<HTMLElement>(DOUBAO_VIDEO_HOVER_GROUP_SELECTOR),
    card
  ].filter(isPresentInLayout);

  for (const scope of scopes) {
    const candidates = [...scope.querySelectorAll<HTMLElement>("*")]
      .filter(isDoubaoVideoActionCandidate)
      .filter(element =>
        hasDoubaoVideoDownloadIcon(element) ||
        hasDoubaoDownloadIcon(element) ||
        isDoubaoDownloadControl(element));
    // 取最内层命中，否则包着整条悬停条的祖先会先按 document order 被选中。
    const innermost = candidates.find(element => !candidates.some(other => other !== element && element.contains(other)));
    if (innermost) return innermost.closest<HTMLElement>("button,[role='button']") ?? innermost;
  }
  return null;
}

function isDoubaoVideoActionCandidate(element: HTMLElement): boolean {
  if (!element.querySelector("svg")) return false;
  if (!isPresentInLayout(element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width <= DOUBAO_VIDEO_ACTION_MAX_SIZE_PX && rect.height <= DOUBAO_VIDEO_ACTION_MAX_SIZE_PX;
}

// 找不到下载按钮时把卡片里的可点击元素和图标 path 记进 trace，
// 下次改选择器就不用再靠猜（和确认按钮那次用的是同一套办法）。
function describeDoubaoVideoCard(card: HTMLElement): Record<string, unknown> {
  const nodes = [...card.querySelectorAll<HTMLElement>("*")];
  return {
    cardClass: elementClassName(card).slice(0, 120),
    nodeCount: nodes.length,
    hasVideoElement: Boolean(card.querySelector("video")),
    hoverGroups: nodes.filter(node => node.matches(DOUBAO_VIDEO_HOVER_GROUP_SELECTOR)).map(describeNodeForTrace),
    iconNodes: nodes.filter(node => node.matches(":has(> svg)")).slice(0, 20).map(describeNodeForTrace),
    clickable: nodes.filter(node => isPresentInLayout(node) && isLikelyClickable(node)).slice(0, 20).map(describeNodeForTrace),
    svgPaths: [...card.querySelectorAll("svg path")].slice(0, 20).map(path => (path.getAttribute("d") ?? "").slice(0, 28))
  };
}

function describeNodeForTrace(element: HTMLElement): string {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return [
    element.tagName.toLowerCase(),
    elementClassName(element).slice(0, 48),
    `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
    `op=${style.opacity}`,
    `vis=${style.visibility}`,
    `cur=${style.cursor}`
  ].filter(Boolean).join("|");
}

function elementClassName(element: Element): string {
  return typeof element.className === "string" ? element.className : String(element.getAttribute("class") ?? "");
}

// GPT has no direct "download" affordance on the image itself — the only
// path is opening the Share sheet (a normal, non-download UI action that a
// synthetic click handles fine) and then trusted-clicking the "Download"
// option inside it, which is the actual download trigger and therefore
// needs the same chrome.debugger treatment as Gemini's button.
async function downloadGptFullSizeImage(image: HTMLImageElement): Promise<Blob> {
  const shareButton = findGptShareButton(image);
  await debugLog("findGptShareButton", { found: Boolean(shareButton) });
  if (!shareButton) throw new Error("ChatGPT's \"Share this image\" button was not found for this image.");
  shareButton.click();

  const dialog = await waitUntilTruthy(() => findVisibleElement<HTMLElement>("[role='dialog'][aria-description='Share sheet']"), 5_000);
  await debugLog("shareDialog", { found: Boolean(dialog) });
  if (!dialog) throw new Error("ChatGPT's share sheet did not open.");
  try {
    const downloadButton = await waitUntilTruthy(() => findGptShareSheetDownloadButton(dialog), 5_000);
    await debugLog("shareSheetDownloadButton", { found: Boolean(downloadButton) });
    if (!downloadButton) throw new Error("ChatGPT's share sheet \"Download\" button was not found.");
    // The share sheet is a Radix-style modal that animates in (opacity/
    // transform transition on mount); a coordinate read immediately after
    // the button is first found in the DOM can be stale by the time the
    // click actually dispatches (chrome.debugger.attach() alone can take
    // long enough for that transition to still be moving). Give it a beat
    // to settle, then re-measure right before dispatching.
    await sleep(400);
    const point = elementCenterPoint(downloadButton);
    await debugLog("downloadButtonPoint", { point });
    if (!point) throw new Error("ChatGPT's share sheet \"Download\" button has no on-screen position to click.");
    const blob = await requestTrustedClickDownload(point, "ChatGPT full-size image download");
    await debugLog("requestTrustedClickDownload", { ok: true, size: blob.size, type: blob.type });
    return blob;
  } catch (error) {
    await debugLog("downloadGptFullSizeImage failed", { error: String(error) });
    throw error;
  } finally {
    dialog.querySelector<HTMLElement>("[data-testid='close-button']")?.click();
  }
}

async function waitUntilTruthy<T>(check: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(150);
  }
  return check();
}

function findGeminiDownloadButton(image: HTMLImageElement): HTMLElement | null {
  const container = image.closest<HTMLElement>(".group\\/imagegen-image, [id^='image-'], generated-image, single-image") ?? image.parentElement;
  if (!container) return null;
  const candidates = [...container.querySelectorAll<HTMLElement>("button,[role='button'],a")];
  return candidates.find(element => {
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.title ?? ""} ${element.innerText ?? ""}`;
    // Gemini renders this button with an "on-hover-button" class that's
    // opacity:0 until the user's mouse is actually resting on the image, so
    // the usual isVisible() (which requires opacity !== "0") would reject
    // it in a headless/no-hover automation run even though it's a real,
    // clickable element occupying layout space. Only require that it isn't
    // display:none/visibility:hidden and has real dimensions.
    return isPresentInLayout(element) && /download full|download full-sized image|下载原图|下载完整/i.test(label);
  }) ?? null;
}

function findDoubaoPreviewSaveButton(): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>("button,[role='button'],a")].filter(isPresentInLayout);

  // 优先认下载图标：新版预览面板的下载按钮只剩这个特征。取最内层的命中，
  // 否则包着整条工具条的祖先按钮会先于真正的按钮被 document order 选中。
  const iconHits = candidates.filter(hasDoubaoDownloadIcon);
  const innermostIconHit = iconHits.find(element => !iconHits.some(other => other !== element && element.contains(other)));
  if (innermostIconHit) return innermostIconHit;

  // 老版 UI（以及其它带文案的下载入口）走文本匹配。
  const labelled = candidates.find(isDoubaoDownloadControl);
  if (labelled) return labelled;

  // 图标再改一次也别整个流程报废：预览开着时，工具条里唯一的品牌蓝按钮就是下载。
  if (!isDoubaoImagePreviewOpen()) return null;
  const blue = candidates.filter(element => getComputedStyle(element).backgroundColor === DOUBAO_BRAND_BLUE);
  return blue.length === 1 ? blue[0] : null;
}

function isDoubaoImagePreviewOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(DOUBAO_PREVIEW_MARKER_SELECTOR)].some(isPresentInLayout);
}

function closeDoubaoImagePreview(): void {
  const closeButton = [...document.querySelectorAll<HTMLElement>("button,[role='button']")]
    .find(element => isPresentInLayout(element) && /close|\u5173\u95ed/i.test(elementAccessibleLabel(element)));
  if (closeButton) {
    closeButton.click();
    return;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

function isPresentInLayout(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

function findGptShareButton(image: HTMLImageElement): HTMLElement | null {
  const container = image.closest<HTMLElement>(".group\\/imagegen-image, [id^='image-']") ?? image.parentElement;
  if (!container) return null;
  const candidates = [...container.querySelectorAll<HTMLElement>("button,[role='button']")];
  // Like Gemini's download button, GPT's image overlay action bar
  // (data-testid="image-gen-overlay-*-actions") is opacity:0 by default and
  // only reaches opacity-100 on real hover/focus — isVisible() (which
  // requires opacity !== "0") would reject it in a no-hover automation run
  // even though it's present and clickable. Only require real layout
  // presence, not full CSS visibility.
  return candidates.find(element => isPresentInLayout(element) && /share this image/i.test(elementAccessibleLabel(element))) ?? null;
}

function findGptShareSheetDownloadButton(dialog: HTMLElement): HTMLElement | null {
  const candidates = [...dialog.querySelectorAll<HTMLElement>("button,[role='button']")];
  return candidates.find(element => isPresentInLayout(element) && /^download$/i.test((element.innerText ?? "").trim())) ?? null;
}

function elementAccessibleLabel(element: HTMLElement): string {
  return `${element.getAttribute("aria-label") ?? ""} ${element.title ?? ""} ${element.innerText ?? ""}`.trim();
}

function imageCandidates(image: HTMLImageElement): string[] {
  const values: string[] = [];
  const container = image.closest<HTMLElement>(".group\\/imagegen-image, [id^='image-'], generated-image, single-image") ?? image.parentElement;
  for (const element of [image, container].filter((el): el is HTMLElement => Boolean(el))) {
    for (const attribute of ["data-full-size-url", "data-download-url", "data-original-src", "data-src"]) {
      const value = element.getAttribute(attribute);
      if (value) values.push(value);
    }
  }
  for (const anchor of container?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []) {
    const label = `${anchor.innerText} ${anchor.getAttribute("aria-label") ?? ""} ${anchor.title ?? ""}`;
    if (/download|full size|原图|下载/i.test(label) || /\.(png|jpe?g|webp)(?:\?|$)/i.test(anchor.href)) {
      values.push(anchor.href);
    }
  }
  return [...new Set(values.map(value => {
    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  }))].filter(value => /^(https?:|blob:|data:image\/)/i.test(value));
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

async function traceJob(jobId: string, stage: string, data: Record<string, unknown> = {}): Promise<void> {
  const message: JobTraceMessage = { type: "JOB_TRACE", jobId, stage, data };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Diagnostics must not disrupt image generation when the MV3 worker restarts.
  }
}

async function debugLog(label: string, data: unknown): Promise<void> {
  try {
    await fetch("http://127.0.0.1:17321/debug-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, data, href: location.href })
    });
  } catch {
    // best-effort diagnostic only
  }
}

async function setExpectingNavigation(expecting: boolean): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "EXPECT_NAVIGATION", expecting });
  } catch {
    // background may be temporarily unreachable during a service worker restart; the
    // navigation still proceeds, it just risks being misclassified as unexpected once.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
