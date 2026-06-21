import type { PopupState } from "./types.js";

const server = document.querySelector("#server")!;
const statusCopy = document.querySelector("#status-copy")!;
const pause = document.querySelector<HTMLButtonElement>("#pause")!;
const tick = document.querySelector<HTMLButtonElement>("#tick")!;
const workers = document.querySelector("#workers")!;
const inspect = document.querySelector<HTMLButtonElement>("#inspect")!;
const debugSuccess = document.querySelector<HTMLButtonElement>("#debug-success")!;
const debugError = document.querySelector<HTMLButtonElement>("#debug-error")!;
const debugStalled = document.querySelector<HTMLButtonElement>("#debug-stalled")!;
const debugTimeout = document.querySelector<HTMLButtonElement>("#debug-timeout")!;
const openTab = document.querySelector<HTMLButtonElement>("#open-tab")!;
const debugOutput = document.querySelector("#debug-output")!;

pause.addEventListener("click", async () => {
  const state = await getState();
  await chrome.runtime.sendMessage({ type: "SET_PAUSED", paused: !state.paused });
  await render();
});

tick.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TICK" });
  await render();
});

inspect.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_INSPECT_CURRENT_TAB" });
});

debugSuccess.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_SUCCESS" });
});

debugError.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_ERROR" });
});

debugStalled.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_STALLED" });
});

debugTimeout.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_TIMEOUT" });
});

openTab.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_OPEN_ACTIVE_TAB" });
});

async function getState(): Promise<PopupState> {
  return chrome.runtime.sendMessage({ type: "GET_STATE" });
}

async function render(): Promise<void> {
  const state = await getState();
  server.textContent = state.serverOk ? "服务在线" : "服务离线";
  server.className = `status-pill ${state.serverOk ? "ok" : "off"}`;
  statusCopy.textContent = statusMessage(state);
  pause.textContent = state.paused ? "开启自动执行" : "暂停自动执行";
  tick.disabled = !state.serverOk;
  pause.disabled = !state.serverOk;
  openTab.disabled = state.workers.length === 0;
  debugOutput.textContent = state.lastDebug || (state.serverOk
    ? "本地服务已连接。运行 auto-chat add <job.json> 创建任务。"
    : "本地服务未连接：请先运行 auto-chat server。");
  workers.innerHTML = state.workers.length
    ? state.workers.map(worker => `
      <div class="worker">
        <div class="worker-title">${escapeHtml(worker.jobId)}</div>
        <div class="worker-meta">
          <span>ChatGPT 标签页 ${worker.tabId}</span>
          <span>已刷新 ${worker.refreshCount} 次</span>
        </div>
      </div>
    `).join("")
    : `<div class="empty">当前没有正在执行的任务。可运行 auto-chat dispatch 触发一次调度。</div>`;
}

async function runDebug(message: { type: string }): Promise<void> {
  const response = await chrome.runtime.sendMessage(message);
  debugOutput.textContent = JSON.stringify(response, null, 2);
  await render();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]!);
}

function statusMessage(state: PopupState): string {
  if (!state.serverOk) return "本地服务未连接：请先运行 auto-chat server。";
  if (state.workers.length > 0) return `正在处理 ${state.workers.length} 个任务。`;
  return state.paused
    ? "自动执行已暂停；点击“执行一次调度”只领取一轮任务。"
    : "自动执行已开启；插件会持续领取队列中的任务。";
}

render();
setInterval(render, 2000);
