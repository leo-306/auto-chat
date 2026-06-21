import path from "node:path";
import fs from "node:fs";

export const workspaceRoot = findWorkspaceRoot(process.cwd());
export const publicDir = path.join(workspaceRoot, "apps", "server", "public");

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
