import { z } from "zod";

export const JOB_STATUSES = [
  "queued",
  "opening_tab",
  "waiting_chat_ready",
  "uploading",
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

export const ConfigSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  stallTimeoutMs: z.number().int().min(30_000).default(120_000),
  hardTimeoutMs: z.number().int().min(60_000).default(900_000),
  maxRefreshPerJob: z.number().int().min(0).max(10).default(2),
  expectedImageCount: z.number().int().min(1).max(12).default(4),
  chatgptUrl: z.string().url().default("https://chatgpt.com/"),
  webhookUrls: z.array(z.string().url()).default([])
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  maxConcurrency: 1,
  stallTimeoutMs: 120_000,
  hardTimeoutMs: 900_000,
  maxRefreshPerJob: 2,
  expectedImageCount: 4,
  chatgptUrl: "https://chatgpt.com/",
  webhookUrls: []
};

export const CreateJobSchema = z.object({
  id: z.string().min(1).optional(),
  prompt: z.string().min(1),
  expectedImageCount: z.number().int().min(1).max(12).optional(),
  sourceImages: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({})
});

export type CreateJobRequest = z.infer<typeof CreateJobSchema>;

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
  kind: z.enum(["output", "source", "screenshot", "log"]),
  filename: z.string().min(1),
  contentType: z.string().min(1).default("application/octet-stream"),
  dataBase64: z.string().min(1)
});

export type ArtifactRequest = z.infer<typeof ArtifactSchema>;

export const JobSchema = z.object({
  id: z.string(),
  status: JobStatusSchema,
  prompt: z.string(),
  expectedImageCount: z.number().int(),
  sourceImages: z.array(z.string()),
  metadata: z.record(z.unknown()),
  conversationUrl: z.string().nullable(),
  tabId: z.number().nullable(),
  attempt: z.number().int(),
  refreshCount: z.number().int(),
  errorMessage: z.string().nullable(),
  workerId: z.string().nullable(),
  outputFiles: z.array(z.string()),
  screenshotFiles: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type Job = z.infer<typeof JobSchema>;

export const ClaimJobSchema = z.object({
  workerId: z.string().min(1),
  runningJobIds: z.array(z.string()).default([])
});

export type ClaimJobRequest = z.infer<typeof ClaimJobSchema>;

export const DispatchStateSchema = z.object({
  id: z.number().int().min(0),
  requestedAt: z.string().nullable()
});

export type DispatchState = z.infer<typeof DispatchStateSchema>;
