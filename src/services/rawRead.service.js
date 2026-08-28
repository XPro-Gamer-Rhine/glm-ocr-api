import config from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import PdfRenderer from "./pdf/pdfRenderer.js";
import { ocrPage } from "./ocr/glmOcr.service.js";
import { engineState, refreshEngineState } from "../bootstrap/index.js";

const log = createLogger("raw-read");

/**
 * Reading a document down to text — the one implementation of it.
 *
 * Both callers want exactly this and nothing else: the local HTTP pipeline
 * (`extraction.service.js`) and the agent worker, which claims a file from the
 * product and has no local Extraction record to write progress into. Keeping
 * one copy is not tidiness — a second copy is a second place for the DPI retry
 * rule to drift, and the retry rule is what decides whether a page's amounts
 * exist at all.
 *
 * Deliberately free of storage, job state and models: it takes a path and
 * returns what it read. Callers report progress through the callbacks.
 */

/**
 * A digital page's embedded text layer beats OCR (it IS the document data);
 * scanned pages have no real text layer, so OCR is the only source.
 */
const DIGITAL_PAGE_MIN_CHARS = 200;

/**
 * Fraction of date-led transaction lines that carry at least one money-like
 * number. A statement page where this collapses means the OCR dropped the
 * amount/balance columns at this DPI.
 */
export function ocrMoneyCoverage(markdown) {
  const lines = String(markdown || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}[-/.]\d{1,2})(?:[-/.]\d{2,4})?\s+\S/.test(l));
  const moneyRows = lines.filter((l) => /\d[.,]\d{2}\b|\d,\d{3}/.test(l)).length;
  return { rows: lines.length, moneyRows, coverage: lines.length ? moneyRows / lines.length : 1 };
}

export function choosePageText(embedded, ocrMarkdown) {
  const text = (embedded || "").trim();
  if (text.length >= DIGITAL_PAGE_MIN_CHARS) return embedded;
  return ocrMarkdown || embedded || "";
}

export function pageSourceName(embedded, ocrMarkdown) {
  const text = (embedded || "").trim();
  if (text.length >= DIGITAL_PAGE_MIN_CHARS) return "embedded-text";
  return ocrMarkdown ? "glm-ocr" : "embedded-text";
}

