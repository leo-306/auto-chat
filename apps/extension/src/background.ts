import type { AppConfig, ArtifactRequest, ClaimJobRequest, DispatchState, Job, JobPlatform, UpdateStatusRequest } from "auto-chat-shared";
import { DEFAULT_CONFIG } from "auto-chat-shared";
import { isDispatchPending, shouldAcknowledgeDispatch } from "./dispatch.js";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";
import type { DebugInspectMessage, DebugInspectResult, ExpectNavigationMessage, JobProgressMessage, PopupState, RequestImageDownloadResult, StartJobMessage, WorkerRecord } from "./types.js";

const SERVER_URL = "http://127.0.0.1:17321";
const PLATFORMS: JobPlatform[] = ["gpt", "gemini", "doubao"];
const RECHECKABLE_STATUSES = new Set<Job["status"]>([
  "opening_tab", "waiting_chat_ready", "uploading", "waiting_upload_ready",
  "sending_prompt", "waiting_generation", "stalled", "refreshing",
  "collecting_outputs", "downloading"
]);
const workerId = `ext_${crypto.randomUUID()}`;
const workers = new Map<number, WorkerRecord>();
let pausedByPlatform: Record<JobPlatform, boolean> = { gpt: true, gemini: true, doubao: true };
let config: AppConfig = DEFAULT_CONFIG;
let serverOk = false;
let lastDebugByPlatform: Record<JobPlatform, string> = { gpt: "", gemini: "", doubao: "" };
let lastAcknowledgedDispatchId: number | null = null;
let lastAcknowledgedDispatchToken: string | null = null;
let pendingDispatch: DispatchState | null = null;

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
  if (!worker) return;

  // Submitting a prompt drives the platform's own client-side router into a
  // fresh conversation URL (e.g. Gemini's /app -> /app/<id>), which we
  // already track as expected progress right below. That router navigation
  // can itself be reported as a "loading" update; without excluding it here
  // it would otherwise be misread as an unexpected reload and re-trigger
  // startJob mid-run, aborting the job's own in-flight controller. A
  // genuine unexpected reload either keeps the same URL (no changeInfo.url)
  // or lands somewhere unrelated (e.g. a login redirect), so it won't match.
  const isEnteringConversation = Boolean(changeInfo.url && isConversationUrl(worker.platform, changeInfo.url));
  if (isEnteringConversation) {
    void postStatus(worker.jobId, {
      status: "waiting_generation",
      tabId,
      conversationUrl: changeInfo.url,
      workerId
    });
  }

  if (changeInfo.status === "loading" && !worker.expectingReload && !isEnteringConversation) {
    void recoverFromUnexpectedReload(tabId, worker);
  }
});

const unexpectedReloadInFlight = new Set<number>();

