import agentConfig from "../config.js";
import { buildChunkPrompt } from "./schema.js";
import { normalizeChunk, mergeChunks, fromCents } from "./normalize.js";
import { voteScalars, voteTransactions, CRITICAL_FIELDS } from "./vote.js";
import claude from "./analysts/claude.js";
import gpt from "./analysts/openai.js";
import glm from "./analysts/glm.js";

/**
 * The consensus engine.
 *
 * GLM-OCR has already turned pixels into text. This is the second half: three
 * independent models read that text, and a figure only becomes an answer when
 * at least two of them produce it on their own.
 *
 * Why three, and why not just trust the best one — a single model reading a
 * scanned statement is confidently wrong in a way that is invisible downstream.
 * It does not stop at a smudged digit and ask; it produces a number, and the
 * number lands in someone's books. Three independent reads make the failure
 * VISIBLE: a misread is a disagreement, and a disagreement is a flag, not a
 * silent error. That is the whole argument for the cost of running it.
 *
 * The models must be genuinely independent for that to hold. Same prompt, same
 * text, three different companies' models, no model shown another's answer.
 */

const ALL_ANALYSTS = [claude, gpt, glm];

/** Pages, grouped into the windows each analyst reads at once. */
export function chunkPages(pages, size) {
  const chunks = [];
  for (let i = 0; i < pages.length; i += size) chunks.push(pages.slice(i, i + size));
  return chunks;
}

function enabledAnalysts() {
  return ALL_ANALYSTS.filter((a) => a.describe().enabled);
}

/**
 * Run the whole vote over one document's pages.
 *
 * @param {object}   opts
 * @param {Array}    opts.pages    [{page, source, text}] in printed order
 * @param {object}   opts.hints    whatever the uploader said (currency, period, note)
 * @param {object}   opts.events   an OcrEvents instance, or null
 * @param {AbortSignal} opts.signal
 */