async function mapWithConcurrency(count, limit, worker) {
  const results = new Array(count);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    for (;;) {
      const i = nextIndex++;
      if (i >= count) return;
      results[i] = await worker(i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Read every page of a document.
 *
 * @param {string}   filePath          the PDF on disk
 * @param {object}   opts
 * @param {boolean}  opts.ocr          run GLM-OCR (default true; false = text layer only)
 * @param {string}   opts.label        an id for the log lines
 * @param {Function} opts.onPage       ({page, pageCount, source, characters, retried})
 * @param {Function} opts.onStage      (stage, {progress, note}) — 0..1 within the stage
 * @param {Function} opts.isCancelled  polled between pages; true stops the read
 */
export async function readDocument(filePath, {
  ocr = true,
  label = "read",
  onPage = () => {},
  onStage = () => {},
  isCancelled = () => false,
} = {}) {
  let renderer;
  try {
    renderer = new PdfRenderer(filePath, { dpi: config.extraction.renderDpi });
    const pagesTotal = renderer.pageCount;
    onStage("reading", { progress: 0, note: `Opening ${pagesTotal} page${pagesTotal === 1 ? "" : "s"}` });

    // Embedded text layer — free, and the fallback when OCR is unavailable.
    const embeddedPages = [];
    for (let i = 0; i < pagesTotal; i += 1) embeddedPages.push(renderer.extractPageText(i));

    await refreshEngineState();
    const useOcr = ocr && engineState.serving && engineState.modelReady;
    if (ocr && !useOcr) {
      log.warn(`[${label}] GLM-OCR unavailable (${engineState.lastError || "not ready"}) — embedded text only.`);
    }

    let pagesDone = 0;
    let ocrPages = null;
    if (useOcr) {
      ocrPages = await mapWithConcurrency(pagesTotal, config.extraction.ocrConcurrency, async (i) => {
        if (isCancelled()) return { page: i + 1, markdown: null, durationMs: null, error: "cancelled" };
        let result;
        try {
          const png = renderer.renderPageToPng(i);
          const { markdown, durationMs } = await ocrPage(png);
          result = { page: i + 1, markdown, durationMs, dpi: config.extraction.renderDpi, error: null };
        } catch (err) {
          log.warn(`[${label}] OCR failed on page ${i + 1}: ${err.message}`);
          result = { page: i + 1, markdown: null, durationMs: null, error: err.message };
        }
        pagesDone += 1;
        onPage({
          page: i + 1,
          pageCount: pagesTotal,
          source: result.markdown ? "glm-ocr" : "embedded-text",
          characters: (result.markdown || embeddedPages[i] || "").length,
          retried: false,
        });
        onStage("reading", { progress: pagesDone / pagesTotal });
        return result;
      });

      // GLM-OCR quality varies per (page, DPI): a page can lose its amount
      // columns at one DPI and be perfect at another. Detect pages whose
      // transaction lines carry too few numbers and re-OCR them at the fallback
      // DPI, keeping whichever variant reads more money rows.
      const retryDpi = config.extraction.retryDpi;
      if (retryDpi && retryDpi !== config.extraction.renderDpi) {
        for (let i = 0; i < pagesTotal; i += 1) {
          if (isCancelled()) break;
          const current = ocrPages[i]?.markdown;
          if (!current) continue;
          const quality = ocrMoneyCoverage(current);
          if (quality.rows < 3 || quality.coverage >= 0.6) continue;

          log.warn(
            `[${label}] page ${i + 1}: only ${quality.moneyRows}/${quality.rows} transaction ` +
              `lines carry amounts — retrying at ${retryDpi} DPI`
          );
          try {
            const png = renderer.renderPageToPng(i, retryDpi);
            const { markdown, durationMs } = await ocrPage(png);
            const retryQuality = ocrMoneyCoverage(markdown);
            if (
              retryQuality.moneyRows > quality.moneyRows ||
              (retryQuality.moneyRows === quality.moneyRows && retryQuality.rows > quality.rows)
            ) {
              ocrPages[i] = { page: i + 1, markdown, durationMs, dpi: retryDpi, retried: true, error: null };
              onPage({
                page: i + 1,
                pageCount: pagesTotal,
                source: "glm-ocr",
                characters: markdown.length,
                retried: true,
              });
              log.info(`[${label}] page ${i + 1}: retry kept (${retryQuality.moneyRows}/${retryQuality.rows} money rows).`);
            } else {
              log.info(`[${label}] page ${i + 1}: retry not better, keeping original.`);
            }
          } catch (err) {
            log.warn(`[${label}] page ${i + 1} retry failed: ${err.message}`);
          }
        }
      }
    }

    // Analysis input, chosen per page: a digital page's embedded text layer is
    // authoritative (no OCR errors); OCR covers scanned pages.
    const pages = Array.from({ length: pagesTotal }, (_, i) => ({
      page: i + 1,
      source: pageSourceName(embeddedPages[i], ocrPages?.[i]?.markdown),
      text: choosePageText(embeddedPages[i], ocrPages?.[i]?.markdown),
    }));

    const embeddedCombined = embeddedPages.join("\n\n");
    const ocrCombined = ocrPages ? ocrPages.map((p) => p.markdown || "").join("\n\n") : null;

    return {
      source: useOcr ? "glm-ocr" : "embedded-text",
      model: useOcr ? config.ollama.model : null,
      pageCount: pagesTotal,
      pages,
      embeddedPages,
      ocrPages,
      combined: ocrCombined ?? embeddedCombined,
      characters: (ocrCombined ?? embeddedCombined).length,
      pdfMetadata: renderer.getMetadata(),
      engine: {
        ocrUsed: useOcr,
        model: useOcr ? config.ollama.model : null,
        ollamaVersion: engineState.serverVersion,
        renderDpi: config.extraction.renderDpi,
        reason: ocr && !useOcr ? engineState.lastError || "not ready" : null,
      },
    };
  } finally {
    renderer?.close();
  }
}

export default { readDocument, ocrMoneyCoverage, choosePageText, pageSourceName };
