import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * The CHAIN, proven rather than assumed.
 *
 * The design says: GLM-OCR turns pixels into text, and that text — nothing else
 * — is what the three readers vote on. Every part of that is easy to believe and
 * easy to get wrong, because the text passes through four modules on its way
 * from the OCR call to the prompt, and a single wrong field name anywhere sends
 * an EMPTY page to the models. They would then agree, unanimously, that the
 * statement has no transactions.
 *
 * So this test stands a fake OpenAI and a fake Ollama on localhost, points the
 * config at them, and runs the real `runConsensus`. Nothing is stubbed inside
 * the pipeline: real chunking, real prompt building, real HTTP, real parsing,
 * real normalization, real vote, real reconciliation.
 *
 * It downloads nothing and calls no paid API.
 */

// The escape hatch config.js documents: DIME_OCR_-prefixed variables are read
// ahead of both the .env chain and the ambient environment. Set BEFORE the
// config module is imported, because it freezes its values on first import.
const PORT = 47311;
process.env.DIME_OCR_OPENAI_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.DIME_OCR_OLLAMA_HOST = `http://127.0.0.1:${PORT}`;
process.env.DIME_OCR_OPENAI_API_KEY = "test-key-not-real";
process.env.DIME_OCR_OPENAI_MODEL = "gpt-test";
process.env.DIME_OCR_GLM_CHAT_MODEL = "glm-test:9b";
// NOTE the doubled prefix on these three. The override scheme is
// `DIME_OCR_` + THE KEY NAME, and these keys already begin with `OCR_`, so the
// variable really is DIME_OCR_OCR_ANALYST_CLAUDE. Getting this wrong fails
// silently — the override is simply not found and the .env value stands, which
// is exactly how an earlier version of this test spawned the real Claude CLI
// while believing it had disabled it.
process.env.DIME_OCR_OCR_ANALYST_CLAUDE = "false"; // spawns a subprocess; keep this hermetic
process.env.DIME_OCR_OCR_CONSENSUS_QUORUM = "2";
process.env.DIME_OCR_OCR_PAGES_PER_CHUNK = "2";

const { runConsensus } = await import("../src/agent/consensus/index.js");
const { choosePageText, pageSourceName } = await import("../src/services/rawRead.service.js");

/** What GLM-OCR would return for a scanned page. */
const OCR_PAGE_1 = `
SONALI BANK LIMITED
Statement of Account — Gulshan Branch
Account Name: ACME TRADING LTD
Account No: 0123456789012
Period: 01-Jan-2025 to 31-Jan-2025   Currency: BDT

Date        Particulars           Debit      Credit     Balance
01/01/2025  BALANCE B/F                                 50,000.00
03/01/2025  CHEQUE DEPOSIT                   25,000.00  75,000.00
`.trim();

const OCR_PAGE_2 = `
07/01/2025  ATM WITHDRAWAL        5,000.00              70,000.00
15/01/2025  SALARY CREDIT                    40,000.00 110,000.00

Total Debits: 5,000.00   Total Credits: 65,000.00   Closing Balance: 110,000.00
`.trim();

/**
 * What both fake readers answer. Identical on purpose: this test is about the
 * PLUMBING, and two identical reads make every value reach quorum, so anything
 * missing from the output is the pipeline's doing and not the vote's.
 */
const reply = (chunkIndex) =>
  chunkIndex === 0
    ? {
        documentType: "bank_statement",
        metadata: {
          companyName: "SONALI BANK LIMITED",
          accountName: "ACME TRADING LTD",
          accountNumber: "0123456789012",
          accountType: null,
          branch: "Gulshan Branch",
          currency: "BDT",
          statementPeriodFrom: "2025-01-01",
          statementPeriodTo: "2025-01-31",
          statementDate: null,
        },
        balances: { opening: 50000, closing: null },
        statedTotals: { totalCredits: null, totalDebits: null, transactionCount: null },
        transactions: [
          { page: 1, dateRaw: "01/01/2025", dateIso: "2025-01-01", description: "BALANCE B/F", reference: null, credit: null, debit: null, balance: 50000 },
          { page: 1, dateRaw: "03/01/2025", dateIso: "2025-01-03", description: "CHEQUE DEPOSIT", reference: null, credit: 25000, debit: null, balance: 75000 },
        ],
      }
    : {
        documentType: "bank_statement",
        metadata: {
          companyName: null, accountName: null, accountNumber: null, accountType: null,
          branch: null, currency: null, statementPeriodFrom: null, statementPeriodTo: null, statementDate: null,
        },
        balances: { opening: null, closing: 110000 },
        statedTotals: { totalCredits: 65000, totalDebits: 5000, transactionCount: null },
        transactions: [
          { page: 3, dateRaw: "07/01/2025", dateIso: "2025-01-07", description: "ATM WITHDRAWAL", reference: null, credit: null, debit: 5000, balance: 70000 },
          { page: 3, dateRaw: "15/01/2025", dateIso: "2025-01-15", description: "SALARY CREDIT", reference: null, credit: 40000, debit: null, balance: 110000 },
        ],
      };

