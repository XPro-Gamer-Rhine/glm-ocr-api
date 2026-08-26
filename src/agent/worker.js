import os from "node:os";
import agentConfig from "./config.js";
import * as envScope from "./env.js";
import { OcrEvents, JOB_STATUS } from "./events.js";
import { ApiRelay, INTERNAL } from "./apiRelay.js";
import { analystStatus } from "./consensus/index.js";
import statementJob from "./jobs/statement.js";

/**
 * The worker loop — this machine's only relationship with the product.
 *
 * Nothing dials this machine, and nothing can: it sits behind NAT with no
 * inbound route, which is exactly why every connection here is OUTBOUND. The
 * loop asks for work, does it, says what happened, and says it is alive. That
 * works from any network, behind any VPN or CGNAT, with no tunnel,
 * port-forward or firewall rule — the same inverted architecture as the
 * month-end close agent and the helper agent, against a third set of internal
 * routes:
 *
 *   claim ──► download ──► OCR ──► three models vote ──► resolve
 *     ▲                                                     │
 *     └─────────────── idle, heartbeat, repeat ─────────────┘
 *
 * From the outside, nobody can tell what read the statement — the dashboard
 * only ever sees the product's own API.
 */

/** Every document type this worker knows how to run. */
const HANDLERS = new Map([[statementJob.kind, statementJob]]);

