import { createLogger } from "../utils/logger.js";

const log = createLogger("queue");

/**
 * In-process FIFO job queue. OCR is compute-heavy, so extraction jobs run
 * one at a time; page-level concurrency inside a job is handled by the
 * extraction service. Swap for BullMQ/Redis later if multi-process is needed.
 */
class JobQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.pending = [];
    this.active = 0;
  }

  /** Returns a promise that settles when the job itself has finished. */
  enqueue(jobId, run) {
    return new Promise((resolve) => {
      this.pending.push({ jobId, run, resolve });
      log.info(`Job ${jobId} queued (${this.pending.length} pending).`);
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const { jobId, run, resolve } = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(run)
        .catch((err) => log.error(`Job ${jobId} crashed: ${err.stack || err.message}`))
        .finally(() => {
          this.active -= 1;
          resolve();
          this.#drain();
        });
    }
  }

  get stats() {
    return { active: this.active, pending: this.pending.length };
  }
}

export default new JobQueue({ concurrency: 1 });
