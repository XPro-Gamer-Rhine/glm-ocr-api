import config from "../config/index.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE = LEVELS[config.logLevel] ?? LEVELS.info;

const COLORS = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  reset: "\x1b[0m",
};

function emit(level, scope, args) {
  if (LEVELS[level] < ACTIVE) return;
  const ts = new Date().toISOString();
  const color = process.stdout.isTTY ? COLORS[level] : "";
  const reset = process.stdout.isTTY ? COLORS.reset : "";
  const prefix = `${ts} ${color}${level.toUpperCase().padEnd(5)}${reset} [${scope}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, ...args);
}

export function createLogger(scope) {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export default createLogger("app");
