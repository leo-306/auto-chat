import { describe, expect, it } from "vitest";
import {
  DOUBAO_IMAGE_MODELS,
  doubaoModelOptionName,
  doubaoModelTriggerName,
  isDoubaoModelSelected,
  matchDoubaoModelOption,
  readDoubaoModel
} from "../src/doubaoModel.js";

const OPTION_TEXTS = [
  "Seedream 5.0 Pro\n升级\n专业出图・4 倍消耗",
  "Seedream 5.0 Lite\n进阶效果・3 倍消耗",
  "Seedream 4.5\n日常生成",
  "Seedream 4.0\n基础生图"
];

describe("readDoubaoModel", () => {
  it("只接受非空字符串", () => {
    expect(readDoubaoModel({ doubaoModel: "Seedream 4.5" })).toBe("Seedream 4.5");
    expect(readDoubaoModel({ doubaoModel: "  Seedream 4.0  " })).toBe("Seedream 4.0");
    expect(readDoubaoModel({ doubaoModel: "   " })).toBeUndefined();
    expect(readDoubaoModel({ doubaoModel: 45 })).toBeUndefined();
    expect(readDoubaoModel({})).toBeUndefined();
  });
});

describe("下拉项与触发按钮文本解析", () => {
  it("取下拉项第一行作为模型名", () => {
    expect(doubaoModelOptionName(OPTION_TEXTS[0])).toBe("Seedream 5.0 Pro");
    expect(doubaoModelOptionName(OPTION_TEXTS[2])).toBe("Seedream 4.5");
    expect(doubaoModelOptionName("")).toBe("");
  });

  it("去掉触发按钮的「模型」前缀", () => {
    expect(doubaoModelTriggerName("模型 Seedream 4.5")).toBe("Seedream 4.5");
    expect(doubaoModelTriggerName("模型\nSeedream 4.0")).toBe("Seedream 4.0");
    expect(doubaoModelTriggerName("")).toBe("");
  });
});

describe("matchDoubaoModelOption", () => {
  it("命中完整名称", () => {
    for (const [index, model] of DOUBAO_IMAGE_MODELS.entries()) {
      expect(matchDoubaoModelOption(OPTION_TEXTS, model)).toEqual({ index });
    }
  });

  it("忽略大小写和多余空白", () => {
    expect(matchDoubaoModelOption(OPTION_TEXTS, "  seedream 5.0 LITE ")).toEqual({ index: 1 });
  });

  it("支持唯一简写", () => {
    expect(matchDoubaoModelOption(OPTION_TEXTS, "4.5")).toEqual({ index: 2 });
    expect(matchDoubaoModelOption(OPTION_TEXTS, "Pro")).toEqual({ index: 0 });
    expect(matchDoubaoModelOption(OPTION_TEXTS, "Lite")).toEqual({ index: 1 });
  });

  it("找不到时给出可选项", () => {
    const result = matchDoubaoModelOption(OPTION_TEXTS, "Seedream 6.0");
    expect(result).toHaveProperty("errorMessage");
    expect((result as { errorMessage: string }).errorMessage).toContain("Seedream 4.5");
  });

  it("简写歧义时拒绝而不是瞎猜", () => {
    const result = matchDoubaoModelOption(["Seedream 4.5\n日常", "Nano 4.5\n其他"], "4.5");
    expect(result).toHaveProperty("errorMessage");
    expect((result as { errorMessage: string }).errorMessage).toContain("匹配到多个");
  });

  it("空下拉也不抛异常", () => {
    expect(matchDoubaoModelOption([], "Seedream 4.5")).toHaveProperty("errorMessage");
  });
});

describe("isDoubaoModelSelected", () => {
  it("按触发按钮回显判断是否已经选中", () => {
    expect(isDoubaoModelSelected("模型 Seedream 4.5", "Seedream 4.5")).toBe(true);
    expect(isDoubaoModelSelected("模型 Seedream 4.5", "4.5")).toBe(true);
    expect(isDoubaoModelSelected("模型 Seedream 4.5", "Seedream 4.0")).toBe(false);
    expect(isDoubaoModelSelected("", "Seedream 4.5")).toBe(false);
  });
});