export async function runConsensus({ pages, hints = {}, events = null, signal = null, log = () => {} } = {}) {
  const cfg = agentConfig.consensus;
  const analysts = enabledAnalysts();
  if (analysts.length < cfg.quorum) {
    throw new Error(
      `${analysts.length} analyst(s) available but ${cfg.quorum} must agree — nothing could ever reach a verdict`
    );
  }

  const pageCount = pages.length;
  const chunks = chunkPages(pages, cfg.pagesPerChunk);

  /** analyst id → the chunk reads it produced, in order, with nulls for failures. */
  const byAnalyst = new Map(analysts.map((a) => [a.id, []]));
  /** analyst id → what went wrong, per chunk. */
  const failures = new Map(analysts.map((a) => [a.id, []]));
  const usage = new Map(analysts.map((a) => [a.id, { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }]));

  for (let c = 0; c < chunks.length; c += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    const chunk = chunks[c];
    const prompt = buildChunkPrompt({
      pages: chunk,
      chunkIndex: c,
      chunkCount: chunks.length,
      pageCount,
      hints,
    });

    events?.stage("analyzing", {
      progress: c / chunks.length,
      note:
        chunks.length === 1
          ? "Three models reading the statement"
          : `Three models reading pages ${chunk[0].page}–${chunk[chunk.length - 1].page}`,
    });

    // All three read the same chunk at once. They never see each other's
    // answers — that independence is the only thing that makes agreement mean
    // anything.
    const results = await Promise.all(
      analysts.map(async (analyst) => {
        let attempt = 0;
        let last = null;
        while (attempt <= cfg.chunkRetries) {
          if (signal?.aborted) return { analyst, result: { ok: false, reason: "cancelled", durationMs: 0 } };
          last = await analyst.analyze({ prompt, signal });
          if (last.ok) break;
          // A cancel or a missing credential will not get better on a retry.
          if (/cancelled|empty|API_KEY|not signed in|not on this machine's PATH/i.test(last.reason || "")) break;
          attempt += 1;
          if (attempt <= cfg.chunkRetries) {
            log(`${analyst.label} could not read pages ${chunk[0].page}–${chunk[chunk.length - 1].page} (${last.reason}) — trying once more.`);
          }
        }
        return { analyst, result: last };
      })
    );

    for (const { analyst, result } of results) {
      const u = usage.get(analyst.id);
      u.durationMs += result.durationMs || 0;
      if (result.usage) {
        u.inputTokens += result.usage.inputTokens || 0;
        u.outputTokens += result.usage.outputTokens || 0;
        u.costUsd += result.usage.costUsd || 0;
      }

      if (!result.ok) {
        failures.get(analyst.id).push({ chunk: c + 1, reason: result.reason });
        byAnalyst.get(analyst.id).push(null);
        events?.vote({
          analyst: analyst.id,
          chunk: c + 1,
          chunks: chunks.length,
          ok: false,
          error: result.reason,
          durationMs: result.durationMs,
        });
        continue;
      }

      const normalized = normalizeChunk(result.value, {
        pageFloor: chunk[0].page,
        pageCeil: chunk[chunk.length - 1].page,
      });
      byAnalyst.get(analyst.id).push(normalized);
      events?.vote({
        analyst: analyst.id,
        chunk: c + 1,
        chunks: chunks.length,
        transactions: normalized.transactions.length,
        ok: true,
        durationMs: result.durationMs,
      });
    }
  }

  events?.stage("reconciling", { progress: 0.1, note: "Comparing what the models found" });

  // A model that failed EVERY chunk did not vote at all. Keeping it in would
  // let an empty read count as "nothing is there" — which is a vote, and the
  // one vote no absent model has earned.
  const reads = analysts
    .map((a) => ({ analyst: a.id, chunks: byAnalyst.get(a.id) }))
    .filter(({ chunks: cs }) => cs.some(Boolean))
    .map(({ analyst, chunks: cs }) => ({ analyst, read: mergeChunks(cs) }));

  if (reads.length < cfg.quorum) {
    const why = analysts
      .map((a) => {
        const f = failures.get(a.id);
        return f.length ? `${a.label}: ${f[0].reason}` : null;
      })
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `only ${reads.length} of ${analysts.length} models produced a usable read — ${cfg.quorum} must agree. ${why}`
    );
  }

  const scalars = voteScalars(reads, { quorum: cfg.quorum });
  const txn = voteTransactions(reads, { quorum: cfg.quorum });

  const consensus = assemble(scalars, txn.rows);
  const reconciliation = reconcile(consensus, scalars);

  const disputes = [
    ...Object.values(scalars)
      .filter((v) => !v.agreed)
      .map((v) => ({
        kind: "field",
        field: v.field,
        detail: `the models did not agree (${v.votes}/${v.of} for the leading value)`,
        candidates: v.candidates,
      })),
    ...txn.disputes,
  ];

  for (const d of disputes.slice(0, 50)) {
    events?.dispute({
      field: d.field || d.kind,
      kind: d.kind,
      values: d.candidates || (d.row ? [d.row] : []),
      resolution: d.kind === "field" ? "left blank" : "excluded, reported for review",
    });
  }

  const criticalOk = CRITICAL_FIELDS.every((f) => !scalars[f] || scalars[f].agreed);
  const txnOk = txn.agreementRatio >= cfg.minTransactionAgreement;
  const reconOk =
    reconciliation.openingNetClosing.ok !== false && reconciliation.statedTotals.ok !== false;
  const verdict = criticalOk && txnOk && reconOk ? "extracted" : "needs_review";

  const votedFields = Object.values(scalars);
  const agreementScore = round4(
    (votedFields.filter((v) => v.agreed).length + txn.rows.length) /
      Math.max(1, votedFields.length + Math.max(txn.rows.length, ...Object.values(txn.counts)))
  );

  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const u of usage.values()) {
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.costUsd += u.costUsd;
  }

  events?.stage("reconciling", { progress: 1, note: "Agreement reached" });

  return {
    verdict,
    agreementScore,
    quorum: cfg.quorum,
    consensus,
    reconciliation,
    agreement: Object.fromEntries(
      Object.entries(scalars).map(([field, v]) => [
        field,
        { agreed: v.agreed, votes: v.votes, of: v.of, unanimous: v.unanimous, analysts: v.analysts },
      ])
    ),
    transactionAgreement: {
      ratio: round4(txn.agreementRatio),
      accepted: txn.rows.length,
      perAnalyst: txn.counts,
      threshold: cfg.minTransactionAgreement,
    },
    disputes,
    analysts: analysts.map((a) => {
      const d = a.describe();
      const cs = byAnalyst.get(a.id);
      return {
        id: a.id,
        label: a.label,
        model: d.model,
        voted: reads.some((r) => r.analyst === a.id),
        chunksRead: cs.filter(Boolean).length,
        chunksFailed: cs.filter((x) => !x).length,
        transactions: txn.counts[a.id] ?? 0,
        errors: failures.get(a.id).slice(0, 10),
        usage: usage.get(a.id),
      };
    }),
    usage: { ...totals, chunks: chunks.length, pages: pageCount },
  };
}

