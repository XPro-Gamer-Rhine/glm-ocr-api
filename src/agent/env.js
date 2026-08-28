import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which backend this piece of work belongs to.
 *
 * One agent serves several backends — local, QA and production, each with its
 * own API and its own job boards. Every job therefore has an ENVIRONMENT, and
 * everything the job touches has to follow it: the base URL it claims from, the
 * token it authenticates with, the URL it streams the file down from, the
 * relay that reports back.
 *
 * Threading that through every call site would mean touching every module and
 * would leave a permanent hazard — one missed argument and a production
 * statement is reported into QA's books, or worse, QA's extractor answers a
 * production upload. So it is not threaded: the worker runs each job inside
 * `runIn(env, …)`, and an AsyncLocalStorage carries it down the whole async
 * tree automatically. A module that needs the environment asks `current()` and
 * cannot get the wrong one, because there is no argument to get wrong.
 *
 * Identical in shape and intent to dime-helper-agent/src/env.js — the two
 * agents share one .env and one multi-backend scheme, so they share the
 * mechanism that keeps the backends apart.
 *
 * With one environment configured this behaves exactly like a plain constant.
 */

const storage = new AsyncLocalStorage();

/** Set once at startup by config.js, so `current()` has something to fall back to. */
let fallback = null;

export function setFallback(env) {
  fallback = env || null;
}

/**
 * The environment this code is running for.
 *
 * Outside a job — the CLI, a diagnostic, startup — there is no ambient
 * environment, so the configured default answers. Inside a job there always is
 * one.
 */
export function current() {
  return storage.getStore() || fallback;
}

/** Run `fn` with `env` as the ambient environment for everything it awaits. */
export function runIn(env, fn) {
  return storage.run(env, fn);
}

/** Name for logs and worker ids. Never throws — this is used in error paths. */
export const label = (env = current()) => (env && env.id) || "default";

export default { current, runIn, setFallback, label };
