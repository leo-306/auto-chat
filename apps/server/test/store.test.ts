import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DuplicateJobError, JobStore } from "../src/store.js";

let tmp = "";
let originalCwd = "";

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-topic-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("JobStore", () => {
  it("creates and claims a job once", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const created = store.createJob({ id: "job_1", prompt: "hello", sourceImages: [], metadata: {} });
    expect(created.mode).toBe("image");
    expect(created.platform).toBe("gpt");
    expect(created.prompt).toContain("JOB_ID: job_1");
    const claimed = store.claimJob({ workerId: "worker", runningJobIds: [] });
    expect(claimed?.id).toBe("job_1");
    expect(claimed?.status).toBe("opening_tab");
    expect(store.claimJob({ workerId: "worker", runningJobIds: [] })).toBeNull();
    store.close();
  });

  it("claims only jobs for the requested platform", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_gpt", platform: "gpt", prompt: "gpt", sourceImages: [], metadata: {} });
    store.createJob({ id: "job_gemini", platform: "gemini", prompt: "gemini", sourceImages: [], metadata: {} });

    const geminiClaim = store.claimJob({ workerId: "gemini_worker", platform: "gemini", runningJobIds: [] });
    expect(geminiClaim?.id).toBe("job_gemini");
    expect(geminiClaim?.platform).toBe("gemini");

    const gptClaim = store.claimJob({ workerId: "gpt_worker", platform: "gpt", runningJobIds: [] });
    expect(gptClaim?.id).toBe("job_gpt");
    expect(gptClaim?.platform).toBe("gpt");

    store.close();
  });

  it("stores explicit Gemini image prompts in metadata", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const created = store.createJob({
      id: "job_gemini_prompts",
      platform: "gemini",
      prompt: "生成两张图，人物一致。",
      prompts: ["红色裙子单人街拍。", "蓝色裙子单人咖啡店。"],
      expectedImageCount: 2,
      sourceImages: [],
      metadata: {}
    });

    expect(created.metadata.geminiPrompts).toEqual(["红色裙子单人街拍。", "蓝色裙子单人咖啡店。"]);

    store.close();
  });

  it("creates text jobs with text output defaults", async () => {
    const store = new JobStore(tmp);
    await store.init();
    const created = store.createJob({ id: "job_text", mode: "text", prompt: "hello", sourceImages: [], metadata: {} });

    expect(created.mode).toBe("text");
    expect(created.expectedImageCount).toBe(0);
    expect(created.textOutputFile).toBeNull();

    store.close();
  });

  it("creates Gemini text jobs with optional source images", async () => {
    const source = path.join(tmp, "gemini-input.png");
    fs.writeFileSync(source, "fake-image");
    const store = new JobStore(tmp);
    await store.init();
    const created = store.createJob({
      id: "job_gemini_text",
      platform: "gemini",
      mode: "text",
      prompt: "describe this image",
      sourceImages: [source],
      metadata: {}
    });

    expect(created.platform).toBe("gemini");
    expect(created.mode).toBe("text");
    expect(created.expectedImageCount).toBe(0);
    expect(created.sourceImages[0]).toBe("http://127.0.0.1:17321/job-assets/job_gemini_text/source/source-1.png");

    store.close();
  });

  it("saves text output artifacts", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_text_output", mode: "text", prompt: "hello", sourceImages: [], metadata: {} });

    const result = store.saveArtifact("job_text_output", {
      kind: "text_output",
      filename: "output-01.txt",
      contentType: "text/plain; charset=utf-8",
      dataBase64: Buffer.from("文本结果").toString("base64")
    });

    expect(fs.readFileSync(result.path, "utf8")).toBe("文本结果");
    expect(result.job.outputFiles).toEqual([result.path]);
    expect(result.job.textOutputFile).toBe(result.path);
    store.close();
  });

  it("saves output artifacts", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_2", prompt: "hello", sourceImages: [], metadata: {} });
    const result = store.saveArtifact("job_2", {
      kind: "output",
      filename: "out.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("ok").toString("base64")
    });
    expect(fs.readFileSync(result.path, "utf8")).toBe("ok");
    expect(result.job.outputFiles).toHaveLength(1);
    store.close();
  });

  it("copies local source images into job assets", async () => {
    const source = path.join(tmp, "input.png");
    fs.writeFileSync(source, "fake-image");
    const store = new JobStore(tmp);
    await store.init();
    const created = store.createJob({ id: "job_3", prompt: "hello", sourceImages: [source], metadata: {} });
    expect(created.sourceImages[0]).toBe("http://127.0.0.1:17321/job-assets/job_3/source/source-1.png");
    expect(fs.readFileSync(path.join(tmp, "data/jobs/job_3/source/source-1.png"), "utf8")).toBe("fake-image");
    expect(store.resolveAssetPath("job_3", "source", "source-1.png")).toBe(path.join(tmp, "data/jobs/job_3/source/source-1.png"));
    expect(store.resolveAssetPath("job_3", "source", "../meta.json")).toBeNull();
    store.close();
  });

  it("rejects duplicate job ids and supports replace", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_4", prompt: "first", sourceImages: [], metadata: {} });
    expect(() => store.createJob({ id: "job_4", prompt: "second", sourceImages: [], metadata: {} }))
      .toThrow(DuplicateJobError);

    const replaced = store.replaceJob({ id: "job_4", prompt: "second", sourceImages: [], metadata: {} });
    expect(replaced.prompt).toContain("second");
    expect(store.listJobs()).toHaveLength(1);
    store.close();
  });

  it("deletes jobs and their files", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "job_delete", prompt: "hello", sourceImages: [], metadata: {} });
    const jobDir = path.join(tmp, "data/jobs/job_delete");
    expect(fs.existsSync(jobDir)).toBe(true);

    store.deleteJob("job_delete");

    expect(store.getJob("job_delete")).toBeNull();
    expect(fs.existsSync(jobDir)).toBe(false);
    store.close();
  });

  it("persists dispatch requests", async () => {
    const store = new JobStore(tmp);
    await store.init();
    expect(store.getDispatch()).toEqual({ id: 0, requestedAt: null, platform: null, jobId: null });

    const requested = store.requestDispatch();
    expect(requested.id).toBe(1);
    expect(requested.requestedAt).toEqual(expect.any(String));
    expect(requested.platform).toBeNull();
    expect(requested.jobId).toBeNull();
    const geminiRequested = store.requestDispatch("gemini", "job_gemini");
    expect(geminiRequested.id).toBe(2);
    expect(geminiRequested.platform).toBe("gemini");
    expect(geminiRequested.jobId).toBe("job_gemini");
    store.close();

    const restored = new JobStore(tmp);
    await restored.init();
    expect(restored.getDispatch()).toEqual(geminiRequested);
    restored.close();
  });

  it("claims the requested queued job when a job id is provided", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "old_job", platform: "gemini", prompt: "old", sourceImages: [], metadata: {} });
    store.createJob({ id: "target_job", platform: "gemini", prompt: "target", sourceImages: [], metadata: {} });

    const claimed = store.claimJob({
      workerId: "worker",
      platform: "gemini",
      jobId: "target_job",
      runningJobIds: []
    });

    expect(claimed?.id).toBe("target_job");
    expect(store.getJob("old_job")?.status).toBe("queued");
    store.close();
  });

  it("reloads a job through the recorded conversation URL without clearing it", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "reload_job", prompt: "hello", sourceImages: [], metadata: {} });
    store.updateStatus("reload_job", {
      status: "failed_retryable",
      tabId: 123,
      conversationUrl: "https://chatgpt.com/c/reload-job",
      workerId: "worker",
      errorMessage: "temporary failure",
      refreshCount: 2
    });

    const reloaded = store.reloadJob("reload_job");

    expect(reloaded.status).toBe("queued");
    expect(reloaded.conversationUrl).toBe("https://chatgpt.com/c/reload-job");
    expect(reloaded.tabId).toBeNull();
    expect(reloaded.workerId).toBeNull();
    expect(reloaded.errorMessage).toBeNull();
    expect(reloaded.refreshCount).toBe(0);
    expect(reloaded.attempt).toBe(1);
    store.close();
  });

  it("rejects reload when no conversation URL was recorded", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "new_job", prompt: "hello", sourceImages: [], metadata: {} });

    expect(() => store.reloadJob("new_job")).toThrow("no recorded conversation URL");
    store.close();
  });
});