/** Every prompt each fake reader was handed, so the chain can be inspected. */
const seen = { gpt: [], glm: [] };

/** When set, both fake readers return this instead of the default fixture. */
let override = null;

function chunkIndexFrom(prompt) {
  const m = prompt.match(/This is chunk (\d+) of (\d+)/);
  return m ? Number(m[1]) - 1 : 0;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // availability probes
    if (req.method === "GET" && req.url.startsWith("/v1/models/")) return json(200, { id: "gpt-test" });
    if (req.method === "GET" && req.url === "/api/tags") return json(200, { models: [{ name: "glm-test:9b" }] });

    const parsed = body ? JSON.parse(body) : {};

    if (req.url === "/v1/chat/completions") {
      const prompt = parsed.messages[0].content;
      seen.gpt.push(prompt);
      return json(200, {
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(override || reply(chunkIndexFrom(prompt))) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    }

    if (req.url === "/api/chat") {
      const prompt = parsed.messages[0].content;
      seen.glm.push(prompt);
      // Ollama wraps its reply differently and often fences it — exercising the
      // tolerant parser rather than the happy path.
      return json(200, {
        message: { content: "```json\n" + JSON.stringify(override || reply(chunkIndexFrom(prompt))) + "\n```" },
        prompt_eval_count: 100,
        eval_count: 50,
      });
    }

    json(404, { error: `unexpected ${req.method} ${req.url}` });
  });
});

