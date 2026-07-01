#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import open from "open";
import { JobPlatformSchema } from "auto-chat-shared";
import type { AppConfig, Job, JobPlatform, JobStatus } from "auto-chat-shared";
import { workspaceRoot } from "./paths.js";

const baseUrl = process.env.JOB_SERVER_URL ?? "http://127.0.0.1:17321";
const dataDir = path.join(workspaceRoot, "data");
const pidFile = path.join(dataDir, "server.pid");
const logFile = path.join(dataDir, "server.log");
const terminalStatuses = new Set<JobStatus>(["done", "failed_retryable", "failed_final", "needs_manual"]);
const extensionGithubUrl = process.env.AUTO_CHAT_EXTENSION_GITHUB_URL ?? "https://github.com/leo-306/auto-chat";
const extensionZipUrl = process.env.AUTO_CHAT_EXTENSION_ZIP_URL ?? `${extensionGithubUrl}/raw/master/auto-chat-extension.zip`;

type CliOptions = {
  json: boolean;
  replace: boolean;
  autoId: boolean;
  platform?: JobPlatform;
};

type ListRow = {
  id: string;
  platform: JobPlatform;
  mode: Job["mode"];
  status: JobStatus;
  progress: string;
  result: string;
  updatedAt: string;
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [rawCommand, ...rawArgs] = argv;
  const command = normalizeCommand(rawCommand ?? "--help");
  const args = rawArgs.filter(arg => arg !== "--");
  const options = parseOptions(args);

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "start") {
    await startServer();
    return;
  }

  if (command === "init") {
    await initAutoChat();
    return;
  }

  if (command === "stop") {
    await stopServer();
    return;
  }

  if (command === "status") {
    await printServerStatus();
    return;
  }

  if (command === "concurrency") {
    const value = positionalArgs(args)[0];
    const config = value
      ? await request<AppConfig>("/config", { method: "PATCH", body: { maxConcurrency: parseMaxConcurrencyArg(value) } })
      : await request<AppConfig>("/config");
    print(options.json ? JSON.stringify(config, null, 2) : formatConcurrencyResult(config));
    return;
  }

  if (command === "autoretry") {
    const value = positionalArgs(args)[0];
    const config = value
      ? await request<AppConfig>("/config", { method: "PATCH", body: parseAutoRetryArg(value) })
      : await request<AppConfig>("/config");
    print(options.json ? JSON.stringify(config, null, 2) : formatAutoRetryResult(config));
    return;
  }

  if (command === "add") {
    const file = positionalArgs(args)[0] ?? readFlag(args, "--file");
    if (!file) throw new Error("缺少任务文件。用法：auto-chat add examples/job.json");
    const body = JSON.parse(fs.readFileSync(resolveInputFile(file), "utf8"));
    if (options.autoId) delete body.id;
    if (options.platform) body.platform = options.platform;
    const apiPath = options.replace ? "/jobs?replace=1" : "/jobs";
    const job = await request<Job>(apiPath, { method: "POST", body });
    print(options.json ? JSON.stringify(job, null, 2) : formatAddResult(job));
    return;
  }

  if (command === "list") {
    const jobs = await request<Job[]>("/jobs");
    if (options.json) {
      print(JSON.stringify(jobs, null, 2));
    } else {
      console.table(jobs.map(job => formatListRow(job)));
    }
    return;
  }

  if (command === "show") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat show <jobId>");
    const job = await request<Job>(`/jobs/${id}`);
    print(options.json ? JSON.stringify(job, null, 2) : formatJobSummary(job));
    return;
  }

  if (command === "watch") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat watch <jobId>");
    await watch(id);
    return;
  }

  if (command === "retry") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat retry <jobId>");
    const job = await request<Job>(`/jobs/${id}/retry`, { method: "POST" });
    print(options.json ? JSON.stringify(job, null, 2) : formatAddResult(job));
    return;
  }

  if (command === "reload") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat reload <jobId>");
    const job = await request<Job>(`/jobs/${id}/reload`, { method: "POST" });
    print(options.json ? JSON.stringify(job, null, 2) : formatReloadResult(job));
    return;
  }

  if (command === "open") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat open <jobId>");
    const job = await request<Job>(`/jobs/${id}`);
    await open(job.conversationUrl ?? `${baseUrl}/jobs/${id}`);
    return;
  }

  if (command === "doctor") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("缺少任务 id。用法：auto-chat doctor <jobId>");
    const job = await request<Job>(`/jobs/${id}`);
    print(options.json ? JSON.stringify(job, null, 2) : formatDoctor(job));
    return;
  }

  if (command === "listen") {
    const id = positionalArgs(args)[0];
    await listen(id, options);
    return;
  }

  if (command === "dispatch") {
    const id = positionalArgs(args)[0];
    const dispatch = await request("/dispatch", {
      method: "POST",
      body: { ...(options.platform ? { platform: options.platform } : {}), ...(id ? { jobId: id } : {}) }
    });
    print(options.json ? JSON.stringify(dispatch, null, 2) : "已请求插件执行一次调度。");
    return;
  }

  throw new Error(`未知命令：${rawCommand ?? ""}\n运行 auto-chat --help 查看可用命令。`);
}

