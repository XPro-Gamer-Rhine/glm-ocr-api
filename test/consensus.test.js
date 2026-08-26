import test from "node:test";
import assert from "node:assert/strict";

import { toCents, toIntOrNull, toIsoDay, textKey, accountKey, normalizeRow, normalizeChunk, mergeChunks, rowKey } from "../src/agent/consensus/normalize.js";
import { voteField, voteScalars, voteTransactions, CRITICAL_FIELDS } from "../src/agent/consensus/vote.js";
import { parseJsonReply } from "../src/agent/consensus/parse.js";
import { chunkPages } from "../src/agent/consensus/index.js";

/**
 * The vote is the part of this system that decides whether a number reaches
 * someone's books, so it is the part worth testing hardest. Every case here is
 * a way three models actually differ on a real statement.
 */

// ── normalization ──────────────────────────────────────────────────────────

test("money normalizes to cents across the shapes models emit", () => {
  assert.equal(toCents(1234.5), 123450);
  assert.equal(toCents("1,234.50"), 123450);
  assert.equal(toCents("1.234,50"), 123450); // European
  assert.equal(toCents("(1,234.50)"), -123450); // parenthesised negative
  assert.equal(toCents("$1,234.50"), 123450);
  assert.equal(toCents(null), null);
  assert.equal(toCents(""), null);
  assert.equal(toCents("n/a"), null);
});

test("an absent whole number stays absent — Number(null) is 0 and that is a lie", () => {
  // `Number(null)`, `Number("")` and `Number(false)` are all 0 and all pass
  // Number.isFinite. Used unguarded, a field the document never printed becomes
  // a printed zero, and the reconciliation then measures the extraction against
  // a total that does not exist.
  assert.equal(toIntOrNull(null), null);
  assert.equal(toIntOrNull(undefined), null);
  assert.equal(toIntOrNull(""), null);
  assert.equal(toIntOrNull("not a number"), null);
  assert.equal(toIntOrNull(NaN), null);
  // …while a real zero survives, because "0 transactions" is a claim a
  // statement can genuinely make.
  assert.equal(toIntOrNull(0), 0);
  assert.equal(toIntOrNull("0"), 0);
  assert.equal(toIntOrNull(42), 42);
  assert.equal(toIntOrNull("42"), 42);
  assert.equal(toIntOrNull(42.7), 42);
});

test("a chunk that prints no totals reports null, not zero", () => {
  const chunk = normalizeChunk({
    statedTotals: { totalCredits: null, totalDebits: null, transactionCount: null },
    transactions: [],
  });
  assert.equal(chunk.statedTotals.transactionCount, null);
  assert.equal(chunk.statedTotals.totalCreditsCents, null);
});

test("a row with no page number does not land on page zero", () => {
  const row = normalizeRow({ page: null, credit: 10, description: "X" }, { pageFloor: 4, pageCeil: 6 });
  assert.equal(row.page, 4, "it inherits the chunk's first page, not 0");
});

test("float cents do not drift — the reason cents exist at all", () => {
  assert.equal(toCents(0.1) + toCents(0.2), toCents(0.3));
});

test("a date is only a date when it is a real calendar day", () => {
  assert.equal(toIsoDay("2025-01-31"), "2025-01-31");
  assert.equal(toIsoDay("2025-02-30"), null); // never rolls into March
  assert.equal(toIsoDay("2024-02-29"), "2024-02-29"); // leap year
  assert.equal(toIsoDay("2025-02-29"), null);
  assert.equal(toIsoDay("31/01/2025"), null); // not ISO — the model failed the contract
  assert.equal(toIsoDay(null), null);
});

test("text compares past the differences OCR invents", () => {
  assert.equal(textKey("ACME LTD."), textKey("Acme  Ltd"));
  assert.equal(textKey("SALARY - JAN/25"), textKey("salary jan 25"));
  assert.notEqual(textKey("ACME LTD"), textKey("ACNE LTD"));
});

