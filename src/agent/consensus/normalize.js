import { parseAmount } from "../../services/analysis.service.js";
import { DOCUMENT_TYPES } from "./schema.js";

/**
 * Turning three models' replies into three things that can be compared.
 *
 * Comparison is the whole product here, and comparison is only meaningful
 * between values in the same form. `1,234.50`, `1234.5` and `1234.50` are one
 * amount written three ways, and three models WILL write it three ways; if the
 * vote sees three different strings it reports a disagreement that does not
 * exist, and the accountant gets sent to review a statement that was read
 * perfectly. Equally, `ACME LTD.` and `Acme Ltd` are one company.
 *
 * So: money becomes integer cents, dates become ISO days, text becomes a
 * comparison key — and the ORIGINAL is kept beside every one of them, because
 * what is eventually written into the books must be what the document said,
 * not what was convenient to compare.
 */

/** Money as integer cents. Floats do not compare: 0.1 + 0.2 is not 0.3. */
export function toCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseAmount(value);
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const fromCents = (cents) => (cents === null || cents === undefined ? null : cents / 100);

/**
 * A whole number, or null — never a zero conjured out of an absence.
 *
 * `Number(null)` is 0 and `Number("")` is 0, and both pass `Number.isFinite`.
 * That turned "the statement prints no transaction count" into "the statement
 * prints a count of ZERO", which the reconciliation then compared against the
 * rows actually extracted and declared the read incomplete — flagging a
 * perfectly good statement for human review. An absent figure must stay absent
 * all the way through.
 */
export function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** A date is only a date here if it is a real calendar day in ISO form. */
export function toIsoDay(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject the 31st of a 30-day month rather than let Date roll it into the 1st.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

/**
 * The comparison key for a piece of text.
 *
 * Case, punctuation, and runs of whitespace are exactly the things OCR and
 * three different models will differ on, and none of them change what a
 * description says. The displayed value stays untouched.
 */
export function textKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return key || null;
}

/** An account number compares on its digits alone — masking varies by model. */
export function accountKey(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits : textKey(value);
}

/**
 * A row that states a balance rather than a movement.
 *
 * Only ever applied when the row carries NO credit and NO debit — a real
 * transaction described as "TOTAL PAYMENT TO ACME" has an amount and is never
 * caught by this.
 */
const BALANCE_LINE =
  /\b(?:bal(?:ance)?\s*(?:b\/?f|c\/?f|fwd|brought|carried)|brought\s+forward|carried\s+forward|opening\s+balance|closing\s+balance|previous\s+balance|sub[\s-]?total|grand\s+total)\b|^\s*total\b/i;

const trimmedOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
  return s;
};

/**
 * One transaction row, canonicalized.
 *
 * `credit` and `debit` collapse into a single signed `amountCents` here and
 * nowhere earlier: the models were asked to copy two columns, and turning two
 * columns into a sign is a decision this code makes once, visibly, rather than
 * three models each making it differently in private.
 */
export function normalizeRow(row, { pageFloor = null, pageCeil = null } = {}) {
  if (!row || typeof row !== "object") return null;

  const credit = toCents(row.credit);
  const debit = toCents(row.debit);
  const description = trimmedOrNull(row.description);
  const dateIso = toIsoDay(row.dateIso);
  const dateRaw = trimmedOrNull(row.dateRaw);

  // A row with neither money nor a description is not a transaction — it is a
  // header, a page footer, or a hallucinated blank the model padded its array
  // with. Dropping it here keeps it out of the vote entirely.
  if (credit === null && debit === null && !description) return null;

  // Neither is a balance line. Every model tested emits "BALANCE B/F" as a
  // transaction row despite being told not to — it looks exactly like one, with
  // a date and a balance and no amount. Left in, it inflates the transaction
  // count, and its balance becomes the first link of the balance chain, so the
  // chain check then measures a row that is not a movement. The prompt asks;
  // this enforces.
  if (credit === null && debit === null && BALANCE_LINE.test(description)) return null;

  // Same hazard as above: a model that omitted `page` sends null, and
  // `Number(null)` is 0 — a page number that exists on no document and sorts
  // ahead of every real row.
  let page = toIntOrNull(row.page);
  if (page === null) page = pageFloor ?? null;
  // A model that wandered outside its chunk was reading a page it was not
  // given. Clamped rather than dropped: the row is real, the page number is a
  // guess, and losing the row would change the totals.
  if (page !== null && pageFloor !== null && page < pageFloor) page = pageFloor;
  if (page !== null && pageCeil !== null && page > pageCeil) page = pageCeil;

  // Both columns filled is a misread of a two-column layout. The larger figure
  // is the amount and the other is almost always the balance bleeding across;
  // rather than guess which, this is flagged by leaving the row's sign
  // ambiguous — the vote will see two models disagree and say so.
  const both = credit !== null && debit !== null;
  const amountCents = both ? null : credit !== null ? credit : debit === null ? null : -Math.abs(debit);

  return {
    page,
    dateRaw,
    dateIso,
    description,
    reference: trimmedOrNull(row.reference),
    creditCents: credit,
    debitCents: debit === null ? null : Math.abs(debit),
    amountCents,
    balanceCents: toCents(row.balance),
    ambiguousColumns: both,
  };
}

