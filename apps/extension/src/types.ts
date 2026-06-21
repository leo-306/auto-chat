import type { AppConfig, Job, JobStatus } from "@wechat-topic/shared";

export type WorkerRecord = {
  tabId: number;
  jobId: string;
  startedAt: number;
  lastStateAt: number;
  refreshCount: number;
};

export type StartJobMessage = {
  type: "START_JOB";
  job: Job;
  config: AppConfig;
};

export type JobProgressMessage = {
  type: "JOB_PROGRESS";
  jobId: string;
  status: JobStatus | "maybe_done";
  signature?: string;
  errorMessage?: string;
  images?: Array<{ index: number; sourceId: string; dataUrl: string; contentType: string }>;
  text?: string;
};

export type PopupState = {
  paused: boolean;
  serverOk: boolean;
  workers: WorkerRecord[];
  lastDebug?: string;
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
