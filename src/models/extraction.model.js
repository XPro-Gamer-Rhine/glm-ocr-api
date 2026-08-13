import fs from "node:fs";
import config from "../config/index.js";
import JsonStore from "./store.js";

export const EXTRACTION_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
});

const store = new JsonStore(config.storage.extractionsDir);

const Extraction = {
  create({ id, file, options = {} }) {
    const now = new Date().toISOString();
    return store.save({
      id,
      status: EXTRACTION_STATUS.QUEUED,
      options: { ocr: options.ocr !== false },
      file: {
        originalName: file.originalname,
        storedPath: file.path,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        uploadedAt: now,
      },
      progress: { stage: "queued", pagesTotal: null, pagesDone: 0, percent: 0 },
      engine: null,
      raw: null,
      processed: null,
      error: null,
      timings: { queuedAt: now, startedAt: null, completedAt: null, durationMs: null },
    });
  },

  get(id) {
    return store.get(id);
  },

  update(id, patch) {
    const current = store.get(id);
    if (!current) return null;
    return store.save({ ...current, ...patch, id });
  },

  setProgress(id, progress) {
    const current = store.get(id);
    if (!current) return null;
    return store.save({ ...current, progress: { ...current.progress, ...progress } });
  },

  list() {
    return store
      .list()
      .sort((a, b) => (b.timings?.queuedAt || "").localeCompare(a.timings?.queuedAt || ""))
      .map((doc) => Extraction.toSummary(doc));
  },

  delete(id) {
    const doc = store.get(id);
    if (doc?.file?.storedPath) fs.rmSync(doc.file.storedPath, { force: true });
    store.delete(id);
  },

  /** Compact shape for list endpoints — no raw/processed payloads. */
  toSummary(doc) {
    return {
      id: doc.id,
      status: doc.status,
      file: {
        originalName: doc.file?.originalName,
        sizeBytes: doc.file?.sizeBytes,
        uploadedAt: doc.file?.uploadedAt,
      },
      progress: doc.progress,
      documentType: doc.processed?.documentType ?? null,
      transactionCount: doc.processed?.summary?.transactionCount ?? null,
      error: doc.error,
    };
  },
};

export default Extraction;