/**
 * The identity of a transaction, for matching one model's rows against
 * another's.
 *
 * Date and amount, plus a short description prefix. NOT the whole description:
 * OCR differs on the tail of a narrative far more often than on its start, and
 * a key that includes the tail turns "read the same row slightly differently"
 * into "found a different row". NOT the balance either, which a model may have
 * dropped without getting the transaction wrong.
 *
 * The prefix is long enough that two genuinely different same-day, same-amount
 * transactions stay distinct, which is the failure in the other direction.
 */
export function rowKey(row) {
  const date = row.dateIso || row.dateRaw || "?";
  const amount = row.amountCents === null ? (row.creditCents ?? row.debitCents ?? "?") : row.amountCents;
  const desc = (textKey(row.description) || "").slice(0, 24);
  return `${date}|${amount}|${desc}`;
}

/** A looser key, for the second matching pass — same day, same money. */
export function rowKeyLoose(row) {
  const date = row.dateIso || row.dateRaw || "?";
  const amount = row.amountCents === null ? (row.creditCents ?? row.debitCents ?? "?") : row.amountCents;
  return `${date}|${amount}`;
}

/** Coerce one model's reply for one chunk into the canonical shape. */
export function normalizeChunk(value, { pageFloor = null, pageCeil = null } = {}) {
  const v = value && typeof value === "object" ? value : {};
  const meta = v.metadata && typeof v.metadata === "object" ? v.metadata : {};
  const balances = v.balances && typeof v.balances === "object" ? v.balances : {};
  const totals = v.statedTotals && typeof v.statedTotals === "object" ? v.statedTotals : {};

  const documentType = trimmedOrNull(v.documentType);

  const rows = (Array.isArray(v.transactions) ? v.transactions : [])
    .map((r) => normalizeRow(r, { pageFloor, pageCeil }))
    .filter(Boolean);

  return {
    documentType: DOCUMENT_TYPES.includes(documentType) ? documentType : documentType ? "other" : null,
    metadata: {
      companyName: trimmedOrNull(meta.companyName),
      accountName: trimmedOrNull(meta.accountName),
      accountNumber: trimmedOrNull(meta.accountNumber),
      accountType: trimmedOrNull(meta.accountType),
      branch: trimmedOrNull(meta.branch),
      currency: trimmedOrNull(meta.currency)?.toUpperCase() ?? null,
      statementPeriodFrom: toIsoDay(meta.statementPeriodFrom),
      statementPeriodTo: toIsoDay(meta.statementPeriodTo),
      statementDate: toIsoDay(meta.statementDate),
    },
    balances: {
      openingCents: toCents(balances.opening),
      closingCents: toCents(balances.closing),
    },
    statedTotals: {
      totalCreditsCents: toCents(totals.totalCredits),
      totalDebitsCents: toCents(totals.totalDebits),
      transactionCount: toIntOrNull(totals.transactionCount),
    },
    transactions: rows,
  };
}

/**
 * One analyst's chunks, folded into one document read.
 *
 * The per-field merge rules are not arbitrary. An opening balance is whatever
 * the FIRST chunk found — a mid-document "balance brought forward" is a page
 * artefact, not the statement's opening. A closing balance is the LAST chunk's,
 * for the mirror reason. Everything else takes the first chunk that saw it,
 * because headers are printed at the front and a repeat further in is a page
 * header, not a correction.
 */
export function mergeChunks(chunks) {
  const usable = chunks.filter(Boolean);
  const first = (pick) => {
    for (const c of usable) {
      const v = pick(c);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const last = (pick) => {
    for (let i = usable.length - 1; i >= 0; i -= 1) {
      const v = pick(usable[i]);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };

  const transactions = usable
    .flatMap((c) => c.transactions)
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));

  return {
    documentType: first((c) => c.documentType),
    metadata: {
      companyName: first((c) => c.metadata.companyName),
      accountName: first((c) => c.metadata.accountName),
      accountNumber: first((c) => c.metadata.accountNumber),
      accountType: first((c) => c.metadata.accountType),
      branch: first((c) => c.metadata.branch),
      currency: first((c) => c.metadata.currency),
      statementPeriodFrom: first((c) => c.metadata.statementPeriodFrom),
      statementPeriodTo: last((c) => c.metadata.statementPeriodTo),
      statementDate: first((c) => c.metadata.statementDate),
    },
    balances: {
      openingCents: usable.length ? usable[0].balances.openingCents : null,
      closingCents: last((c) => c.balances.closingCents),
    },
    statedTotals: {
      totalCreditsCents: last((c) => c.statedTotals.totalCreditsCents),
      totalDebitsCents: last((c) => c.statedTotals.totalDebitsCents),
      transactionCount: last((c) => c.statedTotals.transactionCount),
    },
    transactions,
  };
}

export default {
  toCents,
  fromCents,
  toIntOrNull,
  toIsoDay,
  textKey,
  accountKey,
  normalizeRow,
  normalizeChunk,
  mergeChunks,
  rowKey,
  rowKeyLoose,
};
