import { EVENT } from "./events.js";

/**
 * The agent's report line back to the product.
 *
 * The browser never connects to this machine. It watches an extraction through
 * the product API, which persists every event this relay delivers — so the
 * relay is not a nicety, it IS the user's view. If nothing arrives, a
 * forty-minute OCR run looks frozen from the dashboard however well it is
 * going here.
 *
 * Design constraints, inherited from the helper agent's relay:
 *
 *   ORDER.   Events are a narrative; a verdict before the pages were read
 *            reads as nonsense. One in-flight request per job, always sending
 *            the oldest unacknowledged batch.
 *   LOSS.    A failed POST keeps the batch queued and retries with backoff.
 *            The API dedupes on the agent's own seq, so a retried batch lands
 *            exactly once in order (the queue never reorders).
 *   ENDINGS. ocr:done flushes immediately — it is the event that flips the UI
 *            from a progress bar to the figures, and it must not sit in a timer.
 *   ABSENCE. Unconfigured (no API url or token) the relay is inert and free.
 */

const BATCH_MS = 400;
const MAX_BATCH = 50;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

export const INTERNAL = "/api/v1/internal/ocr-agent";

export class ApiRelay {
  constructor({ baseUrl = "", token = "", kind = "statement", log = () => {} } = {}) {
    this.base = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.kind = kind;
    this.log = log;
    /** Have we already said we cannot reach the API? Say it once, not per batch. */
    this.warned = false;
    /** jobId → { queue: [], timer, inFlight, retryMs, kind } */
    this.jobs = new Map();
  }

  enabled() {
    return Boolean(this.base && this.token);
  }

  /** Queue one event for a job. Cheap enough to call for every page. */
  push(jobId, event, kind = this.kind) {
    if (!this.enabled()) return;
    let state = this.jobs.get(jobId);
    if (!state) {
      state = { queue: [], timer: null, inFlight: false, retryMs: RETRY_BASE_MS, kind };
      this.jobs.set(jobId, state);
    }
    state.queue.push(event);

    if (event && event.type === EVENT.DONE) {
      // The ending never waits for the batch window.
      void this.flush(jobId);
      return;
    }
    if (!state.timer && !state.inFlight) {
      state.timer = setTimeout(() => void this.flush(jobId), BATCH_MS);
      if (state.timer.unref) state.timer.unref();
    }
  }

  async flush(jobId) {
    const state = this.jobs.get(jobId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.inFlight || !state.queue.length) return;

    const batch = state.queue.slice(0, MAX_BATCH);
    state.inFlight = true;
    try {
      const res = await fetch(
        `${this.base}${INTERNAL}/jobs/${encodeURIComponent(state.kind)}/${encodeURIComponent(jobId)}/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ocr-agent-token": this.token,
          },
          body: JSON.stringify({ events: batch }),
        }
      );
      // 404 means the product no longer has this job — someone deleted it.
      // Retrying forever would spam a dead id for the life of the process.
      if (res.status === 404) {
        this.jobs.delete(jobId);
        return;
      }
      if (!res.ok) throw new Error(`the API answered ${res.status}`);
      // Acknowledged — only now do the events leave the queue.
      state.queue.splice(0, batch.length);
      if (this.warned) {
        this.warned = false;
        this.log("Progress is reaching Dime again.");
      }
      state.retryMs = RETRY_BASE_MS;
      state.inFlight = false;
      if (state.queue.length) return this.flush(jobId);
      if (batch.some((e) => e && e.type === EVENT.DONE)) this.jobs.delete(jobId);
    } catch (err) {
      state.inFlight = false;
      // Named plainly and only worth saying once per outage — the events are
      // queued, not lost, and they go out when the API answers again.
      if (!this.warned) {
        this.warned = true;
        this.log(
          `Can't send progress to Dime (${err.message}) — it is queued and will go out when Dime answers.`
        );
      }
      const wait = state.retryMs;
      state.retryMs = Math.min(state.retryMs * 2, RETRY_MAX_MS);
      state.timer = setTimeout(() => void this.flush(jobId), wait);
      if (state.timer.unref) state.timer.unref();
    }
  }

  /** Everything still queued, sent now. Called before a job is resolved. */
  async drain() {
    await Promise.all([...this.jobs.keys()].map((jobId) => this.flush(jobId)));
  }
}

export default { ApiRelay, INTERNAL };
