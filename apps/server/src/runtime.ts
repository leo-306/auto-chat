import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_SERVER_LOG_BACKUPS = 3;

type RotatingLogOptions = {
  maxBytes?: number;
  backups?: number;
};

export type RuntimeLogLevel = "info" | "warn" | "error" | "fatal";

export type RotatingLogStream = {
  write(chunk: string): void;
};

export function createRotatingLogStream(file: string, options: RotatingLogOptions = {}): RotatingLogStream {
  const maxBytes = options.maxBytes ?? DEFAULT_SERVER_LOG_MAX_BYTES;
  const backups = options.backups ?? DEFAULT_SERVER_LOG_BACKUPS;

  return {
    write(chunk: string): void {
      const text = String(chunk);
      rotateLogIfNeeded(file, Buffer.byteLength(text), maxBytes, backups);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
    }
  };
}

export function rotateLogIfNeeded(
  file: string,
  incomingBytes = 0,
  maxBytes = DEFAULT_SERVER_LOG_MAX_BYTES,
  backups = DEFAULT_SERVER_LOG_BACKUPS
): boolean {
  if (maxBytes <= 0 || backups < 1) return false;

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  if (size + incomingBytes <= maxBytes) return false;

  fs.rmSync(`${file}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${file}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${file}.${index + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  return true;
}

export function writeRuntimeLog(
  stream: RotatingLogStream,
  level: RuntimeLogLevel,
  event: string,
  details: Record<string, unknown> = {}
): void {
  stream.write(`${JSON.stringify({
    level: runtimeLogLevelNumber(level),
    time: Date.now(),
    pid: process.pid,
    event,
    ...details
  })}\n`);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { value: String(error) };
}

function runtimeLogLevelNumber(level: RuntimeLogLevel): number {
  if (level === "fatal") return 60;
  if (level === "error") return 50;
  if (level === "warn") return 40;
  return 30;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
