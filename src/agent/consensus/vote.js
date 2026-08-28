import { rowKey, rowKeyLoose, textKey, accountKey } from "./normalize.js";

/**
 * The vote itself.
 *
 * Three models read the same pages independently; a value becomes the answer
 * when at least `quorum` of them produced it. Everything else is recorded as a
 * dispute and sent up for a person to look at — never dropped, never silently
 * resolved by picking a favourite model.
 *
 * NULL IS A VOTE, not an abstention. "Nothing is printed here" is a claim about
 * the document, and two models making it outrank one model that produced a
 * value from somewhere. But a null that WINS while some model had a value is
 * still recorded as a dispute, because the most dangerous thing a model can do
 * is invent a plausible figure — and the second most dangerous is for the
 * others to quietly overrule a figure that was really there.
 */

/** How each scalar field is compared. Anything absent compares by identity. */
const COMPARATORS = {
  "metadata.companyName": textKey,
  "metadata.accountName": textKey,
  "metadata.accountNumber": accountKey,
  "metadata.accountType": textKey,
  "metadata.branch": textKey,
  "metadata.currency": (v) => (v ? String(v).toUpperCase() : null),
};

/**
 * The fields that decide whether an extraction is usable without a human.
 *
 * Not everything matters equally. A missing branch name costs nobody anything;
 * a disagreement about the account number means the transactions might belong
 * to a different account, and a disagreement about the closing balance means
 * the read did not finish. These are the ones that force review.
 */
export const CRITICAL_FIELDS = Object.freeze([
  "metadata.accountNumber",
  "metadata.statementPeriodFrom",
  "metadata.statementPeriodTo",
  "balances.openingCents",
  "balances.closingCents",
]);

const identity = (v) => (v === undefined ? null : v);

/**
 * Vote on one field.
 *
 * @param {Array<{analyst: string, value: *}>} entries  one per model that answered
 * @param {object} opts
 * @param {number} opts.quorum
 * @param {Function} opts.compare  value → comparison key
 */
export function voteField(entries, { quorum = 2, compare = identity, field = "" } = {}) {
  const groups = new Map();
  for (const { analyst, value } of entries) {
    const key = JSON.stringify(compare(value) ?? null);
    if (!groups.has(key)) groups.set(key, { value, analysts: [] });
    groups.get(key).analysts.push(analyst);
  }

  const candidates = [...groups.values()].sort((a, b) => b.analysts.length - a.analysts.length);
  const top = candidates[0] || { value: null, analysts: [] };
  const reached = top.analysts.length >= quorum;
  const unanimous = candidates.length === 1 && entries.length > 1;

  // A null that won while somebody saw a value: the figure may be real and
  // simply hard to read. Flagged, and the dissenting value travels with it.
  const nullWonOverValue =
    reached && (top.value === null || top.value === undefined) && candidates.some((c) => c.value !== null && c.value !== undefined);

  return {
    field,
    value: reached ? top.value : null,
    agreed: reached && !nullWonOverValue,
    votes: top.analysts.length,
    of: entries.length,
    unanimous,
    analysts: top.analysts,
    // Every distinct read, for the review screen. Small, and the only record of
    // what the losing models actually said.
    candidates: candidates.map((c) => ({ value: c.value, analysts: c.analysts })),
  };
}

/** Read a dotted path out of a nested object. */
const at = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Vote on every scalar field of the document.
 *
 * @param {Array<{analyst: string, read: object}>} reads
 */
export function voteScalars(reads, { quorum = 2 } = {}) {
  const fields = [
    "documentType",
    "metadata.companyName",
    "metadata.accountName",
    "metadata.accountNumber",
    "metadata.accountType",
    "metadata.branch",
    "metadata.currency",
    "metadata.statementPeriodFrom",
    "metadata.statementPeriodTo",
    "metadata.statementDate",
    "balances.openingCents",
    "balances.closingCents",
    "statedTotals.totalCreditsCents",
    "statedTotals.totalDebitsCents",
    "statedTotals.transactionCount",
  ];

  const out = {};
  for (const field of fields) {
    out[field] = voteField(
      reads.map(({ analyst, read }) => ({ analyst, value: at(read, field) ?? null })),
      { quorum, compare: COMPARATORS[field] || identity, field }
    );
  }
  return out;
}

