import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, isReadableLocalDownload } from "../src/api.js";
import { JobStore } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-chat-api-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("job assets API", () => {
  it("serves the jobs dashboard with job and global configuration sections", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const app = await buildServer(store);

    const response = await app.inject("/");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("当前系统全局配置");
    expect(response.body).toContain("任务指标与配置释义");
    expect(response.body).toContain("autoChatReloadOnly");
    expect(response.body).toContain("标签页");
    expect(response.body).toContain("jobRenderSignatures");
    expect(response.body).toContain("data-job-id");
    expect(response.body).toContain('role="tablist"');
    expect(response.body).toContain('data-tab-panel="config"');
    expect(response.body).toContain('id="legend-dialog"');
    expect(response.body).toContain("指标释义");
    expect(response.body).toContain("data-retry");
    expect(response.body).toContain("data-recheck");
    expect(response.body).toContain("重新检测");
    expect(response.body).toContain("data-copy-id");
    expect(response.body).toContain("已复制任务 ID");
    expect(response.body).toContain('id="filter-id"');
    expect(response.body).toContain('id="filter-status"');
    expect(response.body).toContain('id="filter-platform"');
    expect(response.body).toContain('id="filter-mode"');
    expect(response.body).toContain('id="pagination"');
    expect(response.body).toContain('id="page-size"');
    expect(response.body).toContain('id="page-prev"');
    expect(response.body).toContain('id="page-next"');
    expect(response.body).toContain("data-status-update");
    expect(response.body).toContain("updateJobStatus");
    expect(response.body).toContain("renderPagination");
    await app.close();
    store.close();
  });

  it("updates a job status through the status API", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_status", platform: "gpt", prompt: "hello", sourceImages: [], metadata: {} });
    const app = await buildServer(store);

    const response = await app.inject({
      method: "POST",
      url: "/jobs/job_status/status",
      payload: { status: "needs_manual" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "job_status", status: "needs_manual" });
    expect(fs.readFileSync(path.join(tmp, "data/jobs/job_status/events.jsonl"), "utf8"))
      .toContain('"status":"needs_manual"');
    await app.close();
    store.close();
  });

  it("requeues and dispatches a failed job for manual retriggering", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_retry", platform: "gpt", prompt: "hello", sourceImages: [], metadata: {} });
    store.markManual("job_retry", "manual intervention required");
    const app = await buildServer(store);

    const retryResponse = await app.inject({ method: "POST", url: "/jobs/job_retry/retry" });

    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({ id: "job_retry", status: "queued", attempt: 1 });

    const dispatchResponse = await app.inject({
      method: "POST",
      url: "/dispatch",
      payload: { platform: "gpt", jobId: "job_retry" }
    });

    expect(dispatchResponse.statusCode).toBe(200);
    expect(dispatchResponse.json()).toMatchObject({ platform: "gpt", jobId: "job_retry" });
    await app.close();
    store.close();
  });

  it("rejects a task whose parent job does not exist", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const app = await buildServer(store);

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        id: "orphan",
        parentJobId: "missing_parent",
        prompt: "child",
        sourceImages: [],
        metadata: {}
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "parent_job_not_found",
      parentJobId: "missing_parent",
      message: "父任务不存在: missing_parent"
    });
    expect(store.getJob("orphan")).toBeNull();
    await app.close();
    store.close();
  });

  it("requests a targeted dispatch when rechecking a running job", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_recheck", platform: "gpt", prompt: "hello", sourceImages: [], metadata: {} });
    store.updateStatus("job_recheck", {
      status: "waiting_generation",
      tabId: 123,
      conversationUrl: "https://chatgpt.com/c/recheck",
      workerId: "worker"
    });
    const app = await buildServer(store);

    const response = await app.inject({ method: "POST", url: "/jobs/job_recheck/recheck" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job: { id: "job_recheck", status: "waiting_generation" },
      dispatch: { platform: "gpt", jobId: "job_recheck" }
    });
    expect(fs.readFileSync(path.join(tmp, "data/jobs/job_recheck/events.jsonl"), "utf8"))
      .toContain("job_recheck_requested");
    await app.close();
    store.close();
  });

  it("rejects rechecking jobs that are not running or have no conversation URL", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "queued_recheck", platform: "gpt", prompt: "queued", sourceImages: [], metadata: {} });
    store.createJob({ id: "missing_url_recheck", platform: "gpt", prompt: "running", sourceImages: [], metadata: {} });
    store.updateStatus("missing_url_recheck", { status: "waiting_generation", workerId: "worker" });
    const app = await buildServer(store);

    const queuedResponse = await app.inject({ method: "POST", url: "/jobs/queued_recheck/recheck" });
    const missingUrlResponse = await app.inject({ method: "POST", url: "/jobs/missing_url_recheck/recheck" });

    expect(queuedResponse.statusCode).toBe(409);
    expect(queuedResponse.json()).toMatchObject({ error: "job_not_running", status: "queued" });
    expect(missingUrlResponse.statusCode).toBe(400);
    expect(missingUrlResponse.json()).toMatchObject({ error: "conversation_url_missing" });
    await app.close();
    store.close();
  });

  it("serves text assets as UTF-8", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_text", mode: "text", prompt: "hello", sourceImages: [], metadata: {} });
    store.saveArtifact("job_text", {
      kind: "text_output",
      filename: "output-01.txt",
      contentType: "text/plain; charset=utf-8",
      dataBase64: Buffer.from("文本结果").toString("base64")
    });
    const app = await buildServer(store);

    const response = await app.inject("/job-assets/job_text/outputs/output-01.txt");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("文本结果");
    await app.close();
    store.close();
  });

  it("returns 400 when reloading a job without a recorded conversation URL", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_without_url", prompt: "hello", sourceImages: [], metadata: {} });
    const app = await buildServer(store);

    const response = await app.inject({ method: "POST", url: "/jobs/job_without_url/reload" });

    expect(response.statusCode).toBe(400);
    await app.close();
    store.close();
  });
});