export function normalizeCommand(command: string): string {
  if (command === "server") return "start";
  if (command === "server:start") return "start";
  if (command === "server:stop") return "stop";
  if (command === "server:status") return "status";
  if (command === "retry-load") return "reload";
  const legacy = /^job:(.+)$/.exec(command);
  return legacy ? legacy[1] : command;
}

export function defaultSkillInstallDirs(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, ".codex", "skills"),
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".config", "opencode", "skills"),
    path.join(homeDir, ".opencode", "skills")
  ];
}

export function formatListRow(job: Job, textPreview: (file: string | null) => string = readTextPreview): ListRow {
  return {
    id: job.id,
    platform: job.platform,
    mode: job.mode,
    status: job.status,
    progress: formatProgress(job),
    result: formatResult(job, textPreview),
    updatedAt: job.updatedAt
  };
}

export function formatJobSummary(job: Job): string {
  const lines = [
    `任务: ${job.id}`,
    `平台: ${formatPlatform(job.platform)}`,
    `模式: ${formatMode(job.mode)}`,
    `状态: ${formatStatus(job.status, job.platform)}`,
    `进度: ${formatProgress(job)}`,
    `结果: ${formatResult(job) || "暂无"}`
  ];
  if (job.mode === "text") {
    const preview = readTextPreview(job.textOutputFile);
    if (preview) lines.push(`预览: ${preview}`);
  }
  if (job.conversationUrl) lines.push(`对话: ${job.conversationUrl}`);
  if (job.errorMessage) lines.push(`错误: ${job.errorMessage}`);
  lines.push(`更新: ${job.updatedAt}`);
  return lines.join("\n");
}

export function formatDoctor(job: Job): string {
  const lines = [doctorHeadline(job), formatJobSummary(job)];

  if (job.status === "done") {
    lines.push(job.mode === "text"
      ? `下一步: 读取 ${displayPath(job.textOutputFile ?? job.outputFiles[0] ?? "")}`
      : "下一步: 使用输出图片；如需确认顺序，查看 events.jsonl 中的 image_order。");
  } else if (job.status === "failed_retryable") {
    lines.push(`下一步: auto-chat retry ${job.id}`);
  } else if (job.status === "needs_manual" || job.status === "failed_final") {
    lines.push(`下一步: auto-chat open ${job.id}`);
  } else if (job.status === "stalled" || job.status === "refreshing") {
    lines.push(`下一步: auto-chat listen ${job.id}`);
  } else {
    lines.push(`下一步: auto-chat listen ${job.id}`);
  }

  return lines.join("\n");
}

