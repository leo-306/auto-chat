import { describe, expect, it } from "vitest";
import {
  DOUBAO_VIDEO_MAX_DURATION_SECONDS,
  DOUBAO_VIDEO_MIN_DURATION_SECONDS,
  DOUBAO_VIDEO_RATIOS,
  clampDurationSeconds,
  doubaoVideoSliderSeconds,
  doubaoVideoSliderValue,
  isDoubaoAttachButtonLabel,
  isDoubaoAttachControlKey,
  isDoubaoVideoConfirmLabel,
  isDoubaoVideoParamsApplied,
  matchDoubaoVideoRatioOption,
  parseDoubaoVideoParamsTrigger,
  readDoubaoVideoDurationSeconds,
  readDoubaoVideoRatio
} from "../src/doubaoVideo.js";

describe("readDoubaoVideoRatio", () => {
  it("只接受非空字符串", () => {
    expect(readDoubaoVideoRatio({ doubaoVideoRatio: "16:9" })).toBe("16:9");
    expect(readDoubaoVideoRatio({ doubaoVideoRatio: "  9:16  " })).toBe("9:16");
    expect(readDoubaoVideoRatio({ doubaoVideoRatio: "   " })).toBeUndefined();
    expect(readDoubaoVideoRatio({ doubaoVideoRatio: 169 })).toBeUndefined();
    expect(readDoubaoVideoRatio({})).toBeUndefined();
  });
});

describe("readDoubaoVideoDurationSeconds", () => {
  it("接受数字与带 s 的字符串，并夹在 4~15 秒之间", () => {
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 8 })).toBe(8);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: "10s" })).toBe(10);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: " 12 " })).toBe(12);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 1 })).toBe(DOUBAO_VIDEO_MIN_DURATION_SECONDS);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 99 })).toBe(DOUBAO_VIDEO_MAX_DURATION_SECONDS);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: "abc" })).toBeUndefined();
    expect(readDoubaoVideoDurationSeconds({})).toBeUndefined();
  });
});

describe("滑块与秒数换算", () => {
  it("aria-valuenow 0 对应 4s，11 对应 15s", () => {
    expect(doubaoVideoSliderValue(4)).toBe(0);
    expect(doubaoVideoSliderValue(15)).toBe(11);
    expect(doubaoVideoSliderValue(10)).toBe(6);
    expect(doubaoVideoSliderSeconds(0)).toBe(4);
    expect(doubaoVideoSliderSeconds(11)).toBe(15);
  });

  it("越界秒数先夹再换算", () => {
    expect(doubaoVideoSliderValue(1)).toBe(0);
    expect(doubaoVideoSliderValue(60)).toBe(11);
    expect(clampDurationSeconds(7.4)).toBe(7);
  });
});

describe("matchDoubaoVideoRatioOption", () => {
  const optionTexts = [...DOUBAO_VIDEO_RATIOS];

  it("按文本精确匹配，忽略空白和全角冒号", () => {
    expect(matchDoubaoVideoRatioOption(optionTexts, "16:9")).toEqual({ index: 4 });
    expect(matchDoubaoVideoRatioOption(optionTexts, " 16 : 9 ")).toEqual({ index: 4 });
    expect(matchDoubaoVideoRatioOption(optionTexts, "16：9")).toEqual({ index: 4 });
    expect(matchDoubaoVideoRatioOption(optionTexts, "自动")).toEqual({ index: 0 });
  });

  it("找不到时列出可选项", () => {
    const result = matchDoubaoVideoRatioOption(optionTexts, "5:4");
    expect(result).toHaveProperty("errorMessage");
    expect((result as { errorMessage: string }).errorMessage).toContain("21:9");
  });
});

