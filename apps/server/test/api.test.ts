import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.js";
import { JobStore } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-topic-api-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("job assets API", () => {
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