async function request<T>(apiPath: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 409) {
      throw new Error(`${text}\n提示：复用同一个 id 用 --replace；创建新任务用 --auto-id。`);
    }
    throw new Error(`${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

async function startServer(): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  if (await isServerHealthy()) {
    print(`auto-chat 服务已在后台运行：${baseUrl}`);
    return;
  }

  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    print(`发现已有服务进程 pid=${existingPid}，但健康检查未通过。日志：${displayPath(logFile)}`);
    return;
  }

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js")], {
    detached: true,
    env: {
      ...process.env,
      PORT: portFromBaseUrl()
    },
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.writeFileSync(pidFile, `${child.pid}\n`);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isServerHealthy()) {
      print(`auto-chat 服务已后台启动：${baseUrl}`);
      print(`pid: ${child.pid}`);
      print(`日志: ${displayPath(logFile)}`);
      return;
    }
    await sleep(250);
  }
  throw new Error(`服务已启动但健康检查未通过。pid=${child.pid} 日志=${displayPath(logFile)}`);
}

async function initAutoChat(): Promise<void> {
  const installed = installAgentSkill();
  for (const line of formatSkillInstallResults(installed)) print(line);
  await startServer();
  await showChromeExtensionInstallGuide();
}

function installAgentSkill(): string[] {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "auto-chat");
  if (!fs.existsSync(source)) {
    throw new Error(`未找到随包发布的 auto-chat skill：${source}`);
  }

  const dirs = skillInstallDirs();
  const installed: string[] = [];
  for (const dir of dirs) {
    const target = path.join(dir, "auto-chat");
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    installed.push(target);
  }
  return installed;
}

function skillInstallDirs(): string[] {
  const raw = process.env.AUTO_CHAT_SKILL_DIRS;
  const dirs = raw
    ? raw.split(path.delimiter).map(value => value.trim()).filter(Boolean)
    : defaultSkillInstallDirs();
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

async function showChromeExtensionInstallGuide(): Promise<void> {
  try {
    await open("chrome://extensions");
  } catch (error) {
    print(`打开 Chrome 扩展管理页失败：${String(error)}`);
  }
  for (const line of formatExtensionInstallInstructions(extensionGithubUrl, extensionZipUrl, extensionPackageZipPath())) print(line);
}

export function formatExtensionInstallInstructions(githubUrl: string, zipUrl: string, localZipPath: string | null): string[] {
  return [
    "",
    "Chrome 插件",
    "已打开: chrome://extensions",
    `下载地址: ${zipUrl}`,
    ...(localZipPath ? [`本机 zip: ${localZipPath}`] : []),
    `项目地址: ${githubUrl}`,
    "",
    "安装引导:",
    localZipPath ? "1. 使用本机 zip，或从 GitHub 下载 auto-chat-extension.zip。" : "1. 下载 auto-chat-extension.zip。",
    "2. 解压 zip 到一个固定目录，不要直接选择 zip 文件。",
    "3. 在 chrome://extensions 页面启用 Developer mode / 开发者模式。",
    "4. 点击 Load unpacked / 加载已解压的扩展程序，选择解压后的目录。",
    "5. 安装后保持 auto-chat 服务运行，打开插件 popup，确认本地服务已连接。"
  ];
}

export function formatSkillInstallResults(paths: string[]): string[] {
  return [
    "已安装 auto-chat skill:",
    ...paths.map(target => `  - ${displayPath(target)}`)
  ];
}

function extensionPackageZipPath(): string | null {
  const root = packageRoot();
  if (fs.existsSync(path.join(root, ".git"))) return null;
  const zipPath = path.join(root, "auto-chat-extension.zip");
  return fs.existsSync(zipPath) ? zipPath : null;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function stopServer(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    print("没有找到 auto-chat 服务 pid 文件。");
    return;
  }
  if (!isProcessAlive(pid)) {
    fs.rmSync(pidFile, { force: true });
    print("pid 文件已过期，已清理。");
    return;
  }

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(pid)) {
      fs.rmSync(pidFile, { force: true });
      print("auto-chat 服务已停止。");
      return;
    }
    await sleep(250);
  }
  throw new Error(`服务未在预期时间内退出，请手动检查 pid=${pid}`);
}

async function printServerStatus(): Promise<void> {
  const pid = readPid();
  const healthy = await isServerHealthy();
  if (healthy) {
    print(`auto-chat 服务在线：${baseUrl}`);
    if (pid) print(`pid: ${pid}`);
    return;
  }
  if (pid && isProcessAlive(pid)) {
    print(`auto-chat 服务进程存在但健康检查失败：pid=${pid}`);
    print(`日志: ${displayPath(logFile)}`);
    return;
  }
  print("auto-chat 服务未运行。");
}

async function isServerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portFromBaseUrl(): string {
  try {
    const url = new URL(baseUrl);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "17321";
  }
}

function parseOptions(args: string[]): CliOptions {
  const rawPlatform = readFlag(args, "--platform");
  return {
    json: args.includes("--json"),
    replace: args.includes("--replace"),
    autoId: args.includes("--auto-id"),
    platform: rawPlatform ? JobPlatformSchema.parse(rawPlatform) : undefined
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function positionalArgs(args: string[]): string[] {
  const flagsWithValues = new Set(["--file", "--platform"]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values;
}

function resolveInputFile(file: string): string {
  if (path.isAbsolute(file)) return file;
  const cwdPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.resolve(workspaceRoot, file);
}

async function watch(jobId: string): Promise<void> {
  let last = "";
  while (true) {
    const job = await request<Job>(`/jobs/${jobId}`);
    const line = `${new Date().toLocaleTimeString()} ${job.id} ${formatStatus(job.status, job.platform)} ${formatProgress(job)} ${job.errorMessage ?? ""}`.trim();
    if (line !== last) {
      print(line);
      last = line;
    }
    if (job.status !== "failed_retryable" && terminalStatuses.has(job.status)) break;
    if (job.status === "failed_retryable") {
      const config = await request<AppConfig>("/config");
      if (!willAutoRetry(job, config)) break;
    }
    await sleep(5000);
  }
}

async function listen(jobId: string | undefined, options: CliOptions): Promise<void> {
  if (jobId && !options.json) {
    try {
      const job = await request<Job>(`/jobs/${jobId}`);
      print(`[${time()}] ${job.id} ${formatStatus(job.status, job.platform)} ${formatProgress(job)}`);
      if (job.status !== "failed_retryable" && terminalStatuses.has(job.status)) return;
      if (job.status === "failed_retryable") {
        const config = await request<AppConfig>("/config").catch(() => undefined);
        if (!willAutoRetry(job, config)) return;
      }
    } catch (error) {
      print(`[${time()}] 初始状态不可用：${String(error)}`);
    }
  }

  const response = await fetch(`${baseUrl}/events`);
  if (!response.ok || !response.body) {
    const text = await response.text();
    if (response.status === 404) {
      throw new Error("SSE 路由 /events 不可用。请运行 auto-chat stop 后再 auto-chat start。");
    }
    throw new Error(`${response.status} ${text}`);
  }
  const config = await request<AppConfig>("/config").catch(() => undefined);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (printSseChunk(chunk, jobId, options, config)) {
        await reader.cancel();
        return;
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

function printSseChunk(chunk: string, jobId: string | undefined, options: CliOptions, config?: Pick<AppConfig, "autoRetry" | "maxRetries">): boolean {
  const dataLine = chunk.split("\n").find(line => line.startsWith("data: "));
  if (!dataLine) return false;
  const payload = JSON.parse(dataLine.slice(6));
  if (options.json) {
    if (!payload.ok && (!jobId || payload.jobId === jobId)) print(JSON.stringify(payload));
    return shouldStopListeningForPayload(payload, jobId, config);
  }
  if (payload.ok) {
    print(`[${time()}] 已连接事件流：${baseUrl}/events`);
    return false;
  }
  if (jobId && payload.jobId !== jobId) return false;
  print(formatSseEvent(payload));
  return shouldStopListeningForPayload(payload, jobId, config);
}

export function shouldStopListeningForPayload(
  payload: { jobId?: string; job?: Pick<Job, "status" | "attempt"> | null },
  jobId: string | undefined,
  config?: Pick<AppConfig, "autoRetry" | "maxRetries">
): boolean {
  if (!jobId || payload.jobId !== jobId || !payload.job) return false;
  if (payload.job.status === "failed_retryable" && willAutoRetry(payload.job, config)) return false;
  return terminalStatuses.has(payload.job.status);
}

function willAutoRetry(job: Pick<Job, "attempt">, config?: Pick<AppConfig, "autoRetry" | "maxRetries">): boolean {
  return Boolean(config?.autoRetry && config.maxRetries !== undefined && job.attempt < config.maxRetries);
}

function formatSseEvent(payload: any): string {
  const job = payload.job as Job | null;
  const event = payload.event as { type?: string; payload?: Record<string, unknown> } | undefined;
  const prefix = `[${time(payload.at)}] ${payload.jobId}`;
  if (event?.type === "job_created") return `${prefix} 已创建任务`;
  if (event?.type === "job_claimed") return `${prefix} 插件已领取任务`;
  if (event?.type === "artifact_saved") return `${prefix} 已保存${artifactLabel(event.payload?.kind)}：${displayPath(String(event.payload?.path ?? ""))}`;
  if (event?.type === "image_order") return `${prefix} 已记录图片顺序`;
  if (event?.type === "text_output") return `${prefix} 已复制文本响应`;
  if (event?.type === "job_retry") return `${prefix} 已重新入队`;
  if (event?.type === "job_reload") return `${prefix} 已重新加载对话`;
  if (job) return `${prefix} ${formatStatus(job.status, job.platform)} ${formatProgress(job)} ${job.errorMessage ?? ""}`.trim();
  return `${prefix} ${payload.type}`;
}

export function formatAddResult(job: Job): string {
  return [
    `已创建任务: ${job.id}`,
    `平台: ${formatPlatform(job.platform)}`,
    `模式: ${formatMode(job.mode)}`,
    `状态: ${formatStatus(job.status, job.platform)}`,
    `下一步: auto-chat dispatch --platform ${job.platform} ${job.id} && auto-chat listen ${job.id}`
  ].join("\n");
}

export function formatReloadResult(job: Job): string {
  return [
    `已请求重试加载: ${job.id}`,
    `平台: ${formatPlatform(job.platform)}`,
    `模式: ${formatMode(job.mode)}`,
    `状态: ${formatStatus(job.status, job.platform)}`,
    `对话: ${job.conversationUrl ?? "未记录"}`,
    `下一步: auto-chat dispatch --platform ${job.platform} ${job.id} && auto-chat listen ${job.id}`
  ].join("\n");
}

export function parseMaxConcurrencyArg(value: string): number {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("最大并发数必须是 1 到 8 的整数");
  }
  return concurrency;
}

export function formatConcurrencyResult(config: Pick<AppConfig, "maxConcurrency">): string {
  return `插件调度最大并发数: ${config.maxConcurrency}`;
}

export function parseAutoRetryArg(value: string): { autoRetry: boolean; maxRetries?: number } {
  const maxRetries = Number(value);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("自动重试次数必须是 0 到 10 的整数（0 表示关闭）");
  }
  return maxRetries === 0 ? { autoRetry: false } : { autoRetry: true, maxRetries };
}

export function formatAutoRetryResult(config: Pick<AppConfig, "autoRetry" | "maxRetries">): string {
  return config.autoRetry
    ? `自动重试: 开启（最多重试 ${config.maxRetries} 次）`
    : "自动重试: 关闭";
}

function formatProgress(job: Job): string {
  if (job.mode === "text") return job.textOutputFile ? "text ready" : "waiting text";
  return `${job.outputFiles.length}/${job.expectedImageCount} images`;
}

function formatResult(job: Job, textPreview: (file: string | null) => string = readTextPreview): string {
  if (job.mode === "text") {
    const file = job.textOutputFile ?? job.outputFiles[0] ?? null;
    return textPreview(file) || displayPath(file ?? "");
  }
  return job.outputFiles.map(displayPath).join(", ");
}

function readTextPreview(file: string | null): string {
  if (!file || !fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function displayPath(value: string): string {
  if (!value) return "";
  const normalized = value.replaceAll(path.sep, "/");
  const outputsIndex = normalized.lastIndexOf("/outputs/");
  if (outputsIndex >= 0) return normalized.slice(outputsIndex + 1);
  const relative = path.relative(process.cwd(), value);
  return relative.startsWith("..") ? value : relative;
}

function formatMode(mode: Job["mode"]): string {
  return mode === "text" ? "常规文本" : "图片生成";
}

function formatPlatform(platform: JobPlatform): string {
  return platform === "gemini" ? "Gemini" : "GPT";
}

function formatStatus(status: JobStatus, platform?: JobPlatform): string {
  const platformLabel = platform === "gemini" ? "Gemini" : "ChatGPT";
  const labels: Record<JobStatus, string> = {
    queued: "排队中",
    opening_tab: `打开 ${platformLabel} 标签页`,
    waiting_chat_ready: `等待 ${platformLabel} 输入框`,
    uploading: "上传参考图片",
    waiting_upload_ready: "等待图片上传完成",
    sending_prompt: "发送提示词",
    waiting_generation: "等待响应",
    stalled: "响应停滞",
    refreshing: "刷新恢复中",
    collecting_outputs: "收集输出",
    downloading: "下载输出",
    done: "完成",
    failed_retryable: "可重试失败",
    failed_final: "最终失败",
    needs_manual: "需要人工接管"
  };
  return labels[status] ?? status;
}

function doctorHeadline(job: Job): string {
  if (job.status === "done") return "OK";
  if (job.status === "failed_retryable") return "RETRYABLE";
  if (job.status === "needs_manual" || job.status === "failed_final") return "NEEDS_MANUAL";
  if (job.status === "stalled" || job.status === "refreshing") return "RECOVERING";
  return "RUNNING";
}

function artifactLabel(kind: unknown): string {
  if (kind === "text_output") return "文本结果";
  if (kind === "output") return "图片";
  if (kind === "screenshot") return "截图";
  return "文件";
}

function time(value?: string): string {
  return new Date(value ?? Date.now()).toLocaleTimeString();
}

function print(message: string): void {
  console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function usage(): void {
  print(`auto-chat

Usage:
  auto-chat init
  auto-chat start
  auto-chat stop
  auto-chat status
  auto-chat add <job.json> [--replace] [--auto-id] [--json]
  auto-chat add <job.json> [--platform gpt|gemini]
  auto-chat list [--json]
  auto-chat show <jobId> [--json]
  auto-chat listen [jobId] [--json]
  auto-chat dispatch [--platform gpt|gemini] [jobId] [--json]
  auto-chat concurrency [1-8] [--json]
  auto-chat autoretry [0-10] [--json]
  auto-chat doctor <jobId>
  auto-chat retry <jobId>
  auto-chat reload <jobId>
  auto-chat open <jobId>

Legacy npm scripts still work, for example:
  npm run job:add -- --file examples/job.json`);
}

const isEntryPoint = isCliEntryPoint();
if (isEntryPoint) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

function isCliEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    const argvPath = fs.realpathSync(process.argv[1]);
    return modulePath === argvPath;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
