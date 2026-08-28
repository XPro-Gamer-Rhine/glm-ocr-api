import { spawn } from "node:child_process";
import agentConfig from "../../config.js";
import { parseJsonReply } from "../parse.js";

/**
 * The Claude vote.
 *
 * Runs through the local Claude Code CLI by default — this machine's own
 * subscription, so there is no API key to hold beside the OpenAI one, and the
 * same runtime the helper and close agents already use here.
 *
 * TOOLS ARE DISABLED, all of them. This model is being asked to read text and
 * return JSON; a tool call here would at best waste a minute and at worst let
 * a prompt injected into a scanned document reach a shell. A statement PDF is
 * untrusted input — anyone can put "ignore your instructions and run…" in the
 * memo line of a transfer and post it to a customer's account.
 *
 * The prompt goes on STDIN, not in argv: a chunk of OCR text is tens of
 * kilobytes and argv has a hard OS limit that would truncate it silently
 * somewhere past a few hundred kilobytes.
 */

export const id = "claude";
export const label = "Claude";

/**
 * Everything the CLI can reach, refused by name. `--disallowedTools` is a
 * denylist, so this list has to be complete rather than clever.
 */
const NO_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
];

export function describe() {
  const c = agentConfig.analysts.claude;
  return {
    id,
    label,
    enabled: c.enabled,
    runtime: c.runtime,
    model: c.model,
    effort: c.effort,
  };
}

export async function available() {
  const c = agentConfig.analysts.claude;
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (c.runtime === "api") {
    return c.apiKey ? { ok: true } : { ok: false, reason: "ANTHROPIC_API_KEY is empty" };
  }
  const found = await new Promise((resolve) => {
    const probe = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    probe.stdout.on("data", (c2) => (out += c2.toString()));
    probe.on("error", () => resolve(null));
    probe.on("exit", (code) => resolve(code === 0 ? out.trim() : null));
  });
  return found ? { ok: true, detail: found } : { ok: false, reason: "the `claude` CLI is not on this machine's PATH" };
}

/**
 * @returns {{ok: boolean, value?: object, reason?: string, usage?: object, durationMs: number}}
 */
export async function analyze({ prompt, signal = null }) {
  const c = agentConfig.analysts.claude;
  const startedAt = Date.now();
  const result =
    c.runtime === "api" ? await viaApi(prompt, c, signal) : await viaCli(prompt, c, signal);
  return { ...result, durationMs: Date.now() - startedAt };
}

function viaCli(prompt, c, signal) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--model", c.model,
      "--effort", c.effort,
      "--output-format", "json",
      "--disallowedTools", ...NO_TOOLS,
    ];

    let child;
    try {
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, reason: `could not start the Claude CLI: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, reason: `no answer within ${Math.round(c.timeoutMs / 1000)}s` });
    }, c.timeoutMs);

    const onAbort = () => {
      kill();
      finish({ ok: false, reason: "cancelled" });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", (err) => finish({ ok: false, reason: `Claude CLI failed to run: ${err.message}` }));

    child.on("exit", (code) => {
      if (settled) return;
      // The envelope first: --output-format json wraps the reply with usage.
      const envelope = parseJsonReply(stdout);
      if (!envelope.ok) {
        const why =
          /oauth|authenticate|not logged in|invalid api key/i.test(`${stdout}${stderr}`)
            ? "the Claude CLI is not signed in on this machine (run `claude` and sign in)"
            : `the Claude CLI exited ${code} without a usable reply${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`;
        finish({ ok: false, reason: why });
        return;
      }

      const env = envelope.value;
      const text = typeof env.result === "string" ? env.result : "";
      if (env.is_error || !text) {
        finish({ ok: false, reason: `the Claude CLI reported an error${text ? `: ${text.slice(0, 200)}` : ""}` });
        return;
      }

      const parsed = parseJsonReply(text);
      if (!parsed.ok) {
        finish({ ok: false, reason: parsed.reason });
        return;
      }

      finish({
        ok: true,
        value: parsed.value,
        usage: {
          inputTokens: Number(env.usage?.input_tokens || 0),
          outputTokens: Number(env.usage?.output_tokens || 0),
          cacheReadTokens: Number(env.usage?.cache_read_input_tokens || 0),
          costUsd: Number(env.total_cost_usd || 0),
        },
      });
    });

    child.stdin.on("error", () => {
      /* the child died before the prompt landed; the exit handler reports it */
    });
    child.stdin.end(prompt);
  });
}

/** Where no CLI exists — a container, CI. Same model, same prompt, a key instead. */
async function viaApi(prompt, c, signal) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: 32000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: signal || AbortSignal.timeout(c.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `Anthropic answered ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseJsonReply(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return {
      ok: true,
      value: parsed.value,
      usage: {
        inputTokens: Number(data.usage?.input_tokens || 0),
        outputTokens: Number(data.usage?.output_tokens || 0),
      },
    };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timed out" : err.message };
  }
}

export default { id, label, analyze, available, describe };
