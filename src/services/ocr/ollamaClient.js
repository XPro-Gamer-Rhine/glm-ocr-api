import config from "../../config/index.js";

/**
 * Thin client for Ollama's native /api/generate endpoint.
 * GLM-OCR requires the native endpoint — Ollama's OpenAI-compatible API
 * has limitations with vision requests (per the official GLM-OCR docs).
 */
export async function generate({ prompt, images, options, timeoutMs }) {
  const res = await fetch(`${config.ollama.host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollama.model,
      prompt,
      ...(images?.length ? { images } : {}),
      stream: false,
      options: {
        temperature: 0,
        num_predict: 8192,
        num_ctx: 8192, // Ollama's 4096 default clips dense statement pages
        ...options,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs ?? config.extraction.ocrTimeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/generate failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  return {
    text: (data.response ?? "").trim(),
    durationMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
  };
}
