// Gemini 视频生成模式的参数（「+」工具菜单里的 Create video + 输入框上的尺寸下拉）。
// 和 doubaoVideo.ts 一样只放纯逻辑，真正的点击在 content.ts 里。
// Gemini 只暴露画面尺寸，没有时长控件，所以这里只处理比例。

// 线上下拉里的写法是「Landscape (16:9)」这种「方向 + 比例」，任务里允许直接写比例，
// 也允许写 landscape / 横屏 这类方向词。
export const GEMINI_VIDEO_RATIOS = ["16:9", "9:16"] as const;

const ORIENTATION_RATIOS: Array<{ pattern: RegExp; ratio: string }> = [
  { pattern: /landscape|横屏|横向|宽屏/i, ratio: "16:9" },
  { pattern: /portrait|竖屏|竖向|纵向/i, ratio: "9:16" },
  { pattern: /square|方形|正方/i, ratio: "1:1" }
];

export function readGeminiVideoRatio(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["geminiVideoRatio", "videoRatio"]) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// 把任务里写的尺寸归一成「宽:高」；识别不出来返回 null，让调用方报错而不是瞎点。
export function resolveGeminiVideoRatio(wanted: string): string | null {
  const token = extractGeminiVideoRatioToken(wanted);
  if (token) return token;
  for (const { pattern, ratio } of ORIENTATION_RATIOS) {
    if (pattern.test(wanted)) return ratio;
  }
  return null;
}

// 从「Landscape (16:9)」这类文案里抠出比例；没有比例数字时退回方向词。
export function extractGeminiVideoRatioToken(text: string): string | null {
  const match = /(\d+)\s*[:：]\s*(\d+)/.exec(text);
  if (match) return `${match[1]}:${match[2]}`;
  for (const { pattern, ratio } of ORIENTATION_RATIOS) {
    if (pattern.test(text)) return ratio;
  }
  return null;
}

export type GeminiVideoRatioMatch = { index: number } | { errorMessage: string };

export function matchGeminiVideoRatioOption(optionTexts: string[], wanted: string): GeminiVideoRatioMatch {
  const target = resolveGeminiVideoRatio(wanted);
  if (!target) {
    return { errorMessage: `无法识别的 Gemini 视频尺寸「${wanted}」，请写成 16:9 / 9:16 或 landscape / portrait。` };
  }

  const index = optionTexts.findIndex((text) => extractGeminiVideoRatioToken(text) === target);
  if (index >= 0) return { index };

  const available = optionTexts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join("、") ||
    "（未读到任何尺寸）";
  return { errorMessage: `Gemini 视频尺寸「${wanted}」未在下拉里找到。可选：${available}` };
}

// 下拉触发按钮上的文字就是当前生效的尺寸，用它做回读断言，
// 和豆包用「16:9 · 4s」断言的做法一致。
export function isGeminiVideoRatioApplied(triggerText: string, wanted: string): boolean {
  const target = resolveGeminiVideoRatio(wanted);
  if (!target) return false;
  return extractGeminiVideoRatioToken(triggerText) === target;
}

// 「+」菜单里的入口是「Create video」（中文界面是「创建视频」/「生成视频」）。
// 正文里也会出现「create a video of…」这类句子，所以只认短标签。
export function isGeminiVideoToolLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 24) return false;
  return /create\s+videos?|make\s+videos?|video\s+generation|生成视频|创建视频|制作视频/i.test(normalized);
}

// 进入视频模式后输入框上方会挂一个「Videos」chip，用它判断模式是否切过去了。
export function isGeminiVideoModeChipLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  return /^(videos?|视频(生成)?)$/i.test(normalized);
}

// 视频模式的输入框占位符是「Describe your video」。
export function isGeminiVideoPlaceholder(text: string): boolean {
  return /describe\s+your\s+video|描述.{0,4}视频/i.test(text);
}

// 视频模式下参考图有自己的入口（尺寸下拉左边那个「图片+」图标按钮），
// 和聊天模式往输入框里贴图不是同一条路。图标按钮通常只有 aria-label，
// 而「+」工具菜单的文案是 upload files and tools 这类，别把两者搞混。
export function isGeminiVideoReferenceButtonLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 40) return false;
  if (/tools|工具/i.test(normalized)) return false;
  return /reference|add\s+(an?\s+)?image|add\s+photo|upload\s+image|image\s*\+|参考图|添加图片|上传图片/i
    .test(normalized);
}

