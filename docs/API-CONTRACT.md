# Internal OCR-agent API contract

What the product API exposes for this agent to work. Implemented in
`ms-university` as `routes/internal/ocrAgent.js`, `services/ocrAgentJobQueue.js`,
`models/accountant/OcrAgentJob.js` and `middleware/ocrAgentAuth.js`.

It **copies the mechanics** of the close-agent and helper-agent surfaces and
**shares none of their storage**.

## Separation from the other two agents — non-negotiable

Three different systems that happen to run on the same machine. They must not
share a queue, a collection, a worker registry, or a secret. Sharing any of
them means one agent can claim another's work, one deploy can stall the others,
and rotating one credential silently breaks all three.

| Concern | Close agent | Helper agent | OCR agent |
| --- | --- | --- | --- |
| Route namespace | `/api/v1/internal/close-agent` | `/api/v1/internal/helper-agent` | `/api/v1/internal/ocr-agent` |
| Auth header | `x-close-agent-token` | `x-helper-agent-token` | `x-ocr-agent-token` |
| Env secret | `CLOSE_AGENT_TOKEN` | `HELPER_AGENT_TOKEN` | `OCR_AGENT_TOKEN` |
| Agent-side key | `BRIDGE_TOKEN` | `BRIDGE_TOKEN` | `OCR_BRIDGE_TOKEN` |
| Middleware | `closeAgentAuth.js` | `helperAgentAuth.js` | `ocrAgentAuth.js` |
| Job model | `WorkflowJob` (`workflowjobs`) | `AgentJob` (`helperagentjobs`) | one per kind (`ocrstatementjobs`, …) |
| Event model | `CloseWorkflowEvent` | `AgentChatEvent` | `OcrAgentEvent` (`ocragentevents`) |
| Worker registry | `WorkflowWorker` | `AgentWorker` | `OcrAgentWorker` (`ocragentworkers`) |
| Queue service | `workflowJobQueue.js` | `helperAgentJobQueue.js` | `ocrAgentJobQueue.js` |
| Job kinds | `close_run`, repair kinds | `helper_chat` | `statement` (one board each) |

`OCR_AGENT_TOKEN` deserves separate care from the other two: it is the only one
that opens a route streaming a customer's bank statement in full.

## One board per document type

Not one board with a `kind` filter. A statement takes minutes of OCR and a
receipt takes seconds; sharing a queue means a hundred-page statement backlog
starves every receipt behind it, and a change to one type's payload shape
touches the other's documents.

`kindRegistry` in `models/accountant/OcrAgentJob.js` is the only place a type is
added:

```js
statement: {
  modelName: 'OcrStatementJob',
  collection: 'ocrstatementjobs',
  label: 'bank, card or wallet statement',
  bucketEnv: 'SPACES_OCR_STATEMENTS_BUCKET_NAME',
}
```

A new type costs one entry here plus one handler in `src/agent/jobs/`. Nothing
in the routes, the worker or the consensus engine changes.

`claimNext` walks every board the worker declared and returns the oldest job it
wins, releasing any others it claimed on the way — so no document type starves
another.

## Mounting

```js
app.use('/api/v1/internal/ocr-agent', express.json({ limit: '64mb' }));  // before the global parser
app.use('/api/v1/internal/ocr-agent', ocrAgentInternal);
```

Outside `/api/v1/accountant` so `auditMiddleware` and user JWTs never apply.
64mb because a resolve payload carries the agreed figures, every transaction and
three models' dissenting reads, and a raw delivery carries a whole scanned
statement's OCR text.

## Auth

Every route: header `x-ocr-agent-token` compared with env `OCR_AGENT_TOKEN` via
length check + `crypto.timingSafeEqual`. Unset env → 503 (fail closed).
Mismatch → 401. The same value goes in this repo's `OCR_BRIDGE_TOKEN`.

## The job document

```
{ businessId, kind, uploadedBy, status: open|claimed|working|resolved|failed|abandoned,
  idempotencyKey: `${businessId}:${sha256}`,
  file: { originalName, bucket, fileKey, contentType, sizeBytes, sha256, pageCount, uploadedAt },
  payload: { ocr, currencyHint, periodHint, note },
  result,                       // the consensus verdict (see below)
  verdict: extracted|needs_review,
  agreementScore, disputeCount, transactionCount,
  agentStatus, progress: [{at, note, percent}],
  claimedBy, claimedAt, startedAt, finishedAt, attempts, error,
  cancelRequested, lastSeq, timestamps }
```

**The idempotency key is the file's SHA-256, not a request id.** A
double-clicked upload and a genuine re-upload of the same PDF are the same event
as far as extraction is concerned. OCR is the most expensive thing in this
system, and two extractions of one statement is how a month's transactions get
imported twice.

Two side collections:

- `OcrAgentRaw` (`ocragentraws`) — the raw read behind the figures, one doc per
  job, unique on `jobId`. Apart from the job because it is the biggest thing
  here and nothing on a list screen reads it. Clipped at 8MB with
  `truncated: true` rather than losing the write.
- `OcrAgentEvent` (`ocragentevents`) — one doc per event, unique on
  `(jobId, seq)`, indexed on `(jobId, agentSeq)` for the retry check.

