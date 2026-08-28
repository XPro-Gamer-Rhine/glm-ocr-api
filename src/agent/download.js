import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import agentConfig from "./config.js";
import { INTERNAL } from "./apiRelay.js";

/**
 * Getting the file onto this machine.
 *
 * The job document never carries the bytes — a scanned statement is megabytes
 * and Mongo caps at sixteen — so the product keeps them in object storage and
 * this pulls them down with the machine token.
 *
 * STREAMED TO DISK, never buffered. The renderer wants a path anyway, and a
 * 500MB scan held in memory alongside an OCR run is how a machine with 16GB
 * starts swapping mid-extraction.
 *
 * THE HASH IS CHECKED. A download truncated by a dropped connection produces a
 * shorter PDF that opens fine and is missing its last pages — and every model
 * would agree about a statement that ends early, because they all read the same
 * truncated file. The one check that catches it has to happen here, before an
 * hour of OCR is spent on the wrong bytes.
 */

export async function downloadJobFile(job, { env, signal = null } = {}) {
  const dir = agentConfig.storage.workDir;
  fs.mkdirSync(dir, { recursive: true });

  const jobId = String(job._id || job.id);
  const ext = path.extname(job.file?.originalName || "") || ".pdf";
  const target = path.join(dir, `${jobId}${ext}`);

  const url = `${env.apiBaseUrl}${INTERNAL}/jobs/${encodeURIComponent(job.kind)}/${encodeURIComponent(jobId)}/file`;
  const res = await fetch(url, {
    headers: { "x-ocr-agent-token": env.bridgeToken },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "the product no longer has this file"
        : `the product answered ${res.status} for this file`
    );
  }
  if (!res.body) throw new Error("the product sent an empty response for this file");

  const hash = crypto.createHash("sha256");
  const tmp = `${target}.part`;
  const out = fs.createWriteStream(tmp);

  // Hash as it lands, so verification costs one pass rather than a re-read.
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => hash.update(chunk));
  try {
    await pipeline(source, out);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`the download stopped partway: ${err.message}`);
  }

  const digest = hash.digest("hex");
  const expected = job.file?.sha256 || res.headers.get("x-file-sha256") || "";
  if (expected && digest !== expected) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      "the file that arrived is not the file that was uploaded (checksum mismatch) — it was truncated or altered in transit"
    );
  }

  fs.renameSync(tmp, target);
  const { size } = fs.statSync(target);
  return { path: target, sizeBytes: size, sha256: digest };
}

/** Remove a job's downloaded file unless the operator asked to keep it. */
export function cleanupJobFile(filePath) {
  if (!filePath || agentConfig.storage.keepFiles) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* a leftover file is not worth failing a finished job over */
  }
}

export default { downloadJobFile, cleanupJobFile };
