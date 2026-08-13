import config from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import Extraction, { EXTRACTION_STATUS } from "../models/extraction.model.js";
import jobQueue from "./jobQueue.js";
import PdfRenderer from "./pdf/pdfRenderer.js";
import { ocrPage, extractStructured } from "./ocr/glmOcr.service.js";
import { analyzeDocument, parseAmount, normalizeDate } from "./analysis.service.js";
import { engineState, refreshEngineState } from "../bootstrap/index.js";

const log = createLogger("extraction");

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

/**
 * Fraction of date-led transaction lines that carry at least one money-like
 * number. A statement page where this collapses means the OCR dropped the
 * amount/balance columns at this DPI.
 */
function ocrMoneyCoverage(markdown) {
  const lines = markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}[-/.]\d{1,2})(?:[-/.]\d{2,4})?\s+\S/.test(l));
  const moneyRows = lines.filter((l) => /\d[.,]\d{2}\b|\d,\d{3}/.test(l)).length;
  return { rows: lines.length, moneyRows, coverage: lines.length ? moneyRows / lines.length : 1 };
}

async function mapWithConcurrency(count, limit, worker) {
  const results = new Array(count);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= count) return;
      results[i] = await worker(i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runExtraction(id) {
  const record = Extraction.get(id);
  if (!record) return;

  const startedAt = Date.now();
  Extraction.update(id, {
    status: EXTRACTION_STATUS.PROCESSING,
    timings: { ...record.timings, startedAt: new Date().toISOString() },
  });

  let renderer;
  try {
    renderer = new PdfRenderer(record.file.storedPath, { dpi: config.extraction.renderDpi });
    const pagesTotal = renderer.pageCount;
    Extraction.setProgress(id, { stage: "reading", pagesTotal, pagesDone: 0, percent: 1 });
    log.info(`[${id}] ${record.file.originalName}: ${pagesTotal} pages`);

    // Embedded text layer — free, and the fallback when OCR is unavailable.
    const embeddedPages = [];
    for (let i = 0; i < pagesTotal; i += 1) {
      embeddedPages.push(renderer.extractPageText(i));
    }

    await refreshEngineState();
    const wantOcr = record.options?.ocr !== false;
    const useOcr = wantOcr && engineState.serving && engineState.modelReady;
    if (wantOcr && !useOcr) {
      log.warn(`[${id}] GLM-OCR unavailable (${engineState.lastError || "not ready"}) — embedded text only.`);
    }

    // OCR every page through GLM-OCR, a few pages in flight at a time.
    let pagesDone = 0;
    let ocrPages = null;
    if (useOcr) {
      Extraction.setProgress(id, { stage: "ocr", percent: 5 });
      ocrPages = await mapWithConcurrency(pagesTotal, config.extraction.ocrConcurrency, async (i) => {
        let result;
        try {
          const png = renderer.renderPageToPng(i);
          const { markdown, durationMs } = await ocrPage(png);
          result = { page: i + 1, markdown, durationMs, dpi: config.extraction.renderDpi, error: null };
        } catch (err) {
          log.warn(`[${id}] OCR failed on page ${i + 1}: ${err.message}`);
          result = { page: i + 1, markdown: null, durationMs: null, error: err.message };
        }
        pagesDone += 1;
        Extraction.setProgress(id, {
          pagesDone,
          percent: 5 + Math.round((pagesDone / pagesTotal) * 85),
        });
        return result;
      });

      // GLM-OCR quality varies per (page, DPI): a page can lose its amount
      // columns at one DPI and be perfect at another. Detect pages whose
      // transaction lines carry too few numbers and re-OCR them at the
      // fallback DPI, keeping whichever variant reads more money rows.
      const retryDpi = config.extraction.retryDpi;
      if (retryDpi && retryDpi !== config.extraction.renderDpi) {
        for (let i = 0; i < pagesTotal; i += 1) {
          const current = ocrPages[i]?.markdown;
          if (!current) continue;
          const quality = ocrMoneyCoverage(current);
          if (quality.rows < 3 || quality.coverage >= 0.6) continue;

          log.warn(
            `[${id}] page ${i + 1}: only ${quality.moneyRows}/${quality.rows} transaction ` +
              `lines carry amounts — retrying at ${retryDpi} DPI`
          );
          Extraction.setProgress(id, { stage: `ocr-retry-p${i + 1}` });
          try {
            const png = renderer.renderPageToPng(i, retryDpi);
            const { markdown, durationMs } = await ocrPage(png);
            const retryQuality = ocrMoneyCoverage(markdown);
            if (
              retryQuality.moneyRows > quality.moneyRows ||
              (retryQuality.moneyRows === quality.moneyRows && retryQuality.rows > quality.rows)
            ) {
              ocrPages[i] = { page: i + 1, markdown, durationMs, dpi: retryDpi, retried: true, error: null };
              log.info(`[${id}] page ${i + 1}: retry kept (${retryQuality.moneyRows}/${retryQuality.rows} money rows).`);
            } else {
              log.info(`[${id}] page ${i + 1}: retry not better, keeping original.`);
            }
          } catch (err) {
            log.warn(`[${id}] page ${i + 1} retry failed: ${err.message}`);
          }
        }
      }
    }

    // Analysis input, chosen per page: a digital page's embedded text layer is
    // authoritative (no OCR errors); OCR covers scanned pages.
    Extraction.setProgress(id, { stage: "analyzing", percent: 92 });
    const analysisPages = Array.from({ length: pagesTotal }, (_, i) => ({
      page: i + 1,
      text: choosePageText(embeddedPages[i], ocrPages?.[i]?.markdown),
    }));
    const analysisSources = Array.from({ length: pagesTotal }, (_, i) =>
      pageSourceName(embeddedPages[i], ocrPages?.[i]?.markdown)
    );
    const processed = analyzeDocument(analysisPages);
    processed.pageCount = pagesTotal;

    // Optional second pass: GLM-OCR information-extraction on page 1
    // fills metadata the regex heuristics missed.
    if (useOcr && config.extraction.llmMetadata) {
      try {
        Extraction.setProgress(id, { stage: "refining-metadata", percent: 95 });
        const structured = await extractStructured(
          renderer.renderPageToPng(0),
          METADATA_SCHEMA,
          "Extract account/statement metadata from this document page."
        );
        mergeLlmMetadata(processed, structured);
      } catch (err) {
        log.warn(`[${id}] Metadata refinement failed: ${err.message}`);
      }
    }

    const embeddedCombined = embeddedPages.join("\n\n");
    const ocrCombined = ocrPages
      ? ocrPages.map((p) => p.markdown || "").join("\n\n")
      : null;

    const raw = {
      source: useOcr ? "glm-ocr" : "embedded-text",
      analysisSources,
      pageCount: pagesTotal,
      characters: (ocrCombined ?? embeddedCombined).length,
      text: embeddedCombined,
      textPages: embeddedPages,
      ocr: ocrPages
        ? { model: config.ollama.model, combined: ocrCombined, pages: ocrPages }
        : null,
      pdfMetadata: renderer.getMetadata(),
    };

    Extraction.update(id, {
      status: EXTRACTION_STATUS.COMPLETED,
      raw,
      processed,
      engine: {
        ocrUsed: useOcr,
        model: useOcr ? config.ollama.model : null,
        ollamaVersion: engineState.serverVersion,
        renderDpi: config.extraction.renderDpi,
      },
      progress: { stage: "done", pagesTotal, pagesDone: pagesTotal, percent: 100 },
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
  } finally {
    renderer?.close();
  }
}

/**
 * A digital page's embedded text layer beats OCR (it IS the document data);
 * scanned pages have no real text layer, so OCR is the only source.
 */
const DIGITAL_PAGE_MIN_CHARS = 200;

function choosePageText(embedded, ocrMarkdown) {
  const text = (embedded || "").trim();
  if (text.length >= DIGITAL_PAGE_MIN_CHARS) return embedded;
  return ocrMarkdown || embedded || "";
}

function pageSourceName(embedded, ocrMarkdown) {
  const text = (embedded || "").trim();
  if (text.length >= DIGITAL_PAGE_MIN_CHARS) return "embedded-text";
  return ocrMarkdown ? "glm-ocr" : "embedded-text";
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