/** Index one read's rows by key, keeping duplicates — a statement can repeat a row. */
function indexRows(rows, keyFn) {
  const map = new Map();
  rows.forEach((row, i) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ row, index: i });
  });
  return map;
}

/** The count at least `quorum` analysts reported for one key. */
function quorumCount(counts, quorum) {
  const tally = new Map();
  for (const n of counts) tally.set(n, (tally.get(n) || 0) + 1);
  let best = null;
  for (const [n, seen] of tally) {
    if (seen < quorum) continue;
    // Ties go to the SMALLER count. Emitting a row two of three models did not
    // see is inventing a transaction; omitting one is a dispute that gets
    // reported. The first is silent, the second is not.
    if (best === null || n < best) best = n;
  }
  return best;
}

/**
 * Vote on the transaction rows.
 *
 * Two passes. The strict key is date + amount + a short description prefix; the
 * loose key drops the description, for rows where one model read a smudged
 * narrative differently but everything that matters financially matches. A row
 * matched loosely still counts as agreement on the MONEY, and its description
 * is then voted on separately — which is exactly the resolution a person would
 * make by hand.
 */
export function voteTransactions(reads, { quorum = 2 } = {}) {
  if (!reads.length) return { rows: [], disputes: [], agreementRatio: 0, counts: {} };

  const strict = reads.map(({ analyst, read }) => ({
    analyst,
    rows: read.transactions || [],
    index: indexRows(read.transactions || [], rowKey),
  }));

  const allKeys = new Set(strict.flatMap((r) => [...r.index.keys()]));

  const accepted = [];
  const disputes = [];
  /** Rows nobody's quorum claimed, held for the loose pass. */
  const leftovers = strict.map(({ analyst }) => ({ analyst, rows: [] }));

  for (const key of allKeys) {
    const counts = strict.map((r) => (r.index.get(key) || []).length);
    const agreedCount = quorumCount(counts, quorum);
    const present = strict.filter((r) => r.index.has(key)).map((r) => r.analyst);

    if (agreedCount === null || agreedCount === 0) {
      // Below quorum, or the quorum agreed the row does not exist.
      for (const r of strict) {
        for (const { row, index } of r.index.get(key) || []) {
          leftovers.find((l) => l.analyst === r.analyst).rows.push({ row, index, key });
        }
      }
      continue;
    }

    for (let occurrence = 0; occurrence < agreedCount; occurrence += 1) {
      const contributors = strict
        .map((r) => ({ analyst: r.analyst, entry: (r.index.get(key) || [])[occurrence] }))
        .filter((c) => c.entry);
      accepted.push(mergeRow(contributors, { quorum, key, matchedBy: "exact", present }));
    }

    // A model that reported the row MORE times than the quorum agreed on has a
    // duplicate; the surplus is a dispute, not a silent trim.
    for (const r of strict) {
      const extra = (r.index.get(key) || []).slice(agreedCount);
      for (const { row, index } of extra) {
        disputes.push({
          kind: "duplicate_row",
          key,
          analysts: [r.analyst],
          detail: `${r.analyst} reported this row ${(r.index.get(key) || []).length} times; ${agreedCount} agreed`,
          row: displayRow(row),
          index,
        });
      }
    }
  }

  // ── Loose pass: same day, same money, different narrative ────────────────
  const looseIndex = leftovers.map(({ analyst, rows }) => ({
    analyst,
    index: indexRows(rows.map((r) => r.row), rowKeyLoose),
    rows,
  }));
  const looseKeys = new Set(looseIndex.flatMap((r) => [...r.index.keys()]));

  for (const key of looseKeys) {
    const counts = looseIndex.map((r) => (r.index.get(key) || []).length);
    const agreedCount = quorumCount(counts, quorum);
    if (agreedCount === null || agreedCount === 0) {
      for (const r of looseIndex) {
        for (const { row } of r.index.get(key) || []) {
          disputes.push({
            kind: "unmatched_row",
            key,
            analysts: [r.analyst],
            detail: `only ${r.analyst} found this row`,
            row: displayRow(row),
          });
        }
      }
      continue;
    }
    for (let occurrence = 0; occurrence < agreedCount; occurrence += 1) {
      const contributors = looseIndex
        .map((r) => ({ analyst: r.analyst, entry: (r.index.get(key) || [])[occurrence] }))
        .filter((c) => c.entry);
      const merged = mergeRow(contributors, { quorum, key, matchedBy: "amount+date", present: contributors.map((c) => c.analyst) });
      accepted.push(merged);
      if (!merged.fields.description.agreed) {
        disputes.push({
          kind: "row_description",
          key,
          analysts: merged.analysts,
          detail: "the models read this row's narrative differently",
          row: displayRow(merged),
          candidates: merged.fields.description.candidates,
        });
      }
    }
  }

  // Printed order: page first, then the position the models put it in. The
  // reference is the read with the most rows, because it is the one that
  // dropped the least.
  const reference = strict.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
  const referenceOrder = new Map();
  (reference?.rows || []).forEach((row, i) => {
    const k = rowKey(row);
    if (!referenceOrder.has(k)) referenceOrder.set(k, i);
  });
  accepted.sort((a, b) => {
    const pa = a.page ?? 0;
    const pb = b.page ?? 0;
    if (pa !== pb) return pa - pb;
    const ia = referenceOrder.has(a.key) ? referenceOrder.get(a.key) : Number.MAX_SAFE_INTEGER;
    const ib = referenceOrder.has(b.key) ? referenceOrder.get(b.key) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return String(a.key).localeCompare(String(b.key));
  });

  const proposed = Math.max(...strict.map((r) => r.rows.length), accepted.length);
  return {
    rows: accepted,
    disputes,
    agreementRatio: proposed ? accepted.length / proposed : 1,
    counts: Object.fromEntries(strict.map((r) => [r.analyst, r.rows.length])),
  };
}

