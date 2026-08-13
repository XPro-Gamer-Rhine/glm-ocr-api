import config from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { detectSystem } from "./systemDetector.js";
import {
  findOllamaBinary,
  getServerVersion,
  installOllama,
  isModelPulled,
  pullModel,
  startOllamaServer,
} from "./ollamaInstaller.js";

const log = createLogger("bootstrap");

/** Shared snapshot of OCR-engine readiness; refreshed by ensureOcrReady + health checks. */
export const engineState = {
  system: null,
  binaryPath: null,
  installed: false,
  serving: false,
  serverVersion: null,
  modelReady: false,
  model: config.ollama.model,
  lastError: null,
  checkedAt: null,
};

/** Cheap re-probe used by /health and by the OCR service before jobs. */
export async function refreshEngineState() {
  engineState.serverVersion = await getServerVersion(config.ollama.host);
  engineState.serving = Boolean(engineState.serverVersion);
  engineState.modelReady = engineState.serving
    ? await isModelPulled(config.ollama.host, config.ollama.model)
    : false;
  engineState.checkedAt = new Date().toISOString();
  return engineState;
}

/**
 * Full boot sequence:
 *   1. detect OS  2. find or install ollama  3. start server  4. pull model
 * Never throws — a failed step leaves the API running in degraded mode
 * (extractions fall back to the embedded PDF text layer) and is visible in /health.
 */
export async function ensureOcrReady() {
  const system = detectSystem();
  engineState.system = system;
  log.info(
    `System: ${system.platformName} ${system.arch} | ${system.cpus} CPUs | ` +
      `${system.totalMemGb} GB RAM | node ${system.nodeVersion}`
  );

  try {
    // 1) Locate or install the Ollama runtime.
    let binaryPath = await findOllamaBinary(system.platform);
    if (!binaryPath) {
      if (!config.bootstrap.autoInstall) {
        throw new Error("Ollama is not installed and AUTO_INSTALL is disabled.");
      }
      if (!system.supported) {
        throw new Error(`Unsupported platform: ${system.platform}`);
      }
      await installOllama(system);
      binaryPath = await findOllamaBinary(system.platform);
      if (!binaryPath) {
        throw new Error("Ollama install finished but the binary could not be located.");
      }
      log.info(`Ollama installed at ${binaryPath}`);
    } else {
      log.info(`Ollama already installed: ${binaryPath}`);
    }
    engineState.binaryPath = binaryPath;
    engineState.installed = true;

    // 2) Make sure the server is running.
    let version = await getServerVersion(config.ollama.host);
    if (!version) {
      if (!config.bootstrap.autoStartOllama) {
        throw new Error("Ollama server is not running and AUTO_START_OLLAMA is disabled.");
      }
      version = await startOllamaServer(binaryPath, config.ollama.host);
    } else {
      log.info(`Ollama server already running (v${version}).`);
    }
    engineState.serving = true;
    engineState.serverVersion = version;

    // 3) Make sure the GLM-OCR model is available.
    if (await isModelPulled(config.ollama.host, config.ollama.model)) {
      log.info(`Model "${config.ollama.model}" already pulled.`);
      engineState.modelReady = true;
    } else if (config.bootstrap.autoPullModel) {
      await pullModel(config.ollama.host, config.ollama.model);
      engineState.modelReady = true;
    } else {
      throw new Error(
        `Model "${config.ollama.model}" is not pulled and AUTO_PULL_MODEL is disabled.`
      );
    }

    engineState.lastError = null;
    log.info("OCR engine ready: GLM-OCR via Ollama.");
  } catch (err) {
    engineState.lastError = err.message;
    log.error(`OCR engine not ready: ${err.message}`);
    log.warn("API will start in degraded mode — extractions use the embedded PDF text layer only.");
  }

  engineState.checkedAt = new Date().toISOString();
  return engineState;
}
