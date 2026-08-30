import { describe, expect, it } from "vitest";
import {
  isGeminiModelApplied,
  isGeminiModelTriggerLabel,
  matchGeminiModelOption,
  readGeminiModel
} from "../src/geminiModel.js";

const MENU = [
  "3.5 Flash-Lite Fastest answers",
  "3.7 Flash All-around help New",
  "3.1 Pro Advanced reasoning",
  "Extended thinking Complex problem solving"
];

describe("readGeminiModel", () => {
  it("认 geminiModel，其次认 model", () => {
    expect(readGeminiModel({ geminiModel: "3.1 Pro" })).toBe("3.1 Pro");
    expect(readGeminiModel({ model: "3.7 Flash" })).toBe("3.7 Flash");
    expect(readGeminiModel({ geminiModel: "  " , model: "3.1 Pro" })).toBe("3.1 Pro");
    expect(readGeminiModel({})).toBeUndefined();
  });
});

describe("matchGeminiModelOption", () => {
  it("带版本号时精确命中那一项", () => {
    expect(matchGeminiModelOption(MENU, "3.1 Pro")).toEqual({ index: 2 });
    expect(matchGeminiModelOption(MENU, "3.7 Flash")).toEqual({ index: 1 });
  });

  it("只写系列名也能命中", () => {
    expect(matchGeminiModelOption(MENU, "Pro")).toEqual({ index: 2 });
    expect(matchGeminiModelOption(MENU, "Flash")).toEqual({ index: 1 });
  });

  it("Flash-Lite 不会被当成 Flash", () => {
    expect(matchGeminiModelOption(MENU, "Flash-Lite")).toEqual({ index: 0 });
    expect(matchGeminiModelOption(MENU, "3.5 flash lite")).toEqual({ index: 0 });
  });

  it("Extended thinking 走文案匹配", () => {
    expect(matchGeminiModelOption(MENU, "Extended thinking")).toEqual({ index: 3 });
  });

  it("找不到时把实际读到的选项写进报错", () => {
    const result = matchGeminiModelOption(MENU, "4.0 Ultra");
    expect(result).toHaveProperty("errorMessage");
    if ("errorMessage" in result) {
      expect(result.errorMessage).toContain("3.1 Pro");
      expect(result.errorMessage).toContain("4.0 Ultra");
    }
  });

  it("下拉是空的时候也给出可读报错", () => {
    const result = matchGeminiModelOption([], "3.1 Pro");
    expect(result).toEqual({ errorMessage: expect.stringContaining("未读到") });
  });
});

describe("isGeminiModelApplied", () => {
  it("触发按钮只剩系列名时也算生效", () => {
    expect(isGeminiModelApplied("Pro", "3.1 Pro")).toBe(true);
    expect(isGeminiModelApplied("Flash", "3.7 Flash")).toBe(true);
  });

  it("系列不一致就算没生效", () => {
    expect(isGeminiModelApplied("Flash", "3.1 Pro")).toBe(false);
    expect(isGeminiModelApplied("Flash", "Flash-Lite")).toBe(false);
    expect(isGeminiModelApplied("", "3.1 Pro")).toBe(false);
  });

  it("两边都有版本号时版本也要对上", () => {
    expect(isGeminiModelApplied("3.5 Flash", "3.7 Flash")).toBe(false);
    expect(isGeminiModelApplied("3.7 Flash", "3.7 Flash")).toBe(true);
  });
});

describe("isGeminiModelTriggerLabel", () => {
  it("认模型下拉，不认尺寸下拉和 Videos chip", () => {
    expect(isGeminiModelTriggerLabel("Flash")).toBe(true);
    expect(isGeminiModelTriggerLabel("Pro")).toBe(true);
    expect(isGeminiModelTriggerLabel("Landscape (16:9)")).toBe(false);
    expect(isGeminiModelTriggerLabel("Videos")).toBe(false);
    expect(isGeminiModelTriggerLabel("")).toBe(false);
  });
});