## Endpoints the agent calls

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| POST | `/jobs/claim` | `{agentId, kinds[], businessId?}` | `204` when nothing waiting, else `200 {job}`. Atomic `findOneAndUpdate` per board: `status:'open'`, or stale claims (`updatedAt` older than 20 min) whose claimer has no live heartbeat (45 s). Never hands out a job with `cancelRequested`. |
| POST | `/jobs/:kind/:jobId/progress` | `{note, percent}` | `200 {job}` — status→working, `startedAt` on first call, push to `progress`. |
| POST | `/jobs/:kind/:jobId/touch` | `{}` | `200 {ok}` — bump `updatedAt` only (`{timestamps: false}`), no progress append; fires every ~10 s. |
| GET | `/jobs/:kind/:jobId/file` | — | `200` the raw bytes, streamed, with `x-file-sha256`. The agent verifies the digest before spending OCR on it. |
| POST | `/jobs/:kind/:jobId/raw` | `{raw: {source, model, pageCount, characters, pages[]}}` | `200 {stored, truncated, pageCount}`. Delivered BEFORE the verdict, so a failed vote still leaves the evidence. |
| POST | `/jobs/:kind/:jobId/resolve` | `{summary, result}` | `200 {job}` — status→resolved, `verdict`/`agreementScore`/`disputeCount`/`transactionCount` promoted out of `result`. |
| POST | `/jobs/:kind/:jobId/fail` | `{error, summary}` | `200 {job}` — status→failed. |
| GET | `/jobs/:kind/:jobId/cancelled` | — | `200 {cancelRequested}` (false when missing, no 404). |
| POST | `/jobs/:kind/:jobId/events` | `{events: [...]}` | `200 {jobId, stored, lastSeq}` — deduped on the agent's `seq`, so a relay retry lands once. `404` when the job was deleted. |
| POST | `/workers/register` | `{workerId, host, version, kinds[], engines}` | `200 {registered}` — upsert by workerId. |
| POST | `/workers/:workerId/heartbeat` | `{status, currentJobId, stats, engines}` | `200 {ok}` — `lastSeenAt = now`; "extractor online" = a beat within 45 s, computed from Mongo, never by calling the worker. |

**Both `extracted` and `needs_review` are RESOLVED jobs.** The data is real
either way, and calling a disagreement a failure would hide a complete
extraction behind an error screen.

## Endpoints the dashboard calls

`accountantProtect` + a business-access check on every one. The UI never talks
to the agent.

- `POST /api/v1/accountant/ocr/:kind` — multipart `file` + `businessId`. Hashes
  the bytes, uploads to Spaces, opens a job. `202 {job}`, or `200
  {duplicate: true, job}` when these exact bytes were already uploaded.
- `GET /api/v1/accountant/ocr/:kind?businessId=&page=&status=&verdict=` — the list.
- `GET /api/v1/accountant/ocr/:kind/:jobId` — the detail, with `result`.
- `GET /api/v1/accountant/ocr/:kind/:jobId/events?after=<seq>` — the live view.
- `GET /api/v1/accountant/ocr/:kind/:jobId/raw` — the evidence, on request only.
- `POST /api/v1/accountant/ocr/:kind/:jobId/stop` — sets `cancelRequested`.
- `GET /api/v1/accountant/ocr/health` — worker liveness from heartbeats.
- `GET /api/v1/accountant/ocr/types` — what this API can extract.

## Events the agent sends

See `src/agent/events.js`.

| Type | Carries |
| --- | --- |
| `ocr:start` | file name, size, business |
| `ocr:stage` | `{stage, note, percent}` — fetching → reading → analyzing → reconciling |
| `ocr:page` | `{page, pageCount, source, characters, retried}` |
| `ocr:vote` | `{analyst, chunk, chunks, transactions, ok, error, durationMs}` |
| `ocr:dispute` | `{field, disputeKind, values, resolution}` |
| `ocr:data` | the agreed figures as they firm up |
| `ocr:trace` | technical detail, folded away |
| `ocr:usage` | what the three voters cost |
| `ocr:done` | `{status: extracted\|needs_review\|failed\|stopped, summary, durationMs}` |

`ocr:stage` and `ocr:page` are for the person watching a bar move — plain
language, no model names, no file paths. `ocr:vote`, `ocr:dispute` and
`ocr:trace` are the audit trail.

## The result payload

```
{ verdict, agreementScore, quorum,
  consensus: { documentType, metadata: {...}, summary: {...}, statedTotals: {...}, transactions: [...] },
  reconciliation: { balanceChain, openingNetClosing, statedTotals, provablyComplete },
  agreement: { 'metadata.accountNumber': {agreed, votes, of, unanimous, analysts}, … },
  transactionAgreement: { ratio, accepted, perAnalyst, threshold },
  disputes: [ {kind, field?, detail, candidates?, row?} ],
  analysts: [ {id, label, model, voted, chunksRead, chunksFailed, transactions, errors, usage} ],
  usage: { inputTokens, outputTokens, costUsd, chunks, pages },
  engine: { ocrUsed, model, renderDpi }, pageCount, durationMs }
```

`consensus.summary.totalCredits` / `totalDebits` are **computed from the agreed
rows**. `consensus.statedTotals` is what the statement itself printed. They are
never merged: the difference between the two is the single most useful signal
that a page was missed.
