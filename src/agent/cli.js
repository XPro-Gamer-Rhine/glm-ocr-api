#!/usr/bin/env node
// The env chain must land before anything reads process.env — see bootstrapEnv.
import "./bootstrapEnv.js";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import agentConfig, { validate } from "./config.js";
import { startWorkers, WORKER_ID } from "./worker.js";
import { INTERNAL } from "./apiRelay.js";
import { analystStatus, runConsensus } from "./consensus/index.js";
import { readDocument } from "../services/rawRead.service.js";
import { ensureOcrReady, ensureChatModel, engineState } from "../bootstrap/index.js";
import { OcrEvents } from "./events.js";

/**
 * The agent's command line.
 *
 *   worker             claim and extract, forever — the normal way to run this
 *   doctor             check the configuration end to end, change nothing
 *   extract <file>     run the whole pipeline on a local file, no product
 *                      involved — the way to test a change to the prompts or
 *                      the vote without uploading anything
 */

const line = (msg = "") => process.stdout.write(`${msg}\n`);
const ok = (msg) => line(`  ✔ ${msg}`);
const bad = (msg) => line(`  ✖ ${msg}`);
const warn = (msg) => line(`  • ${msg}`);

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "worker":
    case undefined:
      return runWorker();
    case "doctor":
      return doctor();
    case "extract":
      return extractLocal(args);
    default:
      line(`Unknown command "${command}".`);
      line("Usage: node src/agent/cli.js <worker|doctor|extract <file>>");
      process.exitCode = 1;
  }
}

// ── worker ─────────────────────────────────────────────────────────────────

