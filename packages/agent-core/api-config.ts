import { DEFAULT_MODEL, MODEL_CHOICES, type HomepageModel } from "./setup";

export type ApiProvider = "anthropic" | "openai-compatible";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Separate credentials/model selections survive switching providers. */
export interface ApiSettings {
  provider: ApiProvider;
  apiKey: string | null;
  model: HomepageModel;
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  openaiModel: string;
}

export const DEFAULT_API_SETTINGS: ApiSettings = {
  provider: "anthropic",
  apiKey: null,
  model: DEFAULT_MODEL,
  openaiApiKey: null,
  openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
  openaiModel: "",
};

export type ApiConfiguration =
  | { provider: "anthropic"; apiKey: string; model: HomepageModel }
  | { provider: "openai-compatible"; apiKey: string; baseUrl: string; model: string };

/** Accept a versioned API root or the complete chat-completions endpoint. */
export function normalizeOpenAIBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Base URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL must use HTTP or HTTPS without credentials, query parameters or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function getApiConfiguration(settings: ApiSettings): ApiConfiguration {
  if (settings.provider === "openai-compatible") {
    const apiKey = settings.openaiApiKey?.trim();
    if (!apiKey) throw new Error("Add an OpenAI-compatible API key in Settings.");
    const model = settings.openaiModel.trim();
    if (!model) throw new Error("Enter your provider's model ID in Settings.");
    return { provider: settings.provider, apiKey, model, baseUrl: normalizeOpenAIBaseUrl(settings.openaiBaseUrl) };
  }
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) throw new Error("No Anthropic API key found. Add your key and try again.");
  return {
    provider: "anthropic",
    apiKey,
    model: MODEL_CHOICES.find((m) => m.id === settings.model)?.id ?? DEFAULT_MODEL,
  };
}

export function hasApiConfiguration(settings: ApiSettings): boolean {
  try {
    getApiConfiguration(settings);
    return true;
  } catch {
    return false;
  }
}