describe("local downloads read endpoint", () => {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const testDownloadPaths: string[] = [];

  afterEach(() => {
    for (const filePath of testDownloadPaths.splice(0)) {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("reads back a downloaded image from the user's Downloads folder and deletes it", async () => {
    fs.mkdirSync(downloadsDir, { recursive: true });
    const filePath = path.join(downloadsDir, `auto-chat-test-${Date.now()}.png`);
    testDownloadPaths.push(filePath);
    fs.writeFileSync(filePath, Buffer.from("fake-png-bytes"));
    const store = new JobStore(tmp);
    await store.init();
    const app = await buildServer(store);

    const response = await app.inject({ method: "POST", url: "/local-downloads/read", payload: { path: filePath } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ contentType: "image/png" });
    expect(Buffer.from(response.json().base64, "base64").toString()).toBe("fake-png-bytes");
    expect(fs.existsSync(filePath)).toBe(false);
    await app.close();
    store.close();
  });

  it("rejects a path outside the Downloads folder", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const app = await buildServer(store);
    const outsidePath = path.join(tmp, "not-a-download.png");
    fs.writeFileSync(outsidePath, Buffer.from("x"));

    const response = await app.inject({ method: "POST", url: "/local-downloads/read", payload: { path: outsidePath } });

    expect(response.statusCode).toBe(400);
    expect(fs.existsSync(outsidePath)).toBe(true);
    await app.close();
    store.close();
  });

  it("rejects a non-image extension even inside the Downloads folder", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const app = await buildServer(store);
    fs.mkdirSync(downloadsDir, { recursive: true });
    const scriptPath = path.join(downloadsDir, `auto-chat-test-${Date.now()}.sh`);

    const response = await app.inject({ method: "POST", url: "/local-downloads/read", payload: { path: scriptPath } });

    expect(response.statusCode).toBe(400);
    await app.close();
    store.close();
  });
});

describe("isReadableLocalDownload", () => {
  it("accepts an image path inside the Downloads folder", () => {
    const target = path.join(os.homedir(), "Downloads", "photo.png");
    expect(isReadableLocalDownload(target)).toBe(true);
  });

  it("rejects path traversal out of the Downloads folder", () => {
    const target = path.join(os.homedir(), "Downloads", "..", "..", "etc", "passwd");
    expect(isReadableLocalDownload(target)).toBe(false);
  });

  it("rejects a non-image extension", () => {
    const target = path.join(os.homedir(), "Downloads", "script.sh");
    expect(isReadableLocalDownload(target)).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isReadableLocalDownload("")).toBe(false);
  });
});