async function recoverFromUnexpectedReload(tabId: number, worker: WorkerRecord): Promise<void> {
  if (unexpectedReloadInFlight.has(tabId)) return;
  unexpectedReloadInFlight.add(tabId);
  try {
    await waitForTabComplete(tabId);
    if (workers.get(tabId) !== worker) return;
    const job = await api<Job>(`/jobs/${worker.jobId}`);
    if (!RECHECKABLE_STATUSES.has(job.status)) return;
    await sendStartMessage(tabId, job, "monitor_only");
  } catch (error) {
    await postStatus(worker.jobId, {
      status: "needs_manual",
      tabId,
      errorMessage: `Failed to recover monitoring after the tab reloaded unexpectedly: ${String(error)}`,
      workerId
    });
    workers.delete(tabId);
  } finally {
    unexpectedReloadInFlight.delete(tabId);
  }
}

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
  if (isExpectNavigation(message)) {
    const tabId = sender.tab?.id;
    const worker = tabId === undefined ? undefined : workers.get(tabId);
    if (worker && tabId !== undefined) {
      worker.expectingReload = message.expecting;
      // A self-initiated SPA navigation (e.g. Gemini's "New chat") normally
      // clears this within ~1.5s via the matching false message; if that
      // message never arrives (tab replaced, message lost) this tab would
      // stay permanently blind to genuinely unexpected reloads otherwise.
      if (message.expecting) {
        setTimeout(() => {
          const current = workers.get(tabId);
          if (current === worker) worker.expectingReload = false;
        }, 10_000);
      }
    }
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
    gemini: stored.pausedByPlatform?.gemini ?? true,
    doubao: stored.pausedByPlatform?.doubao ?? true
  };
  await refreshConfig();
  if (!serverOk) return;
  await pruneTerminalWorkers();
  const dispatched = await consumeDispatchSignal();

  let acknowledgeDispatch = dispatched !== false;
  if (dispatched && dispatched.jobId) {
    const requestedJob = await api<Job>(`/jobs/${dispatched.jobId}`).catch(() => null);
    if (requestedJob && RECHECKABLE_STATUSES.has(requestedJob.status)) {
      try {
        await recheckJob(requestedJob);
      } catch (error) {
        await postStatus(requestedJob.id, {
          status: "needs_manual",
          errorMessage: `Manual recheck failed: ${String(error)}`,
          workerId
        });
      }
      await acknowledgeDispatchSignal(dispatched);
      return;
    }
  }

  const targetPlatforms = options.platform ? [options.platform] : PLATFORMS;
  if (dispatched && dispatched.platform && options.platform && dispatched.platform !== options.platform) {
    acknowledgeDispatch = false;
  }
  for (const platform of targetPlatforms) {
    const dispatchMatches = dispatched !== false &&
      (dispatched === null || dispatched.platform === null || dispatched.platform === platform);
    if (!options.force && pausedByPlatform[platform] && !dispatchMatches) continue;

    if (dispatchMatches && workerCount(platform) >= config.maxConcurrency) {
      acknowledgeDispatch = false;
      lastDebugByPlatform[platform] = "收到调度请求，但当前并发已满；将保留该请求，等待任务释放后自动领取。";
      continue;
    }

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

  if (dispatched && shouldAcknowledgeDispatch(!acknowledgeDispatch)) {
    await acknowledgeDispatchSignal(dispatched);
  }
}

async function recheckJob(job: Job): Promise<void> {
  const activeWorker = [...workers.values()].find(worker => worker.jobId === job.id);
  const recordedTab = activeWorker
    ? await getTab(activeWorker.tabId)
    : job.tabId === null ? null : await getTab(job.tabId);
  let tabId: number;

  if (recordedTab?.id) {
    tabId = recordedTab.id;
    await chrome.tabs.update(tabId, { active: true });
  } else {
    if (!job.conversationUrl) throw new Error(`Job has no recorded conversation URL: ${job.id}`);
    const tab = await chrome.tabs.create({ url: job.conversationUrl, active: true });
    if (!tab.id) throw new Error("Chrome did not return a tab id");
    tabId = tab.id;
  }

  for (const [workerTabId, worker] of workers) {
    if (worker.jobId === job.id && workerTabId !== tabId) workers.delete(workerTabId);
  }
  const worker: WorkerRecord = {
    tabId,
    jobId: job.id,
    platform: job.platform,
    startedAt: Date.now(),
    lastStateAt: Date.now(),
    refreshCount: job.refreshCount,
    rateLimitRefreshCount: 0,
    expectingReload: true
  };
  workers.set(tabId, worker);

  try {
    await postStatus(job.id, {
      status: "refreshing",
      tabId,
      ...(job.conversationUrl ? { conversationUrl: job.conversationUrl } : {}),
      refreshCount: job.refreshCount,
      workerId
    });
    if (recordedTab?.id) await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    const latest = await api<Job>(`/jobs/${job.id}`);
    await sendStartMessage(tabId, latest, "monitor_only");
    worker.expectingReload = false;
  } catch (error) {
    workers.delete(tabId);
    await postStatus(job.id, {
      status: "needs_manual",
      tabId,
      errorMessage: `Manual recheck failed: ${String(error)}`,
      workerId
    });
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
    if (lastAcknowledgedDispatchId === null) {
      const stored = await chrome.storage.local.get([
        "lastAcknowledgedDispatchId",
        "lastAcknowledgedDispatchToken",
        "lastDispatchId"
      ]);
      const acknowledged = Number(stored.lastAcknowledgedDispatchId);
      const acknowledgedToken = typeof stored.lastAcknowledgedDispatchToken === "string"
        ? stored.lastAcknowledgedDispatchToken
        : null;
      if (Number.isInteger(acknowledged) && acknowledged >= -1) {
        lastAcknowledgedDispatchId = acknowledged;
        lastAcknowledgedDispatchToken = acknowledgedToken;
      } else {
        const legacy = Number(stored.lastDispatchId ?? -1);
        lastAcknowledgedDispatchId = await migratedDispatchId(dispatch, legacy);
      }
    }
    if (!isDispatchPending(dispatch, {
      id: lastAcknowledgedDispatchId ?? -1,
      token: lastAcknowledgedDispatchToken
    })) return false;
    pendingDispatch = dispatch;
    const targets = dispatch.platform ? [dispatch.platform] : PLATFORMS;
    for (const platform of targets) {
      lastDebugByPlatform[platform] = `收到外部调度请求：${dispatch.requestedAt ?? "未知时间"}。`;
    }
    return dispatch;
  } catch {
    return false;
  }
}

