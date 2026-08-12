import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLaunchAgentPlist, launchAgentFile, launchAgentTarget } from "../src/launch-agent.js";
import { createRotatingLogStream, rotateLogIfNeeded } from "../src/runtime.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("server runtime", () => {
  it("rotates the active log and preserves the configured backups", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-chat-runtime-"));
    temporaryDirs.push(root);
    const logFile = path.join(root, "server.log");
    fs.writeFileSync(logFile, "old");
    fs.writeFileSync(`${logFile}.1`, "older");

    expect(rotateLogIfNeeded(logFile, 3, 4, 2)).toBe(true);
    expect(fs.readFileSync(`${logFile}.1`, "utf8")).toBe("old");
    expect(fs.readFileSync(`${logFile}.2`, "utf8")).toBe("older");
    expect(fs.existsSync(logFile)).toBe(false);

    const stream = createRotatingLogStream(logFile, { maxBytes: 4, backups: 2 });
    stream.write("next");
    expect(fs.readFileSync(logFile, "utf8")).toBe("next");
  });

  it("creates a user launch agent that preserves paths and automatic restart", () => {
    const plist = buildLaunchAgentPlist({
      nodePath: "/Users/tester/.nvm/node",
      serverPath: "/Users/tester/project/apps/server/dist/index.js",
      workingDirectory: "/Users/tester/project",
      dataDir: "/Users/tester/Library/Application Support/auto-chat",
      port: "17321",
      logFile: "/Users/tester/Library/Application Support/auto-chat/server.log"
    });

    expect(launchAgentFile("/Users/tester")).toBe("/Users/tester/Library/LaunchAgents/com.auto-chat.server.plist");
    expect(launchAgentTarget(501)).toBe("gui/501/com.auto-chat.server");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.auto-chat.server</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>AUTO_CHAT_LOG_FILE</key>");
    expect(plist).toContain("Application Support");
  });
});
