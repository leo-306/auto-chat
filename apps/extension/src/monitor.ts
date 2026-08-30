import type { Job, JobPlatform } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

export const GPT_IMAGE_RENDER_STALL_MIN_MS = 180_000;
export const GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS = 4_000;
const EXPLICIT_GENERATION_ERROR_PATTERN =
  /Image generation failed|Something went wrong|There was a problem generating|Failed to generate|rate limit|too many requests|try again later|出了点问题|生成失败|请求过多|稍后再试/i;
const GPT_IMAGE_GENERATION_FAILED_PATTERN = /Image generation failed/i;

export type MonitorStallRecovery = {
  errorMessage: string;
  recoveryMode: EmptyAssistantRecoveryMode;
};

// Chat interfaces keep Retry/Redo controls on ordinary completed responses.
// Only match an explicit error sentence when deciding to consume a refresh.
export function hasExplicitGenerationError(text: string): boolean {
  return EXPLICIT_GENERATION_ERROR_PATTERN.test(text);
}

export function shouldRetryGptImageGenerationInPage(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  errorText: string;
  retriedInPage: boolean;
  hasRetryButton: boolean;
}): boolean {
  return input.platform === "gpt" &&
    input.mode === "image" &&
    !input.retriedInPage &&
    input.hasRetryButton &&
    GPT_IMAGE_GENERATION_FAILED_PATTERN.test(input.errorText);
}

export function shouldCompleteImageJob(input: {
  mode: Job["mode"];
  loadedImageCount: number;
  expectedImageCount: number;
}): boolean {
  return input.mode === "image" && input.loadedImageCount >= input.expectedImageCount;
}

export function shouldCompleteVideoJob(input: {
  mode: Job["mode"];
  loadedVideoCount: number;
}): boolean {
  return input.mode === "video" && input.loadedVideoCount >= 1;
}

// 视频生成都是异步的：豆包先回一句「视频生成已提交…大约需要 1-3 分钟」并把 isGenerating
// 置回 false，Gemini 同样先回一段文字再慢慢渲染视频卡片。这段等待期页面签名毫无变化，
// 会被通用停滞超时（默认 5 分钟）误判成卡死，所以视频任务用一个更长的空闲下限，
// 上限仍由 hardTimeoutMs（默认 15 分钟）兜住。
export const VIDEO_WAIT_MIN_MS = 720_000;

// 豆包视频还可能插一步二次确认：助手先回一段授权声明 + 一个「确认生成 →」按钮，
// 点了才真正开始排队生成。点击后按钮通常就消失，这里仍留一个次数上限兜底，
// 避免按钮一直留在页面上时被无限点击。
export const DOUBAO_VIDEO_CONFIRM_MAX_CLICKS = 3;

export function shouldClickDoubaoVideoConfirm(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  hasConfirmButton: boolean;
  loadedVideoCount: number;
  isGenerating: boolean;
  confirmClickCount: number;
}): boolean {
  return input.platform === "doubao" &&
    input.mode === "video" &&
    input.hasConfirmButton &&
    !input.isGenerating &&
    input.loadedVideoCount === 0 &&
    input.confirmClickCount < DOUBAO_VIDEO_CONFIRM_MAX_CLICKS;
}

// 豆包可能在图片没有渲染出来时先结束助手回复。对图片任务来说，
// 已完成的非空回复不能被当作成功，避免一直等待到通用停滞超时。
export function shouldFailCompletedDoubaoImageJob(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  assistantExists: boolean;
  assistantText: string;
  loadedImageCount: number;
  isGenerating: boolean;
}): boolean {
  return input.platform === "doubao" &&
    input.mode === "image" &&
    input.assistantExists &&
    Boolean(input.assistantText.trim()) &&
    input.loadedImageCount === 0 &&
    !input.isGenerating;
}

// 豆包会先把文字回复标成完成（isGenerating 转 false），图片卡片晚一步才渲染。
// 原来这里共用 2 秒的图片稳定期，加一次 5 秒轮询也就 6 秒就判失败，
// 线上实测会把图片确实生成成功的任务误杀，所以单独给一个长得多的等待窗口。
export const DOUBAO_IMAGE_RENDER_GRACE_MS = 120_000;

export function shouldGiveUpOnMissingDoubaoImages(input: {
  completedWithoutImagesAt: number;
  now: number;
}): boolean {
  return input.completedWithoutImagesAt > 0 &&
    input.now - input.completedWithoutImagesAt >= DOUBAO_IMAGE_RENDER_GRACE_MS;
}

// 目标是图片/视频，模型却只回了一段文字并结束回答（没有任何 loading）时，页面签名
// 从此不再变化，继续等只能等到停滞超时（视频任务下限 12 分钟）或硬超时。
// 但「只有文字」本身不能当失败：Gemini 成功那次也是先回一句 22 字的排队提示，
// 视频卡片 11 分钟后才渲染出来。所以只认两类明确说「这单不会有产出」的文案：
//   refusal —— 内容策略/能力上的拒绝，重试同一条 prompt 没意义，交人工改需求；
//   capacity —— 并发/配额上限，过一会儿再跑就行，按可重试失败上报。
export const MEDIA_BLOCK_MAX_TEXT_LENGTH = 240;
export type MediaBlockKind = "refusal" | "capacity";

const MEDIA_CAPACITY_PATTERN = new RegExp(
  [
    // 中文：「已经达到一次可以处理的请求上限」「今日额度已用完」
    "上限|配额|额度(?:已)?(?:用完|不足|耗尽)|超出.{0,6}限制|请求过多",
    // 英文：reached the limit / at capacity / too many requests / out of quota
    "reach(?:ed)?\\s+(?:the\\s+|your\\s+)?(?:limit|maximum)|at\\s+capacity|too\\s+many\\s+(?:requests|videos)|quota|rate\\s+limit"
  ].join("|"),
  "i"
);

