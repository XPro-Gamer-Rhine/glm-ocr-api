import config from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import Extraction, { EXTRACTION_STATUS } from "../models/extraction.model.js";
import jobQueue from "./jobQueue.js";
import PdfRenderer from "./pdf/pdfRenderer.js";
import { extractStructured } from "./ocr/glmOcr.service.js";
import { readDocument, choosePageText } from "./rawRead.service.js";
import { analyzeDocument, parseAmount, normalizeDate } from "./analysis.service.js";

const log = createLogger("extraction");

/**
 * The LOCAL pipeline — upload straight to this server, no product involved.
 *
 * The reading itself lives in `rawRead.service.js`, shared with the agent
 * worker: one implementation of render → OCR → per-page DPI retry, so the rule
 * that decides whether a page's amounts exist cannot drift between the two
 * entry points. What is here is the part the agent does differently — a local
 * Extraction record, a single-model analysis, and no consensus.
 */

/** Schema handed to GLM-OCR's information-extraction mode for page 1. */
const METADATA_SCHEMA = {
  type: "object",
  properties: {
    company_name: { type: ["string", "null"], description: "Bank / company / issuer name shown on the document" },
    account_name: { type: ["string", "null"], description: "Account holder or customer name" },
    account_number: { type: ["string", "null"], description: "Account, wallet or card number as printed" },
    statement_period_from: { type: ["string", "null"], description: "Statement start date, YYYY-MM-DD" },
    statement_period_to: { type: ["string", "null"], description: "Statement end date, YYYY-MM-DD" },
    currency: { type: ["string", "null"], description: "ISO 4217 currency code, e.g. USD, BDT" },
    opening_balance: { type: ["number", "string", "null"] },
    closing_balance: { type: ["number", "string", "null"] },
  },
};

/** Queue an extraction; resolves when the job finishes (used by ?sync=true). */
export function queueExtraction(id) {
  return jobQueue.enqueue(id, () => runExtraction(id));
}

/** Re-enqueue jobs that were interrupted by a restart. */
export function resumePendingJobs() {
  const interrupted = Extraction.list().filter(
    (doc) => doc.status === EXTRACTION_STATUS.QUEUED || doc.status === EXTRACTION_STATUS.PROCESSING
  );
  for (const doc of interrupted) {
    log.warn(`Resuming interrupted extraction ${doc.id}`);
    Extraction.update(doc.id, { status: EXTRACTION_STATUS.QUEUED });
    queueExtraction(doc.id);
  }
  return interrupted.length;
}