/** One accepted row, each of its fields voted across the models that had it. */
function mergeRow(contributors, { quorum, key, matchedBy, present }) {
  const vote = (pick, compare) =>
    voteField(
      contributors.map((c) => ({ analyst: c.analyst, value: pick(c.entry.row) })),
      // The quorum for a FIELD of an already-agreed row is a simple majority of
      // the models that found the row — requiring the document-level quorum
      // here would reject a description two of two matched analysts agreed on.
      { quorum: Math.min(quorum, contributors.length), compare: compare || identity, field: "" }
    );

  const fields = {
    page: vote((r) => r.page),
    dateIso: vote((r) => r.dateIso),
    dateRaw: vote((r) => r.dateRaw),
    description: vote((r) => r.description, textKey),
    reference: vote((r) => r.reference, textKey),
    creditCents: vote((r) => r.creditCents),
    debitCents: vote((r) => r.debitCents),
    amountCents: vote((r) => r.amountCents),
    balanceCents: vote((r) => r.balanceCents),
  };

  return {
    key,
    matchedBy,
    analysts: contributors.map((c) => c.analyst),
    seenBy: present,
    page: fields.page.value,
    dateIso: fields.dateIso.value,
    dateRaw: fields.dateRaw.value,
    // The DISPLAYED description is the winning model's own text, not a
    // normalized key — what goes into the books must be what the document said.
    description: fields.description.value,
    reference: fields.reference.value,
    creditCents: fields.creditCents.value,
    debitCents: fields.debitCents.value,
    amountCents: fields.amountCents.value,
    balanceCents: fields.balanceCents.value,
    fields,
  };
}

/** The compact shape a dispute carries — enough to recognise the row, no more. */
function displayRow(row) {
  return {
    page: row.page ?? null,
    date: row.dateIso || row.dateRaw || null,
    description: row.description ?? null,
    credit: row.creditCents === null || row.creditCents === undefined ? null : row.creditCents / 100,
    debit: row.debitCents === null || row.debitCents === undefined ? null : row.debitCents / 100,
    balance: row.balanceCents === null || row.balanceCents === undefined ? null : row.balanceCents / 100,
  };
}

export default { voteField, voteScalars, voteTransactions, CRITICAL_FIELDS };