test("account numbers compare on digits, so masking style does not split the vote", () => {
  assert.equal(accountKey("0123-4567-89"), accountKey("0123456789"));
  assert.equal(accountKey("XXXX XXXX 6789"), accountKey("****-****-6789"));
});

// ── rows ───────────────────────────────────────────────────────────────────

test("a row with neither money nor a description is not a transaction", () => {
  assert.equal(normalizeRow({ page: 1, dateIso: "2025-01-02" }), null);
  assert.equal(normalizeRow({}), null);
});

test("a balance line is not a transaction, however much it looks like one", () => {
  // Every model tested emits these despite being told not to. Left in, they
  // inflate the count and poison the first link of the balance chain.
  for (const description of [
    "BALANCE B/F",
    "Balance b/f",
    "BAL C/F",
    "BALANCE BROUGHT FORWARD",
    "Carried forward",
    "OPENING BALANCE",
    "Closing Balance",
    "Previous Balance",
    "SUB-TOTAL",
    "Total",
  ]) {
    assert.equal(
      normalizeRow({ page: 1, dateIso: "2025-01-01", description, balance: 50000 }),
      null,
      `"${description}" must not become a transaction`
    );
  }
});

test("a real transaction whose narrative contains a total word survives", () => {
  // The filter only ever applies to rows with NO credit and NO debit, so a
  // genuine payment is never caught by it.
  const paid = normalizeRow({ page: 1, dateIso: "2025-01-02", description: "TOTAL PAYMENT TO ACME LTD", debit: 900 });
  assert.ok(paid, "a row with money is a transaction whatever it is called");
  assert.equal(paid.amountCents, -90000);

  const settled = normalizeRow({ page: 1, dateIso: "2025-01-02", description: "CARD SUBTOTAL SETTLEMENT", credit: 12.5 });
  assert.ok(settled);
});

test("an illegible row keeps its place when it still says something specific", () => {
  const row = normalizeRow({ page: 3, dateIso: "2025-01-09", description: "CHEQUE 88192 CLEARING" });
  assert.ok(row, "a row the OCR damaged is reported, not dropped — dropping it changes the totals");
  assert.equal(row.amountCents, null);
});

test("credit and debit collapse into one signed amount, exactly once", () => {
  const credit = normalizeRow({ page: 2, credit: 500, debit: null, description: "PAY" });
  assert.equal(credit.amountCents, 50000);
  const debit = normalizeRow({ page: 2, credit: null, debit: 250.25, description: "FEE" });
  assert.equal(debit.amountCents, -25025);
  assert.equal(debit.debitCents, 25025);
});

test("a row with BOTH columns filled is left ambiguous rather than guessed", () => {
  const row = normalizeRow({ page: 1, credit: 100, debit: 900, description: "?" });
  assert.equal(row.ambiguousColumns, true);
  assert.equal(row.amountCents, null); // the vote will see the disagreement
});

test("a page number outside the chunk is clamped, never dropped", () => {
  const row = normalizeRow({ page: 99, credit: 10, description: "X" }, { pageFloor: 5, pageCeil: 8 });
  assert.equal(row.page, 8);
  const low = normalizeRow({ page: 1, credit: 10, description: "X" }, { pageFloor: 5, pageCeil: 8 });
  assert.equal(low.page, 5);
});

test("the row key ignores the narrative tail but keeps same-day rows distinct", () => {
  const a = normalizeRow({ page: 1, dateIso: "2025-01-02", credit: 100, description: "TRANSFER FROM ACME LTD REF 99812" });
  const b = normalizeRow({ page: 1, dateIso: "2025-01-02", credit: 100, description: "TRANSFER FROM ACME LTD REF 998I2" });
  assert.equal(rowKey(a), rowKey(b), "an OCR slip in the tail must not split one row into two");

  const c = normalizeRow({ page: 1, dateIso: "2025-01-02", credit: 100, description: "ATM WITHDRAWAL" });
  assert.notEqual(rowKey(a), rowKey(c), "two same-day same-amount rows must stay distinct");
});

