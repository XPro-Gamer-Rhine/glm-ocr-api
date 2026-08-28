import "./bootstrapEnv.js";
import path from "node:path";
import { envFiles } from "./bootstrapEnv.js";
import * as envScope from "./env.js";

/**
 * The agent's configuration — every tunable, read once.
 *
 * `bootstrapEnv.js` has already merged the file chain into `process.env` by the
 * time this module runs (it is imported first, above), including the shared
 * backend file the helper agent uses. This file only decides what those values
 * MEAN to the extractor.
 */

const ROOT_DIR = envFiles.rootDir;

/**
 * A deliberate one-off override always wins: `DIME_OCR_CLAUDE_MODEL=… npm run
 * worker`. Otherwise the merged environment answers.
 */
const raw = (key, fallback = "") => {
  const override = process.env[`DIME_OCR_${key}`];
  if (override !== undefined && override !== "") return String(override);
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : String(value);
};

/**
 * A number from the environment, or the documented default. The empty-string
 * check matters: `Number('')` is 0 and would silently zero every unset numeric
 * setting instead of using the fallback beside it.
 */
const num = (key, fallback) => {
  const value = raw(key, "");
  if (value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (key, fallback) => {
  const v = raw(key, "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
};

const list = (key, fallback = []) => {
  const v = raw(key, "");
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * The backends this agent serves.
 *
 * Exactly the helper agent's scheme, reading exactly the helper agent's keys:
 *
 *   DIME_ENVIRONMENTS=local,qa,prod
 *   DIME_API_BASE_URL_LOCAL=…   DIME_API_BASE_URL_QA=…   DIME_API_BASE_URL_PROD=…
 *
 * Anything a named backend does not spell out falls back to the unsuffixed key,
 * so one shared token is written once. With DIME_ENVIRONMENTS unset there is
 * exactly one environment built from the plain keys.
 *
 * The BRIDGE TOKEN is the one thing this agent does NOT share with the helper.
 * `OCR_BRIDGE_TOKEN` must equal `OCR_AGENT_TOKEN` on the API, a different
 * secret from `HELPER_AGENT_TOKEN` — this one opens raw statement downloads,
 * which makes it the most valuable of the three to leak. It falls back to the
 * helper's `BRIDGE_TOKEN` only so a single-secret dev box works out of the box;
 * QA and production should always set it.
 *
 * These are separate products with separate databases: a job claimed from one
 * must never be worked against the other. That is enforced in src/agent/env.js.
 */
function buildEnvironments() {
  // A process the worker spawned is PINNED to one backend — the one the job it
  // was started for belongs to. Honoured ahead of everything else, because the
  // child inherits the same .env and would otherwise rebuild the full list and
  // default to whichever backend is named first.
  const pinned = process.env.DIME_OCR_ENVIRONMENT_JSON;
  if (pinned) {
    try {
      const env = JSON.parse(pinned);
      if (env && env.apiBaseUrl) return [env];
    } catch {
      /* fall through to the configured list */
    }
  }

  const named = list("DIME_ENVIRONMENTS", []);

  const build = (id, suffix) => ({
    id,
    label: id,
    // Suffixed first, plain key second — so one shared value is written once.
    apiBaseUrl: (
      raw(`DIME_API_BASE_URL${suffix}`, "") || raw("DIME_API_BASE_URL", "http://localhost:5000")
    ).replace(/\/+$/, ""),
    bridgeToken:
      raw(`OCR_BRIDGE_TOKEN${suffix}`, "") ||
      raw("OCR_BRIDGE_TOKEN", "") ||
      raw(`BRIDGE_TOKEN${suffix}`, "") ||
      raw("BRIDGE_TOKEN", ""),
    // Carried but unused today. The extractor works entirely through the API;
    // this is here so a future deterministic feature has the same handle the
    // helper agent has, and so `doctor` can report which database a backend
    // belongs to.
    mongoUri: raw(`MONGO_URI${suffix}`, "") || raw("MONGO_URI", ""),
  });

  if (!named.length) return [build("default", "")];
  return named.map((id) => build(id, `_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`));
}

const environments = buildEnvironments();

const agentConfig = Object.freeze({
  rootDir: ROOT_DIR,
  sharedEnvFile: envFiles.sharedEnvFile,

  environments,

  /** The document boards this worker claims from. One today; the list is the hinge. */
  kinds: list("OCR_AGENT_KINDS", ["statement"]),

  worker: Object.freeze({
    /**
     * Who this worker is on the boards. The hostname alone is right for the
     * normal case — one machine, one worker — but a second process on the same
     * machine needs its own WORKER_ID or the two share a registration and
     * overwrite each other's heartbeat.
     */
    id: raw("OCR_WORKER_ID", "") || raw("WORKER_ID", ""),
    pollIntervalMs: Math.max(2000, num("JOB_POLL_INTERVAL_MS", 3000)),
    heartbeatMs: num("OCR_HEARTBEAT_MS", 10000),
    /** How often the stop flag is read. Someone is watching a bar move. */
    cancelPollMs: num("OCR_CANCEL_POLL_MS", 3000),
    /**
     * Files extracted at once on this machine, counted across every backend.
     * ONE by default: OCR saturates the GPU and three models voting saturates
     * what is left, so a second file in flight makes both slower, not faster.
     */
    maxConcurrentJobs: Math.max(1, num("OCR_MAX_CONCURRENT_JOBS", 1)),
    /** A whole extraction's wall clock. A 300-page scan is legitimately long. */
    jobTimeoutMs: num("OCR_JOB_TIMEOUT_MS", 3 * 60 * 60 * 1000),
  }),

  /**
   * The three voters.
   *
   * They exist to disagree. The whole design rests on them being INDEPENDENT —
   * three different companies' models, reading the same raw text, reaching the
   * same figures on their own. Two that agree are evidence; one that is alone
   * is a flag for a person. Point two of these at the same model and the
   * consensus becomes theatre.
   */
  analysts: Object.freeze({
    claude: Object.freeze({
      enabled: bool("OCR_ANALYST_CLAUDE", true),
      /**
       * Run through the local Claude Code CLI — the machine's own subscription,
       * no API key to hold. Set `OCR_CLAUDE_RUNTIME=api` to use
       * ANTHROPIC_API_KEY instead where no CLI is installed.
       */
      runtime: raw("OCR_CLAUDE_RUNTIME", "cli"),
      apiKey: raw("ANTHROPIC_API_KEY", ""),
      model: raw("OCR_CLAUDE_MODEL", "claude-opus-5"),
      effort: raw("OCR_CLAUDE_EFFORT", "high"),
      timeoutMs: num("OCR_CLAUDE_TIMEOUT_MS", 300000),
    }),
    gpt: Object.freeze({
      enabled: bool("OCR_ANALYST_GPT", true),
      apiKey: raw("OPENAI_API_KEY", ""),
      baseUrl: raw("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
      model: raw("OPENAI_MODEL", "gpt-5.5"),
      timeoutMs: num("OCR_GPT_TIMEOUT_MS", 300000),
      maxOutputTokens: num("OCR_GPT_MAX_OUTPUT_TOKENS", 32000),
    }),
    glm: Object.freeze({
      enabled: bool("OCR_ANALYST_GLM", true),
      /**
       * A REASONING model, not the OCR one. `glm-ocr:latest` is 0.9B and reads
       * pixels; it cannot weigh a balance chain or judge whether two
       * descriptions are the same transaction. The vote needs a chat model —
       * pulled alongside it, on the same Ollama.
       */
      model: raw("GLM_CHAT_MODEL", "glm4:9b"),
      host: raw("OLLAMA_HOST", "http://127.0.0.1:11434").replace(/\/+$/, ""),
      timeoutMs: num("OCR_GLM_TIMEOUT_MS", 600000),
      /** Statement pages are dense; Ollama's 4096 default clips them mid-table. */
      numCtx: num("OCR_GLM_NUM_CTX", 32768),
    }),
  }),

  consensus: Object.freeze({
    /**
     * Pages handed to an analyst at once.
     *
     * Not the whole document: a hundred-page scan is hundreds of thousands of
     * characters, past what the local model can hold and past the point where
     * any of the three reads the middle carefully. Chunking also localizes a
     * disagreement — one bad chunk is one chunk to re-read, not a whole
     * statement to redo.
     */
    pagesPerChunk: Math.max(1, num("OCR_PAGES_PER_CHUNK", 4)),
    /** Analysts run concurrently per chunk; chunks run in order. */
    chunkConcurrency: Math.max(1, num("OCR_CHUNK_CONCURRENCY", 3)),
    /** How many of the three must produce the same value for it to be the answer. */
    quorum: Math.max(2, num("OCR_CONSENSUS_QUORUM", 2)),
    /**
     * Money compared to the cent, dates to the day. Both are exact by
     * construction — a tolerance here would let a genuine misread pass as
     * agreement, which is the one failure this whole machine exists to catch.
     */
    amountToleranceCents: Math.max(0, num("OCR_AMOUNT_TOLERANCE_CENTS", 0)),
    /**
     * The share of transaction rows that must reach quorum before the
     * extraction is called agreed. Not 1.0: a single row where one model read
     * a smudged description differently should flag that row, not condemn a
     * 400-row statement. Every shortfall is reported either way.
     */
    minTransactionAgreement: num("OCR_MIN_TXN_AGREEMENT", 0.98),
    /** One retry of a chunk whose analysts came back unusable. */
    chunkRetries: Math.max(0, num("OCR_CHUNK_RETRIES", 1)),
  }),

  storage: Object.freeze({
    /**
     * Where a claimed job's file is written while it is being read. Resolved
     * against the repo, not the working directory: the worker is started from
     * a launchd plist or a pm2 unit as often as from a shell, and a relative
     * DATA_DIR would put a customer's statement somewhere different each time.
     */
    workDir: path.resolve(ROOT_DIR, raw("DATA_DIR", "storage"), "agent-work"),
    /** Keep the downloaded file after the job, for re-reads without re-download. */
    keepFiles: bool("OCR_KEEP_FILES", false),
  }),

  log: Object.freeze({
    level: raw("LOG_LEVEL", "info"),
  }),
});

/** Fail fast and legibly when the environment cannot support the worker. */
export function validate() {
  const problems = [];

  const seenUrl = new Map();
  for (const env of agentConfig.environments) {
    const key = env.id === "default" ? "" : `_${env.id.toUpperCase()}`;
    if (!/^https?:\/\//.test(env.apiBaseUrl)) {
      problems.push(`DIME_API_BASE_URL${key} must be an http(s) URL, got "${env.apiBaseUrl}"`);
    }
    if (!env.bridgeToken) {
      problems.push(
        `no OCR_BRIDGE_TOKEN${key} — this backend's jobs cannot be claimed (it must equal OCR_AGENT_TOKEN on that API)`
      );
    }
    // Two environments pointing at the same backend is not a configuration a
    // person means: it makes every file get claimed twice and extracted twice.
    const seen = seenUrl.get(env.apiBaseUrl);
    if (seen) problems.push(`environments "${seen}" and "${env.id}" both point at ${env.apiBaseUrl}`);
    else seenUrl.set(env.apiBaseUrl, env.id);
  }

  const { claude, gpt, glm } = agentConfig.analysts;
  const enabled = [claude.enabled && "claude", gpt.enabled && "gpt", glm.enabled && "glm"].filter(Boolean);
  if (enabled.length < agentConfig.consensus.quorum) {
    problems.push(
      `${enabled.length} analyst(s) enabled but quorum is ${agentConfig.consensus.quorum} — nothing could ever reach agreement`
    );
  }
  if (gpt.enabled && !gpt.apiKey) problems.push("OCR_ANALYST_GPT is on but OPENAI_API_KEY is empty");
  if (claude.enabled && claude.runtime === "api" && !claude.apiKey) {
    problems.push("OCR_CLAUDE_RUNTIME=api needs ANTHROPIC_API_KEY");
  }
  if (!["cli", "api"].includes(claude.runtime)) {
    problems.push(`OCR_CLAUDE_RUNTIME must be cli or api — got "${claude.runtime}"`);
  }
  if (glm.enabled && /ocr/i.test(glm.model)) {
    problems.push(
      `GLM_CHAT_MODEL is "${glm.model}" — that is the OCR model, which cannot reason over text. Use a chat model (e.g. glm4:9b).`
    );
  }
  return problems;
}

// The default is what `env.current()` answers outside a job.
envScope.setFallback(agentConfig.environments[0]);

export default agentConfig;
