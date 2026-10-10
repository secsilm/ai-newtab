import { MODEL_CHOICES, type ApiProvider, type ApiSettings, type HomepageModel } from "@homepage/agent-core";
import type { CSSProperties } from "react";

const field: CSSProperties = { width: "100%", boxSizing: "border-box", padding: 10, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", marginTop: 6 };
const label: CSSProperties = { display: "block", marginTop: 12, color: "#333", fontSize: 14 };

export function ApiConnectionFields({ value, onChange }: {
  value: ApiSettings;
  onChange: (next: ApiSettings) => void;
}) {
  function change<K extends keyof ApiSettings>(key: K, next: ApiSettings[K]) {
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
          <label style={label}>
            Model ID
            <input style={field} value={value.openaiModel} onChange={(e) => change("openaiModel", e.target.value)}
              placeholder="Exact model ID from your provider" />
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
