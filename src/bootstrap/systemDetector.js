import os from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLATFORM_NAMES = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/**
 * Resolve a command to an absolute path using the platform lookup tool.
 * Returns null when the command is not on PATH.
 */
export async function which(command) {
  const isWindows = process.platform === "win32";
  const tool = isWindows ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(tool, [command]);
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export function detectSystem() {
  const platform = process.platform;
  return {
    platform,
    platformName: PLATFORM_NAMES[platform] || platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    isRoot: typeof process.getuid === "function" ? process.getuid() === 0 : false,
    shell: platform === "win32" ? "powershell" : process.env.SHELL || "sh",
    nodeVersion: process.version,
    supported: platform in PLATFORM_NAMES,
  };
}

/** Synchronous PATH probe, used in candidate-path scans. */
export function commandExistsSync(command) {
  const isWindows = process.platform === "win32";
  const result = spawnSync(isWindows ? "where" : "which", [command], { stdio: "ignore" });
  return result.status === 0;
}
