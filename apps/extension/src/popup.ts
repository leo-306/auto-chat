import type { JobPlatform } from "auto-chat-shared";
import type { PlatformState, PopupState } from "./types.js";

const server = document.querySelector("#server")!;
const statusCopy = document.querySelector("#status-copy")!;
const pause = document.querySelector<HTMLButtonElement>("#pause")!;
const tick = document.querySelector<HTMLButtonElement>("#tick")!;
const workers = document.querySelector("#workers")!;
const workersCopy = document.querySelector("#workers-copy")!;
const inspect = document.querySelector<HTMLButtonElement>("#inspect")!;
const debugSuccess = document.querySelector<HTMLButtonElement>("#debug-success")!;
const debugError = document.querySelector<HTMLButtonElement>("#debug-error")!;
const debugStalled = document.querySelector<HTMLButtonElement>("#debug-stalled")!;
const debugTimeout = document.querySelector<HTMLButtonElement>("#debug-timeout")!;
const openTab = document.querySelector<HTMLButtonElement>("#open-tab")!;
const debugOutput = document.querySelector("#debug-output")!;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>(".tab[data-platform]")];

let activePlatform: JobPlatform = "gpt";

for (const button of tabButtons) {
  button.addEventListener("click", async () => {
    activePlatform = platformFromButton(button);
    await render();
  });
}

pause.addEventListener("click", async () => {
  const state = await getState();
  const platform = state.platforms[activePlatform];
  await chrome.runtime.sendMessage({ type: "SET_PAUSED", platform: activePlatform, paused: !platform.paused });
  await render();
});

tick.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TICK", platform: activePlatform });
  await render();
});

inspect.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_INSPECT_CURRENT_TAB", platform: activePlatform });
});

debugSuccess.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_SUCCESS", platform: activePlatform });
});

debugError.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_ERROR", platform: activePlatform });
});

debugStalled.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_STALLED", platform: activePlatform });
});

debugTimeout.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_SIMULATE_TIMEOUT", platform: activePlatform });
});

openTab.addEventListener("click", async () => {
  await runDebug({ type: "DEBUG_OPEN_ACTIVE_TAB", platform: activePlatform });
});

async function getState(): Promise<PopupState> {
  return chrome.runtime.sendMessage({ type: "GET_STATE", platform: activePlatform });
}

async function render(): Promise<void> {
  const state = await getState();
  const platform = state.platforms[activePlatform];
  for (const button of tabButtons) {
    button.classList.toggle("active", platformFromButton(button) === activePlatform);
  }
  server.textContent = state.serverOk ? "服务在线" : "服务离线";
  server.className = `status-pill ${state.serverOk ? "ok" : "off"}`;
  statusCopy.textContent = statusMessage(state, platform);
  pause.textContent = platform.paused ? "开启自动执行" : "暂停自动执行";
  tick.disabled = !state.serverOk;
  pause.disabled = !state.serverOk;
  openTab.disabled = platform.workers.length === 0;
  workersCopy.textContent = `当前由插件接管的 ${platformLabel(activePlatform)} 标签页和任务。`;
  debugOutput.textContent = platform.lastDebug || (state.serverOk
    ? `本地服务已连接。运行 auto-chat add <job.json> --platform ${activePlatform} 创建任务。`
    : "本地服务未连接：请先运行 auto-chat start。");
  workers.innerHTML = platform.workers.length
    ? platform.workers.map(worker => `
      <div class="worker">
        <div class="worker-title">${escapeHtml(worker.jobId)}</div>
        <div class="worker-meta">
          <span>${platformLabel(worker.platform)} 标签页 ${worker.tabId}</span>
          <span>已刷新 ${worker.refreshCount} 次</span>
        </div>
      </div>
    `).join("")
    : `<div class="empty">当前没有正在执行的 ${platformLabel(activePlatform)} 任务。可运行 auto-chat dispatch --platform ${activePlatform} 触发一次调度。</div>`;
}

async function runDebug(message: { type: string; platform: JobPlatform }): Promise<void> {
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

function statusMessage(state: PopupState, platform: PlatformState): string {
  if (!state.serverOk) return "本地服务未连接：请先运行 auto-chat start。";
  if (platform.workers.length > 0) return `${platformLabel(activePlatform)} 正在处理 ${platform.workers.length} 个任务。`;
  return platform.paused
    ? `${platformLabel(activePlatform)} 自动执行已暂停；点击“执行一次调度”只领取一轮任务。`
    : `${platformLabel(activePlatform)} 自动执行已开启；插件会持续领取该平台队列中的任务。`;
}

function platformFromButton(button: HTMLButtonElement): JobPlatform {
  return button.dataset.platform === "gemini" ? "gemini" : "gpt";
}

function platformLabel(platform: JobPlatform): string {
  return platform === "gemini" ? "Gemini" : "GPT";
}

render();
setInterval(render, 2000);
