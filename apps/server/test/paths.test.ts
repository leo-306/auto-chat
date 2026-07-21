import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyData, resolveDataDir, resolvePaths, shouldUseLegacyData } from "../src/paths.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("data directory paths", () => {
  it("uses the macOS application support directory by default", () => {
    expect(resolveDataDir({ platform: "darwin", homeDir: "/Users/tester", env: {} }))
      .toBe(path.join("/Users/tester", "Library", "Application Support", "auto-chat"));
  });

  it("uses XDG_DATA_HOME on Linux", () => {
    expect(resolveDataDir({
      platform: "linux",
      homeDir: "/home/tester",
      env: { XDG_DATA_HOME: "/var/test-data" }
    })).toBe(path.join("/var/test-data", "auto-chat"));
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(resolveDataDir({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }
    })).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "auto-chat"));
  });

  it("prefers AUTO_CHAT_DATA_DIR and expands the home directory", () => {
    expect(resolveDataDir({
      platform: "darwin",
      homeDir: "/Users/tester",
      cwd: "/tmp/project",
      env: { AUTO_CHAT_DATA_DIR: "~/.auto-chat-custom" }
    })).toBe(path.join("/Users/tester", ".auto-chat-custom"));
  });

  it("keeps explicit JobStore roots compatible with root/data", () => {
    expect(resolvePaths("/tmp/explicit-root").dataDir).toBe(path.join("/tmp/explicit-root", "data"));
  });

  it("disables legacy lookup for custom data directories or isolated servers", () => {
    expect(shouldUseLegacyData({})).toBe(true);
    expect(shouldUseLegacyData({ AUTO_CHAT_DATA_DIR: "/tmp/custom" })).toBe(false);
    expect(shouldUseLegacyData({ JOB_SERVER_URL: "http://127.0.0.1:17329" })).toBe(false);
  });
});

describe("legacy data migration", () => {
  it("copies jobs before using the database as the migration marker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-chat-paths-"));
    temporaryDirs.push(root);
    const source = path.join(root, "legacy");
    const target = path.join(root, "current");
    fs.mkdirSync(path.join(source, "jobs", "job_1"), { recursive: true });
    fs.writeFileSync(path.join(source, "jobs.sqlite"), "database");
    fs.writeFileSync(path.join(source, "jobs", "job_1", "prompt.txt"), "prompt");
    fs.writeFileSync(path.join(source, "server.log"), "large runtime log");

    expect(migrateLegacyData(source, target)).toBe(true);
    expect(fs.readFileSync(path.join(target, "jobs.sqlite"), "utf8")).toBe("database");
    expect(fs.readFileSync(path.join(target, "jobs", "job_1", "prompt.txt"), "utf8")).toBe("prompt");
    expect(fs.existsSync(path.join(target, "server.log"))).toBe(false);
    expect(fs.existsSync(path.join(source, "jobs.sqlite"))).toBe(true);
    expect(migrateLegacyData(source, target)).toBe(false);
  });
});
