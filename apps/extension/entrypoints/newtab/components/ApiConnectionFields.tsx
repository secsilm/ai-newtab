import { MODEL_CHOICES, normalizeOpenAIBaseUrl, type ConnectionTestResult, type ApiProvider, type ApiSettings, type HomepageModel } from "@homepage/agent-core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ConnectionTestMessage } from "@/lib/protocol";
import { btn } from "./ui";

const field: CSSProperties = { width: "100%", boxSizing: "border-box", padding: 10, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", marginTop: 6 };
const label: CSSProperties = { display: "block", marginTop: 12, color: "#333", fontSize: 14 };

export function ApiConnectionFields({ value, onChange }: {
  value: ApiSettings;
  onChange: (next: ApiSettings) => void;
}) {
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [manual, setManual] = useState(false);
  const requestId = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    requestId.current++;
    setResult(null);
    setTesting(false);
    setManual(false);
    return () => { requestId.current++; };
  }, [value.provider, value.openaiBaseUrl, value.openaiApiKey]);

  const models = result?.models ?? [];
  const showManual = manual || !models.includes(value.openaiModel);
  let canTest = Boolean(value.openaiApiKey?.trim());
  try { normalizeOpenAIBaseUrl(value.openaiBaseUrl); } catch { canTest = false; }

  async function testConnection() {
    const id = ++requestId.current;
    const settings = value;
    setTesting(true);
    setResult(null);
    try {
      const reply: ConnectionTestResult = await browser.runtime.sendMessage({
        kind: "testApiConnection", baseUrl: settings.openaiBaseUrl,
        apiKey: settings.openaiApiKey ?? "", model: settings.openaiModel,
      } satisfies ConnectionTestMessage);
      if (id === requestId.current && latest.current.provider === settings.provider &&
        latest.current.openaiBaseUrl === settings.openaiBaseUrl && latest.current.openaiApiKey === settings.openaiApiKey &&
        (reply?.models.length || latest.current.openaiModel === settings.openaiModel)) {
        setResult(reply ?? { ok: false, models: [], message: "Connection test could not reach the extension worker. Try again." });
      }
    } catch {
      if (id === requestId.current) setResult({ ok: false, models: [], message: "Connection test failed. Try again." });
    } finally {
      if (id === requestId.current) setTesting(false);
    }
  }

  function change<K extends keyof ApiSettings>(key: K, next: ApiSettings[K]) {
    if (key === "openaiModel" && result && !result.models.length) setResult(null);
    onChange({ ...value, [key]: next });
  }
  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, color: "#333" }}>API connection</legend>
      <label style={label}>
        Provider
        <select style={field} value={value.provider} onChange={(e) => change("provider", e.target.value as ApiProvider)}>
          <option value="anthropic">Anthropic (Claude Managed Agents)</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
      </label>
      {value.provider === "anthropic" ? (
        <>
          <label style={label}>
            Anthropic API key
            <input style={field} type="password" autoComplete="off" value={value.apiKey ?? ""}
              onChange={(e) => change("apiKey", e.target.value)} placeholder="sk-ant-..." />
          </label>
          <label style={label}>
            Model
            <select style={field} value={value.model} onChange={(e) => change("model", e.target.value as HomepageModel)}>
              {MODEL_CHOICES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </>
      ) : (
        <>
          <label style={label}>
            Base URL
            <input style={field} type="url" value={value.openaiBaseUrl}
              onChange={(e) => change("openaiBaseUrl", e.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label style={label}>
            API key
            <input style={field} type="password" autoComplete="off" value={value.openaiApiKey ?? ""}
              onChange={(e) => change("openaiApiKey", e.target.value)} placeholder="Your provider's API key" />
          </label>
          <button type="button" style={{ ...btn, marginTop: 12, opacity: canTest ? 1 : 0.5 }}
            disabled={!canTest || testing} onClick={testConnection}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          {result && <p role="status" aria-live="polite" style={{ fontSize: 13, lineHeight: 1.5, color: result.ok ? "#087443" : "#a02620" }}>
            {result.message}
          </p>}
          <label style={label}>
            Model ID
            {models.length > 0 && <select aria-label="Available models" style={field}
              value={showManual ? "" : value.openaiModel} onChange={(e) => {
                setManual(!e.target.value);
                if (e.target.value) change("openaiModel", e.target.value);
              }}>
              <option value="">Enter a model ID manually</option>
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>}
            {(models.length === 0 || showManual) && <input style={field} value={value.openaiModel}
              onChange={(e) => change("openaiModel", e.target.value)} placeholder="Exact model ID from your provider" />}
          </label>
          <p style={{ color: "#666", fontSize: 12, lineHeight: 1.5 }}>
            Use the API root including its version path (for example /v1), or the full /chat/completions URL.
            The model must support Chat Completions function calling. For local services without authentication,
            enter a placeholder key such as local.
          </p>
        </>
      )}
      <p style={{ color: "#666", fontSize: 12, lineHeight: 1.5 }}>
        Your browsing digest and page content are sent to the selected provider. Keys are stored locally
        in this browser profile and sent to that provider with API requests.
      </p>
    </fieldset>
  );
}
