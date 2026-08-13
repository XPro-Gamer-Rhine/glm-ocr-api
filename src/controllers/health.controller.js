import config from "../config/index.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { engineState, refreshEngineState } from "../bootstrap/index.js";
import jobQueue from "../services/jobQueue.js";

export async function getHealth(_req, res) {
  await refreshEngineState();
  const ocrReady = engineState.serving && engineState.modelReady;

  return sendSuccess(res, {
    status: "ok",
    ocrReady,
    uptimeSeconds: Math.round(process.uptime()),
    engine: {
      runtime: "ollama",
      model: config.ollama.model,
      host: config.ollama.host,
      installed: engineState.installed,
      serving: engineState.serving,
      serverVersion: engineState.serverVersion,
      modelReady: engineState.modelReady,
      lastError: engineState.lastError,
      checkedAt: engineState.checkedAt,
    },
    system: engineState.system,
    queue: jobQueue.stats,
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
}
