import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic, SqlValue } from "sql.js";
import {
  AppConfig,
  ArtifactRequest,
  ClaimJobRequest,
  CreateJobRequest,
  DEFAULT_CONFIG,
  DispatchState,
  Job,
  JobEvent,
  JobPlatform,
  JobStatus,
  UpdateStatusRequest
} from "@wechat-topic/shared";
import { EventHub } from "./events.js";
import { ResolvedPaths, resolvePaths } from "./paths.js";

type JobRow = {
  id: string;
  platform: JobPlatform;
  mode: Job["mode"];
  status: JobStatus;
  prompt: string;
  expected_image_count: number;
  source_images: string;
  metadata: string;
  conversation_url: string | null;
  tab_id: number | null;
  attempt: number;
  refresh_count: number;
  error_message: string | null;
  worker_id: string | null;
  output_files: string;
  text_output_file: string | null;
  screenshot_files: string;
  created_at: string;
  updated_at: string;
};

export class JobStore {
  private sql!: SqlJsStatic;
  private db!: Database;
  private config: AppConfig = DEFAULT_CONFIG;
  private dispatch: DispatchState = { id: 0, platform: null, jobId: null, requestedAt: null };
  private paths: ResolvedPaths;
  private events?: EventHub;

  constructor(rootDir?: string, events?: EventHub) {
    this.paths = resolvePaths(rootDir);
    this.events = events;
    this.events?.setConfigProvider(() => this.config);
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.mkdirSync(this.paths.jobsDir, { recursive: true });
    this.sql = await initSqlJs();
    this.db = fs.existsSync(this.paths.dbPath)
      ? new this.sql.Database(fs.readFileSync(this.paths.dbPath))
      : new this.sql.Database();
    this.migrate();
    this.loadConfig();
    this.loadDispatch();
    this.persist();
  }

