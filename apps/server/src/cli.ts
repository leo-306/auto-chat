import fs from "node:fs";
import path from "node:path";
import open from "open";
import { workspaceRoot } from "./paths.js";

const baseUrl = process.env.JOB_SERVER_URL ?? "http://127.0.0.1:17321";

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();

  if (cmd === "job:add") {
    const file = readFlag(args, "--file");
    if (!file) throw new Error("Missing --file");
    const body = JSON.parse(fs.readFileSync(resolveInputFile(file), "utf8"));
    if (args.includes("--auto-id")) delete body.id;
    const path = args.includes("--replace") ? "/jobs?replace=1" : "/jobs";
    const job = await request(path, { method: "POST", body });
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  if (cmd === "job:list") {
    const jobs = await request("/jobs");
    console.table(jobs.map((job: any) => ({
      id: job.id,
      status: job.status,
      attempt: job.attempt,
      outputs: job.outputFiles.length,
      updatedAt: job.updatedAt
    })));
    return;
  }

  if (cmd === "job:show") {
    const id = args[0];
    if (!id) throw new Error("Missing job id");
    console.log(JSON.stringify(await request(`/jobs/${id}`), null, 2));
    return;
  }

  if (cmd === "job:watch") {
    const id = args[0];
    if (!id) throw new Error("Missing job id");
    let last = "";
    while (true) {
      const job = await request(`/jobs/${id}`);
      const line = `${new Date().toLocaleTimeString()} ${job.id} ${job.status} outputs=${job.outputFiles.length} error=${job.errorMessage ?? ""}`;
      if (line !== last) {
        console.log(line);
        last = line;
      }
      if (["done", "failed_final", "needs_manual"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return;
  }

  if (cmd === "job:retry") {
    const id = args[0];
    if (!id) throw new Error("Missing job id");
    console.log(JSON.stringify(await request(`/jobs/${id}/retry`, { method: "POST" }), null, 2));
    return;
  }

  if (cmd === "job:open") {
    const id = args[0];
    if (!id) throw new Error("Missing job id");
    const job = await request(`/jobs/${id}`);
    await open(job.conversationUrl ?? `${baseUrl}/jobs/${id}`);
    return;
  }

  if (cmd === "job:doctor") {
    const id = args[0];
    if (!id) throw new Error("Missing job id");
    const job = await request(`/jobs/${id}`);
    console.log(formatDoctor(job));
    return;
  }

  if (cmd === "job:listen") {
    const id = args[0];
    await listen(id);
    return;
  }

  if (cmd === "job:dispatch") {
    console.log(JSON.stringify(await request("/dispatch", { method: "POST" }), null, 2));
    return;
  }

  usage();
}

async function request(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 409) {
      throw new Error(`${text}\n提示：如果想复用同一个 id，请用 --replace；如果想创建新任务，请用 --auto-id。`);
    }
    throw new Error(`${response.status} ${text}`);
  }
  return response.json();
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function resolveInputFile(file: string): string {
  if (path.isAbsolute(file)) return file;
  const cwdPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.resolve(workspaceRoot, file);
}

async function listen(jobId?: string): Promise<void> {
  if (jobId) {
    try {
      const job = await request(`/jobs/${jobId}`);
      console.log(`${new Date().toISOString()} ${job.id} ${job.status} ${job.errorMessage ?? ""}`.trim());
    } catch (error) {
      console.log(`initial status unavailable: ${String(error)}`);
    }
  }
  const response = await fetch(`${baseUrl}/events`);
  if (!response.ok || !response.body) {
    const text = await response.text();
    if (response.status === 404) {
      throw new Error("SSE route /events is unavailable. Please restart npm run dev:server.");
    }
    throw new Error(`${response.status} ${text}`);
  }
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
      printSseChunk(chunk, jobId);
      index = buffer.indexOf("\n\n");
    }
  }
}

function printSseChunk(chunk: string, jobId?: string): void {
  const dataLine = chunk.split("\n").find(line => line.startsWith("data: "));
  if (!dataLine) return;
  const payload = JSON.parse(dataLine.slice(6));
  if (payload.ok) {
    console.log(`LISTENING ${baseUrl}/events`);
    return;
  }
  if (jobId && payload.jobId !== jobId) return;
  const job = payload.job;
  console.log(`${payload.at} ${payload.jobId} ${job?.status ?? payload.type} ${job?.errorMessage ?? ""}`.trim());
}

function formatDoctor(job: any): string {
  const status = job.status as string;
  const outputs = job.outputFiles?.length ?? 0;
  const lines = [
    `job: ${job.id}`,
    `status: ${status}`,
    `outputs: ${outputs}/${job.expectedImageCount}`,
    `conversationUrl: ${job.conversationUrl ?? ""}`,
    `error: ${job.errorMessage ?? ""}`
  ];

  if (status === "done") {
    lines.unshift("OK");
    lines.push("next: 使用 outputFiles 和 events.jsonl 中的 image_order。");
  } else if (status === "failed_retryable") {
    lines.unshift("RETRYABLE");
    lines.push(`next: npm run job:retry -- ${job.id}`);
  } else if (status === "needs_manual" || status === "failed_final") {
    lines.unshift("NEEDS_MANUAL");
    lines.push(`next: npm run job:open -- ${job.id}`);
  } else if (status === "stalled" || status === "refreshing") {
    lines.unshift("RECOVERING");
    lines.push(`next: npm run job:listen -- ${job.id}`);
  } else {
    lines.unshift("RUNNING");
    lines.push(`next: npm run job:listen -- ${job.id}`);
  }

  return lines.join("\n");
}

function usage(): void {
  console.log(`Usage:
  npm run job:add -- --file examples/job.json
  npm run job:add -- --file examples/job.json --auto-id
  npm run job:add -- --file examples/job.json --replace
  npm run job:list
  npm run job:show -- <jobId>
  npm run job:watch -- <jobId>
  npm run job:listen -- [jobId]
  npm run job:dispatch
  npm run job:doctor -- <jobId>
  npm run job:retry -- <jobId>
  npm run job:open -- <jobId>`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