/** One line of it, for the operator's terminal. */
const clipLine = (text, n) => {
  const one = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const WORKER_ID = agentConfig.worker.id || os.hostname();

const headers = (env) => ({
  "Content-Type": "application/json",
  "x-ocr-agent-token": env.bridgeToken,
});

/** Every call names its backend — inside a job that is the one it was claimed from. */
async function post(path, body, env = envScope.current()) {
  const res = await fetch(`${env.apiBaseUrl}${INTERNAL}${path}`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(body || {}),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function get(path, env = envScope.current()) {
  const res = await fetch(`${env.apiBaseUrl}${INTERNAL}${path}`, { headers: headers(env) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * How many files this machine reads at once, across ALL backends. The limit
 * being SHARED is the point: adding QA and production does not multiply the
 * machine — and OCR plus three models already saturates it at one.
 */
class Slots {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.busy = 0;
    this.waiting = [];
  }

  async take() {
    if (this.busy < this.limit) {
      this.busy += 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.busy += 1;
  }

  release() {
    this.busy = Math.max(0, this.busy - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
}

export class OcrWorker {
  constructor({ onLine = () => {}, env = null, slots = null } = {}) {
    // Which backend this loop watches. One OcrWorker per configured backend,
    // all in one process; `startWorkers` below builds them.
    this.env = env || agentConfig.environments[0];
    // Prefix every line with the backend when there is more than one, so
    // "picked up a statement" says WHOSE statement.
    this.onLine = (msg) =>
      onLine(agentConfig.environments.length > 1 ? `[${this.env.id}] ${msg}` : msg);
    this.slots = slots || new Slots(agentConfig.worker.maxConcurrentJobs);
    this.relay = new ApiRelay({
      baseUrl: this.env.apiBaseUrl,
      token: this.env.bridgeToken,
      log: this.onLine,
    });
    this.stats = { resolved: 0, failed: 0 };
    this.stopped = false;
    this.heartbeatTimer = null;
    /** jobId → { controller } for everything this worker is running right now. */
    this.current = new Map();
    /** Whether the last poll reached the API — so we speak only on CHANGE. */
    this.reachable = true;
    /** What this machine can actually run, refreshed at boot and on each beat. */
    this.engines = {};
  }

  async start() {
    if (!this.env.bridgeToken) {
      this.onLine(
        `No OCR_BRIDGE_TOKEN for ${this.env.id} — this backend's jobs cannot be claimed (it must equal OCR_AGENT_TOKEN on that API).`
      );
      return;
    }

    // What this machine can actually run, said out loud at boot rather than
    // discovered by a job failing at the vote after forty minutes of OCR.
    this.engines = await analystStatus();
    const missing = Object.entries(this.engines).filter(([, e]) => e.enabled && !e.ok);
    for (const [id, e] of missing) this.onLine(`${e.label || id} is not available — ${e.reason}`);
    const usable = Object.values(this.engines).filter((e) => e.ok).length;
    if (usable < agentConfig.consensus.quorum) {
      this.onLine(
        `Only ${usable} of the three readers can run, and ${agentConfig.consensus.quorum} must agree — jobs will be claimed and fail. Fix the above first.`
      );
    }

    await this.post("/workers/register", {
      workerId: WORKER_ID,
      host: os.hostname(),
      version: "1.0.0",
      kinds: agentConfig.kinds,
      engines: this.engines,
    }).catch(() => {});

    // Liveness is how the product answers "is the extractor available" without
    // ever calling this machine. Best-effort: a missed beat must never stop work.
    this.heartbeatTimer = setInterval(() => void this.beat(), agentConfig.worker.heartbeatMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    void this.beat();

    this.onLine(
      `Watching for ${agentConfig.kinds.join(", ")} jobs as ${WORKER_ID} at ${this.env.apiBaseUrl}.`
    );
    void this.loop();
  }

  post(path, body) {
    return post(path, body, this.env);
  }

  get(path) {
    return get(path, this.env);
  }

  async beat() {
    const jobIds = [...this.current.keys()];
    await this.post(`/workers/${encodeURIComponent(WORKER_ID)}/heartbeat`, {
      status: jobIds.length ? "busy" : "idle",
      currentJobId: jobIds[0] || null,
      stats: this.stats,
      engines: this.engines,
    }).catch(() => {});

    // Say it on the JOBS too, not just on this worker's record. The board hands
    // a claim to someone else when the JOB has gone quiet — a 300-page scan
    // that never touched its job would be reclaimed and extracted twice.
    for (const [jobId, run] of this.current) {
      await this.post(`/jobs/${run.kind}/${jobId}/touch`, {}).catch(() => {});
    }
  }

  async loop() {
    const idleMs = agentConfig.worker.pollIntervalMs;
    while (!this.stopped) {
      let job = null;
      let claimed = false;
      try {
        const body = await this.post("/jobs/claim", {
          agentId: WORKER_ID,
          kinds: agentConfig.kinds,
        });
        job = body && body.job;
        claimed = true; // the call itself succeeded, job or not
      } catch (err) {
        // Losing the API is ordinary out here — a closed laptop lid, a wifi
        // change, a backend restart. Say it ONCE when it happens and once when
        // it comes back. WHICH failure matters: a 404 means the API answered
        // but has no OCR-agent routes.
        if (this.reachable) {
          this.reachable = false;
          const why = /HTTP 404/.test(err.message)
            ? "it answered, but has no ocr-agent routes — that API needs deploying with them"
            : /HTTP 401/.test(err.message)
              ? "it refused the token — OCR_BRIDGE_TOKEN here must equal OCR_AGENT_TOKEN there"
              : /HTTP 503/.test(err.message)
                ? "it has no OCR_AGENT_TOKEN configured, so its OCR routes are closed"
                : /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(err.message)
                  ? "nothing answered at that address"
                  : err.message;
          this.onLine(`Can't take work from Dime at ${this.env.apiBaseUrl} — ${why}`);
        }
      }

      if (!this.reachable && claimed) {
        this.reachable = true;
        this.onLine(`Dime is answering again at ${this.env.apiBaseUrl}.`);
      }

      if (!job) {
        await new Promise((r) => setTimeout(r, idleMs));
        continue;
      }

      // The claim is this backend's, and so is everything the job touches — its
      // API, its token, the URL the file streams down from. Pinned here, once,
      // for the whole async tree.
      //
      // AWAITED — one file at a time, exactly as the helper agent runs its
      // sessions. OCR saturates the GPU and three models voting saturates what
      // is left; a second file in flight makes both slower, not faster.
      await this.slots.take();
      try {
        await envScope.runIn(this.env, () => this.handle(job));
      } finally {
        this.slots.release();
      }
    }
  }

  async handle(job) {
    const jobId = String(job._id || job.id);
    const kind = String(job.kind || "");
    const handler = HANDLERS.get(kind);

    if (!handler) {
      await this.post(`/jobs/${kind}/${jobId}/fail`, {
        error: `This worker reads ${[...HANDLERS.keys()].join(", ")}; it received a "${kind}" job it does not handle.`,
      }).catch(() => {});
      this.stats.failed += 1;
      return;
    }

    // The backend, carried on the job itself, so the handler's download reaches
    // the right product without another lookup.
    job.__env = this.env;

    const startedAt = Date.now();
    const events = new OcrEvents({ jobId, kind });
    const controller = new AbortController();
    this.current.set(jobId, { kind, controller });
    void this.beat();

    events.on("event", (event) => this.relay.push(jobId, event, kind));

    events.start({
      fileName: job.file?.originalName || null,
      sizeBytes: job.file?.sizeBytes || null,
      businessId: job.businessId || null,
    });

    await this.post(`/jobs/${kind}/${jobId}/progress`, {
      note: "Picked this up.",
      percent: 1,
    }).catch(() => {});

    // Say it on THIS machine too. Until now the terminal went silent the moment
    // it started watching: a file could be claimed, read and answered without a
    // single line, so "is it actually picking things up?" had no answer short
    // of opening the database. One line in, one line out.
    this.onLine(`▶ picked up — ${clipLine(job.file?.originalName || jobId, 60)} (${kind})`);

    // Stop is a flag in the product's database, not a call to this machine.
    // Checked often, because this is someone pressing Stop and watching a bar.
    const cancelWatch = setInterval(async () => {
      const r = await this.get(`/jobs/${kind}/${jobId}/cancelled`).catch(() => null);
      if (r && r.cancelRequested) controller.abort();
    }, agentConfig.worker.cancelPollMs);
    if (cancelWatch.unref) cancelWatch.unref();

    // A whole extraction's wall clock. A 300-page scan is legitimately long;
    // one that has not finished by this is stuck, not thinking.
    const budget = setTimeout(() => controller.abort(), agentConfig.worker.jobTimeoutMs);
    if (budget.unref) budget.unref();

    try {
      const outcome = await handler.run({
        job,
        events,
        signal: controller.signal,
        log: (msg) => this.onLine(msg),
      });

      // The evidence first, then the verdict. A raw delivery that fails must
      // not cost the figures, so it is best-effort and says so.
      if (outcome.raw) {
        await this.post(`/jobs/${kind}/${jobId}/raw`, { raw: outcome.raw }).catch((err) => {
          this.onLine(`Couldn't store the raw read for ${jobId} (${err.message}) — the figures still went through.`);
          events.trace(`raw delivery failed: ${err.message}`);
        });
      }

      const durationMs = Date.now() - startedAt;
      const status =
        outcome.result.verdict === "extracted" ? JOB_STATUS.EXTRACTED : JOB_STATUS.NEEDS_REVIEW;

      events.done({ status, summary: outcome.summary, durationMs });
      await this.relay.drain();

      await this.post(`/jobs/${kind}/${jobId}/resolve`, {
        summary: outcome.summary,
        result: { ...outcome.result, durationMs },
      });

      this.stats.resolved += 1;
      const mark = status === JOB_STATUS.EXTRACTED ? "✔" : "■";
      this.onLine(`${mark} ${status} in ${Math.round(durationMs / 1000)}s — ${clipLine(outcome.summary, 100)}`);
    } catch (err) {
      const cancelled = controller.signal.aborted || /cancelled|aborted/i.test(err.message);
      const timedOut = cancelled && Date.now() - startedAt >= agentConfig.worker.jobTimeoutMs;
      const durationMs = Date.now() - startedAt;

      const human = cancelled
        ? timedOut
          ? "This took longer than the time allowed and was stopped."
          : "Stopped."
        : `Couldn't extract this document: ${err.message}`;

      events.done({
        status: cancelled ? JOB_STATUS.STOPPED : JOB_STATUS.FAILED,
        summary: human,
        durationMs,
        error: err.message,
      });
      await this.relay.drain().catch(() => {});

      await this.post(`/jobs/${kind}/${jobId}/fail`, { error: err.message, summary: human }).catch(() => {});
      this.stats.failed += 1;
      this.onLine(`✖ ${cancelled ? "stopped" : "failed"} — ${clipLine(err.message, 120)}`);
    } finally {
      clearInterval(cancelWatch);
      clearTimeout(budget);
      this.current.delete(jobId);
      void this.beat();
    }
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const { controller } of this.current.values()) controller.abort();
  }
}

/**
 * One worker per backend, sharing this machine's job slots. Each watches its
 * own boards and claims only its own work — there is no routing decision to get
 * wrong, because the claim itself decides.
 */
export function startWorkers({ onLine = () => {} } = {}) {
  const slots = new Slots(agentConfig.worker.maxConcurrentJobs);
  const workers = agentConfig.environments.map((env) => new OcrWorker({ onLine, env, slots }));
  return {
    workers,
    start: () => Promise.all(workers.map((w) => w.start())),
    stop: () => workers.forEach((w) => w.stop()),
  };
}

export { WORKER_ID, Slots, HANDLERS };
export default { OcrWorker, startWorkers, WORKER_ID };
