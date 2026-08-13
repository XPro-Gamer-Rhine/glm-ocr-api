import fs from "node:fs";
import path from "node:path";

/**
 * Minimal file-backed JSON store: one document per file, write-through
 * in-memory cache. Swap this for SQLite/Postgres later without touching
 * the model layer's callers.
 */
export default class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.#warm();
  }

  #warm() {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
        if (doc?.id) this.cache.set(doc.id, doc);
      } catch {
        // Skip corrupt files rather than refusing to boot.
      }
    }
  }

  #fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  get(id) {
    return this.cache.get(id) ?? null;
  }

  list() {
    return [...this.cache.values()];
  }

  save(doc) {
    if (!doc?.id) throw new Error("Document must have an id");
    this.cache.set(doc.id, doc);
    // Atomic write: tmp file + rename, so a crash never leaves a torn JSON.
    const target = this.#fileFor(doc.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    return doc;
  }

  delete(id) {
    this.cache.delete(id);
    fs.rmSync(this.#fileFor(id), { force: true });
  }
}
