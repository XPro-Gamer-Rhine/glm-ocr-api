import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the environment before anything else reads it.
 *
 * SIDE EFFECTS ONLY, and it must be the FIRST import in any entry point —
 * `src/config/index.js` reads `process.env` the moment it is evaluated, and ES
 * modules run their imports in order, so a loader that arrives second arrives
 * too late.
 *
 * THE FILE CHAIN, later wins:
 *
 *   1. Dime-OCR/.env.example      documented defaults, so a fresh clone runs
 *   2. THE SHARED BACKEND FILE    dime-helper-agent/.env by default
 *   3. Dime-OCR/.env              this machine's OCR-specific settings
 *
 * Step 2 is the point of this module. The helper agent already carries the
 * backend list this company runs — `DIME_ENVIRONMENTS=local,qa,prod` and the
 * suffixed `DIME_API_BASE_URL_QA`, `MONGO_URI_PROD`, `JWT_SECRET_LOCAL` keys
 * beside it — and those values belong to the COMPANY, not to one agent. Copying
 * them into a second .env means every backend move has to be made twice and
 * the second copy is the one nobody remembers. So this agent reads the same
 * file, and adds only what is its own: the OCR bridge token and the three
 * models it votes with.
 *
 * Point `DIME_SHARED_ENV_FILE` somewhere else to move it, or set it empty to
 * run standalone from Dime-OCR/.env alone.
 *
 * THE FILE WINS over an inherited environment variable, which is the opposite
 * of the usual dotenv convention and is deliberate — the same lesson the helper
 * agent learned. Names like `MONGO_URI` are not ours alone: a worker launched
 * from inside another tool's session inherits that session's values and would
 * silently ignore this file. Configuration an engineer wrote down must beat
 * configuration that merely leaked in. For a deliberate one-off override,
 * prefix the variable with `DIME_OCR_` — those are read ahead of everything.
 */

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal dotenv: `KEY=value`, `#` comments, optional quotes, no interpolation. */
function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Where the company's backend list lives. Resolved against this repo so the
 * default works from any working directory, and only used if it exists — a
 * standalone install is not an error, it just has one backend.
 */
function sharedEnvFile() {
  const configured = process.env.DIME_SHARED_ENV_FILE;
  if (configured !== undefined) {
    return configured.trim() ? path.resolve(ROOT_DIR, configured.trim()) : null;
  }
  const sibling = path.resolve(ROOT_DIR, "..", "dime-helper-agent", ".env");
  return fs.existsSync(sibling) ? sibling : null;
}

const shared = sharedEnvFile();

const merged = {
  ...parseEnvFile(path.join(ROOT_DIR, ".env.example")),
  ...(shared ? parseEnvFile(shared) : {}),
  ...parseEnvFile(path.join(ROOT_DIR, ".env")),
};

for (const [key, value] of Object.entries(merged)) {
  // An empty line in a file is not a value. Writing it through would clear a
  // real credential the process was started with — the shared file carries
  // blank placeholders for keys only one of the two agents uses.
  if (value === "") continue;
  process.env[key] = value;
}

export const envFiles = {
  rootDir: ROOT_DIR,
  sharedEnvFile: shared,
  loaded: Object.keys(merged).length,
};

export default envFiles;
