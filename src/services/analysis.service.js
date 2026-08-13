/**
 * Turns raw page text (GLM-OCR markdown or embedded PDF text) into
 * structured data: document type, metadata, transactions and summary.
 * Pure functions only — no I/O — so the whole module is unit-testable.
 *
 * Handles both layouts GLM-OCR produces:
 *   - markdown/HTML tables (columned statements)
 *   - flattened text lines ("Feb 02 POS PURCHASE 27.69 5,018.47")
 * Transaction signs are resolved with a running-balance delta chain,
 * falling back to description keywords.
 */

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// No alphabetic currency-code prefix here: "[A-Z]{2,3}" would swallow word
// tails ("CREDIT 50.00" -> "DIT 50.00") and truncate descriptions.
const AMOUNT_TOKEN = /\(?-?[$€£₹৳¥]?\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?(?:\s?(?:Cr|Dr|CR|DR))?|\(?-?[$€£₹৳¥]?\s?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\)?/;

export function parseAmount(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  let s = String(rawInput).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/^[-−]|[-−]\s*$/.test(s.replace(/[$€£₹৳¥\s]/g, ""))) negative = true;
  if (/^-|^\s*[$€£₹৳¥]?\s*-/.test(s)) negative = true;
  if (/\b(?:dr|debit)\.?\s*$/i.test(s)) negative = true;

  s = s.replace(/[^0-9.,]/g, "");
  if (!/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) {
    const decimals = s.length - lastComma - 1;
    if (decimals >= 1 && decimals <= 2) {
      s = s.replace(/\./g, "").replace(",", "."); // European "1.234,56"
    } else {
      s = s.replace(/,/g, "");
    }
  } else {
    s = s.replace(/,/g, "");
  }

  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

/**
 * Line-mode guard: bare integers ("1", "2026", refs) are not money.
 * Money needs decimals, thousand groups, or an explicit currency symbol.
 */
function isMoneyLike(raw) {
  return /\d\.\d{2}\b/.test(raw) || /\d,\d{3}/.test(raw) || /[$€£₹৳¥]\s?\d/.test(raw);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthFromName(name) {
  return MONTHS[name?.slice(0, 3).toLowerCase()] ?? null;
}

/**
 * Parse into {year?, month, day}; year is null for "Feb 02"-style tokens.
 * `order` disambiguates all-numeric dates: "DMY" (default) or "MDY" (US).
 */
export function parseDateParts(raw, order = "DMY") {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s+/g, " ");
  let m;

  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)))
    return validParts(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "MDY"
      ? validParts(Number(m[3]), a, b, true)
      : validParts(Number(m[3]), b, a, true);
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "MDY"
      ? validParts(2000 + Number(m[3]), a, b, true)
      : validParts(2000 + Number(m[3]), b, a, true);
  }
  if ((m = s.match(/^(\d{1,2})[\s\-.]?([A-Za-z]{3,9})[\s\-.,]?\s?(\d{4}|\d{2})$/)))
    return validParts(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), monthFromName(m[2]), Number(m[1]));
  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]?(\d{1,2})(?:st|nd|rd|th)?[\s,.]+(\d{4}|\d{2})$/)))
    return validParts(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), monthFromName(m[1]), Number(m[2]));
  // Year-less: "Feb 02" / "02 Feb" — year filled from document context.
  if ((m = s.match(/^([A-Za-z]{3,9})[\s.]+(\d{1,2})$/)))
    return validParts(null, monthFromName(m[1]), Number(m[2]));
  if ((m = s.match(/^(\d{1,2})[\s.]+([A-Za-z]{3,9})$/)))
    return validParts(null, monthFromName(m[2]), Number(m[1]));
  // Year-less numeric: "02/02", "28/02" (Chase-style compact dates).
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "MDY" ? validParts(null, a, b, true) : validParts(null, b, a, true);
  }

  return null;
}

function validParts(year, month, day, maySwap = false) {
  if (month === null || Number.isNaN(month)) return null;
  if (maySwap && month > 12 && day <= 12) [month, day] = [day, month];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year !== null && (year < 1900 || year > 2200)) return null;
  return { year, month, day };
}

