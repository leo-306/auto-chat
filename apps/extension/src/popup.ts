import type { PopupState } from "./types.js";

const server = document.querySelector("#server")!;
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
  server.textContent = state.serverOk ? "本地服务在线" : "本地服务离线";
  server.className = `status-pill ${state.serverOk ? "ok" : "off"}`;
  pause.textContent = state.paused ? "开启自动执行" : "暂停自动执行";
  debugOutput.textContent = state.lastDebug || "暂无调试输出";
  workers.innerHTML = state.workers.length
    ? state.workers.map(worker => `
      <div class="worker">
        <div class="worker-title">${escapeHtml(worker.jobId)}</div>
        <div class="worker-meta">
          <span>标签页 ${worker.tabId}</span>
          <span>刷新 ${worker.refreshCount} 次</span>
        </div>
      </div>
    `).join("")
    : `<div class="empty">当前没有插件接管中的任务。</div>`;
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

render();
setInterval(render, 2000);
