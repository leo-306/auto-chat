import { z } from "zod";

export const JOB_STATUSES = [
  "queued",
  "opening_tab",
  "waiting_chat_ready",
  "uploading",
  "waiting_upload_ready",
  "sending_prompt",
  "waiting_generation",
  "stalled",
  "refreshing",
  "collecting_outputs",
  "downloading",
  "done",
  "failed_retryable",
  "failed_final",
  "needs_manual"
] as const;

export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobModeSchema = z.enum(["image", "text"]);
export type JobMode = z.infer<typeof JobModeSchema>;

export const JobPlatformSchema = z.enum(["gpt", "gemini"]);
export type JobPlatform = z.infer<typeof JobPlatformSchema>;

export const ConfigSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  stallTimeoutMs: z.number().int().min(30_000).default(300_000),
  hardTimeoutMs: z.number().int().min(60_000).default(900_000),
  maxRefreshPerJob: z.number().int().min(0).max(10).default(2),
  expectedImageCount: z.number().int().min(1).max(12).default(4),
  chatgptUrl: z.string().url().default("https://chatgpt.com/"),
  geminiUrl: z.string().url().default("https://gemini.google.com/app"),
  webhookUrls: z.array(z.string().url()).default([]),
  autoRetry: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).optional()
}).superRefine((value, ctx) => {
  if (value.autoRetry && value.maxRetries === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxRetries"],
      message: "maxRetries is required when autoRetry is enabled."
    });
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  maxConcurrency: 1,
  stallTimeoutMs: 300_000,
  hardTimeoutMs: 900_000,
  maxRefreshPerJob: 2,
  expectedImageCount: 4,
  chatgptUrl: "https://chatgpt.com/",
  geminiUrl: "https://gemini.google.com/app",
  webhookUrls: [],
  autoRetry: false
};

export const CreateJobSchema = z.object({
  id: z.string().min(1).optional(),
  platform: JobPlatformSchema.default("gpt"),
  mode: JobModeSchema.default("image"),
  prompt: z.string().min(1),
  prompts: z.array(z.string().min(1)).optional(),
  expectedImageCount: z.number().int().min(0).max(12).optional(),
  sourceImages: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  persistTab: z.boolean().default(false),
  parentJobId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if ((value.mode ?? "image") === "image" && value.expectedImageCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedImageCount"],
      message: "Image jobs must expect at least one image."
    });
  }
});

export type CreateJobRequest = z.input<typeof CreateJobSchema>;

export const UpdateStatusSchema = z.object({
  status: JobStatusSchema,
  tabId: z.number().int().optional(),
  conversationUrl: z.string().url().optional(),
  errorMessage: z.string().optional(),
  refreshCount: z.number().int().min(0).optional(),
  workerId: z.string().optional()
});

export type UpdateStatusRequest = z.infer<typeof UpdateStatusSchema>;

export const EventSchema = z.object({
  type: z.string().min(1),
  message: z.string().optional(),
  payload: z.record(z.unknown()).default({})
});

export type JobEvent = z.infer<typeof EventSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["output", "text_output", "source", "screenshot", "log"]),
  filename: z.string().min(1),
  contentType: z.string().min(1).default("application/octet-stream"),
  dataBase64: z.string().min(1)
});

export type ArtifactRequest = z.infer<typeof ArtifactSchema>;

