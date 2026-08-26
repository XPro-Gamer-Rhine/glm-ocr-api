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
 * Make sure a model the AGENT needs is pulled, beyond the OCR model above.
 *
 * The boot sequence pulls GLM-OCR because the plain HTTP API cannot read a
 * scanned page without it. The agent needs a second, unrelated model: the GLM
 * chat model that casts the third vote. Nothing in the API path wants it, so it
 * is pulled here rather than in `ensureOcrReady` — and it is pulled at BOOT
 * rather than at the vote, because discovering it missing at the vote means a
 * statement was claimed, downloaded and OCR'd for twenty minutes first.
 *
 * Never throws. A missing voter is a degraded worker, not a dead one: the
 * consensus still reaches a verdict on two readers, and `doctor` says which one
 * is absent.
 *
 * @returns {{ok: boolean, model: string, reason?: string}}
 */
export async function ensureChatModel(model) {
  if (!model) return { ok: false, model, reason: "no model configured" };
  try {
    if (!engineState.serving) {
      await refreshEngineState();
      if (!engineState.serving) {
        return { ok: false, model, reason: "Ollama is not serving" };
      }
    }
    if (await isModelPulled(config.ollama.host, model)) {
      log.info(`Chat model "${model}" already pulled.`);
      return { ok: true, model };
    }
    if (!config.bootstrap.autoPullModel) {
      return { ok: false, model, reason: `not pulled and AUTO_PULL_MODEL is disabled` };
    }
    await pullModel(config.ollama.host, model);
    return { ok: true, model };
  } catch (err) {
    return { ok: false, model, reason: err.message };
  }
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
