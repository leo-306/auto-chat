import type { AppConfig, DispatchState, Job, JobPlatform, JobStatus } from "auto-chat-shared";
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
  extensionVersion: string;
  lastAcknowledgedDispatchId: number | null;
  lastAcknowledgedDispatchToken: string | null;
  pendingDispatch: DispatchState | null;
  platforms: Record<JobPlatform, PlatformState>;
};

export type DebugInspectMessage = {
  type: "DEBUG_INSPECT";
  jobId?: string;
};

export type ExpectNavigationMessage = {
  type: "EXPECT_NAVIGATION";
  expecting: boolean;
};

// Both Gemini's "Download full-sized image" button and GPT's Share-sheet
// "Download" button are the only reliable way to reach a platform's
// original generated image asset — clicking them for real and letting
// background.ts capture the resulting browser download. A synthetic click
// from the content script doesn't carry the "transient user activation"
// these handlers need to reliably trigger a real download, so content.ts
// hands background.ts the target button's on-screen coordinates over an
// "image-download-capture" runtime.connect port, and background.ts
// dispatches a trusted click via chrome.debugger's Input.dispatchMouseEvent
// before capturing the resulting chrome.downloads event. Only one capture
// can be in flight at a time (Chrome's downloads API has no way to tell two
// concurrent downloads apart at onCreated time), so requests queue and each
// port gets its own "RESULT" message once its turn comes up and the
// download has been captured, read back, and cleaned up.
export type RequestImageDownloadResult =
  | { ok: true; contentType: string; base64: string }
  | { ok: false; error: string };

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
