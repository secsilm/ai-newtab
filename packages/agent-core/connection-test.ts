import { normalizeOpenAIBaseUrl, resolveOpenAIApiFormat, type OpenAIApiFormat } from "./api-config";
import { apiFailure, parseResponsesMessage } from "./openai-protocol";

export interface ConnectionTestInput {
  baseUrl: string;
  apiKey: string;
  model?: string;
  apiFormat?: OpenAIApiFormat;
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
    const signal = AbortSignal.timeout(60_000);
    const probeModel = async (models: string[]): Promise<ConnectionTestResult> => {
      const model = input.model?.trim();
      if (!model) return { ok: true, models, message: `Connected. Loaded ${models.length} models. Select a model and test again to verify tool calling.` };
      try {
        const protocol = resolveOpenAIApiFormat(model, input.apiFormat);
        const fn = { name: "connectionCheck", description: "Confirm API tool calling works.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } };
        const prompt = "Call connectionCheck once to test the connection. Do not reply with text.";
        const response = await transport(`${baseUrl}/${protocol === "responses" ? "responses" : "chat/completions"}`, {
          method: "POST", headers, signal, redirect: "error",
          body: JSON.stringify(protocol === "responses"
            ? { model, input: prompt, tools: [{ type: "function", ...fn, strict: false }], stream: false, store: false }
            : { model, messages: [{ role: "user", content: prompt }], tools: [{ type: "function", function: fn }], stream: false }),
        });
        if (!response.ok) throw await apiFailure(response, protocol);
        const body = await response.json();
        const message = protocol === "responses" ? parseResponsesMessage(body) : body.choices?.[0]?.message;
        if (body.error || !message?.tool_calls?.some((call: { id?: string; function?: { name?: string } }) => call.id && call.function?.name === "connectionCheck")) {
          throw new Error("Provider returned no test tool call. Choose another model or API protocol.");
        }
        return { ok: true, models, message: `Connected. ${protocol === "responses" ? "Responses" : "Chat Completions"} tool calling succeeded.${models.length ? ` Loaded ${models.length} models.` : " Model listing is unavailable; use a manual model ID."}` };
      } catch (error) { return { ok: false, models, message: safeError(error) }; }
    };
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
        return probeModel([]);
      }
      if (!response.ok) throw new Error(`Connection test failed (HTTP ${response.status}). Check your Base URL, API key and provider permissions.`);
      const body = await response.json();
      if (body.error || !Array.isArray(body.data) || body.data.some((m: unknown) =>
        !m || typeof m !== "object" || !("id" in m) || typeof m.id !== "string" || !m.id.trim())) {
        throw new Error("Provider returned an invalid model list. You can still enter a model ID manually.");
      }
      for (const model of body.data) models.add(model.id);
      if (body.has_more !== true) {
        if (!models.size && !input.model?.trim()) return { ok: true, models: [], message: "Connected, but the model list is empty. Enter a model ID manually." };
        return probeModel([...models].sort());
      }
      const next = body.last_id ?? body.data.at(-1)?.id;
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Could not retrieve the complete model list. Enter a model ID manually.");
      cursors.add(next);
      cursor = next;
    }
    throw new Error("Model list pagination exceeded the test limit. Enter a model ID manually.");
  } catch (error) {
    return { ok: false, models: [], message: safeError(error) };
  }
}

function safeError(error: unknown): string {
  const safeMessages = /^(Base URL must|Enter an API key|OpenAI-compatible API returned|Connection test failed|Provider returned|Responses API|Invalid Responses API|The provider declined|Could not retrieve|Model list pagination)/;
  return error instanceof Error && safeMessages.test(error.message)
    ? error.message : "Connection test failed or timed out. Check the address and network, then try again.";
}
