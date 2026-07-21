import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const workspaceRoot = findWorkspaceRoot(process.cwd());
export const publicDir = path.join(packageRoot(), "apps", "server", "public");

type DataDirOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
};

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function readPackageVersion(): string {
  const manifestPath = path.join(packageRoot(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

export type ResolvedPaths = ReturnType<typeof resolvePaths>;

export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const override = env.AUTO_CHAT_DATA_DIR?.trim();

  if (override) return path.resolve(cwd, expandHome(override, homeDir));
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "auto-chat");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "auto-chat");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  return path.join(xdgDataHome, "auto-chat");
}

export function resolvePaths(root?: string) {
  const resolvedRoot = root ? path.resolve(root) : findWorkspaceRoot(process.cwd());
  const dataDir = root ? path.join(resolvedRoot, "data") : resolveDataDir();
  const jobsDir = path.join(dataDir, "jobs");
  const dbPath = path.join(dataDir, "jobs.sqlite");
  return {
    workspaceRoot: resolvedRoot,
    dataDir,
    jobsDir,
    dbPath,
    jobDir(jobId: string): string {
      return path.join(jobsDir, jobId);
    },
    jobFile(jobId: string, name: string): string {
      return path.join(jobsDir, jobId, name);
    }
  };
}

export function migrateLegacyData(sourceDataDir: string, targetDataDir: string): boolean {
  const sourceDb = path.join(sourceDataDir, "jobs.sqlite");
  const targetDb = path.join(targetDataDir, "jobs.sqlite");
  if (path.resolve(sourceDataDir) === path.resolve(targetDataDir)) return false;
  if (!fs.existsSync(sourceDb) || fs.existsSync(targetDb)) return false;

  fs.mkdirSync(targetDataDir, { recursive: true });
  const sourceJobs = path.join(sourceDataDir, "jobs");
  if (fs.existsSync(sourceJobs)) {
    fs.cpSync(sourceJobs, path.join(targetDataDir, "jobs"), {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
  fs.copyFileSync(sourceDb, targetDb, fs.constants.COPYFILE_EXCL);
  return true;
}

export function shouldUseLegacyData(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.AUTO_CHAT_DATA_DIR?.trim() && !env.JOB_SERVER_URL?.trim();
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
  return value;
}

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { workspaces?: unknown };
      if (parsed.workspaces) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