// ── field voting ───────────────────────────────────────────────────────────

const entries = (...values) =>
  values.map((value, i) => ({ analyst: ["claude", "gpt", "glm"][i], value }));

test("two of three agreeing carries the field", () => {
  const v = voteField(entries("ACME BANK", "Acme Bank", "ACNE BANK"), { quorum: 2, compare: textKey });
  assert.equal(v.agreed, true);
  assert.equal(v.votes, 2);
  assert.deepEqual(v.analysts, ["claude", "gpt"]);
});

test("three different answers carry nothing", () => {
  const v = voteField(entries(100, 200, 300), { quorum: 2 });
  assert.equal(v.agreed, false);
  assert.equal(v.value, null);
  assert.equal(v.candidates.length, 3);
});

test("null is a vote — two models saying nothing is printed outvote one that found a figure", () => {
  const v = voteField(entries(null, null, 4200), { quorum: 2 });
  assert.equal(v.votes, 2);
  // …but it is NOT called agreement, because a real figure may have been lost.
  assert.equal(v.agreed, false, "a null winning over a value must always be reviewable");
  assert.ok(v.candidates.some((c) => c.value === 4200), "the dissenting figure survives for the reviewer");
});

test("all three silent about an unprinted field is genuine agreement", () => {
  const v = voteField(entries(null, null, null), { quorum: 2 });
  assert.equal(v.agreed, true);
  assert.equal(v.value, null);
  assert.equal(v.unanimous, true);
});

test("every critical field is one the scalar vote actually produces", () => {
  const read = () => ({
    documentType: "bank_statement",
    metadata: { accountNumber: "1", statementPeriodFrom: "2025-01-01", statementPeriodTo: "2025-01-31" },
    balances: { openingCents: 1, closingCents: 2 },
    statedTotals: {},
  });
  const votes = voteScalars(
    [
      { analyst: "claude", read: read() },
      { analyst: "gpt", read: read() },
    ],
    { quorum: 2 }
  );
  for (const field of CRITICAL_FIELDS) {
    assert.ok(votes[field], `${field} is treated as critical but is never voted on`);
  }
});

// ── transaction voting ─────────────────────────────────────────────────────

const row = (over = {}) =>
  normalizeRow({ page: 1, dateIso: "2025-01-02", description: "SALARY", credit: 1000, debit: null, balance: 5000, ...over });

const read = (rows) => ({ transactions: rows });

test("a row two of three found is accepted; a row only one found is not", () => {
  const shared = [row(), row({ dateIso: "2025-01-03", description: "RENT", credit: null, debit: 400, balance: 4600 })];
  const lonely = row({ dateIso: "2025-01-09", description: "GHOST", credit: 12, balance: 4612 });

  const out = voteTransactions(
    [
      { analyst: "claude", read: read([...shared]) },
      { analyst: "gpt", read: read([...shared]) },
      { analyst: "glm", read: read([...shared, lonely]) },
    ],
    { quorum: 2 }
  );

  assert.equal(out.rows.length, 2);
  assert.ok(
    out.disputes.some((d) => d.kind === "unmatched_row" && d.analysts.includes("glm")),
    "the row only one model saw must be reported, not silently dropped"
  );
});

test("a row all three found is accepted with all three named", () => {
  const out = voteTransactions(
    [
      { analyst: "claude", read: read([row()]) },
      { analyst: "gpt", read: read([row()]) },
      { analyst: "glm", read: read([row()]) },
    ],
    { quorum: 2 }
  );
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0].analysts.sort(), ["claude", "glm", "gpt"]);
  assert.equal(out.agreementRatio, 1);
});