describe("parseDoubaoVideoParamsTrigger", () => {
  it("解析触发按钮上的「比例 · 时长」回显", () => {
    expect(parseDoubaoVideoParamsTrigger("16:9 · 4s")).toEqual({ ratio: "16:9", seconds: 4 });
    expect(parseDoubaoVideoParamsTrigger("自动 · 10s")).toEqual({ ratio: "自动", seconds: 10 });
    expect(parseDoubaoVideoParamsTrigger("  21:9\n·\n15s ")).toEqual({ ratio: "21:9", seconds: 15 });
    expect(parseDoubaoVideoParamsTrigger("模型 Seedance 2.0 Mini")).toBeNull();
  });
});

describe("isDoubaoVideoConfirmLabel", () => {
  it("认得二次确认按钮的文案，忽略箭头和空白", () => {
    expect(isDoubaoVideoConfirmLabel("确认生成 →")).toBe(true);
    expect(isDoubaoVideoConfirmLabel(" 确认 生成 ")).toBe(true);
    expect(isDoubaoVideoConfirmLabel("确定生成")).toBe(true);
    expect(isDoubaoVideoConfirmLabel("确认继续生成")).toBe(true);
    expect(isDoubaoVideoConfirmLabel("重新生成")).toBe(false);
    expect(isDoubaoVideoConfirmLabel("生成视频")).toBe(false);
    // 正文句子不算按钮。
    expect(isDoubaoVideoConfirmLabel("请你确认拥有素材授权后点击下方的确认生成按钮")).toBe(false);
    expect(isDoubaoVideoConfirmLabel("")).toBe(false);
  });
});

describe("isDoubaoAttachControlKey", () => {
  it("只认 upload/attach/file 这类附件 key，不误伤模型和参数面板", () => {
    expect(isDoubaoAttachControlKey("upload")).toBe(true);
    expect(isDoubaoAttachControlKey("file-upload")).toBe(true);
    expect(isDoubaoAttachControlKey("attachment")).toBe(true);
    expect(isDoubaoAttachControlKey("video-model")).toBe(false);
    expect(isDoubaoAttachControlKey("model")).toBe(false);
    expect(isDoubaoAttachControlKey("video-generation-params-panel")).toBe(false);
    expect(isDoubaoAttachControlKey("")).toBe(false);
  });
});

describe("isDoubaoAttachButtonLabel", () => {
  it("认得「+」和上传类文案", () => {
    expect(isDoubaoAttachButtonLabel("+")).toBe(true);
    expect(isDoubaoAttachButtonLabel(" 上传图片 ")).toBe(true);
    expect(isDoubaoAttachButtonLabel("添加附件")).toBe(true);
    expect(isDoubaoAttachButtonLabel("Upload image")).toBe(true);
  });

  it("不把模式 chip、模型下拉和长句当成附件入口", () => {
    expect(isDoubaoAttachButtonLabel("视频生成")).toBe(false);
    expect(isDoubaoAttachButtonLabel("图像生成")).toBe(false);
    expect(isDoubaoAttachButtonLabel("模型 Seedance 2.0 Mini")).toBe(false);
    expect(isDoubaoAttachButtonLabel("自动 · 10s")).toBe(false);
    expect(isDoubaoAttachButtonLabel("点这里上传一张参考图然后再描述你想要的画面")).toBe(false);
    expect(isDoubaoAttachButtonLabel("")).toBe(false);
  });
});

describe("isDoubaoVideoParamsApplied", () => {
  it("只校验传进来的那几项", () => {
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { ratio: "16:9", seconds: 8 })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { ratio: "16:9" })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { seconds: 8 })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { ratio: "9:16" })).toBe(false);
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { seconds: 9 })).toBe(false);
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", {})).toBe(true);
  });

  it("越界的期望秒数按夹紧后的值比较", () => {
    expect(isDoubaoVideoParamsApplied("16:9 · 15s", { seconds: 99 })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 4s", { seconds: 1 })).toBe(true);
  });

  it("读不出回显时不认为已生效", () => {
    expect(isDoubaoVideoParamsApplied("", { ratio: "16:9" })).toBe(false);
  });
});
