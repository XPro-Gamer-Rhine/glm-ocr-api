import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function str(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(value.toLowerCase());
}

const dataDir = path.isAbsolute(str("DATA_DIR", "storage"))
  ? str("DATA_DIR", "storage")
  : path.join(ROOT_DIR, str("DATA_DIR", "storage"));

const config = Object.freeze({
  rootDir: ROOT_DIR,

  server: Object.freeze({
    port: num("PORT", 4000),
    host: str("HOST", "0.0.0.0"),
  }),

  logLevel: str("LOG_LEVEL", "info"),

  ollama: Object.freeze({
    host: str("OLLAMA_HOST", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: str("GLM_OCR_MODEL", "glm-ocr:latest"),
  }),

  bootstrap: Object.freeze({
    autoInstall: bool("AUTO_INSTALL", true),
    autoPullModel: bool("AUTO_PULL_MODEL", true),
    autoStartOllama: bool("AUTO_START_OLLAMA", true),
  }),

  extraction: Object.freeze({
    maxFileSizeBytes: num("MAX_FILE_SIZE_MB", 500) * 1024 * 1024,
    // 1 = strictly one page at a time, in order. Local Ollama serializes
    // requests anyway, and sequential pages keep memory flat and progress
    // monotonic on huge PDFs. Raise only for remote/parallel Ollama.
    ocrConcurrency: Math.max(1, num("OCR_CONCURRENCY", 1)),
    // 200 DPI: tested materially better than 150 on scanned statements
    // (fewer merged/dropped rows); 250 gave identical output to 200.
    renderDpi: num("RENDER_DPI", 200),
    // Pages whose amount columns come back empty are re-OCR'd at this DPI.
    retryDpi: num("RETRY_DPI", 150),
    ocrTimeoutMs: num("OCR_TIMEOUT_MS", 180000),
    llmMetadata: bool("LLM_METADATA", true),
  }),

  storage: Object.freeze({
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    extractionsDir: path.join(dataDir, "data", "extractions"),
  }),
});

export default config;
