// 豆包图片生成模式的模型选择器（actionbar 上的「模型」下拉）。
// 这里只放纯逻辑，方便脱离 DOM 做单测；真正的点击在 content.ts 里。

export const DOUBAO_IMAGE_MODELS = [
  "Seedream 5.0 Pro",
  "Seedream 5.0 Lite",
  "Seedream 4.5",
  "Seedream 4.0"
] as const;

export function readDoubaoModel(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.doubaoModel;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// 下拉项的文本是「模型名 + 角标 + 描述」多行结构，例如：
// "Seedream 5.0 Pro\n升级\n专业出图・4 倍消耗"，第一行才是模型名。
export function doubaoModelOptionName(optionText: string): string {
  return optionText.split("\n")[0]?.trim() ?? "";
}

// 触发按钮的文本是「模型 Seedream 4.5」，去掉前缀后是当前选中的模型名。
export function doubaoModelTriggerName(triggerText: string): string {
  return triggerText.replace(/\s+/g, " ").trim().replace(/^模型\s*/, "");
}

function matches(optionName: string, wanted: string): boolean {
  const option = normalize(optionName);
  const target = normalize(wanted);
  if (!option || !target) return false;
  // 允许简写：「4.5」「pro」都能命中，但要求全局唯一，否则由调用方报错。
  return option === target || option.endsWith(` ${target}`) || option.endsWith(target);
}

export function isDoubaoModelSelected(triggerText: string, wanted: string): boolean {
  return matches(doubaoModelTriggerName(triggerText), wanted);
}

export type DoubaoModelMatch = { index: number } | { errorMessage: string };

export function matchDoubaoModelOption(optionTexts: string[], wanted: string): DoubaoModelMatch {
  const names = optionTexts.map(doubaoModelOptionName);
  const hits = names.map((name, index) => ({ name, index })).filter(item => matches(item.name, wanted));

  if (hits.length === 1) return { index: hits[0].index };

  const available = names.filter(Boolean).join("、") || "（未读到任何选项）";
  if (hits.length === 0) {
    return { errorMessage: `豆包模型「${wanted}」未在下拉里找到。可选：${available}` };
  }
  return {
    errorMessage: `豆包模型「${wanted}」匹配到多个选项：${hits.map(item => item.name).join("、")}，请写完整名称。`
  };
}