export function normalizeDate(raw, yearHint = null, order = "DMY") {
  const parts = parseDateParts(raw, order);
  if (!parts) return null;
  const year = parts.year ?? yearHint;
  if (!year) return null;
  return `${year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * Vote on numeric-date order across the document: a component > 12 in the
 * first slot proves day-first, in the second slot proves month-first (US).
 */
export function inferDateOrder(text) {
  let dmy = 0;
  let mdy = 0;
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy += 1;
    else if (b > 12 && a <= 12) mdy += 1;
  }
  return mdy > dmy ? "MDY" : "DMY";
}

const DATE_TOKEN =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[\s\-.]?[A-Za-z]{3,9}[\s\-.,]?\s?\d{2,4}|[A-Za-z]{3,9}[\s\-.]?\d{1,2}(?:st|nd|rd|th)?[\s,.]+\d{2,4}|[A-Za-z]{3,9}[\s.]+\d{1,2}\b|\d{1,2}[\s.]+[A-Za-z]{3,9}\b|\d{1,2}\/\d{1,2}\b/;

export function isDateLike(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 24) return false;
  const token = s.match(DATE_TOKEN)?.[0];
  return token ? parseDateParts(token) !== null : false;
}

/** Most frequent 4-digit year among full dates — fills year-less rows. */
function inferYearHint(text) {
  const counts = new Map();
  for (const match of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const year = Number(match[0]);
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [year, count] of counts) {
    if (count > bestCount) {
      best = year;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tables (markdown pipes + HTML)
// ---------------------------------------------------------------------------

function splitMarkdownRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.replace(/<br\s*\/?\s*>/gi, " ").trim());
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTables(text) {
  const tables = [];

  const lines = text.split(/\r?\n/);
  let current = null;
  const flush = () => {
    if (current && current.length >= 2) tables.push(current);
    current = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed) && trimmed.length > 2) {
      const cells = splitMarkdownRow(trimmed);
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")) || c === "");
      if (isSeparator && cells.some((c) => c.includes("-"))) continue;
      if (!current) current = [];
      current.push(cells);
    } else {
      flush();
    }
  }
  flush();

  for (const tableHtml of text.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = [];
    for (const rowHtml of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        stripHtml(m[1])
      );
      if (cells.length) rows.push(cells);
    }
    if (rows.length >= 2) tables.push(rows);
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Transactions — shared helpers
// ---------------------------------------------------------------------------

// "service charges for period" is a summary label; a bare "Service Charge"
// row ("Account Analysis Service Charge -$55.00") is a real transaction.
const NON_TXN_ROW_BASE =
  /^(?:sub\s*)?total\b|(?:beginning|opening|closing|ending|average|available)\s+balance|balance\s+(?:b\/?f|c\/?f|brought|carried|as\s+of)|grand\s+total|service\s+charges?\s+for\s+(?:the\s+)?period|^page\s+\d|statement\s+(?:date|thru|period)/i;

// "TOTAL NUMBER OF CHECKS PAID TODAY 1  687.20  502.52" is a REAL debit
// (the day's check clearing) despite starting with "TOTAL" — never skip it.
const CHECKS_PAID_ROW = /number\s+of\s+checks\s+paid/i;

function isNonTransactionRow(text) {
  return NON_TXN_ROW_BASE.test(text) && !CHECKS_PAID_ROW.test(text);
}

const CREDIT_WORDS =
  /credit|deposit|reward|refund|rebate|interest\s+(?:paid|earned)|cash\s?back|salary|payroll|received|reversal/i;
const DEBIT_WORDS =
  /debit|withdraw|purchase|payment|fee|charge|pos\b|atm\b|bill|transfer\s+to|sent|paid\s+out/i;

function tentativeType(description) {
  const desc = description || "";
  // "TRANSFER CREDIT" contains both words — check credit last so it wins ties.
  const credit = CREDIT_WORDS.test(desc);
  const debit = DEBIT_WORDS.test(desc);
  if (credit && !debit) return "credit";
  if (debit && !credit) return "debit";
  if (credit && debit) return CREDIT_WORDS.test(desc.split(/\s+/).at(-1)) ? "credit" : null;
  return null;
}

const approx = (a, b) => Math.abs(a - b) < 0.015;

/**
 * Resolve ambiguous signs with the running balance:
 * prev + x == balance -> credit; prev - x == balance -> debit.
 * The chain survives OCR glitches by re-anchoring on every printed balance.
 */
function resolveSignsByBalance(transactions) {
  let prev = null;
  for (const txn of transactions) {
    if (txn.amount === null) continue; // unfilled descOnly candidates
    const mag = Math.abs(txn.amount);
    if (prev !== null && txn.balance !== null) {
      if (approx(prev + mag, txn.balance)) {
        txn.amount = mag;
        txn.type = "credit";
      } else if (approx(prev - mag, txn.balance)) {
        txn.amount = -mag;
        txn.type = "debit";
      }
    }
    if (txn.type === null) {
      txn.type = "debit"; // most unlabeled statement rows are outflows
      txn.amount = -mag;
    } else {
      txn.amount = txn.type === "credit" ? mag : -mag;
    }
    if (txn.balance !== null) prev = txn.balance;
    else prev = null; // unknown intermediate balance breaks the chain
  }
  return transactions;
}

/**
 * Repair rows the OCR damaged, using neighbours as constraints:
 *  - balance missing, amount trusted  -> fill balance if the chain then meets
 *    the next printed balance.
 *  - OCR merged "amount balance" into one number (row shows only the balance)
 *    -> reinterpret the number as the balance and derive the amount from the
 *    previous balance ("481.14  42.73" read as "42.73").
 */
function repairBalanceChain(transactions) {
  const prevBalanceBefore = (i) => {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (transactions[j].balance !== null) return transactions[j].balance;
    }
    return null;
  };
  const nextReal = (i) => {
    for (let j = i + 1; j < transactions.length; j += 1) {
      const t = transactions[j];
      if (t.amount !== null && t.balance !== null) {
        // Only usable as a constraint when nothing unresolved sits between.
        for (let k = i + 1; k < j; k += 1) {
          if (transactions[k].amount === null || transactions[k].balance === null) return null;
        }
        return t;
      }
      if (t.amount === null || t.balance === null) return null;
    }
    return null;
  };
  const round2 = (n) => Math.round(n * 100) / 100;

  for (let i = 0; i < transactions.length; i += 1) {
    const txn = transactions[i];
    const prev = prevBalanceBefore(i);
    const next = nextReal(i);
    if (prev === null || next === null) continue;

    // A) Amount-dropped row ("Feb 05 INTERNATIONAL ..." with no numbers):
    //    the balance gap around it IS the missing amount.
    if (txn.descOnly && txn.amount === null) {
      const gap = next.balance - next.amount - prev;
      if (Math.abs(gap) > 0.009) {
        txn.amount = round2(gap);
        txn.balance = round2(prev + gap);
        txn.type = gap >= 0 ? "credit" : "debit";
        txn.inferred = true;
        delete txn.descOnly;
      }
      continue;
    }
    if (txn.amount === null) continue;

    const mag = Math.abs(txn.amount);

    // B) Balance missing on a normal row.
    if (txn.balance === null) {
      const filled = prev + txn.amount;
      if (approx(filled + next.amount, next.balance)) {
        txn.balance = round2(filled);
        txn.repaired = "balance-filled";
      } else if (approx(mag + next.amount, next.balance)) {
        // The single number was actually the balance ("481.14 42.73" -> "42.73").
        const derived = mag - prev;
        if (Math.abs(derived) > 0.009) {
          txn.balance = round2(mag);
          txn.amount = round2(derived);
          txn.type = derived >= 0 ? "credit" : "debit";
          txn.repaired = "amount-balance-merge";
        }
      }
      continue;
    }

    // C) Row with 3+ money tokens whose default (amount, balance) pick breaks
    //    the chain — OCR glued a neighbouring row's numbers on. Re-pick the
    //    token whose implied balance makes the next row chain.
    if (txn.altAmounts && !approx(prev + txn.amount, txn.balance)) {
      for (const token of txn.altAmounts) {
        for (const signed of [Math.abs(token), -Math.abs(token)]) {
          const implied = prev + signed;
          if (approx(implied + next.amount, next.balance)) {
            txn.amount = round2(signed);
            txn.balance = round2(implied);
            txn.type = signed >= 0 ? "credit" : "debit";
            txn.repaired = "multi-amount-disambiguated";
            break;
          }
        }
        if (txn.repaired === "multi-amount-disambiguated") break;
      }
    }
  }

  // Unfilled candidates carry no information — drop them.
  for (let i = transactions.length - 1; i >= 0; i -= 1) {
    if (transactions[i].amount === null) transactions.splice(i, 1);
    else delete transactions[i].altAmounts;
  }
  return transactions;
}

/** Count remaining spots where prev + amount != printed balance. */
function countChainBreaks(transactions) {
  let breaks = 0;
  let prev = null;
  for (const txn of transactions) {
    if (prev !== null && txn.balance !== null && !approx(prev + txn.amount, txn.balance)) {
      breaks += 1;
      txn.chainBreak = true;
    }
    if (txn.balance !== null) prev = txn.balance;
  }
  return breaks;
}

// ---------------------------------------------------------------------------
// Transactions — table mode
// ---------------------------------------------------------------------------

const COLUMN_MATCHERS = [
  ["date", /^(?:txn\s*|value\s*|posting\s*|trans(?:action)?\s*)?date$|^date\b/i],
  ["description", /descri|particular|narration|details|memo|remark|transaction\s*(?:details)?$/i],
  ["reference", /\bref|cheque|chq|check\s*no|txn\s*id|transaction\s*id|utr|voucher|trx/i],
  ["debit", /debit|withdraw|paid\s*out|money\s*out|^dr\.?$/i],
  ["credit", /credit|deposit|paid\s*in|money\s*in|^cr\.?$/i],
  ["balance", /balance/i],
  ["type", /^type$|dr\s*\/\s*cr/i],
  ["amount", /amount|value$/i],
];

function mapHeaderColumns(headerRow) {
  const mapping = {};
  headerRow.forEach((cell, index) => {
    const header = cell.toLowerCase().trim();
    if (!header) return;
    for (const [field, re] of COLUMN_MATCHERS) {
      if (re.test(header) && mapping[field] === undefined) {
        mapping[field] = index;
        break;
      }
    }
  });
  return mapping;
}

function isTransactionHeader(mapping) {
  const hasMoney =
    mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined;
  return mapping.date !== undefined && (hasMoney || mapping.balance !== undefined);
}

function rowToTransaction(row, mapping, page, yearHint, dateOrder) {
  const cell = (field) => (mapping[field] !== undefined ? row[mapping[field]] ?? "" : "");

  const dateRaw = cell("date").trim();
  const description = cell("description").trim();
  if (isNonTransactionRow(description) || isNonTransactionRow(dateRaw)) return null;
  if (!isDateLike(dateRaw)) return null;

  const debit = parseAmount(cell("debit"));
  const credit = parseAmount(cell("credit"));
  let amount = null;
  let type = null;

  if (credit !== null && credit !== 0 && (debit === null || debit === 0)) {
    amount = Math.abs(credit);
    type = "credit";
  } else if (debit !== null && debit !== 0) {
    amount = -Math.abs(debit);
    type = "debit";
  } else {
    const generic = parseAmount(cell("amount"));
    if (generic !== null) {
      const typeCell = cell("type").toLowerCase();
      if (/cr|credit|deposit|in\b/.test(typeCell)) type = "credit";
      else if (/dr|debit|withdraw|out\b/.test(typeCell)) type = "debit";
      else type = tentativeType(description) ?? (generic < 0 ? "debit" : null);
      amount = generic;
    }
  }
  if (amount === null) return null;

  return {
    date: dateRaw,
    dateIso: normalizeDate(dateRaw.match(DATE_TOKEN)?.[0] ?? dateRaw, yearHint, dateOrder),
    description: description || null,
    reference: cell("reference").trim() || null,
    amount,
    type,
    balance: parseAmount(cell("balance")),
    page,
  };
}

function transactionsFromTables(tables, page, yearHint, dateOrder) {
  const transactions = [];
  for (const table of tables) {
    const mapping = mapHeaderColumns(table[0]);
    if (!isTransactionHeader(mapping)) continue;
    for (const row of table.slice(1)) {
      const parsed = rowToTransaction(row, mapping, page, yearHint, dateOrder);
      if (parsed) transactions.push(parsed);
    }
  }
  return transactions;
}

// ---------------------------------------------------------------------------
// Transactions — flattened line mode
// ---------------------------------------------------------------------------

function moneyMatchesIn(text) {
  return [...text.matchAll(new RegExp(AMOUNT_TOKEN.source, "g"))]
    .map((m) => ({ raw: m[0], value: parseAmount(m[0]), index: m.index }))
    .filter((a) => a.value !== null && isMoneyLike(a.raw));
}

/**
 * Parses statements GLM-OCR flattens into lines:
 *   "Feb 02 POS PURCHASE NON-PIN 27.69 5,018.47"        date desc amount balance
 *   "REF 292CBX0 FROM *1229 1,000.00 2,254.46"          continuation with own amounts
 * Signs are resolved later by the balance chain.
 */
function transactionsFromLines(text, page, yearHint, dateOrder) {
  const transactions = [];
  let lastDate = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/\s{2,}/g, " ");
    if (trimmed.length < 8) continue;

    const dateMatch = trimmed.match(DATE_TOKEN);
    const startsWithDate = dateMatch && trimmed.indexOf(dateMatch[0]) <= 2 && parseDateParts(dateMatch[0]);

    if (startsWithDate) {
      const rest = trimmed.slice(trimmed.indexOf(dateMatch[0]) + dateMatch[0].length).trim();
      if (isNonTransactionRow(rest)) {
        lastDate = dateMatch[0];
        continue;
      }
      const amounts = moneyMatchesIn(rest);
      lastDate = dateMatch[0];

      if (amounts.length === 0) {
        // Date + description but no money: OCR dropped the amount column.
        // Keep as a candidate — the repair pass fills it from the balance gap.
        if (rest.length >= 6) {
          transactions.push({
            date: dateMatch[0],
            dateIso: normalizeDate(dateMatch[0], yearHint, dateOrder),
            description: rest.replace(/\s+/g, " ").trim(),
            reference: null,
            amount: null,
            type: null,
            balance: null,
            page,
            descOnly: true,
          });
        }
        continue;
      }

      const balance = amounts.length >= 2 ? amounts.at(-1).value : null;
      const amountEntry = amounts.length >= 2 ? amounts.at(-2) : amounts[0];
      const description = rest.slice(0, amountEntry.index).replace(/\s+/g, " ").trim();

      transactions.push({
        date: dateMatch[0],
        dateIso: normalizeDate(dateMatch[0], yearHint, dateOrder),
        description: description || null,
        reference: null,
        amount: Math.abs(amountEntry.value),
        type: tentativeType(description),
        balance,
        page,
        // Kept only when >2 money tokens: lets the repair pass re-pick which
        // token is the amount if the default (last two) breaks the chain.
        ...(amounts.length > 2 ? { altAmounts: amounts.map((a) => a.value) } : {}),
      });
    } else if (lastDate && !isNonTransactionRow(trimmed)) {
      // Continuation row: only trust it when it carries amount + balance.
      const amounts = moneyMatchesIn(trimmed);
      if (amounts.length < 2) continue;
      const balance = amounts.at(-1).value;
      const amountEntry = amounts.at(-2);
      const description = trimmed.slice(0, amountEntry.index).replace(/\s+/g, " ").trim();
      if (!description || /^[\d\s$.,-]*$/.test(description)) continue;

      transactions.push({
        date: lastDate,
        dateIso: normalizeDate(lastDate, yearHint, dateOrder),
        description,
        reference: null,
        amount: Math.abs(amountEntry.value),
        type: tentativeType(description),
        balance,
        page,
        continuation: true,
      });
    }
  }
  return transactions;
}

// ---------------------------------------------------------------------------
// Transactions — vertical mode (one table cell per line)
// ---------------------------------------------------------------------------

const PURE_MONEY_LINE = /^[-(]?\s?[$€£₹৳¥]?\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?$/;

/**
 * Parses text layers where the PDF emits each table cell as its own line:
 *   02/02
 *   Stripe Payout
 *   $13,100.00
 *   $146,447.74
 * Common in digitally-generated statements (Chase et al).
 */
function transactionsFromVerticalLines(text, page, yearHint, dateOrder) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const pureDateRe = new RegExp(`^(?:${DATE_TOKEN.source})$`);
  const isPureDate = (l) =>
    l.length > 0 && l.length <= 14 && pureDateRe.test(l) && parseDateParts(l, dateOrder) !== null;
  const isPureMoney = (l) => PURE_MONEY_LINE.test(l) && isMoneyLike(l);

  const transactions = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isPureDate(lines[i])) continue;

    const desc = [];
    const money = [];
    let j = i + 1;
    while (j < lines.length && money.length < 2) {
      const line = lines[j];
      if (!line) {
        j += 1;
        continue;
      }
      if (isPureDate(line)) break;
      if (isPureMoney(line)) money.push(parseAmount(line));
      else if (money.length === 0 && desc.length < 4) desc.push(line);
      else break;
      j += 1;
    }

    const description = desc.join(" ").replace(/\s+/g, " ").trim();
    if (money.length >= 1 && description && !isNonTransactionRow(description)) {
      const amount = money[0];
      transactions.push({
        date: lines[i],
        dateIso: normalizeDate(lines[i], yearHint, dateOrder),
        description,
        reference: null,
        amount,
        type: amount < 0 ? "debit" : "credit",
        balance: money[1] ?? null,
        page,
      });
    }
    i = j - 1;
  }
  return transactions;
}

// ---------------------------------------------------------------------------
// Document type
// ---------------------------------------------------------------------------

const DOC_TYPE_SIGNALS = {
  bank_statement: [
    /account\s+statement|statement\s+of\s+account|bank\s+statement|statement\s+activity/i,
    /(?:opening|beginning)\s+balance/i,
    /(?:closing|ending)\s+balance/i,
    /withdraw|deposit/i,
    /branch|ifsc|iban|sort\s+code|routing/i,
    /available\s+balance|running\s+balance|average\s+balance/i,
    /transaction\s+detail/i,
    /statement\s+(?:date|period|thru)/i,
  ],
  mobile_wallet_statement: [
    /bkash|nagad|rocket|upay|wallet/i,
    /cash\s+in|cash\s+out/i,
    /send\s+money|receive\s+money|mobile\s+recharge/i,
    /merchant\s+payment/i,
  ],
  credit_card_statement: [
    /credit\s+card/i,
    /minimum\s+(?:amount\s+)?(?:payment|due)/i,
    /payment\s+due\s+date/i,
    /credit\s+limit/i,
    /card\s+(?:no|number)/i,
  ],
  invoice: [/\binvoice\b/i, /bill\s+to/i, /subtotal/i, /total\s+due|amount\s+due/i, /payment\s+terms|po\s+number/i],
  receipt: [/\breceipt\b/i, /change\s+due|cash\s+tendered/i, /cashier|till/i, /thank\s+you\s+for/i],
  payslip: [/payslip|pay\s+slip|salary\s+slip/i, /gross\s+(?:pay|salary)/i, /net\s+pay/i, /deductions/i, /employee\s+(?:id|no)/i],
};

export function classifyDocument(text) {
  const scores = {};
  for (const [type, patterns] of Object.entries(DOC_TYPE_SIGNALS)) {
    scores[type] = patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0) / patterns.length;
  }
  const [bestType, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (bestType === "bank_statement" && scores.mobile_wallet_statement >= 0.5) {
    return { documentType: "mobile_wallet_statement", confidence: scores.mobile_wallet_statement, scores };
  }
  if (bestScore >= 0.3) return { documentType: bestType, confidence: Math.min(1, bestScore + 0.2), scores };
  return { documentType: "document", confidence: 0.3, scores };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const CURRENCY_SIGNALS = [
  ["BDT", /৳|\bBDT\b|\bTk\.?\b|taka/gi],
  ["USD", /\$|\bUSD\b/g],
  ["EUR", /€|\bEUR\b/g],
  ["GBP", /£|\bGBP\b/g],
  ["INR", /₹|\bINR\b|\bRs\.?\b/g],
  ["JPY", /¥|\bJPY\b/g],
];

function detectCurrency(text) {
  let best = null;
  let bestCount = 0;
  for (const [code, re] of CURRENCY_SIGNALS) {
    const count = (text.match(re) || []).length;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function findLabeledValue(text, labelRe, { validate } = {}) {
  const re = new RegExp(`(?:${labelRe.source})\\s*[:.\\-]*\\s*(.{2,80})`, "gi");
  for (const match of text.matchAll(re)) {
    const value = match[1].split(/\s{3,}|\||\n/)[0].replace(/[,;.]+$/, "").trim();
    if (!value) continue;
    if (!validate || validate(value)) return value;
  }
  return null;
}

function findLabeledAmount(text, labelRe) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!labelRe.test(lines[i])) continue;
    const cleaned = lines[i].replace(labelRe, " ");
    const matches = moneyMatchesIn(cleaned);
    if (matches.length) return matches.at(-1).value;
    // Vertical layouts put the number on the following line.
    for (let j = i + 1; j <= i + 2 && j < lines.length; j += 1) {
      const lookahead = lines[j].trim();
      if (!lookahead) continue;
      if (PURE_MONEY_LINE.test(lookahead) && isMoneyLike(lookahead)) {
        return parseAmount(lookahead);
      }
      break;
    }
  }
  return null;
}

function guessCompanyName(firstPageText) {
  const lines = firstPageText
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").replace(/[|*_`]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3);
  const top = lines.slice(0, 12);
  const orgRe = /\b(?:bank|plc|ltd|limited|inc\.?|llc|corp(?:oration)?|company|financial|finance|n\.a\.|gmbh)\b/i;
  const brandRe = /bkash|nagad|rocket|paypal|stripe|wise|payoneer/i;
  for (const line of top) {
    if ((orgRe.test(line) || brandRe.test(line)) && line.length <= 70 && !/statement|page\s+\d/i.test(line)) {
      return line;
    }
  }
  return top.find((l) => l.length <= 70 && !/statement|page\s+\d|date/i.test(l)) || null;
}

