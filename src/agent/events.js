import { EventEmitter } from "node:events";

/**
 * The event contract — everything the product (and therefore the upload screen)
 * learns about an extraction travels as one of these.
 *
 * The dashboard never connects to this machine. It watches an extraction
 * through the product API, which persists every event the relay delivers — so
 * this contract is the UI's data model, not an internal detail.
 *
 * Two audiences, two channels, the same rule as the helper agent:
 *   - `ocr:stage` and `ocr:page` are for the person watching a bar move. Plain
 *     language, no model names, no file paths.
 *   - `ocr:vote` and `ocr:trace` carry the evidence trail — which model said
 *     what, where they differed — folded away for whoever wants to audit it.
 */

export const EVENT = Object.freeze({
  START: "ocr:start",       // claimed, and what was claimed
  STAGE: "ocr:stage",       // a step of the pipeline, with a percentage
  PAGE: "ocr:page",         // one page read, with how it was read
  VOTE: "ocr:vote",         // one analyst's verdict on one chunk
  DISPUTE: "ocr:dispute",   // a field or a row the models did not agree on
  DATA: "ocr:data",         // the agreed figures, as they firm up
  TRACE: "ocr:trace",       // technical detail, folded away
  USAGE: "ocr:usage",       // what the three voters cost
  DONE: "ocr:done",         // the verdict
});

export const JOB_STATUS = Object.freeze({
  RUNNING: "running",
  /** The models agreed. The figures are the product's to use. */
  EXTRACTED: "extracted",
  /** They did not. The data is complete and every dissent is recorded. */
  NEEDS_REVIEW: "needs_review",
  FAILED: "failed",
  STOPPED: "stopped",
});

/** The stages, in order, with the share of the bar each one owns. */
export const STAGES = Object.freeze({
  fetching: { label: "Fetching the document", from: 0, to: 5 },
  reading: { label: "Reading the pages", from: 5, to: 60 },
  analyzing: { label: "Three models reading the data", from: 60, to: 92 },
  reconciling: { label: "Comparing what they found", from: 92, to: 99 },
  done: { label: "Done", from: 100, to: 100 },
});

export class OcrEvents extends EventEmitter {
  constructor({ jobId, kind, onEvent = null } = {}) {
    super();
    this.jobId = jobId;
    this.kind = kind;
    this.seq = 0;
    this.events = [];
    if (onEvent) this.on("event", onEvent);
  }

  /** Append one event: stamped, sequenced, kept, emitted. */
  emitEvent(type, body = {}) {
    const event = {
      seq: this.seq++,
      type,
      at: new Date().toISOString(),
      jobId: this.jobId,
      kind: this.kind,
      ...body,
    };
    this.events.push(event);
    this.emit("event", event);
    return event;
  }

  start(body = {}) {
    return this.emitEvent(EVENT.START, body);
  }

  /**
   * A step of the pipeline. `percent` is computed from the stage's own share of
   * the bar, so a stage that runs long never overshoots the next one — a bar
   * that jumps backwards reads as a restart to the person watching.
   */
  stage(stage, { note = null, progress = 0, ...rest } = {}) {
    const spec = STAGES[stage] || { label: stage, from: 0, to: 100 };
    const clamped = Math.max(0, Math.min(1, progress));
    return this.emitEvent(EVENT.STAGE, {
      stage,
      note: note || spec.label,
      percent: Math.round(spec.from + (spec.to - spec.from) * clamped),
      ...rest,
    });
  }

  page({ page, pageCount, source, characters = null, retried = false }) {
    return this.emitEvent(EVENT.PAGE, { page, pageCount, source, characters, retried });
  }

  vote({ analyst, chunk, chunks, transactions = null, ok = true, error = null, durationMs = null }) {
    return this.emitEvent(EVENT.VOTE, { analyst, chunk, chunks, transactions, ok, error, durationMs });
  }

  dispute({ field, kind = "field", values = [], resolution = null }) {
    return this.emitEvent(EVENT.DISPUTE, { field, disputeKind: kind, values, resolution });
  }

  data(payload) {
    return this.emitEvent(EVENT.DATA, { data: payload && typeof payload === "object" ? payload : {} });
  }

  trace(text) {
    return this.emitEvent(EVENT.TRACE, { text: String(text || "") });
  }

  usage(usage) {
    return this.emitEvent(EVENT.USAGE, { usage });
  }

  done({ status, summary = null, durationMs = null, error = null }) {
    return this.emitEvent(EVENT.DONE, { status, summary, durationMs, error });
  }
}

export default { OcrEvents, EVENT, JOB_STATUS, STAGES };
