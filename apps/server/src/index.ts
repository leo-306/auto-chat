import { buildServer } from "./api.js";
import { EventHub } from "./events.js";
import { JobStore } from "./store.js";
import { resolvePaths } from "./paths.js";
import {
  createRotatingLogStream,
  serializeError,
  writeRuntimeLog
} from "./runtime.js";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 17321);
const dataDir = resolvePaths().dataDir;
const pidFile = path.join(dataDir, "server.pid");
const logFile = process.env.AUTO_CHAT_LOG_FILE?.trim() || path.join(dataDir, "server.log");
const logStream = createRotatingLogStream(logFile);
let app: FastifyInstance | undefined;
let store: JobStore | undefined;
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(`signal:${signal}`, 0));
}

process.on("warning", warning => {
  writeRuntimeLog(logStream, "warn", "process_warning", { warning: serializeError(warning) });
});

process.on("uncaughtException", error => {
  writeRuntimeLog(logStream, "fatal", "uncaught_exception", { error: serializeError(error) });
  void shutdown("uncaught_exception", 1);
});

process.on("unhandledRejection", reason => {
  writeRuntimeLog(logStream, "fatal", "unhandled_rejection", { reason: serializeError(reason) });
  void shutdown("unhandled_rejection", 1);
});

process.once("exit", code => {
  writeRuntimeLog(logStream, code === 0 ? "info" : "error", "process_exit", { code });
  removePidFile();
});

void main();

async function main(): Promise<void> {
  writeRuntimeLog(logStream, "info", "server_starting", { host, port, logFile });
  try {
    const events = new EventHub();
    store = new JobStore(undefined, events);
    await store.init();
    app = await buildServer(store, events, { level: "info", stream: logStream });
    await app.listen({ host, port });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    app.log.info({ event: "server_started", host, port, logFile }, "auto-chat server started");
  } catch (error) {
    writeRuntimeLog(logStream, "fatal", "server_start_failed", { error: serializeError(error) });
    await shutdown("startup_error", 1);
  }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  writeRuntimeLog(logStream, exitCode === 0 ? "info" : "error", "server_shutdown_started", { reason, exitCode });

  // Fastify waits for SSE clients to disconnect. Let clients finish briefly,
  // then close lingering sockets so the background process can actually exit.
  const forceCloseTimer = setTimeout(() => app?.server.closeAllConnections(), 2_000);
  forceCloseTimer.unref();
  try {
    await app?.close();
  } catch (error) {
    writeRuntimeLog(logStream, "error", "server_shutdown_failed", { error: serializeError(error) });
  } finally {
    clearTimeout(forceCloseTimer);
    store?.close();
    removePidFile();
    writeRuntimeLog(logStream, exitCode === 0 ? "info" : "error", "server_shutdown_complete", { reason, exitCode });
    process.exit(exitCode);
  }
}

function removePidFile(): void {
  try {
    if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {
    // A failed or already removed PID file must not prevent process shutdown.
  }
}