export const JobSchema = z.object({
  id: z.string(),
  platform: JobPlatformSchema,
  mode: JobModeSchema,
  status: JobStatusSchema,
  prompt: z.string(),
  expectedImageCount: z.number().int().min(0),
  sourceImages: z.array(z.string()),
  metadata: z.record(z.unknown()),
  conversationUrl: z.string().nullable(),
  tabId: z.number().nullable(),
  attempt: z.number().int(),
  refreshCount: z.number().int(),
  errorMessage: z.string().nullable(),
  workerId: z.string().nullable(),
  outputFiles: z.array(z.string()),
  textOutputFile: z.string().nullable(),
  screenshotFiles: z.array(z.string()),
  persistTab: z.boolean(),
  parentJobId: z.string().nullable(),
  outputDir: z.string().nullable(),
  copiedOutputFiles: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type Job = z.infer<typeof JobSchema>;

export const ClaimJobSchema = z.object({
  workerId: z.string().min(1),
  platform: JobPlatformSchema.default("gpt"),
  jobId: z.string().min(1).optional(),
  runningJobIds: z.array(z.string()).default([])
});

export type ClaimJobRequest = z.input<typeof ClaimJobSchema>;

export const DispatchStateSchema = z.object({
  id: z.number().int().min(0),
  platform: JobPlatformSchema.nullable().default(null),
  jobId: z.string().nullable().default(null),
  requestedAt: z.string().nullable()
});

export type DispatchState = z.infer<typeof DispatchStateSchema>;

export function buildGeminiOutputPrompt(prompt: string, outputIndex: number, prompts?: string[]): string {
  const explicitPrompt = prompts?.[outputIndex - 1]?.trim();
  const imagePrompt = explicitPrompt || extractImagePrompt(prompt, outputIndex);
  const globalConstraints = extractGeminiGlobalConstraints(prompt);
  const jobId = extractJobId(prompt);
  return [
    jobId && !imagePrompt.includes(`JOB_ID: ${jobId}`) ? `JOB_ID: ${jobId}` : "",
    imagePrompt,
    globalConstraints,
    "生成这张图片。",
    imagePrompt.includes("JOB_OUTPUT_INDEX:") ? "" : `JOB_OUTPUT_INDEX: ${outputIndex}`
  ].filter(Boolean).join("\n\n");
}

function extractJobId(prompt: string): string | null {
  return prompt.match(/JOB_ID:\s*([^\s]+)/)?.[1] ?? null;
}

function extractImagePrompt(prompt: string, outputIndex: number): string {
  const normalized = prompt.trim();
  const marker = new RegExp(`图\\s*${outputIndex}\\s*[：:=]?`, "u");
  const markerMatch = marker.exec(normalized);
  if (!markerMatch) return normalized;

  const start = markerMatch.index + markerMatch[0].length;
  const nextMarker = new RegExp(`图\\s*${outputIndex + 1}\\s*[：:=]?`, "u").exec(normalized.slice(start));
  const end = nextMarker ? start + nextMarker.index : normalized.length;
  const raw = normalized.slice(start, end);
  return cleanupGeminiImagePrompt(raw);
}

function cleanupGeminiImagePrompt(value: string): string {
  return value
    .replace(/^[\s,，。；;、]+/u, "")
    .replace(/[\s,，；;、]+$/u, "")
    .trim();
}

function extractGeminiGlobalConstraints(prompt: string): string {
  return prompt
    .split(/(?<=[。！？!?])\s*/u)
    .map(sentence => sentence.trim())
    .filter(sentence =>
      /^每张图/u.test(sentence) ||
      /^所有图片/u.test(sentence) ||
      /^人物一致/u.test(sentence) ||
      /^保持/u.test(sentence)
    )
    .filter(sentence => !/图\s*\d/u.test(sentence))
    .join("\n");
}

export type ConversationTurnRole = "user" | "assistant" | "other";

export interface ConversationTurnCandidate {
  role: ConversationTurnRole;
  text: string;
}

export interface JobConversationScope {
  userIndex: number;
  assistantIndex: number | null;
  nextUserIndex: number | null;
}

export function findLatestJobConversationScope(turns: ConversationTurnCandidate[], jobId: string): JobConversationScope | null {
  for (let userIndex = turns.length - 1; userIndex >= 0; userIndex -= 1) {
    const user = turns[userIndex];
    if (user?.role !== "user" || !user.text.includes(`JOB_ID: ${jobId}`)) continue;

    let assistantIndex: number | null = null;
    let nextUserIndex: number | null = null;
    for (let index = userIndex + 1; index < turns.length; index += 1) {
      const role = turns[index]?.role;
      if (role === "user") {
        nextUserIndex = index;
        break;
      }
      if (role === "assistant" && assistantIndex === null) {
        assistantIndex = index;
      }
    }

    return { userIndex, assistantIndex, nextUserIndex };
  }

  return null;
}
