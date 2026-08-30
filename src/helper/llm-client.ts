/**
 * Helper LLM client. Prefers OpenRouter (`OPENROUTER_API_KEY`); falls back to
 * Gemini generateContent (`GEMINI_API_KEY`) so Process still works without OR.
 *
 * Visual (YouTube URL) calls pin OpenRouter to Google AI Studio — Vertex does
 * not accept YouTube links. Gemini Web in the extension does not use this file.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

/** Stored KV ids are often bare `gemini-3.1-flash-lite`; OpenRouter wants `google/…`. */
const MODEL_ALIASES: Record<string, string> = {
  "gemini-3-flash": "google/gemini-3-flash-preview",
  "google/gemini-3-flash": "google/gemini-3-flash-preview",
  "gemini-3-pro": "google/gemini-3.1-pro-preview",
  "google/gemini-3-pro": "google/gemini-3.1-pro-preview",
};

export function normalizeModelId(model: string | undefined | null): string {
  const raw = String(model || "").trim();
  if (!raw) return "google/gemini-3.1-flash-lite";
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw];
  if (raw.includes("/")) return raw;
  return `google/${raw}`;
}

/** Strip `google/` so the native Gemini generateContent path still works. */
export function toGeminiModelId(model: string): string {
  const n = normalizeModelId(model);
  return n.startsWith("google/") ? n.slice("google/".length) : n;
}

export type LlmUsage = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  /** USD billed when the provider reports it (OpenRouter `usage.cost`). */
  cost?: number;
};

export type LlmResult = {
  text: string;
  usage: LlmUsage;
  finishReason?: string;
};

export type CompleteTextOpts = {
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
};

export type CompleteVisualOpts = {
  model: string;
  youtubeUrl: string;
  prompt: string;
  schema: Record<string, any>;
  maxTokens?: number;
  thinking?: "low" | "medium" | "high";
  /** HIGH is Gemini-native; OpenRouter may ignore it (spike item). */
  mediaResolution?: "default" | "high";
};

const GEMINI_PRICES: Array<{ match: RegExp; inputPerM: number; outputPerM: number }> = [
  { match: /3\.7-flash/, inputPerM: 0.75, outputPerM: 3.75 },
  { match: /3\.6-flash/, inputPerM: 1.5, outputPerM: 7.5 },
  { match: /pro/, inputPerM: 1.25, outputPerM: 5.0 },
  { match: /lite/, inputPerM: 0.0375, outputPerM: 0.15 },
];

/** Prefer provider-reported USD; otherwise estimate from Gemini-era list prices. */
export function calculateCost(model: string, usage: LlmUsage | any | undefined): number {
  if (!usage) return 0;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) return usage.cost;
  const inputTokens = usage.promptTokenCount || usage.prompt_tokens || 0;
  const outputTokens = usage.candidatesTokenCount || usage.completion_tokens || 0;
  const price = GEMINI_PRICES.find((p) => p.match.test(String(model)))
    || { inputPerM: 0.075, outputPerM: 0.3 };
  return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}

function hasOpenRouter(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

function hasGemini(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

function jsonSchemaToOpenAI(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(jsonSchemaToOpenAI);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" && typeof v === "string") {
      out.type = v.toLowerCase();
    } else {
      out[k] = jsonSchemaToOpenAI(v);
    }
  }
  return out;
}

function mapFinishReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const u = raw.toUpperCase();
  if (u === "LENGTH" || u === "MAX_TOKENS") return "MAX_TOKENS";
  if (u === "CONTENT_FILTER" || u === "SAFETY" || u === "PROHIBITED_CONTENT") return "SAFETY";
  return u;
}

async function openRouterChat(body: Record<string, any>): Promise<LlmResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing in .env");

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "yt-pipeline",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err.slice(0, 800)}`);
  }
  const data: any = await response.json();
  const choice = data?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const u = data?.usage || {};
  const prompt = u.prompt_tokens || 0;
  const completion = u.completion_tokens || 0;
  return {
    text,
    usage: {
      promptTokenCount: prompt,
      candidatesTokenCount: completion,
      totalTokenCount: u.total_tokens || prompt + completion,
      cost: typeof u.cost === "number" ? u.cost : undefined,
    },
    finishReason: mapFinishReason(choice?.finish_reason || choice?.native_finish_reason),
  };
}

async function geminiGenerate(opts: {
  model: string;
  contents: any;
  generationConfig: Record<string, any>;
}): Promise<LlmResult> {
  if (!hasGemini()) throw new Error("GEMINI_API_KEY missing in .env");
  const model = toGeminiModelId(opts.model);
  const response = await fetch(GEMINI_URL(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: opts.contents,
      generationConfig: opts.generationConfig,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err.slice(0, 800)}`);
  }
  const data: any = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("") || "";
  const u = data?.usageMetadata || {};
  return {
    text,
    usage: {
      promptTokenCount: u.promptTokenCount || 0,
      candidatesTokenCount: u.candidatesTokenCount || 0,
      totalTokenCount: u.totalTokenCount || 0,
    },
    finishReason: mapFinishReason(candidate?.finishReason),
  };
}

export async function completeText(opts: CompleteTextOpts): Promise<LlmResult> {
  const model = normalizeModelId(opts.model);
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.3;

  if (hasOpenRouter()) {
    const result = await openRouterChat({
      model,
      messages: [{ role: "user", content: opts.prompt }],
      max_tokens: maxTokens,
      temperature,
    });
    if (!result.text) throw new Error("Empty response from OpenRouter");
    return result;
  }

  const result = await geminiGenerate({
    model,
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  });
  if (!result.text) throw new Error("Empty response from Gemini");
  return result;
}

export async function completeVisual(opts: CompleteVisualOpts): Promise<LlmResult> {
  const model = normalizeModelId(opts.model);
  const maxTokens = opts.maxTokens ?? 32768;
  const thinking = opts.thinking || "low";
  const high = opts.mediaResolution === "high";

  if (hasOpenRouter()) {
    const body: Record<string, any> = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "video_url", video_url: { url: opts.youtubeUrl } },
          { type: "text", text: opts.prompt },
        ],
      }],
      max_tokens: maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "visual_assets",
          strict: false,
          schema: jsonSchemaToOpenAI(opts.schema),
        },
      },
      reasoning: { effort: thinking },
      // Vertex rejects YouTube URLs. Fail closed rather than silently routing there.
      provider: { only: ["Google AI Studio"], allow_fallbacks: false },
    };
    // OpenRouter validates Gemini enums: "high" 400s. Omit on default (provider default fps).
    if (high) body.media_resolution = "MEDIA_RESOLUTION_HIGH";
    return openRouterChat(body);
  }

  const mediaResolution = high ? "MEDIA_RESOLUTION_HIGH" : "MEDIA_RESOLUTION_DEFAULT";
  return geminiGenerate({
    model,
    contents: [{
      role: "user",
      parts: [
        { file_data: { file_uri: opts.youtubeUrl } },
        { text: opts.prompt },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: opts.schema,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingLevel: thinking },
      mediaResolution,
    },
  });
}

export function llmBackendName(): "openrouter" | "gemini" {
  if (hasOpenRouter()) return "openrouter";
  if (hasGemini()) return "gemini";
  throw new Error("OPENROUTER_API_KEY or GEMINI_API_KEY missing in .env");
}

