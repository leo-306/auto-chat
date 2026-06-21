import type { AppConfig, ArtifactRequest, ClaimJobRequest, DispatchState, Job, UpdateStatusRequest } from "@wechat-topic/shared";
import { DEFAULT_CONFIG } from "@wechat-topic/shared";
import type { DebugInspectMessage, DebugInspectResult, JobProgressMessage, PopupState, StartJobMessage, WorkerRecord } from "./types.js";

const SERVER_URL = "http://127.0.0.1:17321";
const workerId = `ext_${crypto.randomUUID()}`;
const workers = new Map<number, WorkerRecord>();
let paused = true;
let config: AppConfig = DEFAULT_CONFIG;
let serverOk = false;
let lastDebug = "";
let lastDispatchId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ paused: true });
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
  if (!worker || !changeInfo.url?.includes("/c/")) return;
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

  const typed = message as { type?: string; paused?: boolean; jobId?: string; tabId?: number };
  if (typed.type === "GET_STATE") {
    return state();
  }
  if (typed.type === "SET_PAUSED") {
    paused = Boolean(typed.paused);
    await chrome.storage.local.set({ paused });
    if (!paused) void schedulerTick();
    return state();
  }
  if (typed.type === "TICK") {
    await schedulerTick({ force: true });
    return state();
  }
  if (typed.type === "DEBUG_INSPECT_CURRENT_TAB") {
    return debugInspectCurrentTab();
  }
  if (typed.type === "DEBUG_SIMULATE_SUCCESS") {
    return debugSimulate("done");
  }
  if (typed.type === "DEBUG_SIMULATE_ERROR") {
    return debugSimulate("failed_retryable", "Debug simulated ChatGPT error.");
  }
  if (typed.type === "DEBUG_SIMULATE_STALLED") {
    return debugSimulate("stalled", "Debug simulated stalled generation.");
  }
  if (typed.type === "DEBUG_SIMULATE_TIMEOUT") {
    return debugSimulate("needs_manual", "Debug simulated hard timeout.");
  }
  if (typed.type === "DEBUG_OPEN_ACTIVE_TAB") {
    const worker = firstWorker();
    if (!worker) return debugResult("No active worker tab.");
    await chrome.tabs.update(worker.tabId, { active: true });
    return debugResult(`已切换到任务标签页：tab=${worker.tabId}，任务=${worker.jobId}。`);
  }
  return { ok: false };
}

async function schedulerTick(options: { force?: boolean } = {}): Promise<void> {
  const stored = await chrome.storage.local.get(["paused"]);
  paused = stored.paused !== false;
  await refreshConfig();
  const dispatched = await consumeDispatchSignal();
  if ((!options.force && paused && !dispatched) || !serverOk) return;

  while (workers.size < config.maxConcurrency) {
    const job = await claimJob();
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

async function refreshConfig(): Promise<void> {
  try {
    config = await api<AppConfig>("/config");
    serverOk = true;
  } catch {
    serverOk = false;
  }
}

async function consumeDispatchSignal(): Promise<boolean> {
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
    lastDebug = `收到外部调度请求：${dispatch.requestedAt ?? "未知时间"}。`;
    return true;
  } catch {
    return false;
  }
}

async function claimJob(): Promise<Job | null> {
  const body: ClaimJobRequest = {
    workerId,
    runningJobIds: [...workers.values()].map(worker => worker.jobId)
  };
  return api<Job | null>(`/jobs/claim`, { method: "POST", body });
}

async function launchJob(job: Job): Promise<void> {
  const tab = await chrome.tabs.create({ url: config.chatgptUrl, active: false });
  if (!tab.id) throw new Error("Chrome did not return a tab id");
  const worker: WorkerRecord = {
    tabId: tab.id,
    jobId: job.id,
    startedAt: Date.now(),
    lastStateAt: Date.now(),
    refreshCount: job.refreshCount
  };
  workers.set(tab.id, worker);
  await postStatus(job.id, { status: "opening_tab", tabId: tab.id, workerId });
  await waitForTabComplete(tab.id);
  await sendStartMessage(tab.id, job);
}

async function sendStartMessage(tabId: number, job: Job): Promise<void> {
  const message: StartJobMessage = { type: "START_JOB", job, config };
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
    await sendStartMessage(tabId, job);
    return;
  }

  if (message.status === "done") {
    try {
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
      await postStatus(message.jobId, {
        status: "done",
        tabId,
        workerId
      });
      workers.delete(tabId);
      await chrome.tabs.remove(tabId);
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

function state(): PopupState {
  return {
    paused,
    serverOk,
    workers: [...workers.values()],
    lastDebug
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
    lastDebug = `检测：任务=${result.jobId ?? "无"} 可用图片=${result.loadedImages}/${result.expectedImages ?? "?"} 任务区=${result.scopedImages} 全页=${result.pageImages} 生成中=${result.isGenerating} 连接中断=${result.isInterrupted} 异常=${result.hasError}${mismatch}`;
    return { ok: true, message: lastDebug, result };
  } catch (error) {
    return debugResult(`检测失败：${String(error)}`, false);
  }
}

async function debugSimulate(
  status: JobProgressMessage["status"],
  errorMessage?: string
): Promise<{ ok: boolean; message: string }> {
  const worker = firstWorker();
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

function firstWorker(): WorkerRecord | undefined {
  return [...workers.values()][0];
}

function debugResult(message: string, ok = true): { ok: boolean; message: string } {
  lastDebug = message;
  return { ok, message };
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