const ACCOUNT_NUMBER_LABEL =
  /account\s*(?:no|number|#)|a\/c\s*(?:no|number)?|acct\.?\s*(?:no|number)?|\biban\b|wallet\s*(?:no|number)/i;

export function extractMetadata(firstPageText, fullText, yearHint, dateOrder = "DMY") {
  const dateSrc = DATE_TOKEN.source;
  const period =
    fullText.match(
      new RegExp(
        `(?:statement\\s+period|period|statement\\s+for|for\\s+the\\s+period)\\s*[:\\-]?\\s*(${dateSrc})\\s*(?:to|through|till|until|[-–—])\\s*(${dateSrc})`,
        "i"
      )
    ) || null;

  let statementPeriod = period
    ? {
        from: normalizeDate(period[1], yearHint, dateOrder) ?? period[1],
        to: normalizeDate(period[2], yearHint, dateOrder) ?? period[2],
      }
    : null;

  // US-style statements: "Beginning Balance as of 02/01/2026 ... Ending Balance as of 02/28/2026"
  if (!statementPeriod) {
    const from = fullText.match(new RegExp(`(?:beginning|opening)\\s+balance\\s+as\\s+of\\s+(${dateSrc})`, "i"));
    const to = fullText.match(new RegExp(`(?:ending|closing)\\s+balance\\s+as\\s+of\\s+(${dateSrc})`, "i"));
    if (from || to) {
      statementPeriod = {
        from: from ? normalizeDate(from[1], yearHint, dateOrder) ?? from[1] : null,
        to: to ? normalizeDate(to[1], yearHint, dateOrder) ?? to[1] : null,
      };
    }
  }

  const accountNumber = findLabeledValue(fullText, ACCOUNT_NUMBER_LABEL, {
    // Require an actual number-ish token; kills "Interest Paid In 2025 Balance" header noise.
    validate: (v) => /(?:[\dXx*][\s-]?){5,}/.test(v) && /\d{4,}/.test(v.replace(/\D/g, "")),
  });

  return {
    companyName: guessCompanyName(firstPageText),
    accountName: findLabeledValue(
      fullText,
      /account\s*(?:name|holder|title|owner)(?:\(s\))?|customer\s*name|name\s+of\s+(?:account\s+)?holder/i
    ),
    accountNumber: accountNumber
      ? accountNumber.replace(/[^A-Za-z0-9*\- ]/g, "").trim().split(/\s{2,}/)[0]
      : null,
    statementPeriod,
    currency: detectCurrency(fullText),
  };
}

/** Statements often print their own totals — extract for reconciliation. */
function extractStatedTotals(text) {
  // \s* crosses newlines (vertical layouts put the number on the next line);
  // the minus may precede or follow the currency symbol.
  const creditMatch = text.match(
    /(?:deposits(?:\s+and\s+credits)?|total\s+credits?)\s*\((\d+)\)\s*[-−]?[$€£₹৳¥]?\s?[-−]?([\d,]+\.?\d*)/i
  );
  const debitMatch = text.match(
    /(?:withdrawals(?:\s+and\s+debits)?|total\s+debits?)\s*\((\d+)\)\s*[-−]?[$€£₹৳¥]?\s?[-−]?([\d,]+\.?\d*)/i
  );
  if (!creditMatch && !debitMatch) return null;
  return {
    creditCount: creditMatch ? Number(creditMatch[1]) : null,
    totalCredits: creditMatch ? parseAmount(creditMatch[2]) : null,
    debitCount: debitMatch ? Number(debitMatch[1]) : null,
    totalDebits: debitMatch ? parseAmount(debitMatch[2]) : null,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {Array<{page:number, text:string}>} pages page text in reading order
 * @returns processed payload: documentType, metadata, transactions, summary
 */
export function analyzeDocument(pages) {
  const fullText = pages.map((p) => p.text).join("\n\n");
  const firstPageText = pages[0]?.text ?? "";
  const yearHint = inferYearHint(fullText);
  const dateOrder = inferDateOrder(fullText);

  const { documentType, confidence, scores } = classifyDocument(fullText);
  const metadata = extractMetadata(firstPageText, fullText, yearHint, dateOrder);

  // Each page can use a different physical layout (pipe tables, flattened
  // lines, or one-cell-per-line vertical text). Parse with every strategy
  // and keep the one that reads the most transactions from that page.
  const transactions = [];
  for (const { page, text } of pages) {
    const modes = [
      transactionsFromTables(parseTables(text), page, yearHint, dateOrder),
      transactionsFromLines(text, page, yearHint, dateOrder),
      transactionsFromVerticalLines(text, page, yearHint, dateOrder),
    ];
    const realCount = (list) => list.filter((t) => !t.descOnly).length;
    transactions.push(...modes.sort((a, b) => realCount(b) - realCount(a))[0]);
  }
  resolveSignsByBalance(transactions);
  repairBalanceChain(transactions);
  resolveSignsByBalance(transactions); // repaired balances re-anchor the chain
  const chainBreaks = countChainBreaks(transactions);

  const credits = transactions.filter((t) => t.amount > 0);
  const debits = transactions.filter((t) => t.amount < 0);
  const round = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

  const openingBalance =
    findLabeledAmount(
      fullText,
      /(?:opening|beginning|previous)\s+balance|balance\s+(?:b\/?f|brought\s+forward)/i
    ) ?? transactions.find((t) => t.balance !== null)?.balance ?? null;

  const closingBalance =
    findLabeledAmount(
      fullText,
      /(?:closing|ending|new)\s+balance|balance\s+(?:c\/?f|carried\s+forward)/i
    ) ?? [...transactions].reverse().find((t) => t.balance !== null)?.balance ?? null;

  const totalCredits = credits.reduce((sum, t) => sum + t.amount, 0);
  const totalDebits = debits.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const statedTotals = extractStatedTotals(fullText);

  // Self-check: does what we parsed agree with what the statement declares
  // about itself, and does the running balance actually chain?
  const reconciliation = {
    balanceChainBreaks: chainBreaks,
    balanceChainConsistent: chainBreaks === 0,
    openPlusNetEqualsClose:
      openingBalance !== null && closingBalance !== null
        ? approx2(openingBalance + totalCredits - totalDebits, closingBalance)
        : null,
    matchesStatedTotals: statedTotals
      ? {
          count:
            statedTotals.creditCount !== null && statedTotals.debitCount !== null
              ? transactions.length === statedTotals.creditCount + statedTotals.debitCount
              : null,
          credits: statedTotals.totalCredits !== null ? approx2(totalCredits, statedTotals.totalCredits) : null,
          debits: statedTotals.totalDebits !== null ? approx2(totalDebits, statedTotals.totalDebits) : null,
        }
      : null,
  };

  return {
    documentType,
    confidence: round(confidence),
    classificationScores: scores,
    metadata,
    transactions,
    summary: {
      transactionCount: transactions.length,
      creditCount: credits.length,
      debitCount: debits.length,
      totalCredits: round(totalCredits),
      totalDebits: round(totalDebits),
      netChange: round(totalCredits - totalDebits),
      openingBalance: round(openingBalance),
      closingBalance: round(closingBalance),
      totalBalance: round(closingBalance),
      currency: metadata.currency,
      ...(statedTotals ? { statedTotals } : {}),
      reconciliation,
    },
  };
}

function approx2(a, b) {
  return Math.abs(a - b) < 0.02;
}