async function runWorker() {
  const problems = validate();
  if (problems.length) {
    line("This machine cannot run the extractor yet:");
    for (const p of problems) bad(p);
    line("");
    line("Run `npm run agent:doctor` for the full picture.");
    process.exitCode = 1;
    return;
  }

  // Ollama and GLM-OCR, installed and pulled if missing. Without them there is
  // no raw read, and every claimed job would fail after downloading its file.
  line("Preparing the OCR engine…");
  await ensureOcrReady();
  if (!engineState.serving || !engineState.modelReady) {
    warn(`GLM-OCR is not ready (${engineState.lastError || "unknown"}) — scanned pages cannot be read.`);
  }

  // The GLM voter's model, which is NOT the OCR model and is not pulled by the
  // boot sequence above. Done here, before the first claim, because finding it
  // missing at the vote means a statement was already downloaded and OCR'd for
  // twenty minutes. A failure is a warning, not a stop: two readers still reach
  // a verdict.
  const glm = agentConfig.analysts.glm;
  if (glm.enabled) {
    const pulled = await ensureChatModel(glm.model);
    if (!pulled.ok) {
      warn(`The GLM reader's model "${glm.model}" is unavailable (${pulled.reason}).`);
      warn(`Two readers will vote instead of three. Pull it with: ollama pull ${glm.model}`);
    }
  }

  const backends = agentConfig.environments.map((e) => e.id).join(", ");
  line(`Backends: ${backends}`);
  if (agentConfig.sharedEnvFile) line(`Backend list read from ${agentConfig.sharedEnvFile}`);
  line("");

  const fleet = startWorkers({ onLine: (msg) => line(msg) });
  await fleet.start();

  const shutdown = (signal) => {
    line(`\n${signal} received — finishing up.`);
    fleet.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── doctor ─────────────────────────────────────────────────────────────────

/**
 * Everything that has to be true, checked in the order it would break.
 *
 * Deliberately read-only against the product: it registers this worker (an
 * idempotent upsert) rather than claiming a job, because a doctor that claims
 * work would take a real statement off the board and never extract it.
 */
async function doctor() {
  line("Dime-OCR agent — checking this machine\n");

  line("Configuration");
  line(`  worker id ......... ${WORKER_ID}  (${os.hostname()})`);
  line(`  boards ............ ${agentConfig.kinds.join(", ")}`);
  line(`  shared env file ... ${agentConfig.sharedEnvFile || "(none — running standalone)"}`);
  line(`  work directory .... ${agentConfig.storage.workDir}`);
  line("");

  const problems = validate();
  line("Settings");
  if (!problems.length) ok("nothing missing");
  for (const p of problems) bad(p);
  line("");

  line("Backends");
  for (const env of agentConfig.environments) {
    line(`  ${env.id} → ${env.apiBaseUrl}`);
    if (!env.bridgeToken) {
      bad("no token — jobs here cannot be claimed");
      continue;
    }
    try {
      const res = await fetch(`${env.apiBaseUrl}${INTERNAL}/workers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ocr-agent-token": env.bridgeToken },
        body: JSON.stringify({
          workerId: WORKER_ID,
          host: os.hostname(),
          version: "doctor",
          kinds: agentConfig.kinds,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) ok("reachable, and the token is accepted");
      else if (res.status === 401) bad("the token was refused — OCR_BRIDGE_TOKEN must equal OCR_AGENT_TOKEN there");
      else if (res.status === 404) bad("that API has no ocr-agent routes — it needs deploying with them");
      else if (res.status === 503) bad("that API has no OCR_AGENT_TOKEN set, so its OCR routes are closed");
      else bad(`answered ${res.status}`);
    } catch (err) {
      bad(`could not be reached: ${err.message}`);
    }
  }
  line("");

  line("OCR engine (GLM-OCR through Ollama)");
  try {
    const res = await fetch(`${agentConfig.analysts.glm.host}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    ok(`Ollama is serving at ${agentConfig.analysts.glm.host}`);
    if (names.length) line(`    pulled: ${names.join(", ")}`);
    else warn("no models are pulled yet — `npm run agent:worker` pulls GLM-OCR and the GLM reader's model on boot");
  } catch (err) {
    bad(`${err.message} — run \`ollama serve\`, or let the worker start it`);
  }
  line("");

  line(`The three readers (${agentConfig.consensus.quorum} must agree)`);
  const status = await analystStatus();
  let usable = 0;
  for (const [id, s] of Object.entries(status)) {
    if (!s.enabled) {
      warn(`${s.label} (${id}) — turned off`);
      continue;
    }
    if (s.ok) {
      usable += 1;
      ok(`${s.label}: ${s.model}${s.detail && s.detail !== s.model ? ` (${s.detail})` : ""}`);
    } else {
      bad(`${s.label}: ${s.reason}`);
    }
  }
  line("");
  if (usable >= agentConfig.consensus.quorum) {
    ok(`${usable} readers available — a verdict is possible`);
  } else {
    bad(`only ${usable} reader(s) available, ${agentConfig.consensus.quorum} must agree — jobs would be claimed and fail`);
    process.exitCode = 1;
  }
}

// ── extract (local) ────────────────────────────────────────────────────────

/**
 * The whole pipeline against a file on this disk, with no product involved.
 *
 * This is how a change to the prompts, the chunk size or the vote gets tested:
 * on a real statement, end to end, without putting anything on a job board or
 * touching a customer's data.
 */
async function extractLocal(args) {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    line("Usage: node src/agent/cli.js extract <file.pdf> [--no-ocr] [--out result.json]");
    process.exitCode = 1;
    return;
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    line(`No such file: ${filePath}`);
    process.exitCode = 1;
    return;
  }
  const outIndex = args.indexOf("--out");
  const outPath = outIndex !== -1 ? path.resolve(args[outIndex + 1] || "extraction.json") : null;

  await ensureOcrReady();

  line(`Reading ${path.basename(filePath)}…`);
  const events = new OcrEvents({ jobId: "local", kind: "statement" });
  events.on("event", (e) => {
    if (e.type === "ocr:stage") line(`  [${String(e.percent).padStart(3)}%] ${e.note}`);
    else if (e.type === "ocr:vote" && !e.ok) line(`  ! ${e.analyst} could not read chunk ${e.chunk}: ${e.error}`);
    else if (e.type === "ocr:vote") line(`  · ${e.analyst} read chunk ${e.chunk}/${e.chunks}: ${e.transactions} rows`);
  });

  const read = await readDocument(filePath, {
    ocr: !args.includes("--no-ocr"),
    label: "local",
    onStage: (stage, info) => events.stage(stage, info),
  });
  line(`  ${read.pageCount} pages, ${read.characters.toLocaleString()} characters, read by ${read.source}`);

  const result = await runConsensus({ pages: read.pages, events, log: (m) => line(`  ${m}`) });

  line("");
  line(`Verdict: ${result.verdict.toUpperCase()}  (agreement ${(result.agreementScore * 100).toFixed(1)}%)`);
  const s = result.consensus.summary;
  line(`  ${s.transactionCount} transactions — ${s.totalCredits} in, ${s.totalDebits} out`);
  line(`  opening ${s.openingBalance} → closing ${s.closingBalance} (${s.currency || "currency unknown"})`);
  line(`  account: ${result.consensus.metadata.companyName || "?"} / ${result.consensus.metadata.accountNumber || "?"}`);
  line(`  period:  ${result.consensus.metadata.statementPeriod.from || "?"} → ${result.consensus.metadata.statementPeriod.to || "?"}`);
  line("");
  for (const a of result.analysts) {
    line(`  ${a.label.padEnd(8)} ${a.voted ? "voted" : "DID NOT VOTE"} — ${a.transactions} rows, ${a.chunksRead} chunks read, ${a.chunksFailed} failed`);
    for (const e of a.errors.slice(0, 3)) line(`      chunk ${e.chunk}: ${e.reason}`);
  }
  if (result.disputes.length) {
    line("");
    line(`  ${result.disputes.length} dispute(s):`);
    for (const d of result.disputes.slice(0, 10)) {
      line(`    ${d.kind}${d.field ? ` ${d.field}` : ""} — ${d.detail}`);
    }
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ raw: read.pages, result }, null, 2));
    line(`\nWritten to ${outPath}`);
  }
}

main().catch((err) => {
  line(`\nFatal: ${err.stack || err.message}`);
  process.exit(1);
});
