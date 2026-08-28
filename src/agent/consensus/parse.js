/**
 * Getting an object back out of a model's reply.
 *
 * All three are asked for bare JSON and all three occasionally add something
 * anyway — a fence, a "Here is the extraction:", a trailing note about a
 * smudged row. Refusing those replies would throw away a perfectly good read
 * over punctuation, so this recovers the object and the caller decides whether
 * what is inside it is usable.
 *
 * Deliberately NOT a repair pass. It finds the JSON; it never patches broken
 * JSON into something that parses, because a model that truncated mid-array
 * produced a SHORT statement, and a half-recovered array of transactions is the
 * one failure mode this system must never paper over.
 */

/** Strip a ```json fence if the whole reply is wrapped in one. */
function unfence(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : String(text).trim();
}

/**
 * The outermost balanced `{…}`, respecting strings and escapes.
 *
 * A plain indexOf('{')/lastIndexOf('}') is wrong the moment a transaction
 * description contains a brace — and bank narratives do, constantly.
 */
function outermostObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — the reply was truncated
}

/**
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseJsonReply(text) {
  if (!text || !String(text).trim()) return { ok: false, reason: "empty reply" };
  const body = unfence(text);

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    /* fall through to extraction */
  }

  const candidate = outermostObject(body);
  if (!candidate) {
    // No closing brace at the depth it opened at: the model ran out of output
    // budget mid-object. Named specifically, because the fix is a bigger token
    // ceiling or a smaller chunk — not a better prompt.
    return { ok: false, reason: "reply is not a complete JSON object (truncated output?)" };
  }
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return { ok: false, reason: `malformed JSON: ${err.message}` };
  }
}

export default { parseJsonReply };
