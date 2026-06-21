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
    expect(created.prompt).toContain("JOB_ID: job_1");
    const claimed = store.claimJob({ workerId: "worker", runningJobIds: [] });
    expect(claimed?.id).toBe("job_1");
    expect(claimed?.status).toBe("opening_tab");
    expect(store.claimJob({ workerId: "worker", runningJobIds: [] })).toBeNull();
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
    expect(store.getDispatch()).toEqual({ id: 0, requestedAt: null });

    const requested = store.requestDispatch();
    expect(requested.id).toBe(1);
    expect(requested.requestedAt).toEqual(expect.any(String));
    store.close();

    const restored = new JobStore(tmp);
    await restored.init();
    expect(restored.getDispatch()).toEqual(requested);
    restored.close();
  });
});
