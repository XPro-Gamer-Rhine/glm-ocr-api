import agentConfig from "../../config.js";
import { parseJsonReply } from "../parse.js";

/**
 * The GPT vote.
 *
 * The one voter that needs a key. It reuses the product API's own
 * `OPENAI_API_KEY` — the same account, no second credential to provision or
 * rotate — read out of the shared env file like everything else.
 *
 * JSON MODE, not free text. The prompt already carries the schema, but asking
 * the API to guarantee an object removes the whole class of "here is your
 * extraction:" preambles that would otherwise cost a retry each time.
 *
 * The GPT-5 family moved two parameters: `max_tokens` became
 * `max_completion_tokens`, and `temperature` no longer takes a value other than
 * the default. Sending the old ones is a 400, not a warning — so this sends the
 * new shape and falls back once if the account's model is an older one. One
 * retry, not a negotiation loop.
 */

export const id = "gpt";
export const label = "GPT";

export function describe() {
  const c = agentConfig.analysts.gpt;
  return { id, label, enabled: c.enabled, model: c.model, baseUrl: c.baseUrl, hasKey: Boolean(c.apiKey) };
}

export async function available() {
  const c = agentConfig.analysts.gpt;
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!c.apiKey) return { ok: false, reason: "OPENAI_API_KEY is empty" };
  try {
    const res = await fetch(`${c.baseUrl}/models/${encodeURIComponent(c.model)}`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true, detail: c.model };
    if (res.status === 404) {
      return { ok: false, reason: `this account has no model "${c.model}" — set OPENAI_MODEL to one it has` };
    }
    if (res.status === 401) return { ok: false, reason: "OPENAI_API_KEY was refused" };
    return { ok: false, reason: `OpenAI answered ${res.status} when asked about "${c.model}"` };
  } catch (err) {
    return { ok: false, reason: `could not reach OpenAI: ${err.message}` };
  }
}

export async function analyze({ prompt, signal = null }) {
  const c = agentConfig.analysts.gpt;
  const startedAt = Date.now();
  if (!c.apiKey) {
    return { ok: false, reason: "OPENAI_API_KEY is empty", durationMs: 0 };
  }

  const base = {
    model: c.model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  };

  let result = await call({ ...base, max_completion_tokens: c.maxOutputTokens }, c, signal);
  // An older model on this account: the parameter it wants is the old name.
  if (!result.ok && result.retryable) {
    result = await call({ ...base, max_tokens: c.maxOutputTokens, temperature: 0 }, c, signal);
  }
  return { ...result, durationMs: Date.now() - startedAt };
}

async function call(body, c, signal) {
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(c.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `OpenAI answered ${res.status}: ${text.slice(0, 300)}`,
        // Only a parameter complaint is worth trying again in another shape.
        retryable: res.status === 400 && /max_completion_tokens|max_tokens|temperature|unsupported/i.test(text),
      };
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    // A reply cut off at the token ceiling is a SHORT statement, not a reply
    // with a few rows missing. Named as its own failure so the fix is obvious.
    if (choice && choice.finish_reason === "length") {
      return { ok: false, reason: "ran out of output tokens mid-answer — lower OCR_PAGES_PER_CHUNK or raise OCR_GPT_MAX_OUTPUT_TOKENS" };
    }
    const text = (choice && choice.message && choice.message.content) || "";
    const parsed = parseJsonReply(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    return {
      ok: true,
      value: parsed.value,
      usage: {
        inputTokens: Number(data.usage?.prompt_tokens || 0),
        outputTokens: Number(data.usage?.completion_tokens || 0),
      },
    };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" || err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

export default { id, label, analyze, available, describe };
