import agentConfig from "../../config.js";
import { CHUNK_SCHEMA } from "../schema.js";
import { parseJsonReply } from "../parse.js";

/**
 * The GLM vote.
 *
 * Runs on the SAME Ollama that did the OCR, but NOT the same model. `glm-ocr`
 * is 0.9B and reads pixels; it cannot weigh a balance chain or judge whether
 * two narratives are one transaction. The vote needs a chat model — pulled
 * alongside it, on the same runtime.
 *
 * This is also the only voter that costs nothing per call, which makes it the
 * natural third opinion: two paid models agreeing is the common case, and the
 * third exists for the times they do not.
 *
 * Ollama takes a JSON Schema as its `format`, which constrains generation
 * rather than merely asking for JSON — worth more on a 9B model than on the
 * other two. Older builds only understand `format: "json"`, so a rejection
 * falls back once rather than failing the vote.
 */

export const id = "glm";
export const label = "GLM";

export function describe() {
  const c = agentConfig.analysts.glm;
  return { id, label, enabled: c.enabled, model: c.model, host: c.host };
}

export async function available() {
  const c = agentConfig.analysts.glm;
  if (!c.enabled) return { ok: false, reason: "disabled" };
  try {
    const res = await fetch(`${c.host}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `Ollama answered ${res.status}` };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    if (!names.includes(c.model)) {
      const bare = c.model.split(":")[0];
      const near = names.find((n) => n.split(":")[0] === bare);
      return {
        ok: false,
        reason: near
          ? `"${c.model}" is not pulled, but "${near}" is — set GLM_CHAT_MODEL to it`
          : `"${c.model}" is not pulled — run \`ollama pull ${c.model}\``,
      };
    }
    return { ok: true, detail: c.model };
  } catch (err) {
    return { ok: false, reason: `could not reach Ollama at ${c.host}: ${err.message}` };
  }
}

export async function analyze({ prompt, signal = null }) {
  const c = agentConfig.analysts.glm;
  const startedAt = Date.now();

  let result = await call(prompt, c, CHUNK_SCHEMA, signal);
  if (!result.ok && result.retryable) result = await call(prompt, c, "json", signal);
  return { ...result, durationMs: Date.now() - startedAt };
}

async function call(prompt, c, format, signal) {
  try {
    const res = await fetch(`${c.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: "user", content: prompt }],
        format,
        stream: false,
        options: {
          // Zero temperature is not a style choice here: the three votes only
          // mean something if each model would give the same answer twice.
          temperature: 0,
          num_ctx: c.numCtx,
          num_predict: -1,
        },
      }),
      signal: signal || AbortSignal.timeout(c.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `Ollama answered ${res.status}: ${text.slice(0, 300)}`,
        // An older build that only understands format:"json".
        retryable: res.status === 400 && format !== "json",
      };
    }

    const data = await res.json();
    if (data.error) {
      return { ok: false, reason: `Ollama error: ${data.error}`, retryable: format !== "json" };
    }
    const text = (data.message && data.message.content) || "";
    const parsed = parseJsonReply(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    return {
      ok: true,
      value: parsed.value,
      usage: {
        inputTokens: Number(data.prompt_eval_count || 0),
        outputTokens: Number(data.eval_count || 0),
        costUsd: 0,
      },
    };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" || err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

export default { id, label, analyze, available, describe };
