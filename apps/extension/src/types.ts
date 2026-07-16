import type { AppConfig, Job, JobPlatform, JobStatus } from "auto-chat-shared";
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

export type WorkerRecord = {
  tabId: number;
  jobId: string;
  platform: JobPlatform;
  startedAt: number;
  lastStateAt: number;
  refreshCount: number;
  rateLimitRefreshCount: number;
  expectingReload: boolean;
};

export type StartJobMessage = {
  type: "START_JOB";
  job: Job;
  config: AppConfig;
  recoveryMode?: EmptyAssistantRecoveryMode;
};

export type JobProgressMessage = {
  type: "JOB_PROGRESS";
  jobId: string;
  status: JobStatus | "maybe_done" | "rate_limited";
  signature?: string;
  errorMessage?: string;
  images?: Array<{ index: number; sourceId: string; dataUrl: string; contentType: string }>;
  imageOrderComplete?: boolean;
  text?: string;
  recoveryMode?: EmptyAssistantRecoveryMode;
};

export type PlatformState = {
  paused: boolean;
  workers: WorkerRecord[];
  lastDebug?: string;
};

export type PopupState = {
  serverOk: boolean;
  activePlatform: JobPlatform;
  platforms: Record<JobPlatform, PlatformState>;
};

export type DebugInspectMessage = {
  type: "DEBUG_INSPECT";
  jobId?: string;
};

export type DebugInspectResult = {
  ok: boolean;
  jobId: string | null;
  pageJobId: string | null;
  url: string;
  hasJobAssistant: boolean;
  hasError: boolean;
  isInterrupted: boolean;
  isGenerating: boolean;
  loadedImages: number;
  scopedImages: number;
  pageImages: number;
  expectedImages: number | null;
  signature: string;
  errorText?: string;
};
