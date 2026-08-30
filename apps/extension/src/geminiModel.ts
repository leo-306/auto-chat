// Gemini 输入框右边那个模型下拉（"Flash" / "Pro" / "Flash-Lite"）。
// 下拉项的文案是「标题 + 一句说明」拼在一起的（例如 "3.7 Flash All-around help New"），
// 而触发按钮上只留一个短名（"Flash"），所以匹配和回读都按「系列 + 可选版本号」来做，
// 不做整串相等比较。

// 顺序有讲究：flash-lite 必须排在 flash 前面，否则 "3.5 Flash-Lite" 会被当成 flash。
const MODEL_FAMILIES: Array<{ family: string; pattern: RegExp }> = [
  { family: "flash-lite", pattern: /flash[\s-]*lite/i },
  { family: "thinking", pattern: /extended\s*thinking|thinking|思考/i },
  { family: "pro", pattern: /\bpro\b/i },
  { family: "flash", pattern: /\bflash\b/i }
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function detectGeminiModelFamily(text: string): string | null {
  return MODEL_FAMILIES.find(entry => entry.pattern.test(text))?.family ?? null;
}

export function detectGeminiModelVersion(text: string): string | null {
  return /(\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
}

export function readGeminiModel(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["geminiModel", "model"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// 只有短文案 + 能认出系列的按钮才算模型下拉，避免把「Videos」chip
// 或者尺寸下拉（"Landscape (16:9)"）当成它。
export function isGeminiModelTriggerLabel(label: string): boolean {
  const text = normalize(label);
  if (!text || text.length > 40) return false;
  if (/\d+\s*[:：]\s*\d+/.test(text)) return false;
  return detectGeminiModelFamily(text) !== null;
}

export type GeminiModelMatch = { index: number } | { errorMessage: string };

export function matchGeminiModelOption(optionTexts: string[], wanted: string): GeminiModelMatch {
  const want = normalize(wanted);
  const wantFamily = detectGeminiModelFamily(want);
  const wantVersion = detectGeminiModelVersion(want);

  const scored = optionTexts.map((text, index) => ({ index, text: normalize(text) }));
  const byFamily = wantFamily
    ? scored.filter(option => detectGeminiModelFamily(option.text) === wantFamily)
    : scored;
  const byVersion = wantVersion
    ? byFamily.filter(option => detectGeminiModelVersion(option.text) === wantVersion)
    : byFamily;

  const hit = (wantFamily || wantVersion ? byVersion : [])[0]
    ?? scored.find(option => option.text.toLowerCase().includes(want.toLowerCase()));
  if (hit) return { index: hit.index };

  const readable = optionTexts.map(text => normalize(text)).filter(Boolean).join("、");
  return {
    errorMessage: `Gemini 模型「${wanted}」不在下拉里。读到的选项：${readable || "（未读到）"}`
  };
}

// 触发按钮上通常只有系列名，没有版本号；有版本号时才顺带校验版本。
export function isGeminiModelApplied(triggerText: string, wanted: string): boolean {
  const want = normalize(wanted);
  const wantFamily = detectGeminiModelFamily(want);
  const trigger = normalize(triggerText);
  if (!trigger) return false;
  if (wantFamily && detectGeminiModelFamily(trigger) !== wantFamily) return false;
  if (!wantFamily && !trigger.toLowerCase().includes(want.toLowerCase())) return false;
  const wantVersion = detectGeminiModelVersion(want);
  const triggerVersion = detectGeminiModelVersion(trigger);
  if (wantVersion && triggerVersion && wantVersion !== triggerVersion) return false;
  return true;
}