const MEDIA_REFUSAL_PATTERN = new RegExp(
  [
    // 中文：「我无法制作这类视频」「抱歉，我不能帮你生成这样的内容」
    "(?:无法|不能|没法|没办法|不便|不支持)(?:为你|帮你|帮您|给你)?(?:制作|生成|创建|做|画|提供|完成|处理|满足)",
    // 中文里也有不带动词的说法：「我做不了这个视频」
    "(?:做不了|办不到|帮不了|实现不了)",
    // 英文：I can't create / I'm unable to generate / I cannot help with that
    "(?:can(?:'|’)?t|cannot|can\\s+not|unable\\s+to|not\\s+able\\s+to)\\s+(?:create|generate|make|produce|help|assist|fulfill|complete|do)\\b"
  ].join("|"),
  "i"
);

export function classifyMediaBlockText(text: string): MediaBlockKind | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  // 这两类话术都很短；长文里出现「无法保证…」之类的句子不算，避免误杀。
  if (!normalized || normalized.length > MEDIA_BLOCK_MAX_TEXT_LENGTH) return null;
  // 「因为已达上限所以无法生成」两个模式都会命中，按可重试的那类处理。
  if (MEDIA_CAPACITY_PATTERN.test(normalized)) return "capacity";
  if (MEDIA_REFUSAL_PATTERN.test(normalized)) return "refusal";
  return null;
}

export function detectMediaBlock(input: {
  mode: Job["mode"];
  assistantExists: boolean;
  assistantText: string;
  isGenerating: boolean;
  loadedImageCount: number;
  loadedVideoCount: number;
}): MediaBlockKind | null {
  // 文本任务里这类回复本身就是答案，只在要产出图片/视频时才当失败。
  if (input.mode === "text") return null;
  if (!input.assistantExists || input.isGenerating) return null;
  if (input.loadedImageCount > 0 || input.loadedVideoCount > 0) return null;
  return classifyMediaBlockText(input.assistantText);
}

// 流式输出的间隙里 isGenerating 可能短暂为 false，稳定几秒再判，
// 相比十几分钟的等待这点成本可以忽略。
export const MEDIA_BLOCK_STABLE_MS = 8_000;

export function shouldGiveUpOnMediaBlock(input: { blockedAt: number; now: number }): boolean {
  return input.blockedAt > 0 && input.now - input.blockedAt >= MEDIA_BLOCK_STABLE_MS;
}

export function shouldStopGptImageGeneration(input: {
  platform: JobPlatform;
  isGenerating: boolean;
  imageJobComplete: boolean;
}): boolean {
  return input.platform === "gpt" && input.isGenerating && input.imageJobComplete;
}

export function selectStuckGptImageStopRecovery(input: {
  platform: JobPlatform;
  imageJobComplete: boolean;
  isGenerating: boolean;
  stopRequestedAt: number;
  now: number;
}): MonitorStallRecovery | null {
  if (
    input.platform !== "gpt" ||
    !input.imageJobComplete ||
    !input.isGenerating ||
    !input.stopRequestedAt ||
    input.now - input.stopRequestedAt < GPT_IMAGE_STOP_CONFIRM_TIMEOUT_MS
  ) {
    return null;
  }

  return {
    errorMessage: "ChatGPT stop control remained loading for 4 seconds after a complete image was found; refreshing the conversation before collecting the image.",
    recoveryMode: "monitor_only"
  };
}

export function shouldResubmitEmptyGptImage(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  sourceImageCount: number;
  assistantExists: boolean;
  assistantText: string;
  loadedImageCount: number;
  isGenerating: boolean;
  composerInteractive: boolean;
  hasOnlyResponseActionMenu: boolean;
}): boolean {
  return input.platform === "gpt" &&
    input.mode === "image" &&
    input.sourceImageCount === 0 &&
    input.assistantExists &&
    !input.assistantText.trim() &&
    input.loadedImageCount === 0 &&
    !input.isGenerating &&
    input.composerInteractive &&
    input.hasOnlyResponseActionMenu;
}

export function selectGptErrorRefresh(input: {
  platform: JobPlatform;
  refreshCount: number;
  maxRefreshPerJob: number;
}): MonitorStallRecovery | null {
  if (input.platform !== "gpt" || input.refreshCount >= input.maxRefreshPerJob) return null;

  return {
    errorMessage: "ChatGPT reported an error; refreshing the submitted conversation before retrying.",
    recoveryMode: "retry_after_refresh"
  };
}

export function selectMonitorStallRecovery(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  isGenerating: boolean;
  idleMs: number;
  stallTimeoutMs: number;
}): MonitorStallRecovery | null {
  if (
    input.platform === "gpt" &&
    input.mode === "image" &&
    input.isGenerating &&
    input.idleMs >= GPT_IMAGE_RENDER_STALL_MIN_MS
  ) {
    return {
      errorMessage: "ChatGPT image generation showed no visible progress for 3 minutes; refreshing the conversation and checking whether the submitted prompt remains.",
      recoveryMode: "resubmit_if_prompt_missing_after_refresh"
    };
  }

  if (!input.isGenerating && input.idleMs > effectiveStallTimeoutMs(input)) {
    return {
      errorMessage: "No visible progress before stall timeout.",
      recoveryMode: "monitor_only"
    };
  }

  return null;
}

function effectiveStallTimeoutMs(input: {
  platform: JobPlatform;
  mode: Job["mode"];
  stallTimeoutMs: number;
}): number {
  if (input.mode === "video") {
    return Math.max(input.stallTimeoutMs, VIDEO_WAIT_MIN_MS);
  }
  return input.stallTimeoutMs;
}
