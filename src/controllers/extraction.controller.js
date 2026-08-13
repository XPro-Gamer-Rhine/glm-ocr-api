import ApiError from "../utils/ApiError.js";
import { sendSuccess } from "../utils/apiResponse.js";
import Extraction, { EXTRACTION_STATUS } from "../models/extraction.model.js";
import { queueExtraction, reanalyzeExtraction } from "../services/extraction.service.js";

function getRecordOr404(id) {
  const record = Extraction.get(id);
  if (!record) throw ApiError.notFound(`No extraction found with id "${id}".`);
  return record;
}

function links(id) {
  return {
    self: `/api/v1/extract/statements/${id}`,
    raw: `/api/v1/extract/statements/${id}/raw`,
    processed: `/api/v1/extract/statements/${id}/processed`,
  };
}

/**
 * POST /api/v1/extractions
 * Multipart upload (field "file"). Queues OCR + analysis and returns 202.
 * Add ?sync=true to block until the extraction finishes (small PDFs only).
 */
export async function createExtraction(req, res) {
  const id = req.extractionId;
  // ?ocr=false skips GLM-OCR and uses only the embedded text layer —
  // instant for digital PDFs; scanned PDFs need OCR (the default).
  Extraction.create({ id, file: req.file, options: { ocr: req.query.ocr !== "false" } });
  const done = queueExtraction(id);

  if (req.query.sync === "true") {
    await done;
    const record = getRecordOr404(id);
    return sendSuccess(res, { ...record, links: links(id) }, record.status === EXTRACTION_STATUS.FAILED ? 200 : 201);
  }

  return sendSuccess(
    res,
    {
      id,
      status: EXTRACTION_STATUS.QUEUED,
      file: { originalName: req.file.originalname, sizeBytes: req.file.size },
      links: links(id),
    },
    202
  );
}

/** GET /api/v1/extractions — newest-first summaries. */
export function listExtractions(_req, res) {
  const items = Extraction.list();
  return sendSuccess(res, items, 200, { count: items.length });
}

/** GET /api/v1/extractions/:id — full record: status, progress, raw + processed. */
export function getExtraction(req, res) {
  const record = getRecordOr404(req.params.id);
  return sendSuccess(res, { ...record, links: links(record.id) });
}

/**
 * For sub-resource routes: completed -> null (proceed), failed -> 422 error,
 * queued/processing -> 202 with progress so clients can poll the same URL.
 */
function respondIfNotReady(record, res) {
  if (record.status === EXTRACTION_STATUS.FAILED) {
    throw ApiError.unprocessable(`Extraction failed: ${record.error}`, {
      details: { id: record.id },
    });
  }
  if (record.status !== EXTRACTION_STATUS.COMPLETED) {
    sendSuccess(res, { id: record.id, status: record.status, progress: record.progress }, 202);
    return true;
  }
  return false;
}

/** GET /api/v1/extractions/:id/raw — raw OCR + embedded text only. */
export function getRawData(req, res) {
  const record = getRecordOr404(req.params.id);
  if (respondIfNotReady(record, res)) return;
  return sendSuccess(res, { id: record.id, file: record.file, raw: record.raw });
}

/** GET /api/v1/extractions/:id/processed — structured data + analysis only. */
export function getProcessedData(req, res) {
  const record = getRecordOr404(req.params.id);
  if (respondIfNotReady(record, res)) return;
  return sendSuccess(res, { id: record.id, file: record.file, processed: record.processed });
}

/**
 * POST /api/v1/extractions/:id/reanalyze — re-run the analysis stage on
 * stored raw data without re-OCR (instant; useful after parser upgrades).
 */
export function reanalyze(req, res) {
  const record = getRecordOr404(req.params.id);
  if (!record.raw) {
    throw ApiError.unprocessable("No raw data stored yet — the extraction has not completed.");
  }
  const updated = reanalyzeExtraction(record.id);
  return sendSuccess(res, { id: updated.id, processed: updated.processed });
}

/** DELETE /api/v1/extractions/:id — remove record and stored PDF. */
export function deleteExtraction(req, res) {
  const record = getRecordOr404(req.params.id);
  if (record.status === EXTRACTION_STATUS.PROCESSING) {
    throw new ApiError(409, "Cannot delete an extraction while it is processing.");
  }
  Extraction.delete(record.id);
  return sendSuccess(res, { id: record.id, deleted: true });
}