export async function runExtraction(id) {
  const record = Extraction.get(id);
  if (!record) return;

  const startedAt = Date.now();
  Extraction.update(id, {
    status: EXTRACTION_STATUS.PROCESSING,
    timings: { ...record.timings, startedAt: new Date().toISOString() },
  });

  try {
    Extraction.setProgress(id, { stage: "reading", pagesDone: 0, percent: 1 });
    log.info(`[${id}] ${record.file.originalName}`);

    const read = await readDocument(record.file.storedPath, {
      ocr: record.options?.ocr !== false,
      label: id,
      onPage: ({ page, pageCount, retried }) => {
        Extraction.setProgress(id, {
          stage: retried ? `ocr-retry-p${page}` : "ocr",
          pagesTotal: pageCount,
          pagesDone: page,
          percent: 5 + Math.round((page / pageCount) * 85),
        });
      },
    });

    Extraction.setProgress(id, { stage: "analyzing", pagesTotal: read.pageCount, percent: 92 });
    const processed = analyzeDocument(read.pages.map((p) => ({ page: p.page, text: p.text })));
    processed.pageCount = read.pageCount;

    // Optional second pass: GLM-OCR information-extraction on page 1 fills
    // metadata the regex heuristics missed.
    if (read.engine.ocrUsed && config.extraction.llmMetadata) {
      let renderer;
      try {
        Extraction.setProgress(id, { stage: "refining-metadata", percent: 95 });
        renderer = new PdfRenderer(record.file.storedPath, { dpi: config.extraction.renderDpi });
        const structured = await extractStructured(
          renderer.renderPageToPng(0),
          METADATA_SCHEMA,
          "Extract account/statement metadata from this document page."
        );
        mergeLlmMetadata(processed, structured);
      } catch (err) {
        log.warn(`[${id}] Metadata refinement failed: ${err.message}`);
      } finally {
        renderer?.close();
      }
    }

    const raw = {
      source: read.source,
      analysisSources: read.pages.map((p) => p.source),
      pageCount: read.pageCount,
      characters: read.characters,
      text: read.embeddedPages.join("\n\n"),
      textPages: read.embeddedPages,
      ocr: read.ocrPages
        ? { model: read.model, combined: read.combined, pages: read.ocrPages }
        : null,
      pdfMetadata: read.pdfMetadata,
    };

    Extraction.update(id, {
      status: EXTRACTION_STATUS.COMPLETED,
      raw,
      processed,
      engine: read.engine,
      progress: { stage: "done", pagesTotal: read.pageCount, pagesDone: read.pageCount, percent: 100 },
      timings: {
        ...Extraction.get(id).timings,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    });
    log.info(
      `[${id}] completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
        `${processed.documentType}, ${processed.summary.transactionCount} transactions`
    );
  } catch (err) {
    log.error(`[${id}] extraction failed: ${err.stack || err.message}`);
    Extraction.update(id, {
      status: EXTRACTION_STATUS.FAILED,
      error: err.message,
      progress: { ...(Extraction.get(id)?.progress || {}), stage: "failed" },
      timings: {
        ...(Extraction.get(id)?.timings || {}),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    });
  }
}

/**
 * Re-run analysis on already-stored raw data (no re-OCR). Lets parser
 * improvements apply to old extractions instantly.
 */
export function reanalyzeExtraction(id) {
  const record = Extraction.get(id);
  if (!record?.raw) return null;

  const textPages = record.raw.textPages || [];
  const ocrPages = record.raw.ocr?.pages || [];
  const pagesTotal =
    record.raw.pageCount || Math.max(textPages.length, ocrPages.length) || 1;

  const pages = Array.from({ length: pagesTotal }, (_, i) => ({
    page: i + 1,
    text:
      choosePageText(textPages[i], ocrPages[i]?.markdown) ||
      (pagesTotal === 1 ? record.raw.text || "" : ""),
  }));

  const processed = analyzeDocument(pages);
  processed.pageCount = record.raw.pageCount;
  return Extraction.update(id, { status: EXTRACTION_STATUS.COMPLETED, processed, error: null });
}

/** LLM values fill gaps and override low-confidence regex guesses. */
function mergeLlmMetadata(processed, structured) {
  if (!structured || typeof structured !== "object") return;
  const meta = processed.metadata;
  const clean = (v) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);

  meta.companyName = clean(structured.company_name) ?? meta.companyName;
  meta.accountName = clean(structured.account_name) ?? meta.accountName;
  meta.accountNumber = clean(structured.account_number) ?? meta.accountNumber;
  meta.currency = clean(structured.currency)?.toUpperCase() ?? meta.currency;

  const from = normalizeDate(clean(structured.statement_period_from)) ?? clean(structured.statement_period_from);
  const to = normalizeDate(clean(structured.statement_period_to)) ?? clean(structured.statement_period_to);
  if (from || to) meta.statementPeriod = { from: from ?? meta.statementPeriod?.from ?? null, to: to ?? meta.statementPeriod?.to ?? null };

  const opening = typeof structured.opening_balance === "number" ? structured.opening_balance : parseAmount(structured.opening_balance);
  const closing = typeof structured.closing_balance === "number" ? structured.closing_balance : parseAmount(structured.closing_balance);
  if (processed.summary.openingBalance === null && opening !== null) processed.summary.openingBalance = opening;
  if (processed.summary.closingBalance === null && closing !== null) {
    processed.summary.closingBalance = closing;
    processed.summary.totalBalance = closing;
  }
  if (meta.currency && processed.summary.currency === null) processed.summary.currency = meta.currency;
  processed.metadataRefinedByModel = true;
}
