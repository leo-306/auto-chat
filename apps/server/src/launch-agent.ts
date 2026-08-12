import path from "node:path";

export const launchAgentLabel = "com.auto-chat.server";

export type LaunchAgentSpec = {
  nodePath: string;
  serverPath: string;
  workingDirectory: string;
  dataDir: string;
  port: string;
  logFile: string;
};

export function launchAgentFile(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
}

export function launchAgentTarget(uid: number): string {
  return `gui/${uid}/${launchAgentLabel}`;
}

export function launchAgentDomain(uid: number): string {
  return `gui/${uid}`;
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const dictionary = (entries: Array<[string, string]>): string => entries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n${value}`)
    .join("\n");
  const string = (value: string): string => `    <string>${xmlEscape(value)}</string>`;
  const array = (values: string[]): string => `    <array>\n${values.map(value => `      <string>${xmlEscape(value)}</string>`).join("\n")}\n    </array>`;
  const environment = dictionary([
    ["AUTO_CHAT_DATA_DIR", string(spec.dataDir)],
    ["AUTO_CHAT_LOG_FILE", string(spec.logFile)],
    ["PORT", string(spec.port)]
  ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    dictionary([
      ["Label", string(launchAgentLabel)],
      ["ProgramArguments", array([spec.nodePath, spec.serverPath])],
      ["WorkingDirectory", string(spec.workingDirectory)],
      ["EnvironmentVariables", `    <dict>\n${environment}\n    </dict>`],
      ["KeepAlive", "    <true/>"],
      ["RunAtLoad", "    <true/>"],
      ["ThrottleInterval", "    <integer>10</integer>"]
    ]),
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
