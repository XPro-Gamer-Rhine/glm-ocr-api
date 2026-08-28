/**
 * The contract all three models answer in.
 *
 * ONE schema, handed to all three verbatim. That is what makes their answers
 * comparable at all: if Claude returns `{amount, type}` and GPT returns
 * `{credit, debit}`, every row disagrees for a reason that has nothing to do
 * with what is printed on the statement, and the consensus measures the prompt
 * instead of the document.
 *
 * CREDIT AND DEBIT AS SEPARATE FIELDS, not a signed amount with a type. A
 * statement prints two columns and the model's job is to copy them, not to
 * decide a sign. Sign inference belongs downstream, where the running balance
 * can prove it — and where being wrong is detectable.
 *
 * DATES AS THE STATEMENT PRINTS THEM, plus an ISO normalization. `03/04/2025`
 * is the 3rd of April in Dhaka and the 4th of March in New York, and the model
 * that guesses is guessing about the bank's locale from a scanned page. Both
 * fields travel, so a disagreement about the ORDER shows up as a disagreement
 * rather than silently picking a month.
 */

export const DOCUMENT_TYPES = Object.freeze([
  "bank_statement",
  "credit_card_statement",
  "mobile_wallet_statement",
  "loan_statement",
  "investment_statement",
  "other",
]);

/**
 * The JSON Schema, used three ways: embedded in the prompt for every model,
 * handed to OpenAI as a structured-output format, and handed to Ollama as its
 * `format`. One definition, so all three are constrained identically.
 */
export const CHUNK_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["documentType", "metadata", "balances", "statedTotals", "transactions"],
  properties: {
    documentType: { type: ["string", "null"], enum: [...DOCUMENT_TYPES, null] },
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: {
        companyName: { type: ["string", "null"], description: "Bank, card issuer or wallet operator, exactly as printed" },
        accountName: { type: ["string", "null"], description: "Account holder / customer name, exactly as printed" },
        accountNumber: { type: ["string", "null"], description: "Account, card or wallet number, exactly as printed, masking included" },
        accountType: { type: ["string", "null"], description: "e.g. Current, Savings, Credit Card — only if printed" },
        branch: { type: ["string", "null"] },
        currency: { type: ["string", "null"], description: "ISO 4217 code if determinable, e.g. USD, BDT, GBP" },
        statementPeriodFrom: { type: ["string", "null"], description: "Period start, YYYY-MM-DD" },
        statementPeriodTo: { type: ["string", "null"], description: "Period end, YYYY-MM-DD" },
        statementDate: { type: ["string", "null"], description: "Issue date, YYYY-MM-DD" },
      },
      required: [
        "companyName",
        "accountName",
        "accountNumber",
        "accountType",
        "branch",
        "currency",
        "statementPeriodFrom",
        "statementPeriodTo",
        "statementDate",
      ],
    },
    balances: {
      type: "object",
      additionalProperties: false,
      properties: {
        opening: { type: ["number", "null"], description: "Opening / brought-forward balance, only if printed" },
        closing: { type: ["number", "null"], description: "Closing / carried-forward balance, only if printed" },
      },
      required: ["opening", "closing"],
    },
    statedTotals: {
      type: "object",
      additionalProperties: false,
      description: "Totals the STATEMENT ITSELF prints. Never computed by you.",
      properties: {
        totalCredits: { type: ["number", "null"] },
        totalDebits: { type: ["number", "null"] },
        transactionCount: { type: ["integer", "null"] },
      },
      required: ["totalCredits", "totalDebits", "transactionCount"],
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "dateRaw", "dateIso", "description", "reference", "credit", "debit", "balance"],
        properties: {
          page: { type: "integer", description: "The page number this row was printed on" },
          dateRaw: { type: ["string", "null"], description: "The date exactly as printed, e.g. 03/04/2025 or 3 Apr 25" },
          dateIso: { type: ["string", "null"], description: "The same date as YYYY-MM-DD" },
          description: { type: ["string", "null"], description: "The narrative column, verbatim, whole" },
          reference: { type: ["string", "null"], description: "Cheque / transaction / reference number if a separate column" },
          credit: { type: ["number", "null"], description: "Money IN. Null when the row has no credit." },
          debit: { type: ["number", "null"], description: "Money OUT. Null when the row has no debit." },
          balance: { type: ["number", "null"], description: "Running balance printed on the row" },
        },
      },
    },
  },
});

/**
 * What every analyst is told about its job, before it sees any text.
 *
 * The rules here are not style preferences. Each one corresponds to a way a
 * language model quietly ruins a statement extraction: filling a gap with a
 * plausible number, tidying a description, converting a currency, computing a
 * total the page did not print, or silently skipping a row it could not read.
 * A model that invents one number is worse than useless here, because the
 * consensus is what is supposed to catch invention — and three models inventing
 * politely can agree.
 */