test.before(() => new Promise((r) => server.listen(PORT, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

// ── Step 1: GLM-OCR's text is what gets carried forward ───────────────────

test("a scanned page with no text layer carries the OCR read forward, not the empty layer", () => {
  // This is the join between the OCR call and everything downstream. If it
  // picked the embedded layer, every reader would receive a blank page and
  // agree unanimously that the statement is empty.
  assert.equal(choosePageText("", OCR_PAGE_1), OCR_PAGE_1);
  assert.equal(choosePageText("   \n  ", OCR_PAGE_1), OCR_PAGE_1);
  assert.equal(pageSourceName("", OCR_PAGE_1), "glm-ocr");
});

test("a digital page prefers its own text layer over OCR", () => {
  const digital = "x".repeat(250);
  assert.equal(choosePageText(digital, OCR_PAGE_1), digital, "a real text layer has no OCR errors in it");
  assert.equal(pageSourceName(digital, OCR_PAGE_1), "embedded-text");
});

// ── Steps 2-5: the whole vote, over real HTTP ─────────────────────────────

test("GLM-OCR text reaches both readers and their agreement becomes the result", async () => {
  seen.gpt.length = 0;
  seen.glm.length = 0;

  const pages = [
    { page: 1, source: "glm-ocr", text: OCR_PAGE_1 },
    { page: 2, source: "glm-ocr", text: "" },
    { page: 3, source: "glm-ocr", text: OCR_PAGE_2 },
  ];

  const result = await runConsensus({ pages, hints: { currency: "BDT" } });

  // ── the chain itself ────────────────────────────────────────────────────
  assert.ok(seen.gpt.length >= 1, "GPT was never called");
  assert.ok(seen.glm.length >= 1, "GLM was never called");
  assert.equal(seen.gpt.length, seen.glm.length, "both readers must see every chunk");

  const gptAll = seen.gpt.join("\n");
  const glmAll = seen.glm.join("\n");
  for (const [who, all] of [["GPT", gptAll], ["GLM", glmAll]]) {
    assert.ok(all.includes("SONALI BANK LIMITED"), `${who} never received the OCR header text`);
    assert.ok(all.includes("CHEQUE DEPOSIT"), `${who} never received page 1's transactions`);
    assert.ok(all.includes("SALARY CREDIT"), `${who} never received page 3's transactions`);
    assert.ok(all.includes("Total Credits: 65,000.00"), `${who} never received the printed totals`);
    assert.ok(all.includes("BDT"), `${who} never received the uploader's currency hint`);
  }

  // Identical prompts are what makes the three reads comparable at all.
  assert.deepEqual(seen.gpt, seen.glm, "the readers must be given byte-identical prompts");

  // Page numbers travel, so a row can be traced back to where it was printed.
  assert.ok(gptAll.includes("PAGE 1 of 3"), "pages are not labelled for the reader");
  assert.ok(gptAll.includes("PAGE 3 of 3"));

  // ── the result ──────────────────────────────────────────────────────────
  assert.equal(result.verdict, "extracted", `expected agreement, got ${result.verdict}: ${JSON.stringify(result.disputes)}`);
  assert.equal(result.quorum, 2);

  const m = result.consensus.metadata;
  assert.equal(m.companyName, "SONALI BANK LIMITED");
  assert.equal(m.accountNumber, "0123456789012");
  assert.equal(m.currency, "BDT");
  assert.equal(m.statementPeriod.from, "2025-01-01");
  assert.equal(m.statementPeriod.to, "2025-01-31");

  const s = result.consensus.summary;
  assert.equal(s.transactionCount, 3, "BALANCE B/F is a balance, not a transaction");
  assert.equal(s.openingBalance, 50000, "opening comes from the FIRST chunk");
  assert.equal(s.closingBalance, 110000, "closing comes from the LAST chunk");
  assert.equal(s.totalCredits, 65000);
  assert.equal(s.totalDebits, 5000);
  assert.equal(s.netChange, 60000);

  // Every row agreed by both readers, and named as such.
  assert.equal(result.transactionAgreement.ratio, 1);
  for (const t of result.consensus.transactions) {
    assert.deepEqual(t.agreedBy.sort(), ["glm", "gpt"], `${t.description} was not agreed by both`);
  }

  // ── the arithmetic ──────────────────────────────────────────────────────
  // Three models agreeing proves they read the same thing, not that they read
  // everything. This is the check that catches a page they all missed.
  assert.equal(result.reconciliation.openingNetClosing.ok, true, "50,000 + 60,000 must equal 110,000");
  assert.equal(result.reconciliation.statedTotals.ok, true, "extracted totals must match the printed ones");
  assert.equal(result.reconciliation.provablyComplete, true);

  assert.equal(result.disputes.length, 0, `unexpected disputes: ${JSON.stringify(result.disputes)}`);
});

test("both readers are reported as having voted, with their usage", async () => {
  const pages = [{ page: 1, source: "glm-ocr", text: OCR_PAGE_1 }];
  const result = await runConsensus({ pages });

  const voted = result.analysts.filter((a) => a.voted).map((a) => a.id).sort();
  assert.deepEqual(voted, ["glm", "gpt"]);
  // A DISABLED reader is absent from the report entirely, not listed as having
  // abstained — `analysts` reports the readers that were actually in the vote.
  assert.equal(result.analysts.find((a) => a.id === "claude"), undefined, "Claude was disabled for this test");
  assert.ok(result.usage.inputTokens > 0, "token usage is not being accumulated");
  assert.equal(result.usage.pages, 1);
});

test("an unprinted total stays absent instead of becoming zero", async () => {
  // The regression this file was written to catch. Both readers report
  // statedTotals.transactionCount as null — the statement prints no count.
  // `Number(null)` is 0, so an earlier version recorded a printed count of
  // ZERO, compared it against the 3 rows extracted, and flagged a clean
  // statement for human review.
  const pages = [
    { page: 1, source: "glm-ocr", text: OCR_PAGE_1 },
    { page: 2, source: "glm-ocr", text: "" },
    { page: 3, source: "glm-ocr", text: OCR_PAGE_2 },
  ];
  const result = await runConsensus({ pages });

  assert.equal(result.consensus.statedTotals.transactionCount, null, "an unprinted count must be null, never 0");
  const countCheck = result.reconciliation.statedTotals.checks.find((c) => c.what === "transaction count");
  assert.equal(countCheck, undefined, "a total the statement never printed must not be reconciled against");
  assert.equal(result.reconciliation.statedTotals.ok, true);
  assert.equal(result.verdict, "extracted");
});

test("a row with no printed balance does not fake a break in the chain", async () => {
  // The regression: the walk used to run over rows that PRINT a balance, so a
  // row whose balance the OCR could not read made the rows either side of it
  // look adjacent — and they disagree by exactly the skipped row's amount.
  // The chain is real here: 1,000 +100 = 1,100, +50 = 1,150, +25 = 1,175.
  const page = [
    "ACME BANK  Account No: 999  Period: 01-Jan-2025 to 31-Jan-2025",
    "01/01/2025  OPENING BALANCE                1,000.00",
    "02/01/2025  DEPOSIT A          100.00      1,100.00",
    "03/01/2025  DEPOSIT B           50.00",           // balance column unreadable
    "04/01/2025  DEPOSIT C           25.00      1,175.00",
  ].join("\n");

  const rows = [
    { page: 1, dateRaw: "02/01/2025", dateIso: "2025-01-02", description: "DEPOSIT A", reference: null, credit: 100, debit: null, balance: 1100 },
    { page: 1, dateRaw: "03/01/2025", dateIso: "2025-01-03", description: "DEPOSIT B", reference: null, credit: 50, debit: null, balance: null },
    { page: 1, dateRaw: "04/01/2025", dateIso: "2025-01-04", description: "DEPOSIT C", reference: null, credit: 25, debit: null, balance: 1175 },
  ];
  const answer = {
    documentType: "bank_statement",
    metadata: { companyName: "ACME BANK", accountName: null, accountNumber: "999", accountType: null, branch: null, currency: null, statementPeriodFrom: "2025-01-01", statementPeriodTo: "2025-01-31", statementDate: null },
    balances: { opening: 1000, closing: 1175 },
    statedTotals: { totalCredits: null, totalDebits: null, transactionCount: null },
    transactions: rows,
  };

  const prev = override;
  override = answer;
  try {
    const result = await runConsensus({ pages: [{ page: 1, source: "glm-ocr", text: page }] });
    const chain = result.reconciliation.balanceChain;
    assert.equal(chain.breakCount, 0, `spurious breaks: ${JSON.stringify(chain.breaks)}`);
    assert.equal(chain.ok, true);
    assert.equal(result.consensus.summary.transactionCount, 3, "all three movements are kept");
  } finally {
    override = prev;
  }
});

test("a balance that genuinely does not add up IS reported", async () => {
  // The other direction: the check must still catch a real break, and must not
  // cascade — one bad row, one break, not a break on every row after it.
  const rows = [
    { page: 1, dateRaw: "02/01/2025", dateIso: "2025-01-02", description: "DEPOSIT A", reference: null, credit: 100, debit: null, balance: 1100 },
    { page: 1, dateRaw: "03/01/2025", dateIso: "2025-01-03", description: "DEPOSIT B", reference: null, credit: 50, debit: null, balance: 9999 },
    { page: 1, dateRaw: "04/01/2025", dateIso: "2025-01-04", description: "DEPOSIT C", reference: null, credit: 25, debit: null, balance: 10024 },
  ];
  const prev = override;
  override = {
    documentType: "bank_statement",
    metadata: { companyName: "ACME BANK", accountName: null, accountNumber: "999", accountType: null, branch: null, currency: null, statementPeriodFrom: "2025-01-01", statementPeriodTo: "2025-01-31", statementDate: null },
    balances: { opening: 1000, closing: 10024 },
    statedTotals: { totalCredits: null, totalDebits: null, transactionCount: null },
    transactions: rows,
  };
  try {
    const result = await runConsensus({ pages: [{ page: 1, source: "glm-ocr", text: "x" }] });
    const chain = result.reconciliation.balanceChain;
    assert.equal(chain.breakCount, 1, `expected exactly one break, got ${JSON.stringify(chain.breaks)}`);
    assert.equal(chain.breaks[0].printed, 9999);
    assert.equal(chain.breaks[0].expected, 1150);
  } finally {
    override = prev;
  }
});

test("when one reader dies the other cannot reach quorum alone", async () => {
  // Quorum is 2 and only two readers are enabled, so losing one must FAIL
  // loudly rather than quietly promoting a single model's word to the truth.
  const original = process.env.DIME_OCR_OPENAI_BASE_URL;
  const { analystStatus } = await import("../src/agent/consensus/index.js");
  const before = await analystStatus();
  assert.equal(before.gpt.ok, true, "precondition: the fake GPT is reachable");

  await assert.rejects(
    () =>
      runConsensus({
        pages: [{ page: 1, source: "glm-ocr", text: OCR_PAGE_1 }],
        // A signal already aborted kills both readers, standing in for an
        // outage — the point is that a shortfall throws instead of resolving.
        signal: AbortSignal.abort(),
      }),
    /cancelled|usable read|agree/i,
    "a shortfall of readers must throw, never resolve on one opinion"
  );
  process.env.DIME_OCR_OPENAI_BASE_URL = original;
});