async function migratedDispatchId(dispatch: DispatchState, legacyId: number): Promise<number> {
  if (!Number.isInteger(legacyId) || legacyId < -1) return -1;
  // Older extension versions marked a dispatch handled before attempting a
  // claim. Preserve their acknowledgement except for the exact queued job
  // that exposes that bug, which must be retried after this upgrade.
  if (dispatch.id === legacyId && dispatch.jobId) {
    const job = await api<Job>(`/jobs/${dispatch.jobId}`).catch(() => null);
    if (job?.status === "queued") return -1;
  }
  return legacyId;
}

async function acknowledgeDispatchSignal(dispatch: DispatchState): Promise<void> {
  lastAcknowledgedDispatchId = dispatch.id;
  lastAcknowledgedDispatchToken = dispatch.token;
  pendingDispatch = null;
  await chrome.storage.local.set({ lastAcknowledgedDispatchId, lastAcknowledgedDispatchToken });
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

async function pruneTerminalWorkers(): Promise<void> {
  await Promise.all([...workers.entries()].map(async ([tabId, worker]) => {
    const job = await api<Job>(`/jobs/${worker.jobId}`).catch(() => null);
    if (!job || !RECHECKABLE_STATUSES.has(job.status)) {
      if (workers.get(tabId) === worker) workers.delete(tabId);
    }
  }));
}

async function launchJob(job: Job): Promise<void> {
  let tabId: number;
  let needsLoad = true;
  let conversationUrl = job.conversationUrl;
  const reloadOnly = job.metadata.autoChatReloadOnly === true;
  const activateTab = job.platform === "gpt" || job.mode === "image" || reloadOnly;

  if (job.parentJobId) {
    const parentJob = await api<Job>(`/jobs/${job.parentJobId}`);
    const parentTabId = parentJob.tabId;
    const parentTab = parentTabId === null ? null : await getTab(parentTabId);
    if (parentTab?.id) {
      tabId = parentTab.id;
      needsLoad = false;
      if (activateTab) await chrome.tabs.update(tabId, { active: true });
      conversationUrl = parentTab.url && isConversationUrl(job.platform, parentTab.url)
        ? parentTab.url
        : await findRecordedConversationUrl(parentJob);
    } else {
      conversationUrl = await findRecordedConversationUrl(parentJob);
      const url = conversationUrl ?? urlForPlatform(job.platform);
      const tab = await chrome.tabs.create({ url, active: activateTab });
      if (!tab.id) throw new Error("Chrome did not return a tab id");
      tabId = tab.id;
    }
  } else {
    const tab = await chrome.tabs.create({
      url: job.conversationUrl ?? urlForPlatform(job.platform),
      active: activateTab
    });
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
    rateLimitRefreshCount: 0,
    // The tab's own initial navigation (freshly created, or already loading
    // job.conversationUrl) fires the same chrome.tabs.onUpdated "loading"
    // event as a genuinely unexpected mid-job reload. Since the worker
    // record already exists at this point, that first load would otherwise
    // be misclassified as unexpected, triggering a duplicate START_JOB via
    // recoverFromUnexpectedReload that races with the one sent below and
    // aborts this job's own in-flight controller.
    expectingReload: needsLoad
  };
  workers.set(tabId, worker);
  await postStatus(job.id, {
    status: "opening_tab",
    tabId,
    ...(conversationUrl ? { conversationUrl } : {}),
    workerId
  });
  if (needsLoad) await waitForTabComplete(tabId);
  await sendStartMessage(tabId, job);
  worker.expectingReload = false;
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
    worker.expectingReload = true;
    await postStatus(worker.jobId, { status: "refreshing", tabId, refreshCount: worker.refreshCount, workerId });
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    const job = await api<Job>(`/jobs/${worker.jobId}`);
    await sendStartMessage(tabId, job, "monitor_only");
    worker.expectingReload = false;
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
    worker.expectingReload = true;
    await postStatus(worker.jobId, {
      status: "refreshing",
      tabId,
      refreshCount: worker.refreshCount,
      workerId
    });
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    const job = await api<Job>(`/jobs/${worker.jobId}`);
    await sendStartMessage(tabId, job, message.recoveryMode ?? "monitor_only");
    worker.expectingReload = false;
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

// Chrome's downloads API gives no way to associate an onCreated event with
// the click that triggered it (there's no correlation id for downloads the
// page itself initiates), so only one capture can safely be in flight at a
// time: whichever download fires next while we're listening is assumed to
// be ours. downloadQueueTail chains requests so concurrent image-download
// jobs (Gemini or GPT) wait their turn instead of racing to claim the same
// onCreated event.
//
// chrome.downloads.onCreated/onChanged are registered ONCE HERE, at the top
// level of the script, and stay registered for the service worker's entire
// lifetime — never added/removed inside captureOneDownload(). This matters
// because MV3 service workers are killed after ~30s idle and only respawn
// on a NEW top-level-registered event; a listener added dynamically inside
// a function call does NOT survive that respawn. Two images in the same
// multi-image job can be a minute or more apart (page navigation + prompt
// submission + generation), which is easily enough idle time for the
// worker to be torn down between arming the capture and Gemini's button
// actually completing its download — silently orphaning a
// dynamically-registered listener while the real download fires into a
// service worker instance that isn't listening for it. Routing every event
// through this single always-on listener plus a `pendingCapture` variable
// avoids that: whichever service worker instance happens to be running
// when Chrome delivers the event handles it, using state that gets
// reconstructed by captureOneDownload() on every call regardless of
// respawns in between.
let downloadQueueTail: Promise<unknown> = Promise.resolve();
const DOWNLOAD_CAPTURE_TIMEOUT_MS = 30_000;

type PendingCapture = {
  downloadId: number | null;
  onCreated: (item: chrome.downloads.DownloadItem) => void;
  onChanged: (item: chrome.downloads.DownloadItem) => void;
};
let pendingCapture: PendingCapture | null = null;

chrome.downloads.onCreated.addListener(item => {
  pendingCapture?.onCreated(item);
});

chrome.downloads.onChanged.addListener(delta => {
  if (!pendingCapture || pendingCapture.downloadId !== delta.id || !delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    chrome.downloads.search({ id: delta.id }).then(([item]) => {
      if (item) pendingCapture?.onChanged(item);
    });
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "image-download-capture") return;
  const tabId = port.sender?.tab?.id;
  port.onMessage.addListener((message: { type?: string; point?: { x: number; y: number } }) => {
    if (message?.type !== "REQUEST_IMAGE_DOWNLOAD" || !message.point || tabId === undefined) return;
    const point = message.point;
    const turn = downloadQueueTail.then(() => captureOneDownload(port, tabId, point));
    // Swallow rejections in the chain itself so one failed/aborted capture
    // doesn't permanently jam the queue for requests behind it.
    downloadQueueTail = turn.catch(() => {});
  });
});

// A synthetic HTMLElement.click() from the content script doesn't carry the
// browser's "transient user activation" that these download handlers need
// to actually trigger a save-to-disk — the click event reaches the button,
// but empirically Gemini's underlying download only fired reliably for the
// very first such click in a tab's lifetime, then intermittently stopped
// working (see the long investigation in git history for this file). Only
// an OS-level input event can grant that activation, which content scripts
// have no way to produce. chrome.debugger's Input.dispatchMouseEvent (the
// same Chrome DevTools Protocol call the reference Electron implementation
// uses) is a real, trusted click as far as the page and browser are
// concerned, so it reliably triggers the download every time.
async function dispatchTrustedClick(tabId: number, point: { x: number; y: number }): Promise<void> {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const args = { x: point.x, y: point.y, button: "left" as const, clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...args });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...args });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function captureOneDownload(port: chrome.runtime.Port, tabId: number, point: { x: number; y: number }): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
    });

    const finish = (result: RequestImageDownloadResult) => {
      if (settled) return;
      settled = true;
      pendingCapture = null;
      clearTimeout(timeout);
      if (!disconnected) {
        try {
          port.postMessage({ type: "RESULT", ...result });
        } catch {
          // the content script's tab may already be gone
        }
      }
      resolve();
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for the download to start." });
    }, DOWNLOAD_CAPTURE_TIMEOUT_MS);

    // Arm the listener BEFORE dispatching the click — the whole point of
    // this handshake is that the click only happens once we're guaranteed
    // to observe the resulting onCreated event.
    pendingCapture = {
      downloadId: null,
      onCreated: item => {
        if (pendingCapture) pendingCapture.downloadId = item.id;
      },
      onChanged: item => {
        if (item.state === "interrupted") {
          finish({ ok: false, error: "Download was interrupted." });
          return;
        }
        readAndCleanUpDownload(item).then(finish, error => finish({ ok: false, error: String(error) }));
      }
    };
    dispatchTrustedClick(tabId, point).catch(error => {
      finish({ ok: false, error: `Failed to dispatch a trusted click via chrome.debugger: ${String(error)}` });
    });
  });
}

