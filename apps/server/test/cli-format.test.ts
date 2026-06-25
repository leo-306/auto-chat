import { describe, expect, it } from "vitest";
import { buildGeminiOutputPrompt } from "@wechat-topic/shared";
import type { Job } from "@wechat-topic/shared";
import {
  defaultSkillInstallDirs,
  formatAddResult,
  formatDoctor,
  formatExtensionInstallInstructions,
  formatJobSummary,
  formatListRow,
  formatReloadResult,
  normalizeCommand,
  positionalArgs,
  shouldStopListeningForPayload
} from "../src/cli.js";

const baseJob: Job = {
  id: "job_1",
  platform: "gpt",
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
    expect(normalizeCommand("retry-load")).toBe("reload");
    expect(normalizeCommand("add")).toBe("add");
  });

  it("formats image and text job rows with readable progress and result", () => {
    expect(formatListRow(baseJob)).toMatchObject({
      id: "job_1",
      platform: "gpt",
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

  it("shows text previews in list rows when the text output exists", () => {
    expect(formatListRow({
      ...baseJob,
      id: "text_1",
      mode: "text",
      expectedImageCount: 0,
      outputFiles: ["/tmp/data/jobs/text_1/outputs/output-01.txt"],
      textOutputFile: "/tmp/data/jobs/text_1/outputs/output-01.txt"
    }, () => "太阳系是以太阳为中心的行星系统。")).toMatchObject({
      id: "text_1",
      mode: "text",
      progress: "text ready",
      result: "太阳系是以太阳为中心的行星系统。"
    });
  });

  it("stops listening when the selected job reaches an actionable terminal status", () => {
    expect(shouldStopListeningForPayload({
      jobId: "job_1",
      job: { ...baseJob, status: "done" }
    }, "job_1")).toBe(true);
    expect(shouldStopListeningForPayload({
      jobId: "job_1",
      job: { ...baseJob, status: "failed_retryable" }
    }, "job_1")).toBe(true);
    expect(shouldStopListeningForPayload({
      jobId: "job_2",
      job: { ...baseJob, status: "done" }
    }, "job_1")).toBe(false);
    expect(shouldStopListeningForPayload({
      jobId: "job_1",
      job: { ...baseJob, status: "waiting_generation" }
    }, "job_1")).toBe(false);
  });

  it("uses global agent skill directories for init installs", () => {
    expect(defaultSkillInstallDirs("/Users/alice")).toEqual([
      "/Users/alice/.codex/skills",
      "/Users/alice/.claude/skills",
      "/Users/alice/.agents/skills",
      "/Users/alice/.config/opencode/skills",
      "/Users/alice/.opencode/skills"
    ]);
  });

  it("formats GitHub-based Chrome extension install guidance", () => {
    expect(formatExtensionInstallInstructions(
      "https://github.com/leo-306/auto-chat",
      "https://github.com/leo-306/auto-chat/raw/master/auto-chat-extension.zip",
      "/usr/local/lib/node_modules/auto-chat-cli/auto-chat-extension.zip"
    )).toEqual([
      "Chrome 插件需要手动安装。已打开 chrome://extensions。",
      "插件下载: https://github.com/leo-306/auto-chat/raw/master/auto-chat-extension.zip",
      "本机 zip: /usr/local/lib/node_modules/auto-chat-cli/auto-chat-extension.zip",
      "项目地址: https://github.com/leo-306/auto-chat",
      "安装引导:",
      "1. 使用本机 zip，或从 GitHub 下载 auto-chat-extension.zip。",
      "2. 解压 zip 到一个固定目录，不要直接选择 zip 文件。",
      "3. 在 chrome://extensions 页面启用 Developer mode / 开发者模式。",
      "4. 点击 Load unpacked / 加载已解压的扩展程序，选择解压后的目录。",
      "5. 安装后保持 auto-chat 服务运行，打开插件 popup，确认本地服务已连接。"
    ]);
  });

  it("formats job summaries and doctor output with next actions", () => {
    expect(formatJobSummary(baseJob)).toContain("任务: job_1");
    expect(formatJobSummary({ ...baseJob, platform: "gemini" })).toContain("平台: Gemini");
    expect(formatJobSummary(baseJob)).toContain("结果: outputs/output-01.png, outputs/output-02.png");
    expect(formatDoctor({ ...baseJob, status: "failed_retryable", errorMessage: "rate limited" }))
      .toContain("下一步: auto-chat retry job_1");
  });

  it("formats platform-specific running statuses", () => {
    expect(formatJobSummary({ ...baseJob, platform: "gemini", status: "opening_tab" }))
      .toContain("状态: 打开 Gemini 标签页");
    expect(formatJobSummary({ ...baseJob, platform: "gpt", status: "waiting_chat_ready" }))
      .toContain("状态: 等待 ChatGPT 输入框");
  });

  it("formats add result with platform-specific dispatch command", () => {
    expect(formatAddResult({ ...baseJob, platform: "gemini" })).toContain(
      "下一步: auto-chat dispatch --platform gemini job_1 && auto-chat listen job_1"
    );
    expect(formatAddResult(baseJob)).toContain(
      "下一步: auto-chat dispatch --platform gpt job_1 && auto-chat listen job_1"
    );
  });

  it("formats reload result with the preserved conversation URL", () => {
    expect(formatReloadResult(baseJob)).toContain("已请求重试加载: job_1");
    expect(formatReloadResult(baseJob)).toContain("对话: https://chatgpt.com/c/abc");
    expect(formatReloadResult(baseJob)).toContain(
      "下一步: auto-chat dispatch --platform gpt job_1 && auto-chat listen job_1"
    );
  });

  it("reads positional args without treating option values as job ids", () => {
    expect(positionalArgs(["--platform", "gemini", "img_1", "--json"])).toEqual(["img_1"]);
    expect(positionalArgs(["--file", "examples/job.json", "--platform", "gpt"])).toEqual([]);
    expect(positionalArgs(["examples/job.json", "--platform", "gpt"])).toEqual(["examples/job.json"]);
  });

  it("builds stable Gemini per-image prompts", () => {
    expect(buildGeminiOutputPrompt("JOB_ID: gemini_img_test_001\n生成两张图，人物一致。", 2, ["红色裙子单人街拍。", "蓝色裙子单人咖啡店。"])).toBe(
      "JOB_ID: gemini_img_test_001\n\n蓝色裙子单人咖啡店。\n\n生成这张图片。\n\nJOB_OUTPUT_INDEX: 2"
    );
    expect(buildGeminiOutputPrompt("请生成：\n图1：红色外套，街拍。\n图2：蓝色外套，咖啡店。\n图3：绿色外套，公园。", 3)).toBe(
      "绿色外套，公园。\n\n生成这张图片。\n\nJOB_OUTPUT_INDEX: 3"
    );
  });
});
