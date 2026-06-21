import { describe, expect, it } from "vitest";
import type { Job } from "@wechat-topic/shared";
import { formatDoctor, formatJobSummary, formatListRow, normalizeCommand } from "../src/cli.js";

const baseJob: Job = {
  id: "job_1",
  mode: "image",
  status: "done",
  prompt: "JOB_ID: job_1\nhello",
  expectedImageCount: 2,
  sourceImages: [],
  metadata: {},
  conversationUrl: "https://chatgpt.com/c/abc",
  tabId: null,
  attempt: 0,
  refreshCount: 0,
  errorMessage: null,
  workerId: null,
  outputFiles: ["/tmp/data/jobs/job_1/outputs/output-01.png", "/tmp/data/jobs/job_1/outputs/output-02.png"],
  textOutputFile: null,
  screenshotFiles: [],
  createdAt: "2026-06-21T00:00:00.000Z",
  updatedAt: "2026-06-21T00:01:00.000Z"
};

describe("CLI formatting", () => {
  it("normalizes old job commands to new auto-chat commands", () => {
    expect(normalizeCommand("job:add")).toBe("add");
    expect(normalizeCommand("job:list")).toBe("list");
    expect(normalizeCommand("job:listen")).toBe("listen");
    expect(normalizeCommand("server")).toBe("start");
    expect(normalizeCommand("server:start")).toBe("start");
    expect(normalizeCommand("server:stop")).toBe("stop");
    expect(normalizeCommand("add")).toBe("add");
  });

  it("formats image and text job rows with readable progress and result", () => {
    expect(formatListRow(baseJob)).toMatchObject({
      id: "job_1",
      mode: "image",
      status: "done",
      progress: "2/2 images",
      result: "outputs/output-01.png, outputs/output-02.png"
    });

    expect(formatListRow({
      ...baseJob,
      id: "text_1",
      mode: "text",
      expectedImageCount: 0,
      outputFiles: ["/tmp/data/jobs/text_1/outputs/output-01.txt"],
      textOutputFile: "/tmp/data/jobs/text_1/outputs/output-01.txt"
    })).toMatchObject({
      id: "text_1",
      mode: "text",
      progress: "text ready",
      result: "outputs/output-01.txt"
    });
  });

  it("formats job summaries and doctor output with next actions", () => {
    expect(formatJobSummary(baseJob)).toContain("任务: job_1");
    expect(formatJobSummary(baseJob)).toContain("结果: outputs/output-01.png, outputs/output-02.png");
    expect(formatDoctor({ ...baseJob, status: "failed_retryable", errorMessage: "rate limited" }))
      .toContain("下一步: auto-chat retry job_1");
  });
});
