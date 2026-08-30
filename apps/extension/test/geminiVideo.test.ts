import { describe, expect, it } from "vitest";
import {
  extractGeminiVideoRatioToken,
  isGeminiVideoModeChipLabel,
  isGeminiVideoPlaceholder,
  isGeminiVideoRatioApplied,
  isGeminiVideoToolLabel,
  matchGeminiVideoRatioOption,
  readGeminiVideoRatio,
  resolveGeminiVideoRatio
} from "../src/geminiVideo.js";

describe("readGeminiVideoRatio", () => {
  it("读 geminiVideoRatio，兼容通用的 videoRatio", () => {
    expect(readGeminiVideoRatio({ geminiVideoRatio: "16:9" })).toBe("16:9");
    expect(readGeminiVideoRatio({ videoRatio: " 9:16 " })).toBe("9:16");
    expect(readGeminiVideoRatio({ geminiVideoRatio: "  ", videoRatio: "16:9" })).toBe("16:9");
    expect(readGeminiVideoRatio({ geminiVideoRatio: 169 })).toBeUndefined();
    expect(readGeminiVideoRatio({})).toBeUndefined();
  });
});

describe("resolveGeminiVideoRatio", () => {
  it("接受比例写法与方向词", () => {
    expect(resolveGeminiVideoRatio("16:9")).toBe("16:9");
    expect(resolveGeminiVideoRatio("9 ： 16")).toBe("9:16");
    expect(resolveGeminiVideoRatio("landscape")).toBe("16:9");
    expect(resolveGeminiVideoRatio("竖屏")).toBe("9:16");
    expect(resolveGeminiVideoRatio("Landscape (16:9)")).toBe("16:9");
    expect(resolveGeminiVideoRatio("超宽")).toBeNull();
  });
});

describe("extractGeminiVideoRatioToken", () => {
  it("从下拉文案里抠比例", () => {
    expect(extractGeminiVideoRatioToken("Landscape (16:9)")).toBe("16:9");
    expect(extractGeminiVideoRatioToken("Portrait (9:16)")).toBe("9:16");
    expect(extractGeminiVideoRatioToken("Portrait")).toBe("9:16");
    expect(extractGeminiVideoRatioToken("Videos")).toBeNull();
  });
});

describe("matchGeminiVideoRatioOption", () => {
  it("按比例匹配下拉项", () => {
    const options = ["Landscape (16:9)", "Portrait (9:16)"];
    expect(matchGeminiVideoRatioOption(options, "16:9")).toEqual({ index: 0 });
    expect(matchGeminiVideoRatioOption(options, "portrait")).toEqual({ index: 1 });
  });

  it("识别不了的写法直接报错", () => {
    const match = matchGeminiVideoRatioOption(["Landscape (16:9)"], "很宽");
    expect(match).toHaveProperty("errorMessage");
    expect((match as { errorMessage: string }).errorMessage).toContain("无法识别");
  });

  it("找不到时把实际读到的选项列出来", () => {
    const match = matchGeminiVideoRatioOption(["Landscape (16:9)", "Portrait (9:16)"], "1:1");
    expect(match).toHaveProperty("errorMessage");
    expect((match as { errorMessage: string }).errorMessage).toContain("Landscape (16:9)、Portrait (9:16)");
  });
});

describe("isGeminiVideoRatioApplied", () => {
  it("用触发按钮文案回读断言", () => {
    expect(isGeminiVideoRatioApplied("Landscape (16:9)", "16:9")).toBe(true);
    expect(isGeminiVideoRatioApplied("Landscape (16:9)", "landscape")).toBe(true);
    expect(isGeminiVideoRatioApplied("Landscape (16:9)", "9:16")).toBe(false);
    expect(isGeminiVideoRatioApplied("Landscape (16:9)", "很宽")).toBe(false);
  });
});

describe("isGeminiVideoToolLabel", () => {
  it("只认菜单里的短标签", () => {
    expect(isGeminiVideoToolLabel("Create video")).toBe(true);
    expect(isGeminiVideoToolLabel("创建视频")).toBe(true);
    expect(isGeminiVideoToolLabel("生成视频")).toBe(true);
    expect(isGeminiVideoToolLabel("Create image")).toBe(false);
    expect(isGeminiVideoToolLabel("Create a video of a cat surfing in Hawaii")).toBe(false);
  });
});

describe("isGeminiVideoModeChipLabel", () => {
  it("认输入框上的 Videos chip", () => {
    expect(isGeminiVideoModeChipLabel("Videos")).toBe(true);
    expect(isGeminiVideoModeChipLabel(" video ")).toBe(true);
    expect(isGeminiVideoModeChipLabel("视频")).toBe(true);
    expect(isGeminiVideoModeChipLabel("Images")).toBe(false);
    expect(isGeminiVideoModeChipLabel("Deep Research")).toBe(false);
  });
});

describe("isGeminiVideoPlaceholder", () => {
  it("认视频模式的占位符", () => {
    expect(isGeminiVideoPlaceholder("Describe your video")).toBe(true);
    expect(isGeminiVideoPlaceholder("描述你想要的视频")).toBe(true);
    expect(isGeminiVideoPlaceholder("Ask Gemini")).toBe(false);
  });
});