export const SYSTEM_PROMPT = `You are one of three independent extraction models reading the same scanned financial document. Your reads are compared field by field against the other two; a value only becomes the answer when at least two of you produce it independently.

That comparison is the entire point, so:

TRANSCRIBE, DO NOT INTERPRET.
- Every number you emit must be printed on the page you were given. Copy the digits exactly.
- NEVER compute a value the document does not print. Not a total, not a balance, not a count, not a difference. If it is not printed, the field is null.
- NEVER round, reformat, convert a currency, or "correct" an amount that looks wrong. A statement that does not add up is a fact about the statement.
- NEVER tidy a description. Copy the narrative column as printed, in full, including reference codes inside it.
- If a row is partly illegible, still emit the row with null for the fields you cannot read. A dropped row is far worse than an incomplete one: it silently changes the totals.
- Do not merge two rows, and do not split one row into two.
- A BALANCE LINE IS NOT A TRANSACTION. "Balance b/f", "brought forward", "carried forward", "opening balance", "closing balance", "sub-total", "total" — none of these belong in 'transactions'. They are balances and totals, and they have their own fields. Emitting one as a transaction double-counts it against the rows it summarises.

DATES.
- 'dateRaw' is exactly what is printed. 'dateIso' is the same date as YYYY-MM-DD.
- Decide day-first vs month-first from evidence on the page — the statement period, a day number above 12, the issuer's country. If the page gives you no evidence, leave 'dateIso' null rather than guessing. A wrong month is invisible downstream; a null is not.
- A row printed without a year takes the year from the statement period.

CREDIT AND DEBIT.
- Two separate fields. A row has one of them, never both.
- If the document has a single amount column with a Dr/Cr marker or a sign, put the amount in the field the marker indicates.
- If a single amount column has no marker at all, use the running balance to decide: an amount that made the balance rise is a credit, one that made it fall is a debit. If there is no balance column either, put the amount in 'debit' and leave 'credit' null — do not guess.

OUTPUT.
- Return ONE JSON object matching the given schema and NOTHING else. No prose, no explanation, no markdown fence, no commentary before or after.
- Every property in the schema must be present. Use null, never omit.`;

const clip = (s, n) => {
  const str = String(s == null ? "" : s);
  return str.length > n ? `${str.slice(0, n)}\n…[clipped]` : str;
};

/**
 * The briefing for one chunk of pages.
 *
 * The chunk carries its own page numbers and its place in the document, because
 * a model that does not know it is reading pages 9–12 of 40 will "helpfully"
 * report an opening balance from a mid-document carry-forward line, or decide
 * the statement has 14 transactions.
 */
export function buildChunkPrompt({
  pages,
  chunkIndex,
  chunkCount,
  pageCount,
  hints = {},
  maxCharsPerPage = 60000,
}) {
  const isFirst = chunkIndex === 0;
  const isLast = chunkIndex === chunkCount - 1;
  const first = pages[0]?.page;
  const last = pages[pages.length - 1]?.page;

  const body = pages
    .map(
      (p) =>
        `───────── PAGE ${p.page} of ${pageCount} (read by: ${p.source}) ─────────\n${clip(p.text, maxCharsPerPage)}`
    )
    .join("\n\n");

  const hintLines = [
    hints.currency ? `  The uploader says the currency is ${hints.currency}.` : null,
    hints.period ? `  The uploader says this covers ${hints.period}.` : null,
    hints.note ? `  The uploader added: ${clip(hints.note, 300)}` : null,
  ].filter(Boolean);

  return `${SYSTEM_PROMPT}

THE SCHEMA — your entire reply is one object of this shape:
${JSON.stringify(CHUNK_SCHEMA, null, 2)}

WHAT YOU ARE READING
  Pages ${first}${last !== first ? `–${last}` : ""} of a ${pageCount}-page document.
  This is chunk ${chunkIndex + 1} of ${chunkCount}.
${hintLines.length ? `${hintLines.join("\n")}\n` : ""}
SCOPE — this matters, read it twice:
  * 'transactions' must contain EVERY transaction row printed on these pages, and NOTHING from any other page. Rows are in printed order.
${
  isFirst
    ? `  * These are the OPENING pages: fill 'metadata' from the header, and 'balances.opening' from the opening / brought-forward line if one is printed.`
    : `  * These are NOT the opening pages. Fill 'metadata' only from what is actually printed here (many statements repeat the account number in a page header) and leave the rest null. A "balance brought forward" line at the top of a continuation page is NOT the statement's opening balance — leave 'balances.opening' null.`
}
${
  isLast
    ? `  * These are the CLOSING pages: fill 'balances.closing' and 'statedTotals' from the summary block if one is printed. If the document prints no totals, they stay null — do not add them up yourself.`
    : `  * These are NOT the closing pages. Leave 'balances.closing' and 'statedTotals' null unless a total block is genuinely printed on these pages.`
}

THE TEXT
${body}

Return only the JSON object.`;
}

export default { CHUNK_SCHEMA, SYSTEM_PROMPT, buildChunkPrompt, DOCUMENT_TYPES };
