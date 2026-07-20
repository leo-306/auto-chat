import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const workspaceRoot = findWorkspaceRoot(process.cwd());
export const publicDir = path.join(workspaceRoot, "apps", "server", "public");

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function readPackageVersion(): string {
  const manifestPath = path.join(packageRoot(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

export type ResolvedPaths = ReturnType<typeof resolvePaths>;

export function resolvePaths(root = findWorkspaceRoot(process.cwd())) {
  const dataDir = path.join(root, "data");
  const jobsDir = path.join(dataDir, "jobs");
  const dbPath = path.join(dataDir, "jobs.sqlite");
  return {
    workspaceRoot: root,
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