test("a narrative one model read differently still agrees on the money", () => {
  const a = row({ description: "TRANSFER FROM ACME LTD" });
  const b = row({ description: "TRANSFER FROM ACME LTD" });
  const c = row({ description: "TRANSFEP FRQM ACNE LTB" }); // badly OCR'd

  const out = voteTransactions(
    [
      { analyst: "claude", read: read([a]) },
      { analyst: "gpt", read: read([b]) },
      { analyst: "glm", read: read([c]) },
    ],
    { quorum: 2 }
  );
  assert.equal(out.rows.length, 1, "one transaction, not two");
  assert.equal(out.rows[0].amountCents, 100000);
  assert.equal(out.rows[0].description, "TRANSFER FROM ACME LTD", "the majority's reading wins the text");
});

test("a duplicate one model invented is reported and not emitted twice", () => {
  const out = voteTransactions(
    [
      { analyst: "claude", read: read([row()]) },
      { analyst: "gpt", read: read([row()]) },
      { analyst: "glm", read: read([row(), row()]) },
    ],
    { quorum: 2 }
  );
  assert.equal(out.rows.length, 1);
  assert.ok(out.disputes.some((d) => d.kind === "duplicate_row"));
});

test("a row genuinely printed twice survives when two models both saw it twice", () => {
  const twice = [row(), row()];
  const out = voteTransactions(
    [
      { analyst: "claude", read: read([...twice]) },
      { analyst: "gpt", read: read([...twice]) },
      { analyst: "glm", read: read([row()]) },
    ],
    { quorum: 2 }
  );
  assert.equal(out.rows.length, 2, "two models saw two rows, so there are two rows");
});

test("accepted rows come out in printed order across pages", () => {
  const rows = [
    row({ page: 3, dateIso: "2025-01-20", description: "C", credit: 3 }),
    row({ page: 1, dateIso: "2025-01-02", description: "A", credit: 1 }),
    row({ page: 2, dateIso: "2025-01-10", description: "B", credit: 2 }),
  ];
  const out = voteTransactions(
    [
      { analyst: "claude", read: read([...rows]) },
      { analyst: "gpt", read: read([...rows]) },
    ],
    { quorum: 2 }
  );
  assert.deepEqual(out.rows.map((r) => r.page), [1, 2, 3]);
});

// ── chunk merging ──────────────────────────────────────────────────────────

test("opening comes from the first chunk and closing from the last", () => {
  const merged = mergeChunks([
    normalizeChunk({ balances: { opening: 100, closing: 500 }, transactions: [] }),
    normalizeChunk({ balances: { opening: 500, closing: 900 }, transactions: [] }),
  ]);
  assert.equal(merged.balances.openingCents, 10000, "a mid-document carry-forward is not the opening balance");
  assert.equal(merged.balances.closingCents, 90000);
});

test("a chunk a model failed does not erase what the others read", () => {
  const merged = mergeChunks([
    null,
    normalizeChunk({ metadata: { companyName: "ACME BANK" }, transactions: [{ page: 5, credit: 10, description: "X" }] }),
  ]);
  assert.equal(merged.metadata.companyName, "ACME BANK");
  assert.equal(merged.transactions.length, 1);
});

test("pages chunk evenly and completely", () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ page: i + 1 }));
  const chunks = chunkPages(pages, 4);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.flat().length, 9);
  assert.deepEqual(chunks[2].map((p) => p.page), [9]);
});

// ── reply parsing ──────────────────────────────────────────────────────────

test("a fenced reply parses", () => {
  const r = parseJsonReply('```json\n{"a": 1}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 1);
});

test("prose around the object parses", () => {
  const r = parseJsonReply('Here is the extraction:\n{"a": 1}\nLet me know if you need more.');
  assert.equal(r.ok, true);
});

test("a brace inside a transaction description does not break the scan", () => {
  const r = parseJsonReply('{"transactions":[{"description":"PAYMENT {REF 12}"}]}');
  assert.equal(r.ok, true);
  assert.equal(r.value.transactions[0].description, "PAYMENT {REF 12}");
});

test("a reply truncated mid-array is refused, never half-recovered", () => {
  const r = parseJsonReply('{"transactions":[{"credit":1},{"credit":2}');
  assert.equal(r.ok, false);
  assert.match(r.reason, /truncated/);
});
