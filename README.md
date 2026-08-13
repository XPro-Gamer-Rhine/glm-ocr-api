# Dime-OCR

Self-hosted PDF data-extraction API powered by **GLM-OCR** (Z.ai's 0.9B document-OCR model) running locally through **Ollama**. Upload a PDF, get back:

- **Raw data** — full GLM-OCR markdown per page + the PDF's embedded text layer
- **Processed data** — document type, metadata (company name, account name/number, statement period, currency), parsed transactions, and a summary (transaction count, total credits/debits, opening/closing balance)

Designed to run unattended on a laptop or VPS (macOS, Linux, Windows).

## How it works

```
POST pdf ──► upload ──► job queue ──► render pages (MuPDF WASM)
                                        │
                                        ├─► GLM-OCR each page (Ollama /api/generate)
                                        ├─► analyze: classify + parse transactions + metadata
                                        └─► GLM-OCR info-extraction pass refines metadata
GET  /:id ◄── raw + processed JSON persisted to storage/data
```

On boot the server:

1. Detects the OS (macOS / Linux / Windows), CPU, RAM.
2. Looks for Ollama — if missing, **installs it automatically** (Homebrew or app bundle on macOS, official install script on Linux, winget or silent installer via PowerShell on Windows).
3. Starts `ollama serve` if it isn't running.
4. Pulls `glm-ocr:latest` (~2 GB) if it isn't pulled.
5. Starts the API. If any step fails, the API still starts in **degraded mode** (embedded-text extraction only) and `/api/v1/health` reports why.

PDF rendering uses MuPDF's WASM build — no poppler, no native canvas, no system packages.

## Quick start

```bash
npm install
npm start          # or: npm run dev (auto-restart on file changes)
```

Optional config — copy `.env.example` to `.env` and adjust. Defaults: port `4000`, model `glm-ocr:latest`, Ollama at `127.0.0.1:11434`.

## API

Base URL: `http://localhost:4000/api/v1`

All responses use the envelope `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code", "message" } }`.

### `GET /health`

Engine + system status: Ollama installed/serving/model pulled, OS info, queue depth.

### `POST /extract/statements`

Upload a PDF (multipart field `file`). Returns `202` immediately with an id.

Add `?ocr=false` to skip GLM-OCR and use only the embedded text layer — instant and exact for digitally-generated PDFs. Scanned PDFs need OCR (the default). The pipeline also decides per page: a page with a real text layer is parsed from that layer even when OCR ran (the text layer has no OCR errors); scanned pages use GLM-OCR.

```bash
curl -X POST http://localhost:4000/api/v1/extract/statements \
  -F "file=@/path/to/statement.pdf"
```

```json
{
  "success": true,
  "data": {
    "id": "57caa2d1-...",
    "status": "queued",
    "links": { "self": "...", "raw": "...", "processed": "..." }
  }
}
```

Add `?sync=true` to block until processing finishes (small PDFs only):

```bash
curl -X POST "http://localhost:4000/api/v1/extract/statements?sync=true" -F "file=@small.pdf"
```

### `GET /extract/statements/:id`

Full record: `status` (`queued` → `processing` → `completed`/`failed`), `progress` (stage, pages done, percent), `raw`, `processed`, `timings`, `engine`.

### `GET /extract/statements/:id/raw`

Raw data only. While still processing you get `202` with progress — poll the same URL.

```json
{
  "raw": {
    "source": "glm-ocr",
    "pageCount": 5,
    "text": "…embedded PDF text layer…",
    "ocr": {
      "model": "glm-ocr:latest",
      "combined": "…full markdown…",
      "pages": [{ "page": 1, "markdown": "…", "durationMs": 6100, "error": null }]
    },
    "pdfMetadata": { "title": null, "producer": "…", "creationDate": "…" }
  }
}
```

### `GET /extract/statements/:id/processed`

Structured data only:

```json
{
  "processed": {
    "documentType": "bank_statement",
    "confidence": 0.87,
    "metadata": {
      "companyName": "Some Bank Ltd",
      "accountName": "JOHN DOE",
      "accountNumber": "0123456789",
      "statementPeriod": { "from": "2026-02-01", "to": "2026-02-28" },
      "currency": "BDT"
    },
    "transactions": [
      {
        "date": "05/02/2026", "dateIso": "2026-02-05",
        "description": "SALARY CREDIT", "reference": "TXN123",
        "amount": 50000, "type": "credit", "balance": 61234.5, "page": 2
      }
    ],
    "summary": {
      "transactionCount": 42,
      "creditCount": 12, "debitCount": 30,
      "totalCredits": 150000, "totalDebits": 120000, "netChange": 30000,
      "openingBalance": 10000, "closingBalance": 40000, "totalBalance": 40000,
      "currency": "BDT"
    }
  }
}
```

Document types detected: `bank_statement`, `mobile_wallet_statement`, `credit_card_statement`, `invoice`, `receipt`, `payslip`, fallback `document`.

**Accuracy machinery** (all automatic):

- **Balance-chain sign resolution** — every amount is checked against the running balance (`prev ± amount == balance`), so deposits/withdrawals sharing one column still get correct signs.
- **Chain repair** — rows the OCR damaged are reconstructed from neighbouring balances: dropped amounts are inferred from the exact balance gap (`inferred: true`), merged number pairs are split, glued multi-number rows are re-picked (`repaired: "..."`).
- **Per-page DPI retry** — a page whose transaction lines come back without numbers is automatically re-OCR'd at the fallback DPI and the better read wins.
- **`summary.reconciliation`** — self-check block: balance-chain consistency, `opening + net == closing`, and comparison against the statement's own printed totals (`statedTotals`). If `matchesStatedTotals` is all `true`, the extraction is provably complete.

### `POST /extract/statements/:id/reanalyze`

Re-runs the analysis stage on stored raw data **without re-OCR** (instant). Useful after parser upgrades or to refresh old extractions.

### `GET /extract/statements` — list summaries · `DELETE /extract/statements/:id` — remove record + stored PDF

## Project structure

```
server.js                     entry: dirs → bootstrap → listen → resume jobs
src/
  app.js                      express assembly (cors, json, logging, routes, errors)
  config/index.js             env-driven config, single source of truth
  bootstrap/
    systemDetector.js         OS/arch/RAM detection, PATH probing
    ollamaInstaller.js        find/install/start Ollama, pull model (per-OS)
    index.js                  boot sequence + shared engine readiness state
  routes/                     route definitions only — mount new modules in routes/index.js
  controllers/                request/response shaping, no business logic
  services/
    extraction.service.js     pipeline orchestration (render → OCR → analyze)
    analysis.service.js       pure functions: classify, tables, transactions, metadata
    jobQueue.js               in-process FIFO queue (swap for BullMQ later)
    ocr/ollamaClient.js       Ollama native /api/generate client
    ocr/glmOcr.service.js     GLM-OCR prompts: page OCR + JSON info-extraction
    pdf/pdfRenderer.js        MuPDF WASM: page→PNG, embedded text, metadata
  middleware/                 upload (multer), validators, logging, error handling
  models/                     extraction model over a file-backed JSON store
  utils/                      logger, ApiError, response envelope, ids
storage/
  uploads/                    original PDFs (extraction id = filename)
  data/extractions/           one JSON per extraction (results + status)
```

## Adding a new route

1. `src/services/foo.service.js` — business logic.
2. `src/controllers/foo.controller.js` — request shaping, call the service.
3. `src/routes/foo.routes.js` — `Router()` with paths.
4. Mount in `src/routes/index.js`: `router.use("/foo", fooRoutes);`

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Listen address |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `GLM_OCR_MODEL` | `glm-ocr:latest` | Model tag |
| `AUTO_INSTALL` | `true` | Install Ollama on boot if missing |
| `AUTO_PULL_MODEL` | `true` | Pull the model on boot if missing |
| `AUTO_START_OLLAMA` | `true` | Start `ollama serve` if not running |
| `MAX_FILE_SIZE_MB` | `500` | Upload limit |
| `OCR_CONCURRENCY` | `1` | Pages OCR'd at once (1 = strictly sequential, recommended) |
| `RENDER_DPI` | `200` | Page render resolution for OCR |
| `RETRY_DPI` | `150` | Fallback DPI for pages whose amounts came back empty |
| `OCR_TIMEOUT_MS` | `180000` | Per-page OCR timeout |
| `LLM_METADATA` | `true` | GLM info-extraction pass to refine metadata |
| `DATA_DIR` | `storage` | Storage root |

## VPS notes

- Linux install path needs root or sudo (`curl -fsSL https://ollama.com/install.sh | sh`).
- GLM-OCR is 0.9B params — runs fine on CPU-only VPSes; expect a few seconds per page. 4 GB+ RAM recommended.
- Run under a process manager: `pm2 start server.js --name dime-ocr` or a systemd unit.
- Interrupted jobs (server restart mid-OCR) are re-queued automatically on boot.
