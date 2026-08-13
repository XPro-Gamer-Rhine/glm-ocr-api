import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "../utils/logger.js";
import { which } from "./systemDetector.js";

const log = createLogger("installer");

/** Well-known install locations checked when `ollama` is not on PATH. */
const BINARY_CANDIDATES = {
  darwin: [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
  ],
  linux: ["/usr/local/bin/ollama", "/usr/bin/ollama", "/opt/ollama/bin/ollama"],
  win32: [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    "C:\\Program Files\\Ollama\\ollama.exe",
  ],
};

/**
 * Run a shell command, streaming output lines into the logger.
 * Uses sh -c on unix and powershell on Windows so pipe-based installers work.
 */
function runShell(command, { platform, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = (platform || process.platform) === "win32";
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command])
      : spawn("sh", ["-c", command]);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    const forward = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) log.info(`  ${line.trim()}`);
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}: ${command}`));
    });
  });
}

/** Locate the ollama binary via PATH, then well-known locations. */
export async function findOllamaBinary(platform = process.platform) {
  const onPath = await which("ollama");
  if (onPath) return onPath;
  for (const candidate of BINARY_CANDIDATES[platform] || []) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Returns the Ollama server version string if it is reachable, otherwise null. */
export async function getServerVersion(host) {
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body.version || "unknown";
  } catch {
    return null;
  }
}

/**
 * Install Ollama for the detected OS.
 * macOS: Homebrew when available, otherwise the official app bundle.
 * Linux: official install script (VPS-friendly, needs root or sudo).
 * Windows: winget when available, otherwise silent installer download.
 */
export async function installOllama(system) {
  const { platform } = system;
  log.info(`Ollama not found — installing for ${system.platformName} (${system.arch})...`);

  if (platform === "darwin") {
    if (await which("brew")) {
      await runShell("brew install ollama");
      return;
    }
    log.info("Homebrew not found, downloading Ollama.app bundle...");
    await runShell(
      [
        'TMP_ZIP="$(mktemp -d)/Ollama-darwin.zip"',
        'curl -fSL --retry 3 -o "$TMP_ZIP" https://ollama.com/download/Ollama-darwin.zip',
        'ditto -xk "$TMP_ZIP" /Applications',
        'rm -f "$TMP_ZIP"',
      ].join(" && ")
    );
    return;
  }

  if (platform === "linux") {
    const script = "curl -fsSL https://ollama.com/install.sh | sh";
    if (system.isRoot) {
      await runShell(script);
    } else if (await which("sudo")) {
      // Script self-elevates via sudo; -n would fail on password prompts, so run plain.
      await runShell(script);
    } else {
      throw new Error(
        "Cannot install Ollama on Linux without root or sudo. " +
          "Run manually: curl -fsSL https://ollama.com/install.sh | sh"
      );
    }
    return;
  }

  if (platform === "win32") {
    if (await which("winget")) {
      await runShell(
        "winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements",
        { platform }
      );
      return;
    }
    log.info("winget not found, downloading OllamaSetup.exe...");
    await runShell(
      [
        "$installer = Join-Path $env:TEMP 'OllamaSetup.exe'",
        "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $installer",
        "Start-Process -FilePath $installer -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait",
        "Remove-Item $installer -ErrorAction SilentlyContinue",
      ].join("; "),
      { platform }
    );
    return;
  }

  throw new Error(`Unsupported platform for automatic install: ${platform}`);
}

/**
 * Start the Ollama server in the background and wait until it responds.
 * On macOS prefers the app bundle (menu-bar daemon) when the CLI came from it.
 */
export async function startOllamaServer(binaryPath, host, { waitMs = 60_000 } = {}) {
  log.info("Starting Ollama server...");

  if (process.platform === "darwin" && binaryPath.includes("Ollama.app")) {
    await runShell("open -a Ollama");
  } else {
    const child = spawn(binaryPath, ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const version = await getServerVersion(host);
    if (version) {
      log.info(`Ollama server is up (v${version}).`);
      return version;
    }
    await sleep(1000);
  }
  throw new Error(`Ollama server did not become ready within ${waitMs / 1000}s`);
}

/** Check whether the target model is present locally. */
export async function isModelPulled(host, model) {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    const wanted = model.includes(":") ? model : `${model}:latest`;
    return models.some((m) => m.name === wanted || m.name === model || m.model === wanted);
  } catch {
    return false;
  }
}

/**
 * Pull the model through the Ollama API, streaming progress to the log.
 * Model downloads are multi-GB; no timeout is applied to the overall pull.
 */
export async function pullModel(host, model) {
  log.info(`Pulling model "${model}" (this can take a while on first run)...`);
  const res = await fetch(`${host}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Model pull failed to start: HTTP ${res.status}`);
  }

  let lastPercent = -10;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.error) throw new Error(`Model pull failed: ${event.error}`);
      if (event.total && event.completed !== undefined) {
        const percent = Math.floor((event.completed / event.total) * 100);
        if (percent >= lastPercent + 10) {
          lastPercent = percent;
          log.info(`  ${event.status}: ${percent}%`);
        }
      } else if (event.status && !event.status.startsWith("pulling")) {
        log.info(`  ${event.status}`);
      }
    }
  }
  log.info(`Model "${model}" ready.`);
}
