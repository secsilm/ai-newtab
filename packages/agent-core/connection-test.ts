import { normalizeOpenAIBaseUrl } from "./api-config";

export interface ConnectionTestInput {
  baseUrl: string;
  apiKey: string;
  model?: string;
}
export interface ConnectionTestResult {
  ok: boolean;
  models: string[];
  message: string;
}

/** Only synthetic requests: never sends browsing history or saves credentials. */
export async function testOpenAIConnection(
  input: ConnectionTestInput,
  transport: typeof fetch = fetch,
): Promise<ConnectionTestResult> {
  try {
    const baseUrl = normalizeOpenAIBaseUrl(input.baseUrl);
    const key = input.apiKey.trim();
    if (!key) throw new Error("Enter an API key first.");
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const signal = AbortSignal.timeout(20_000);
    const models = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${baseUrl}/models`);
      if (cursor) url.searchParams.set("after", cursor);
      const response = await transport(url.toString(), { headers, signal, redirect: "error" });
      if ([404, 405, 501].includes(response.status) && page === 0) {
        if (!input.model?.trim()) {
          return { ok: false, models: [], message: "This provider does not offer a model list. Enter a model ID manually and test again." };
        }
        const completion = await transport(`${baseUrl}/chat/completions`, {
          method: "POST", headers, signal, redirect: "error",
          body: JSON.stringify({ model: input.model.trim(), messages: [{ role: "user", content: "Reply with OK." }], stream: false }),
        });
        if (!completion.ok) throw new Error(`Model request failed (HTTP ${completion.status}). Check your key, model and Base URL.`);
        const body = await completion.json();
        if (body.error || !Array.isArray(body.choices) || !body.choices.length || typeof body.choices[0]?.message?.content !== "string") {
          throw new Error("Provider returned an invalid Chat Completions response.");
        }
        return { ok: true, models: [], message: "Model request succeeded. Model listing is unavailable; keep using a manual model ID. Tool calling has not been tested." };
      }
      if (!response.ok) throw new Error(`Connection test failed (HTTP ${response.status}). Check your Base URL, API key and provider permissions.`);
      const body = await response.json();
      if (body.error || !Array.isArray(body.data) || body.data.some((m: unknown) =>
        !m || typeof m !== "object" || !("id" in m) || typeof m.id !== "string" || !m.id.trim())) {
        throw new Error("Provider returned an invalid model list. You can still enter a model ID manually.");
      }
      for (const model of body.data) models.add(model.id);
      if (body.has_more !== true) {
        return {
          ok: true, models: [...models].sort(),
          message: models.size
            ? `Connected. Loaded ${models.size} models. Model generation and tool calling have not been tested.`
            : "Connected, but the model list is empty. Enter a model ID manually.",
        };
      }
      const next = body.last_id ?? body.data.at(-1)?.id;
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Could not retrieve the complete model list. Enter a model ID manually.");
      cursors.add(next);
      cursor = next;
    }
    throw new Error("Model list pagination exceeded the test limit. Enter a model ID manually.");
  } catch (error) {
    // Never surface network exceptions/provider bodies that may echo secrets.
    const safeMessages = /^(Base URL must|Enter an API key|Model request failed|Connection test failed|Provider returned|Could not retrieve|Model list pagination)/;
    return {
      ok: false, models: [],
      message: error instanceof Error && safeMessages.test(error.message)
        ? error.message : "Connection test failed or timed out. Check the address and network, then try again.",
    };
  }
}