async function readAndCleanUpDownload(item: chrome.downloads.DownloadItem): Promise<RequestImageDownloadResult> {
  try {
    const result = await api<{ contentType: string; base64: string }>("/local-downloads/read", {
      method: "POST",
      body: { path: item.filename }
    });
    return { ok: true, contentType: result.contentType, base64: result.base64 };
  } finally {
    await chrome.downloads.removeFile(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  }
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

function isExpectNavigation(message: unknown): message is ExpectNavigationMessage {
  return Boolean(message && typeof message === "object" && (message as { type?: string }).type === "EXPECT_NAVIGATION");
}

function state(activePlatform: JobPlatform): PopupState {
  return {
    serverOk,
    activePlatform,
    extensionVersion: chrome.runtime.getManifest().version,
    lastAcknowledgedDispatchId,
    lastAcknowledgedDispatchToken,
    pendingDispatch,
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
      },
      doubao: {
        paused: pausedByPlatform.doubao,
        workers: workersForPlatform("doubao"),
        lastDebug: lastDebugByPlatform.doubao
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
  if (platform === "gemini" || platform === "doubao") return platform;
  return "gpt";
}

function urlForPlatform(platform: JobPlatform): string {
  if (platform === "gemini") return config.geminiUrl;
  if (platform === "doubao") return config.doubaoUrl;
  return config.chatgptUrl;
}

function workerCount(platform: JobPlatform): number {
  return workersForPlatform(platform).length;
}

function workersForPlatform(platform: JobPlatform): WorkerRecord[] {
  return [...workers.values()].filter(worker => worker.platform === platform);
}

function platformForUrl(url: string): JobPlatform {
  if (url.includes("gemini.google.com")) return "gemini";
  if (url.includes("doubao.com")) return "doubao";
  return "gpt";
}

function platformName(platform: JobPlatform): string {
  if (platform === "gemini") return "Gemini";
  if (platform === "doubao") return "豆包";
  return "GPT";
}

function isConversationUrl(platform: JobPlatform, url: string): boolean {
  if (platform === "gemini") return url.includes("gemini.google.com/app");
  if (platform === "doubao") return /doubao\.com\/chat\/\d+/.test(url);
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

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function findRecordedConversationUrl(job: Job): Promise<string | null> {
  const visited = new Set<string>();
  let current: Job | null = job;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.conversationUrl) return current.conversationUrl;
    current = current.parentJobId
      ? await api<Job>(`/jobs/${current.parentJobId}`)
      : null;
  }
  return null;
}
