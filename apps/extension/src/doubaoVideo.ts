// 豆包视频生成模式的参数（actionbar 上的「模型」下拉 + 「比例 · 时长」面板）。
// 这里只放纯逻辑，方便脱离 DOM 做单测；真正的点击在 content.ts 里。
// 模型下拉和图片模式结构完全一致，直接复用 doubaoModel.ts 的匹配逻辑，
// 这个文件只负责视频独有的比例与时长。

export const DOUBAO_VIDEO_MODELS = [
  "Seedance 2.5",
  "Seedance 2.0",
  "Seedance 2.0 Fast",
  "Seedance 2.0 Mini"
] as const;

export const DOUBAO_VIDEO_RATIOS = ["自动", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"] as const;

// 时长是一个 Radix slider，aria-valuemin=0 / aria-valuemax=11，
// 面板两端标着 4s 与 15s，即「秒数 = aria-valuenow + 4」（2026-08 线上实测）。
export const DOUBAO_VIDEO_MIN_DURATION_SECONDS = 4;
export const DOUBAO_VIDEO_MAX_DURATION_SECONDS = 15;

export function readDoubaoVideoRatio(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.doubaoVideoRatio;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readDoubaoVideoDurationSeconds(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.doubaoVideoDuration;
  const seconds = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim().replace(/s$/i, ""))
      : Number.NaN;
  return Number.isFinite(seconds) ? clampDurationSeconds(seconds) : undefined;
}

export function clampDurationSeconds(seconds: number): number {
  const rounded = Math.round(seconds);
  if (rounded < DOUBAO_VIDEO_MIN_DURATION_SECONDS) return DOUBAO_VIDEO_MIN_DURATION_SECONDS;
  if (rounded > DOUBAO_VIDEO_MAX_DURATION_SECONDS) return DOUBAO_VIDEO_MAX_DURATION_SECONDS;
  return rounded;
}

export function doubaoVideoSliderValue(seconds: number): number {
  return clampDurationSeconds(seconds) - DOUBAO_VIDEO_MIN_DURATION_SECONDS;
}

export function doubaoVideoSliderSeconds(sliderValue: number): number {
  return sliderValue + DOUBAO_VIDEO_MIN_DURATION_SECONDS;
}

export type DoubaoVideoRatioMatch = { index: number } | { errorMessage: string };

// 比例按钮上只有一行纯文本（"16:9"），没有 aria/data 状态，所以按文本精确匹配。
export function matchDoubaoVideoRatioOption(optionTexts: string[], wanted: string): DoubaoVideoRatioMatch {
  const names = optionTexts.map(normalizeRatio);
  const index = names.indexOf(normalizeRatio(wanted));
  if (index >= 0) return { index };

  const available = names.filter(Boolean).join("、") || "（未读到任何比例）";
  return { errorMessage: `豆包视频比例「${wanted}」未在面板里找到。可选：${available}` };
}

function normalizeRatio(value: string): string {
  return value.replace(/\s+/g, "").replace(/[：:]/g, ":").trim();
}

// 参数触发按钮的文本就是当前生效的「比例 · 时长」，例如 "16:9 · 4s"，
// 用它来回读断言，和模型下拉用触发按钮文本断言的做法一致。
export function parseDoubaoVideoParamsTrigger(triggerText: string): { ratio: string; seconds: number } | null {
  const normalized = triggerText.replace(/\s+/g, " ").trim();
  const match = /^(.+?)\s*·\s*(\d+)\s*s$/.exec(normalized);
  if (!match) return null;
  return { ratio: match[1]!.trim(), seconds: Number(match[2]) };
}

// 豆包有时会先回一段素材授权声明，并附一个「确认生成 →」按钮，
// 不点它就永远不会真正开始生成视频（2026-08 线上实测）。
// 正文里也会出现「点击确认生成」这类句子，所以只认短标签，避免把整段文字当按钮。
export function isDoubaoVideoConfirmLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, "");
  return normalized.length <= 16 && /确[认定](继续)?生成/.test(normalized);
}

// 输入框左边的「+」是附件入口。聊天模式下 input[type=file] 一直挂在 DOM 上，
// 但切进视频生成模式会重建输入框，这时可能要先点「+」才会出现 input。
// 图标按钮经常没有 aria-label，所以先按 actionbar 的 data-key 认，再退回文案；
// 两条都认不出时由调用方把整条 actionbar trace 出来，别瞎点。
export function isDoubaoAttachControlKey(key: string): boolean {
  return /upload|attach|file/i.test(key);
}

export function isDoubaoAttachButtonLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  // 附件入口是个图标按钮，文案最多是「上传图片」这种短标签；长句是正文，不是按钮。
  if (!normalized || normalized.length > 16) return false;
  // 别把模式 chip 和模型/参数下拉当成附件入口。
  if (/生成|模型|比例|时长/.test(normalized)) return false;
  return normalized === "+" ||
    /上传|附件|添加(图片|文件)|参考图|upload|attach|add\s+(file|image|photo)/i.test(normalized);
}

export function isDoubaoVideoParamsApplied(
  triggerText: string,
  expected: { ratio?: string; seconds?: number }
): boolean {
  const parsed = parseDoubaoVideoParamsTrigger(triggerText);
  if (!parsed) return false;
  if (expected.ratio !== undefined && normalizeRatio(parsed.ratio) !== normalizeRatio(expected.ratio)) return false;
  if (expected.seconds !== undefined && parsed.seconds !== clampDurationSeconds(expected.seconds)) return false;
  return true;
}