/** The agreed figures, in money rather than cents — the shape the product reads. */
function assemble(scalars, rows) {
  const val = (f) => scalars[f]?.value ?? null;

  const transactions = rows.map((r) => ({
    page: r.page,
    date: r.dateIso,
    dateRaw: r.dateRaw,
    description: r.description,
    reference: r.reference,
    credit: fromCents(r.creditCents),
    debit: fromCents(r.debitCents),
    amount: fromCents(r.amountCents),
    type: r.amountCents === null ? null : r.amountCents >= 0 ? "credit" : "debit",
    balance: fromCents(r.balanceCents),
    agreedBy: r.analysts,
    matchedBy: r.matchedBy,
  }));

  const totalCreditsCents = rows.reduce((s, r) => s + (r.creditCents || 0), 0);
  const totalDebitsCents = rows.reduce((s, r) => s + (r.debitCents || 0), 0);

  return {
    documentType: val("documentType"),
    metadata: {
      companyName: val("metadata.companyName"),
      accountName: val("metadata.accountName"),
      accountNumber: val("metadata.accountNumber"),
      accountType: val("metadata.accountType"),
      branch: val("metadata.branch"),
      currency: val("metadata.currency"),
      statementPeriod: {
        from: val("metadata.statementPeriodFrom"),
        to: val("metadata.statementPeriodTo"),
      },
      statementDate: val("metadata.statementDate"),
    },
    summary: {
      transactionCount: rows.length,
      creditCount: rows.filter((r) => (r.creditCents || 0) > 0).length,
      debitCount: rows.filter((r) => (r.debitCents || 0) > 0).length,
      // COMPUTED from the agreed rows, and labelled as such. The figures the
      // statement itself printed live in `statedTotals` and are never
      // overwritten with these — the difference between the two is the single
      // most useful signal that a page was missed.
      totalCredits: fromCents(totalCreditsCents),
      totalDebits: fromCents(totalDebitsCents),
      netChange: fromCents(totalCreditsCents - totalDebitsCents),
      openingBalance: fromCents(val("balances.openingCents")),
      closingBalance: fromCents(val("balances.closingCents")),
      currency: val("metadata.currency"),
    },
    statedTotals: {
      totalCredits: fromCents(val("statedTotals.totalCreditsCents")),
      totalDebits: fromCents(val("statedTotals.totalDebitsCents")),
      transactionCount: val("statedTotals.transactionCount"),
    },
    transactions,
  };
}

/**
 * The arithmetic the document can be held to.
 *
 * Three models agreeing proves they READ the same thing; it does not prove they
 * read everything. A whole page dropped by all three is unanimous and wrong.
 * These three checks are what catch that — the statement's own numbers,
 * disagreeing with the transactions extracted from it.
 */
