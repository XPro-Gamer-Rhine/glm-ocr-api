import { generate } from "./ollamaClient.js";

/**
 * GLM-OCR task prompts (from the official model card):
 *   "Text Recognition:"     -> full-page document parsing to markdown
 *   "Table Recognition:"    -> table-focused parsing
 *   "Formula Recognition:"  -> formula parsing
 * Information extraction uses a JSON-schema prompt.
 */
export const PROMPTS = Object.freeze({
  TEXT: "Text Recognition:",
  TABLE: "Table Recognition:",
  FORMULA: "Formula Recognition:",
});

/** OCR a single rendered page image; returns markdown-ish text. */
export async function ocrPage(pngBuffer) {
  const { text, durationMs } = await generate({
    prompt: PROMPTS.TEXT,
    images: [pngBuffer.toString("base64")],
  });
  return { markdown: text, durationMs };
}

/**
 * GLM-OCR information-extraction mode: give the model a JSON schema and an
 * image, get structured JSON back. Used on page 1 to refine document metadata.
 */
export async function extractStructured(pngBuffer, schema, instruction) {
  const prompt =
    `${instruction || "Extract the following fields from the document."}\n` +
    `Return ONLY a valid JSON object matching this schema, with null for missing fields:\n` +
    `${JSON.stringify(schema, null, 2)}`;

  const { text } = await generate({
    prompt,
    images: [pngBuffer.toString("base64")],
  });
  return parseJsonLoose(text);
}

/** Tolerant JSON parse: strips code fences and trailing prose. */
export function parseJsonLoose(text) {
  if (!text) return null;
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
