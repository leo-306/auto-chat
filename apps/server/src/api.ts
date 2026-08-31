import Fastify, { FastifyInstance } from "fastify";
import type { FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import {
  ArtifactSchema,
  ClaimJobSchema,
  ConfigSchema,
  CreateJobSchema,
  EventSchema,
  JobPlatformSchema,
  UpdateStatusSchema
} from "auto-chat-shared";
import type { ArtifactRequest } from "auto-chat-shared";
import { DuplicateJobError, InvalidParentJobError, JobNotQueuedError, JobStore } from "./store.js";
import { publicDir, readPackageVersion } from "./paths.js";
import { canRemoveGeminiImageWatermark, removeGeminiImageWatermark } from "./watermark.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { EventHub } from "./events.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// 豆包视频那条路走的也是「页面自己下载 + 读回 Downloads 里的文件」，
// 所以这里必须同时放行视频扩展名，否则读回时会被当成非法路径。
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);

const RECHECKABLE_STATUSES = new Set([
  "opening_tab", "waiting_chat_ready", "uploading", "waiting_upload_ready",
  "sending_prompt", "waiting_generation", "stalled", "refreshing",
  "collecting_outputs", "downloading"
]);

export async function buildServer(
  store: JobStore,
  events = new EventHub(),
  logger: FastifyServerOptions["logger"] = true
): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 50 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // 未打包加载的插件改了代码必须重新加载一次，否则跑的还是老 background/content。
  // 手点 chrome://extensions 太费人工，所以这里放一个令牌：POST 一下就换成新值，
  // 插件在轮询里看到值变了就自己 chrome.runtime.reload()。服务重启后是空串，
  // 空串永远不算重载请求，避免重启把正常运行的插件也顺手重载一遍。
  let extensionReloadToken = "";

  app.get("/extension/reload-token", async () => ({ token: extensionReloadToken }));

  app.post("/extension/reload", async () => {
    extensionReloadToken = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return { token: extensionReloadToken };
  });

  app.get("/health", async () => ({ ok: true, version: readPackageVersion() }));

  app.get("/events", async (request, reply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    raw.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
    const unsubscribe = events.subscribe(event => {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepalive = setInterval(() => {
      raw.write(`: keepalive ${new Date().toISOString()}\n\n`);
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    return reply;
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html").send(fs.createReadStream(path.join(publicDir, "index.html")));
  });

  app.get("/job-assets/:id/:folder/:file", async (request, reply) => {
    const { id, folder, file } = request.params as { id: string; folder: string; file: string };
    const target = store.resolveAssetPath(id, folder, file);
    if (!target) {
      return reply.code(404).send({ error: "not_found" });
    }
    const contentType = contentTypeForAsset(file);
    if (contentType) reply.type(contentType);
    return reply.send(fs.createReadStream(target));
  });

  app.get("/config", async () => store.getConfig());

  app.patch("/config", async (request, reply) => {
    try {
      // JSON can't carry `undefined`, so an explicit null means "clear this
      // optional field" (the dashboard sends it when maxRetries is emptied).
      const body = (request.body ?? {}) as Record<string, unknown>;
      const normalized = Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, value === null ? undefined : value])
      );
      const patch = ConfigSchema.innerType().partial().parse(normalized);
      return store.updateConfig(patch);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: "invalid_config",
          issues: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }))
        });
      }
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.get("/dispatch", async () => store.getDispatch());

  app.post("/dispatch", async (request) => {
    const body = (request.body ?? {}) as { platform?: unknown; jobId?: unknown };
    const platform = body.platform === undefined ? null : JobPlatformSchema.parse(body.platform);
    const jobId = typeof body.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : null;
    return store.requestDispatch(platform, jobId);
  });

  app.post("/jobs", async (request, reply) => {
    const body = CreateJobSchema.parse(request.body);
    const query = request.query as { replace?: string };
    try {
      const job = query.replace === "1" ? store.replaceJob(body) : store.createJob(body);
      return reply.code(201).send(job);
    } catch (error) {
      if (error instanceof DuplicateJobError) {
        return reply.code(409).send({
          error: "duplicate_job",
          message: `Job already exists: ${error.jobId}`,
          jobId: error.jobId,
          hint: "Use auto-chat retry <jobId>, auto-chat add <file> --replace, or auto-chat add <file> --auto-id."
        });
      }
      if (error instanceof InvalidParentJobError) {
        return reply.code(400).send({
          error: error.reason === "not_found" ? "parent_job_not_found" : "invalid_parent_job",
          message: error.reason === "not_found"
            ? `父任务不存在: ${error.parentJobId}`
            : `任务不能把自己设为父任务: ${error.parentJobId}`,
          parentJobId: error.parentJobId,
          hint: "请使用 auto-chat show <parentJobId> 确认父任务存在，或移除 parentJobId 创建独立会话。"
        });
      }
      throw error;
    }
  });

  app.get("/jobs", async () => store.listJobs());

  app.post("/jobs/claim", async (request) => {
    const body = ClaimJobSchema.parse(request.body);
    return store.claimJob(body);
  });

  app.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    return job;
  });

  app.delete("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getJob(id)) return reply.code(404).send({ error: "not_found" });
    store.deleteJob(id);
    return { ok: true };
  });

  app.post("/jobs/:id/claim", async (request) => {
    const body = ClaimJobSchema.parse(request.body);
    return store.claimJob(body);
  });

  app.post("/jobs/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateStatusSchema.parse(request.body);
    try {
      return store.updateStatus(id, body);
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/jobs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getJob(id)) return reply.code(404).send({ error: "not_found" });
    const body = EventSchema.parse(request.body);
    store.appendEvent(id, body);
    return { ok: true };
  });

  app.post("/jobs/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ArtifactSchema.parse(request.body);
    // 去水印放在落盘之前：这样 outputs/、outputDir 副本、以及后面所有读文件的人
    // 拿到的都是同一份干净图，store.saveArtifact 一行都不用改。
    const artifact = await stripGeminiWatermark(id, body);
    try {
      return store.saveArtifact(id, artifact);
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/jobs/:id/screenshots", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ArtifactSchema.extend({ kind: ArtifactSchema.shape.kind.default("screenshot") })
      .parse({ ...(request.body as object), kind: "screenshot" });
    try {
      return store.saveArtifact(id, body);
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return store.retryJob(id);
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/jobs/:id/dispatch/reset", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return store.resetDispatchBlock(id);
    } catch (error) {
      if (error instanceof JobNotQueuedError) {
        return reply.code(409).send({ error: "job_not_queued", status: error.status });
      }
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/jobs/:id/recheck", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (!RECHECKABLE_STATUSES.has(job.status)) {
      return reply.code(409).send({ error: "job_not_running", status: job.status });
    }
    if (!job.conversationUrl) {
      return reply.code(400).send({ error: "conversation_url_missing" });
    }
    store.appendEvent(id, { type: "job_recheck_requested", payload: { status: job.status } });
    const dispatch = store.requestDispatch(job.platform, job.id);
    return { job, dispatch };
  });

  app.post("/jobs/:id/reload", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return store.reloadJob(id);
    } catch (error) {
      const message = String(error);
      if (message.includes("no recorded conversation URL")) {
        return reply.code(400).send({ error: message });
      }
      return reply.code(404).send({ error: message });
    }
  });

  app.post("/jobs/:id/manual", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { message?: string };
    try {
      return store.markManual(id, body.message);
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  // Chrome's downloads API can only place a download inside the user's
  // Downloads folder, never at an arbitrary path, and it exposes no way to
  // read a downloaded file's bytes directly — only this local server (a
  // Node process with real filesystem access) can do that. The extension's
  // background script drives the browser's own "Download full-sized image"
  // button to fetch the real, uncropped generated image (see
  // apps/extension/src/background.ts's downloadGeneratedImage), waits for
  // the download to land at an absolute path, then calls this endpoint to
  // read it back as base64 before deleting the temporary file. The path is
  // restricted to the user's Downloads directory and an image extension so
  // this can't be turned into an arbitrary local file reader.
  app.post("/local-downloads/read", async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    const target = typeof body.path === "string" ? body.path : "";
    if (!isReadableLocalDownload(target)) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    try {
      const buffer = await fs.promises.readFile(target);
      const contentType = contentTypeForAsset(target) ?? "application/octet-stream";
      await fs.promises.unlink(target).catch(() => {});
      return { contentType, base64: buffer.toString("base64") };
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  // 用户在 Gemini 页面手点「下载」拿到的是浏览器原生下载：文件直接落到
  // Downloads，整条 job 采集链路（以及挂在 artifact 上传上的那个去水印钩子）
  // 都碰不到它。插件监听到这类下载完成后调这里，就地把水印去掉再覆盖回去。
  // 只覆盖不删除；算法没动过像素时一个字节都不写。
  app.post("/local-downloads/dewatermark", async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    const target = typeof body.path === "string" ? body.path : "";
    // 跟 /local-downloads/read 同一道闸：只认 Downloads 目录里的已知媒体扩展名。
    if (!isReadableLocalDownload(target)) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    if (!store.getConfig().removeGeminiWatermark) return { changed: false, reason: "disabled" };
    const resolved = path.resolve(target);
    // 视频扩展名能过上面那道闸，但去水印目前只做图片，这里筛掉。
    if (!canRemoveGeminiImageWatermark(resolved)) return { changed: false, reason: "unsupported_type" };

    try {
      const removal = await removeGeminiImageWatermark(await fs.promises.readFile(resolved), {
        filename: resolved
      });
      if (!removal) return { changed: false, reason: "no_watermark" };
      // 先写同目录临时文件再 rename：中途出错也不会把用户的图留成半截。
      const temp = `${resolved}.dewatermark.tmp`;
      await fs.promises.writeFile(temp, removal.buffer);
      await fs.promises.rename(temp, resolved);
      const info = {
        path: resolved,
        quality: removal.meta.qualityStatus ?? null,
        position: removal.meta.position,
        bytes: removal.buffer.length
      };
      app.log.info(info, "manual download dewatermarked");
      return { changed: true, ...info };
    } catch (error) {
      app.log.warn({ path: resolved, error: String(error) }, "manual download dewatermark failed");
      return reply.code(500).send({ error: String(error) });
    }
  });

  // Temporary diagnostic endpoint: content.ts has no way to surface what
  // actually happened during the GPT download-capture flow (its
  // console.log output only reaches the ChatGPT tab's own DevTools, which
  // isn't accessible while debugging this remotely) — this makes that
  // visible via the server's own request log instead.
  app.post("/debug-log", async (request) => {
    app.log.info({ debugLog: request.body }, "client debug log");
    return { ok: true };
  });

  // Gemini 出图右下角带一枚半透明星芒 logo，落盘前在这里去掉。
  // 整个函数的原则是「任何一步不顺就退回原图」：留着水印顶多是张带 logo 的图，
  // 而让后处理把 artifact 上传搞失败，整条采集链路就白跑一趟了。
  async function stripGeminiWatermark(jobId: string, artifact: ArtifactRequest): Promise<ArtifactRequest> {
    if (artifact.kind !== "output") return artifact;
    if (!canRemoveGeminiImageWatermark(artifact.filename, artifact.contentType)) return artifact;
    if (!store.getConfig().removeGeminiWatermark) return artifact;
    // job 不存在时不在这里报错，交给下面的 saveArtifact 走原来那条 404。
    if (store.getJob(jobId)?.platform !== "gemini") return artifact;

    try {
      const removal = await removeGeminiImageWatermark(Buffer.from(artifact.dataBase64, "base64"), {
        filename: artifact.filename,
        contentType: artifact.contentType
      });
      // null = 没检测到水印，或者算法判断再动下去会伤画面，两种都保持原图。
      if (!removal) return artifact;
      store.appendEvent(jobId, {
        type: "watermark_removed",
        payload: {
          filename: artifact.filename,
          quality: removal.meta.qualityStatus ?? null,
          position: removal.meta.position,
          alphaGain: removal.meta.alphaGain
        }
      });
      return { ...artifact, dataBase64: removal.buffer.toString("base64") };
    } catch (error) {
      app.log.warn(
        { jobId, filename: artifact.filename, error: String(error) },
        "gemini watermark removal failed, keeping original"
      );
      return artifact;
    }
  }

  return app;
}

export function isReadableLocalDownload(target: string): boolean {
  if (!target) return false;
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const resolved = path.resolve(target);
  const withinDownloads = resolved === downloadsDir || resolved.startsWith(`${downloadsDir}${path.sep}`);
  const ext = path.extname(resolved).toLowerCase();
  return withinDownloads && (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext));
}

function contentTypeForAsset(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return null;
}
