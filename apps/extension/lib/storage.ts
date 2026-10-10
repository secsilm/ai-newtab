import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  type KVStore,
  DEFAULT_API_SETTINGS,
  getApiConfiguration,
  type ApiSettings,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  model: "model",
  provider: "apiProvider",
  openaiApiKey: "openaiApiKey",
  openaiBaseUrl: "openaiBaseUrl",
  openaiModel: "openaiModel",
  openaiApiFormat: "openaiApiFormat",
  /** Pins provider, endpoint, model and credentials while a build is in flight. */
  activeBuildConfig: "activeBuildConfig",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings extends ApiSettings {
  systemPrompt: string;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.model,
    KEYS.provider,
    KEYS.openaiApiKey,
    KEYS.openaiBaseUrl,
    KEYS.openaiModel,
    KEYS.openaiApiFormat,
    KEYS.autoRebuild,
    KEYS.rebuildIntervalHours,
  ]);
  const model = s[KEYS.model] as string | undefined;
  return {
    ...DEFAULT_API_SETTINGS,
    provider: s[KEYS.provider] === "openai-compatible" ? "openai-compatible" : "anthropic",
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    openaiApiKey: (s[KEYS.openaiApiKey] as string | undefined) ?? null,
    openaiBaseUrl: (s[KEYS.openaiBaseUrl] as string | undefined) ?? DEFAULT_API_SETTINGS.openaiBaseUrl,
    openaiModel: (s[KEYS.openaiModel] as string | undefined) ?? "",
    openaiApiFormat: s[KEYS.openaiApiFormat] === "responses" ? "responses" : s[KEYS.openaiApiFormat] === "chat-completions" ? "chat-completions" : "auto",
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

/** Write connection fields together so the worker never sees half a provider switch. */
export async function saveApiSettings(settings: ApiSettings): Promise<void> {
  const config = getApiConfiguration(settings);
  await browser.storage.local.set({
    [KEYS.provider]: settings.provider,
    [KEYS.apiKey]: settings.apiKey?.trim() || null,
    [KEYS.model]: settings.model,
    [KEYS.openaiApiKey]: settings.openaiApiKey?.trim() || null,
    [KEYS.openaiBaseUrl]: config.provider === "openai-compatible" ? config.baseUrl : settings.openaiBaseUrl,
    [KEYS.openaiModel]: settings.openaiModel.trim(),
    [KEYS.openaiApiFormat]: settings.openaiApiFormat ?? "auto",
  });
}

export async function saveSetting<K extends "apiKey" | "systemPrompt" | "model" | "autoRebuild" | "rebuildIntervalHours">(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}
