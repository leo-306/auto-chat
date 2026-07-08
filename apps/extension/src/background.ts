import type { AppConfig, ArtifactRequest, ClaimJobRequest, DispatchState, Job, JobPlatform, UpdateStatusRequest } from "auto-chat-shared";
import { DEFAULT_CONFIG } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";
import type { DebugInspectMessage, DebugInspectResult, JobProgressMessage, PopupState, StartJobMessage, WorkerRecord } from "./types.js";

const SERVER_URL = "http://127.0.0.1:17321";
const PLATFORMS: JobPlatform[] = ["gpt", "gemini"];
const workerId = `ext_${crypto.randomUUID()}`;
const workers = new Map<number, WorkerRecord>();
let pausedByPlatform: Record<JobPlatform, boolean> = { gpt: true, gemini: true };
let config: AppConfig = DEFAULT_CONFIG;
let serverOk = false;
let lastDebugByPlatform: Record<JobPlatform, string> = { gpt: "", gemini: "" };
let lastDispatchId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ pausedByPlatform });
  chrome.alarms.create("scheduler", { periodInMinutes: 0.1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("scheduler", { periodInMinutes: 0.1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "scheduler") void schedulerTick();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const worker = workers.get(tabId);
  if (!worker || !changeInfo.url || !isConversationUrl(worker.platform, changeInfo.url)) return;
  void postStatus(worker.jobId, {
    status: "waiting_generation",
    tabId,
    conversationUrl: changeInfo.url,
    workerId
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const worker = workers.get(tabId);
  if (!worker) return;
  workers.delete(tabId);
  void postStatus(worker.jobId, {
    status: "needs_manual",
    errorMessage: "Tab was closed before the job completed.",
    workerId
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function handleMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (isProgress(message)) {
    await handleProgress(message, sender.tab?.id);
    return { ok: true };
  }

  const typed = message as { type?: string; paused?: boolean; platform?: JobPlatform; jobId?: string; tabId?: number };
  const platform = normalizePlatform(typed.platform);
  if (typed.type === "GET_STATE") {
    return state(platform);
  }
  if (typed.type === "SET_PAUSED") {
    pausedByPlatform[platform] = Boolean(typed.paused);
    await chrome.storage.local.set({ pausedByPlatform });
    if (!pausedByPlatform[platform]) void schedulerTick({ platform });
    return state(platform);
  }
  if (typed.type === "TICK") {
    await requestDispatch(platform);
    await schedulerTick({ force: true, platform });
    return state(platform);
  }
  if (typed.type === "DEBUG_INSPECT_CURRENT_TAB") {
    return debugInspectCurrentTab();
  }
  if (typed.type === "DEBUG_SIMULATE_SUCCESS") {
    return debugSimulate("done", undefined, platform);
  }
  if (typed.type === "DEBUG_SIMULATE_ERROR") {
    return debugSimulate("failed_retryable", `Debug simulated ${platformName(platform)} error.`, platform);
  }
  if (typed.type === "DEBUG_SIMULATE_STALLED") {
    return debugSimulate("stalled", "Debug simulated stalled generation.", platform);
  }
  if (typed.type === "DEBUG_SIMULATE_TIMEOUT") {
    return debugSimulate("needs_manual", "Debug simulated hard timeout.", platform);
  }
  if (typed.type === "DEBUG_OPEN_ACTIVE_TAB") {
    const worker = firstWorker(platform);
    if (!worker) return debugResult("No active worker tab.");
    await chrome.tabs.update(worker.tabId, { active: true });
    return debugResult(`已切换到任务标签页：tab=${worker.tabId}，任务=${worker.jobId}。`);
  }
  return { ok: false };
}

async function schedulerTick(options: { force?: boolean; platform?: JobPlatform } = {}): Promise<void> {
  const stored = await chrome.storage.local.get(["paused", "pausedByPlatform"]);
  pausedByPlatform = {
    gpt: stored.pausedByPlatform?.gpt ?? stored.paused !== false,
    gemini: stored.pausedByPlatform?.gemini ?? true
  };
  await refreshConfig();
  const dispatched = await consumeDispatchSignal();
  if (!serverOk) return;

  const targetPlatforms = options.platform ? [options.platform] : PLATFORMS;
  for (const platform of targetPlatforms) {
    const dispatchMatches = dispatched !== false &&
      (dispatched === null || dispatched.platform === null || dispatched.platform === platform);
    if (!options.force && pausedByPlatform[platform] && !dispatchMatches) continue;

    while (workerCount(platform) < config.maxConcurrency) {
      const job = await claimJob(platform, dispatchMatches && dispatched && dispatched !== null ? dispatched.jobId : null);
      if (!job) break;
      try {
        await launchJob(job);
      } catch (error) {
        await postStatus(job.id, {
          status: "needs_manual",
          errorMessage: String(error),
          workerId
        });
      }
    }
  }
}

async function refreshConfig(): Promise<void> {
  try {
    config = await api<AppConfig>("/config");
    serverOk = true;
  } catch {
    serverOk = false;
  }
}

async function consumeDispatchSignal(): Promise<DispatchState | null | false> {
  if (!serverOk) return false;
  try {
    const dispatch = await api<DispatchState>("/dispatch");
    if (lastDispatchId === null) {
      const stored = await chrome.storage.local.get(["lastDispatchId"]);
      lastDispatchId = Number(stored.lastDispatchId ?? 0);
    }
    if (dispatch.id <= lastDispatchId) return false;
    lastDispatchId = dispatch.id;
    await chrome.storage.local.set({ lastDispatchId });
    const targets = dispatch.platform ? [dispatch.platform] : PLATFORMS;
    for (const platform of targets) {
      lastDebugByPlatform[platform] = `收到外部调度请求：${dispatch.requestedAt ?? "未知时间"}。`;
    }
    return dispatch;
  } catch {
    return false;
  }
}

async function claimJob(platform: JobPlatform, jobId?: string | null): Promise<Job | null> {
  const body: ClaimJobRequest = {
    workerId,
    platform,
    ...(jobId ? { jobId } : {}),
    runningJobIds: [...workers.values()].map(worker => worker.jobId)
  };
  return api<Job | null>(`/jobs/claim`, { method: "POST", body });
}

async function launchJob(job: Job): Promise<void> {
  let tabId: number;
  let needsLoad = true;

  if (job.parentJobId) {
    const parentJob = await api<Job>(`/jobs/${job.parentJobId}`);
    const parentTabId = parentJob.tabId;
    const parentTabAlive = parentTabId !== null && await isTabAlive(parentTabId);
    if (parentTabAlive && parentTabId !== null) {
      tabId = parentTabId;
      needsLoad = false;
    } else {
      const url = parentJob.conversationUrl ?? urlForPlatform(job.platform);
      const tab = await chrome.tabs.create({ url, active: false });
      if (!tab.id) throw new Error("Chrome did not return a tab id");
      tabId = tab.id;
    }
  } else {
    const tab = await chrome.tabs.create({ url: job.conversationUrl ?? urlForPlatform(job.platform), active: false });
    if (!tab.id) throw new Error("Chrome did not return a tab id");
    tabId = tab.id;
  }

  const worker: WorkerRecord = {
    tabId,
    jobId: job.id,
    platform: job.platform,
    startedAt: Date.now(),
    lastStateAt: Date.now(),
    refreshCount: job.refreshCount,
    rateLimitRefreshCount: 0
  };
  workers.set(tabId, worker);
  await postStatus(job.id, { status: "opening_tab", tabId, workerId });
  if (needsLoad) await waitForTabComplete(tabId);
  await sendStartMessage(tabId, job);
}

async function sendStartMessage(
  tabId: number,
  job: Job,
  recoveryMode?: EmptyAssistantRecoveryMode
): Promise<void> {
  const message: StartJobMessage = { type: "START_JOB", job, config, recoveryMode };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Could not contact content script in tab ${tabId}`);
}

async function handleProgress(message: JobProgressMessage, tabId?: number): Promise<void> {
  if (!tabId) return;
  const worker = workers.get(tabId);
  if (!worker || worker.jobId !== message.jobId) return;
  worker.lastStateAt = Date.now();

  if (message.status === "maybe_done") {
    return;
  }

  if (message.status === "waiting_generation" && worker.platform === "gemini") {
    try { await chrome.tabs.update(tabId, { active: true }); } catch { /* tab gone */ }
  }

  if (message.status === "rate_limited") {
    if (worker.rateLimitRefreshCount >= config.maxRefreshPerJob) {
      await postStatus(worker.jobId, {
        status: "needs_manual",
        tabId,
        errorMessage: `ChatGPT is still rate-limiting this conversation after ${worker.rateLimitRefreshCount} refresh attempt(s) ("Too many requests" modal keeps reappearing). The prompt was already sent and ChatGPT may still be generating a reply — please check the tab manually.`,
        refreshCount: worker.refreshCount,
        workerId
      });
      workers.delete(tabId);
      return;
    }
    worker.rateLimitRefreshCount += 1;
    await postStatus(worker.jobId, { status: "refreshing", tabId, refreshCount: worker.refreshCount, workerId });
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    const job = await api<Job>(`/jobs/${worker.jobId}`);
    await sendStartMessage(tabId, job, "monitor_only");
    return;
  }

  if (message.status === "stalled") {
    if (worker.refreshCount >= config.maxRefreshPerJob) {
      await postStatus(worker.jobId, {
        status: "needs_manual",
        tabId,
        errorMessage: "Job stalled after maximum refresh attempts.",
        refreshCount: worker.refreshCount,
        workerId
      });
      workers.delete(tabId);
      return;
    }
    worker.refreshCount += 1;
    await postStatus(worker.jobId, {
      status: "refreshing",
      tabId,
      refreshCount: worker.refreshCount,
      workerId
    });
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    const job = await api<Job>(`/jobs/${worker.jobId}`);
    await sendStartMessage(tabId, job, message.recoveryMode);
    return;
  }

  if (message.status === "done") {
    try {
      const job = await api<Job>(`/jobs/${message.jobId}`);
      if (job.mode === "text") {
        await saveArtifact(message.jobId, {
          kind: "text_output",
          filename: "output-01.txt",
          contentType: "text/plain; charset=utf-8",
          dataBase64: textToBase64(message.text ?? "")
        });
        await postEvent(message.jobId, {
          type: "text_output",
          payload: {
            length: message.text?.length ?? 0
          }
        });
      } else {
        for (const image of message.images ?? []) {
          await saveArtifact(message.jobId, {
            kind: "output",
            filename: `output-${String(image.index + 1).padStart(2, "0")}.${extensionFor(image.contentType)}`,
            contentType: image.contentType,
            dataBase64: image.dataUrl.split(",")[1] ?? image.dataUrl
          });
        }
        await postEvent(message.jobId, {
          type: "image_order",
          payload: {
            images: (message.images ?? []).map(image => ({
              index: image.index + 1,
              sourceId: image.sourceId
            }))
          }
        });
      }
      await postStatus(message.jobId, {
        status: "done",
        tabId,
        workerId
      });
      workers.delete(tabId);
      if (!job.persistTab && !job.parentJobId) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // The job is already saved and marked done. Tab cleanup failures should not
          // overwrite the terminal job status.
        }
      }
    } catch (error) {
      await postStatus(message.jobId, {
        status: "needs_manual",
        tabId,
        errorMessage: `Failed to save generated image: ${String(error)}`,
        workerId
      });
      workers.delete(tabId);
    }
    return;
  }

  await postStatus(message.jobId, {
    status: message.status,
    tabId,
    errorMessage: message.errorMessage,
    workerId
  });

  if (["failed_retryable", "failed_final", "needs_manual"].includes(message.status)) {
    workers.delete(tabId);
  }
}

async function postStatus(jobId: string, body: UpdateStatusRequest): Promise<void> {
  await api(`/jobs/${jobId}/status`, { method: "POST", body });
}

async function postEvent(jobId: string, body: { type: string; message?: string; payload?: Record<string, unknown> }): Promise<void> {
  await api(`/jobs/${jobId}/events`, { method: "POST", body });
}

async function saveArtifact(jobId: string, body: ArtifactRequest): Promise<void> {
  await api(`/jobs/${jobId}/artifacts`, { method: "POST", body });
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function requestDispatch(platform: JobPlatform): Promise<void> {
  await api("/dispatch", { method: "POST", body: { platform } });
}

async function waitForTabComplete(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

function isProgress(message: unknown): message is JobProgressMessage {
  return Boolean(message && typeof message === "object" && (message as { type?: string }).type === "JOB_PROGRESS");
}

function state(activePlatform: JobPlatform): PopupState {
  return {
    serverOk,
    activePlatform,
    platforms: {
      gpt: {
        paused: pausedByPlatform.gpt,
        workers: workersForPlatform("gpt"),
        lastDebug: lastDebugByPlatform.gpt
      },
      gemini: {
        paused: pausedByPlatform.gemini,
        workers: workersForPlatform("gemini"),
        lastDebug: lastDebugByPlatform.gemini
      }
    }
  };
}

async function debugInspectCurrentTab(): Promise<{ ok: boolean; message: string; result?: DebugInspectResult }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return debugResult("没有当前标签页。");
  const worker = workers.get(tab.id);
  const message: DebugInspectMessage = { type: "DEBUG_INSPECT", jobId: worker?.jobId };
  try {
    const result = await chrome.tabs.sendMessage(tab.id, message) as DebugInspectResult;
    const mismatch = result.pageJobId && result.jobId && result.pageJobId !== result.jobId
      ? ` JOB_ID不一致：当前页=${result.pageJobId}`
      : "";
    const platform = worker?.platform ?? platformForUrl(result.url);
    lastDebugByPlatform[platform] = `检测：任务=${result.jobId ?? "无"} 可用图片=${result.loadedImages}/${result.expectedImages ?? "?"} 任务区=${result.scopedImages} 全页=${result.pageImages} 生成中=${result.isGenerating} 连接中断=${result.isInterrupted} 异常=${result.hasError}${mismatch}`;
    return { ok: true, message: lastDebugByPlatform[platform], result };
  } catch (error) {
    return debugResult(`检测失败：${String(error)}`, false);
  }
}

async function debugSimulate(
  status: JobProgressMessage["status"],
  errorMessage?: string,
  platform?: JobPlatform
): Promise<{ ok: boolean; message: string }> {
  const worker = firstWorker(platform);
  if (!worker) return debugResult("没有插件接管中的任务。请先创建任务，再点击“立即领取一轮”或调用 dispatch。", false);
  await handleProgress({
    type: "JOB_PROGRESS",
    jobId: worker.jobId,
    status,
    errorMessage,
    images: status === "done" ? [debugImage()] : undefined
  }, worker.tabId);
  return debugResult(`已写入模拟结果：任务=${worker.jobId}，状态=${status}。`);
}

function firstWorker(platform?: JobPlatform): WorkerRecord | undefined {
  return [...workers.values()].find(worker => !platform || worker.platform === platform);
}

function debugResult(message: string, ok = true): { ok: boolean; message: string } {
  for (const platform of PLATFORMS) lastDebugByPlatform[platform] = message;
  return { ok, message };
}

function normalizePlatform(platform: unknown): JobPlatform {
  return platform === "gemini" ? "gemini" : "gpt";
}

function urlForPlatform(platform: JobPlatform): string {
  return platform === "gemini" ? config.geminiUrl : config.chatgptUrl;
}

function workerCount(platform: JobPlatform): number {
  return workersForPlatform(platform).length;
}

function workersForPlatform(platform: JobPlatform): WorkerRecord[] {
  return [...workers.values()].filter(worker => worker.platform === platform);
}

function platformForUrl(url: string): JobPlatform {
  return url.includes("gemini.google.com") ? "gemini" : "gpt";
}

function platformName(platform: JobPlatform): string {
  return platform === "gemini" ? "Gemini" : "GPT";
}

function isConversationUrl(platform: JobPlatform, url: string): boolean {
  if (platform === "gemini") return url.includes("gemini.google.com/app");
  return url.includes("/c/");
}

function debugImage(): { index: number; sourceId: string; dataUrl: string; contentType: string } {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="#f6f8fa"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="20" fill="#24292f">debug image</text></svg>`;
  return {
    index: 0,
    sourceId: "debug-image",
    contentType: "image/svg+xml",
    dataUrl: `data:image/svg+xml;base64,${btoa(svg)}`
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extensionFor(contentType: string): string {
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function isTabAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}