function reconcile(consensus, scalars) {
  const s = consensus.summary;
  const rows = consensus.transactions;
  const cents = (v) => (v === null || v === undefined ? null : Math.round(v * 100));

  // 1. Does the balance column walk?
  //
  // Walked over EVERY row in order, not over the rows that happen to print a
  // balance. Filtering first and comparing neighbours in the filtered list
  // treats two non-adjacent rows as adjacent — so a single row whose balance
  // the OCR could not read makes the rows either side of it disagree, and the
  // check reports a break that is not there. False alarms are worse than no
  // check at all here: they are what teaches people to ignore the flag.
  //
  // Instead a running balance is carried across rows that print none, and a
  // row whose AMOUNT is unreadable severs the chain until the next printed
  // balance resynchronises it — because past that point nothing can be proven.
  let chain = { ok: null, checked: 0, breaks: [] };
  const printsBalance = rows.filter((r) => r.balance !== null).length;
  if (printsBalance >= 2) {
    let checked = 0;
    let severed = 0;
    const breaks = [];
    let running = null;

    for (const row of rows) {
      const printed = row.balance === null ? null : cents(row.balance);

      if (row.amount === null) {
        // An unreadable movement: everything downstream of it is unprovable
        // until a printed balance re-anchors the walk.
        running = printed !== null ? printed : null;
        if (printed === null) severed += 1;
        continue;
      }

      if (running === null) {
        // Not anchored yet (or just severed) — a printed balance anchors it.
        running = printed;
        continue;
      }

      const expected = running + cents(row.amount);
      if (printed !== null) {
        checked += 1;
        if (expected !== printed) {
          breaks.push({
            page: row.page,
            date: row.date,
            description: row.description,
            expected: expected / 100,
            printed: printed / 100,
          });
        }
        // Resynchronise on what the statement actually says, so one bad row
        // does not cascade into a break on every row after it.
        running = printed;
      } else {
        running = expected;
      }
    }

    chain = {
      ok: checked > 0 ? breaks.length === 0 : null,
      checked,
      severed,
      breaks: breaks.slice(0, 20),
      breakCount: breaks.length,
    };
  }

  // 2. opening + net == closing
  const opening = cents(s.openingBalance);
  const closing = cents(s.closingBalance);
  const net = cents(s.netChange);
  const openingNetClosing =
    opening === null || closing === null
      ? { ok: null, reason: "the statement does not print both an opening and a closing balance" }
      : {
          ok: opening + net === closing,
          opening: s.openingBalance,
          net: s.netChange,
          closing: s.closingBalance,
          difference: (opening + net - closing) / 100,
        };

  // 3. The statement's own totals against the rows extracted from it.
  const stated = consensus.statedTotals;
  const checks = [];
  if (stated.totalCredits !== null) {
    checks.push({
      what: "total credits",
      stated: stated.totalCredits,
      extracted: s.totalCredits,
      ok: cents(stated.totalCredits) === cents(s.totalCredits),
    });
  }
  if (stated.totalDebits !== null) {
    checks.push({
      what: "total debits",
      stated: stated.totalDebits,
      extracted: s.totalDebits,
      ok: cents(stated.totalDebits) === cents(s.totalDebits),
    });
  }
  if (stated.transactionCount !== null) {
    checks.push({
      what: "transaction count",
      stated: stated.transactionCount,
      extracted: s.transactionCount,
      ok: Number(stated.transactionCount) === s.transactionCount,
    });
  }
  const statedTotals = checks.length
    ? { ok: checks.every((c) => c.ok), checks }
    : { ok: null, reason: "the statement prints no totals to check against", checks: [] };

  return {
    balanceChain: chain,
    openingNetClosing,
    statedTotals,
    /**
     * The one line that says whether this extraction can be trusted without a
     * person: the document's own arithmetic agreeing with what came out of it.
     */
    provablyComplete: statedTotals.ok === true && openingNetClosing.ok !== false,
    fieldsUnanimous: Object.values(scalars).filter((v) => v.unanimous).length,
    fieldsVoted: Object.values(scalars).length,
  };
}

const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);

/** Which voters this machine can actually run right now — for `doctor` and the heartbeat. */
export async function analystStatus() {
  const out = {};
  for (const a of ALL_ANALYSTS) {
    const d = a.describe();
    const availability = d.enabled ? await a.available() : { ok: false, reason: "disabled" };
    out[a.id] = { label: a.label, model: d.model, enabled: d.enabled, ...availability };
  }
  return out;
}

export default { runConsensus, analystStatus, chunkPages };
