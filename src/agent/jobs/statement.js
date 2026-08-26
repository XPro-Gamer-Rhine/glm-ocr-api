import { readDocument } from "../../services/rawRead.service.js";
import { downloadJobFile, cleanupJobFile } from "../download.js";
import { runConsensus } from "../consensus/index.js";

/**
 * One statement, end to end.
 *
 * The pipeline in full:
 *
 *   claim ─► download ─► GLM-OCR every page ─► deliver the raw read
 *                                                   │
 *                          ┌────────────────────────┼────────────────────────┐
 *                       Claude                     GPT                     GLM
 *                          └────────────────────────┼────────────────────────┘
 *                                          two of three must agree
 *                                                   ▼
 *                                       reconcile against the
 *                                     statement's own arithmetic
 *                                                   ▼
 *                                         resolve to the product
 *
 * GLM-OCR is the only thing that sees the PAGE; the three voters only ever see
 * its text. That is deliberate: the OCR model is specialized for reading
 * documents and the reasoning models are not, and asking three general models
 * to squint at a scan would produce three different transcription errors on top
 * of the extraction errors this is meant to catch.
 *
 * A new document type is a sibling of this file plus one registry entry on the
 * API — nothing in the worker changes.
 */

export const kind = "statement";

export async function run({ job, events, signal, log = () => {} }) {
  const payload = job.payload || {};
  let filePath = null;

  try {
    // ── 1. The bytes ──────────────────────────────────────────────────────
    events.stage("fetching", { progress: 0, note: "Fetching the document" });
    const file = await downloadJobFile(job, { env: job.__env, signal });
    filePath = file.path;
    events.stage("fetching", {
      progress: 1,
      note: `Got ${job.file?.originalName || "the document"} (${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    });

    // ── 2. The read ───────────────────────────────────────────────────────
    const read = await readDocument(filePath, {
      ocr: payload.ocr !== false,
      label: String(job._id || job.id),
      isCancelled: () => Boolean(signal?.aborted),
      onPage: (p) => events.page(p),
      onStage: (stage, info) => events.stage(stage, info),
    });

    if (signal?.aborted) throw new Error("cancelled");

    if (!read.pageCount) throw new Error("that file has no pages this reader can open");

    const emptyPages = read.pages.filter((p) => !p.text || !p.text.trim()).length;
    if (emptyPages === read.pageCount) {
      throw new Error(
        read.engine.ocrUsed
          ? "every page came back blank — the scan may be too low-resolution to read"
          : `every page came back blank and OCR was unavailable${read.engine.reason ? ` (${read.engine.reason})` : ""}`
      );
    }
    if (emptyPages) {
      log(`${emptyPages} of ${read.pageCount} pages came back blank.`);
      events.trace(`${emptyPages} of ${read.pageCount} pages produced no text.`);
    }

    // ── 3. The evidence, delivered before the verdict ─────────────────────
    // Sent first on purpose: if the vote falls over, the product still holds
    // what was actually read, and a re-run costs the models but not the OCR.
    const raw = {
      source: read.source,
      model: read.model,
      pageCount: read.pageCount,
      characters: read.characters,
      pages: read.pages.map((p) => ({ page: p.page, source: p.source, text: p.text })),
    };

    // ── 4. The vote ───────────────────────────────────────────────────────
    const result = await runConsensus({
      pages: read.pages,
      hints: {
        currency: payload.currencyHint || null,
        period: payload.periodHint || null,
        note: payload.note || null,
      },
      events,
      signal,
      log,
    });

    events.data({
      documentType: result.consensus.documentType,
      metadata: result.consensus.metadata,
      summary: result.consensus.summary,
      reconciliation: result.reconciliation,
    });
    events.usage(result.usage);

    return {
      raw,
      summary: summarize(result, read),
      result: {
        ...result,
        engine: read.engine,
        pageCount: read.pageCount,
      },
    };
  } finally {
    cleanupJobFile(filePath);
  }
}

/**
 * One sentence for the upload screen, in the words an accountant uses.
 *
 * Never mentions a model by name, a chunk, a token or a route. What it does say
 * is whether the figures can be trusted without opening the PDF — which is the
 * only question the person uploading actually has.
 */
function summarize(result, read) {
  const s = result.consensus.summary;
  const money = (v) =>
    v === null || v === undefined
      ? "—"
      : `${s.currency ? `${s.currency} ` : ""}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const head =
    `${s.transactionCount} transaction${s.transactionCount === 1 ? "" : "s"} across ` +
    `${read.pageCount} page${read.pageCount === 1 ? "" : "s"}, ` +
    `${money(s.totalCredits)} in and ${money(s.totalDebits)} out`;

  if (result.verdict === "extracted") {
    const proof = result.reconciliation.provablyComplete
      ? " and they match the statement's own totals"
      : "";
    return `${head}. All three readings agree${proof}.`;
  }

  const reasons = [];
  const fieldDisputes = result.disputes.filter((d) => d.kind === "field").length;
  const rowDisputes = result.disputes.length - fieldDisputes;
  if (fieldDisputes) reasons.push(`${fieldDisputes} detail${fieldDisputes === 1 ? "" : "s"} read differently`);
  if (rowDisputes) reasons.push(`${rowDisputes} row${rowDisputes === 1 ? "" : "s"} not confirmed`);
  if (result.reconciliation.statedTotals.ok === false) reasons.push("the totals do not match the statement's own");
  if (result.reconciliation.openingNetClosing.ok === false) reasons.push("the opening and closing balances do not reconcile");
  if (result.reconciliation.balanceChain.ok === false) {
    reasons.push(`the balance column breaks in ${result.reconciliation.balanceChain.breakCount} place(s)`);
  }

  return `${head}. Needs a look: ${reasons.join("; ") || "the readings did not agree"}.`;
}

export default { kind, run };
