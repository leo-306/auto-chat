import Fastify, { FastifyInstance } from "fastify";
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
import { DuplicateJobError, InvalidParentJobError, JobStore } from "./store.js";
import { publicDir } from "./paths.js";
import fs from "node:fs";
import path from "node:path";
import { EventHub } from "./events.js";

export async function buildServer(store: JobStore, events = new EventHub()): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

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
    const patch = ConfigSchema.innerType().partial().parse(request.body);
    try {
      return store.updateConfig(patch);
    } catch (error) {
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
    try {
      return store.saveArtifact(id, body);
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

  return app;
}

function contentTypeForAsset(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return null;
}
