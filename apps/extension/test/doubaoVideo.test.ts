import { describe, expect, it } from "vitest";
import {
  DOUBAO_VIDEO_MAX_DURATION_SECONDS,
  DOUBAO_VIDEO_MIN_DURATION_SECONDS,
  DOUBAO_VIDEO_RATIOS,
  clampDurationSeconds,
  isDoubaoAttachButtonLabel,
  isDoubaoAttachControlKey,
  isDoubaoVideoConfirmLabel,
  isDoubaoVideoParamsApplied,
  matchDoubaoVideoRatioOption,
  maxDurationSecondsForModel,
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

describe("maxDurationSecondsForModel", () => {
  it("Seedance 2.5 到 30s，其他模型按 15s 兜底", () => {
    expect(maxDurationSecondsForModel("Seedance 2.5")).toBe(30);
    expect(maxDurationSecondsForModel("  seedance   2.5 ")).toBe(30);
    expect(maxDurationSecondsForModel("Seedance 2.0")).toBe(15);
    expect(maxDurationSecondsForModel("Seedance 2.0 Fast")).toBe(15);
    expect(maxDurationSecondsForModel("Seedance 2.0 Mini")).toBe(15);
    expect(maxDurationSecondsForModel(undefined)).toBe(15);
  });
});

describe("readDoubaoVideoDurationSeconds", () => {
  it("接受数字与带 s 的字符串，并按模型上限裁剪", () => {
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 8 })).toBe(8);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: "10s" })).toBe(10);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: " 12 " })).toBe(12);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 1 })).toBe(DOUBAO_VIDEO_MIN_DURATION_SECONDS);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: "abc" })).toBeUndefined();
    expect(readDoubaoVideoDurationSeconds({})).toBeUndefined();
  });

  it("没写模型或写了 2.0 家族时超过 15s 会被压到 15s", () => {
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 30 })).toBe(15);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 22, doubaoModel: "Seedance 2.0 Fast" })).toBe(15);
  });

  it("Seedance 2.5 能保留 15s 以上的请求", () => {
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 22, doubaoModel: "Seedance 2.5" })).toBe(22);
    expect(readDoubaoVideoDurationSeconds({ doubaoVideoDuration: 99, doubaoModel: "Seedance 2.5" }))
      .toBe(DOUBAO_VIDEO_MAX_DURATION_SECONDS);
  });
});

describe("clampDurationSeconds", () => {
  it("四舍五入，下限 4s，上限默认到控件极限 30s", () => {
    expect(clampDurationSeconds(7.4)).toBe(7);
    expect(clampDurationSeconds(1)).toBe(DOUBAO_VIDEO_MIN_DURATION_SECONDS);
    expect(clampDurationSeconds(60)).toBe(DOUBAO_VIDEO_MAX_DURATION_SECONDS);
  });

  it("传入模型上限时按它裁剪，且不会超过控件极限", () => {
    expect(clampDurationSeconds(22, 15)).toBe(15);
    expect(clampDurationSeconds(12, 15)).toBe(12);
    expect(clampDurationSeconds(60, 99)).toBe(DOUBAO_VIDEO_MAX_DURATION_SECONDS);
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

  it("期望秒数只四舍五入，不再自己夹紧上限", () => {
    expect(isDoubaoVideoParamsApplied("16:9 · 8s", { seconds: 8.4 })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 22s", { seconds: 22 })).toBe(true);
    expect(isDoubaoVideoParamsApplied("16:9 · 15s", { seconds: 99 })).toBe(false);
  });

  it("读不出回显时不认为已生效", () => {
    expect(isDoubaoVideoParamsApplied("", { ratio: "16:9" })).toBe(false);
  });
});
