import fs from "node:fs";
import config from "./src/config/index.js";
import { createLogger } from "./src/utils/logger.js";
import { ensureOcrReady } from "./src/bootstrap/index.js";
import { createApp } from "./src/app.js";
import { resumePendingJobs } from "./src/services/extraction.service.js";

const log = createLogger("server");

async function main() {
  // Storage directories must exist before anything touches them.
  fs.mkdirSync(config.storage.uploadsDir, { recursive: true });
  fs.mkdirSync(config.storage.extractionsDir, { recursive: true });

  // Detect the OS, install Ollama + GLM-OCR if missing, start the runtime.
  await ensureOcrReady();

  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    log.info(`dime-ocr API listening on http://${config.server.host}:${config.server.port}`);
    const resumed = resumePendingJobs();
    if (resumed > 0) log.info(`Re-queued ${resumed} interrupted extraction(s).`);
  });

  // Huge uploads over slow links: don't let default timeouts kill them.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err.stack || err);
  process.exit(1);
});

main().catch((err) => {
  log.error("Fatal boot error:", err.stack || err);
  process.exit(1);
});