  createJob(input: CreateJobRequest): Job {
    const id = input.id ?? makeJobId();
    if (this.getJob(id)) {
      throw new DuplicateJobError(id);
    }
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(this.paths.jobDir(id), "source"), { recursive: true });
    fs.mkdirSync(path.join(this.paths.jobDir(id), "outputs"), { recursive: true });
    fs.mkdirSync(path.join(this.paths.jobDir(id), "screenshots"), { recursive: true });
    fs.writeFileSync(this.paths.jobFile(id, "prompt.txt"), withJobId(id, input.prompt));
    const sourceImages = this.normalizeSourceImages(id, input.sourceImages ?? []);
    const platform = input.platform ?? "gpt";
    const mode = input.mode ?? "image";
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.prompts ? { geminiPrompts: input.prompts } : {})
    };
    const expectedImageCount = mode === "text" ? 0 : input.expectedImageCount ?? this.config.expectedImageCount;

    this.run(
      `insert into jobs (
        id, platform, mode, status, prompt, expected_image_count, source_images, metadata,
        conversation_url, tab_id, attempt, refresh_count, error_message,
        worker_id, output_files, text_output_file, screenshot_files, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, 0, 0, null, null, ?, null, ?, ?, ?)`,
      [
        id,
        platform,
        mode,
        "queued",
        withJobId(id, input.prompt),
        expectedImageCount,
        JSON.stringify(sourceImages),
        JSON.stringify(metadata),
        JSON.stringify([]),
        JSON.stringify([]),
        now,
        now
      ]
    );
    this.writeMeta(id);
    this.appendEvent(id, { type: "job_created", payload: { expectedImageCount, platform } });
    this.persist();
    return this.getJob(id)!;
  }

  listJobs(): Job[] {
    return this.query<JobRow>("select * from jobs order by created_at desc").map(rowToJob);
  }

  getJob(id: string): Job | null {
    const rows = this.query<JobRow>("select * from jobs where id = ?", [id]);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  replaceJob(input: CreateJobRequest): Job {
    if (input.id) this.deleteJob(input.id);
    return this.createJob(input);
  }

  deleteJob(id: string): void {
    this.run("delete from jobs where id = ?", [id]);
    fs.rmSync(this.paths.jobDir(id), { recursive: true, force: true });
    this.persist();
  }

  claimJob(input: ClaimJobRequest): Job | null {
    const params = input.jobId
      ? [input.platform ?? "gpt", input.jobId]
      : [input.platform ?? "gpt"];
    const row = this.query<JobRow>(
      input.jobId
        ? "select * from jobs where status = 'queued' and platform = ? and id = ? order by created_at asc limit 1"
        : "select * from jobs where status = 'queued' and platform = ? order by created_at asc limit 1",
      params
    )[0];
    if (!row) return null;
    const now = new Date().toISOString();
    this.run(
      "update jobs set status = ?, worker_id = ?, updated_at = ? where id = ? and status = 'queued'",
      ["opening_tab", input.workerId, now, row.id]
    );
    this.appendEvent(row.id, { type: "job_claimed", payload: { workerId: input.workerId } });
    this.persist();
    return this.getJob(row.id);
  }

  updateStatus(id: string, input: UpdateStatusRequest): Job {
    const existing = this.mustGet(id);
    const nextTabId = input.tabId ?? existing.tabId;
    const nextConversationUrl = input.conversationUrl ?? existing.conversationUrl;
    const nextRefreshCount = input.refreshCount ?? existing.refreshCount;
    const nextWorkerId = input.workerId ?? existing.workerId;
    const nextErrorMessage = input.errorMessage ?? existing.errorMessage;
    const now = new Date().toISOString();
    this.run(
      `update jobs set status = ?, tab_id = ?, conversation_url = ?, refresh_count = ?,
       worker_id = ?, error_message = ?, updated_at = ? where id = ?`,
      [
        input.status,
        nextTabId,
        nextConversationUrl,
        nextRefreshCount,
        nextWorkerId,
        nextErrorMessage,
        now,
        id
      ]
    );
    if (nextConversationUrl) fs.writeFileSync(this.paths.jobFile(id, "conversation.url"), nextConversationUrl);
    this.appendEvent(id, { type: "status", payload: input });
    this.writeMeta(id);
    this.persist();
    return this.mustGet(id);
  }

  retryJob(id: string): Job {
    const existing = this.mustGet(id);
    const now = new Date().toISOString();
    const metadata = { ...existing.metadata };
    delete metadata.autoChatReloadOnly;
    this.run(
      `update jobs set status = 'queued', tab_id = null, worker_id = null, error_message = null,
       metadata = ?,
       refresh_count = 0, attempt = ?, updated_at = ? where id = ?`,
      [JSON.stringify(metadata), existing.attempt + 1, now, id]
    );
    this.appendEvent(id, { type: "job_retry", payload: { attempt: existing.attempt + 1 } });
    this.persist();
    return this.mustGet(id);
  }

  reloadJob(id: string): Job {
    const existing = this.mustGet(id);
    if (!existing.conversationUrl) {
      throw new Error(`Job has no recorded conversation URL: ${id}`);
    }
    const now = new Date().toISOString();
    const metadata = { ...existing.metadata, autoChatReloadOnly: true };
    this.run(
      `update jobs set status = 'queued', tab_id = null, worker_id = null, error_message = null,
       metadata = ?,
       refresh_count = 0, attempt = ?, updated_at = ? where id = ?`,
      [JSON.stringify(metadata), existing.attempt + 1, now, id]
    );
    this.appendEvent(id, { type: "job_reload", payload: { attempt: existing.attempt + 1, conversationUrl: existing.conversationUrl } });
    this.persist();
    return this.mustGet(id);
  }

  markManual(id: string, message?: string): Job {
    return this.updateStatus(id, { status: "needs_manual", errorMessage: message });
  }

  appendEvent(id: string, event: JobEvent): void {
    fs.mkdirSync(this.paths.jobDir(id), { recursive: true });
    const stamped = { ...event, at: new Date().toISOString() };
    fs.appendFileSync(this.paths.jobFile(id, "events.jsonl"), `${JSON.stringify(stamped)}\n`);
    this.events?.emit({
      type: event.type,
      jobId: id,
      job: this.getJob(id),
      event: stamped,
      at: stamped.at
    });
  }

  saveArtifact(id: string, artifact: ArtifactRequest): { path: string; job: Job } {
    this.mustGet(id);
    const folder = artifact.kind === "output" || artifact.kind === "text_output"
      ? "outputs"
      : artifact.kind === "screenshot"
        ? "screenshots"
        : artifact.kind === "source"
          ? "source"
      : "";
    const targetDir = folder ? path.join(this.paths.jobDir(id), folder) : this.paths.jobDir(id);
    fs.mkdirSync(targetDir, { recursive: true });
    const safeName = artifact.filename.replace(/[^\w.\-]+/g, "_");
    const target = path.join(targetDir, safeName);
    fs.writeFileSync(target, Buffer.from(artifact.dataBase64, "base64"));

    const job = this.mustGet(id);
    if (artifact.kind === "output") {
      this.setJsonColumn(id, "output_files", [...job.outputFiles, target]);
    }
    if (artifact.kind === "text_output") {
      this.setTextOutput(id, target);
    }
    if (artifact.kind === "screenshot") {
      this.setJsonColumn(id, "screenshot_files", [...job.screenshotFiles, target]);
    }
    this.appendEvent(id, { type: "artifact_saved", payload: { kind: artifact.kind, path: target } });
    this.persist();
    return { path: target, job: this.mustGet(id) };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getDispatch(): DispatchState {
    return this.dispatch;
  }

  requestDispatch(platform: JobPlatform | null = null, jobId: string | null = null): DispatchState {
    this.dispatch = {
      id: this.dispatch.id + 1,
      platform,
      jobId,
      requestedAt: new Date().toISOString()
    };
    this.run("insert or replace into config (key, value) values ('dispatch', ?)", [
      JSON.stringify(this.dispatch)
    ]);
    this.persist();
    return this.dispatch;
  }

  resolveAssetPath(id: string, folder: string, file: string): string | null {
    if (!["source", "outputs", "screenshots"].includes(folder)) return null;
    const folderRoot = path.resolve(this.paths.jobDir(id), folder);
    const target = path.resolve(folderRoot, file);
    if (!target.startsWith(`${folderRoot}${path.sep}`) || !fs.existsSync(target)) return null;
    return target;
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch };
    this.run("insert or replace into config (key, value) values ('app', ?)", [
      JSON.stringify(this.config)
    ]);
    this.persist();
    return this.config;
  }

  close(): void {
    this.persist();
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      create table if not exists jobs (
        id text primary key,
        platform text not null default 'gpt',
        mode text not null default 'image',
        status text not null,
        prompt text not null,
        expected_image_count integer not null,
        source_images text not null,
        metadata text not null,
        conversation_url text,
        tab_id integer,
        attempt integer not null,
        refresh_count integer not null,
        error_message text,
        worker_id text,
        output_files text not null,
        text_output_file text,
        screenshot_files text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists config (
        key text primary key,
        value text not null
      );
    `);
    this.addColumnIfMissing("jobs", "mode", "text not null default 'image'");
    this.addColumnIfMissing("jobs", "platform", "text not null default 'gpt'");
    this.addColumnIfMissing("jobs", "text_output_file", "text");
  }

  private loadConfig(): void {
    const rows = this.query<{ value: string }>("select value from config where key = 'app'");
    if (rows[0]) {
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(rows[0].value) };
    } else {
      this.updateConfig(DEFAULT_CONFIG);
    }
  }

  private loadDispatch(): void {
    const rows = this.query<{ value: string }>("select value from config where key = 'dispatch'");
    if (rows[0]) {
      this.dispatch = { ...this.dispatch, platform: null, jobId: null, ...JSON.parse(rows[0].value) };
    }
  }

  private writeMeta(id: string): void {
    const job = this.getJob(id);
    if (job) fs.writeFileSync(this.paths.jobFile(id, "meta.json"), JSON.stringify(job, null, 2));
  }

  private normalizeSourceImages(id: string, sourceImages: string[]): string[] {
    return sourceImages.map((source, index) => {
      if (/^(https?:|data:|blob:)/i.test(source)) return source;
      const absolute = path.resolve(source);
      if (!fs.existsSync(absolute)) return source;
      const extension = path.extname(absolute) || ".png";
      const filename = `source-${index + 1}${extension}`;
      const target = path.join(this.paths.jobDir(id), "source", filename);
      fs.copyFileSync(absolute, target);
      return `http://127.0.0.1:17321/job-assets/${encodeURIComponent(id)}/source/${encodeURIComponent(filename)}`;
    });
  }

  private setJsonColumn(id: string, column: "output_files" | "screenshot_files", value: string[]): void {
    this.run(`update jobs set ${column} = ?, updated_at = ? where id = ?`, [
      JSON.stringify(value),
      new Date().toISOString(),
      id
    ]);
    this.writeMeta(id);
  }

  private setTextOutput(id: string, target: string): void {
    this.run("update jobs set output_files = ?, text_output_file = ?, updated_at = ? where id = ?", [
      JSON.stringify([target]),
      target,
      new Date().toISOString(),
      id
    ]);
    this.writeMeta(id);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.query<{ name: string }>(`pragma table_info(${table})`);
    if (columns.some(existing => existing.name === column)) return;
    this.db.run(`alter table ${table} add column ${column} ${definition}`);
  }

  private mustGet(id: string): Job {
    const job = this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private query<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return rows;
  }

  private run(sql: string, params: SqlValue[] = []): void {
    const stmt = this.db.prepare(sql);
    stmt.run(params);
    stmt.free();
  }

  private persist(): void {
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.writeFileSync(this.paths.dbPath, Buffer.from(this.db.export()));
  }
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    platform: row.platform ?? "gpt",
    mode: row.mode ?? "image",
    status: row.status,
    prompt: row.prompt,
    expectedImageCount: row.expected_image_count,
    sourceImages: JSON.parse(row.source_images),
    metadata: JSON.parse(row.metadata),
    conversationUrl: row.conversation_url,
    tabId: row.tab_id,
    attempt: row.attempt,
    refreshCount: row.refresh_count,
    errorMessage: row.error_message,
    workerId: row.worker_id,
    outputFiles: JSON.parse(row.output_files),
    textOutputFile: row.text_output_file,
    screenshotFiles: JSON.parse(row.screenshot_files),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function makeJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `img_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

function withJobId(id: string, prompt: string): string {
  return prompt.includes(`JOB_ID: ${id}`) ? prompt : `JOB_ID: ${id}\n${prompt}`;
}

export class DuplicateJobError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job already exists: ${jobId}`);
    this.name = "DuplicateJobError";
  }
}
