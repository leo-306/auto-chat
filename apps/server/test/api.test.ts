import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.js";
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
