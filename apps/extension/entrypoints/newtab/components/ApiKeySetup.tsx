import { useState } from "react";
import { hasApiConfiguration, type ApiSettings } from "@homepage/agent-core";
import { ApiConnectionFields } from "./ApiConnectionFields";
import { btn } from "./ui";

export function ApiKeySetup({ initialSettings, onSave }: {
  initialSettings: ApiSettings;
  onSave: (settings: ApiSettings) => Promise<void>;
}) {
  const [value, setValue] = useState(initialSettings);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = hasApiConfiguration(value);

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your AI provider</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        Choose Anthropic or an OpenAI-compatible API to build your homepage.
      </p>
      <ApiConnectionFields value={value} onChange={setValue} />
      {error && <p role="alert" style={{ color: "#a02620" }}>{error}</p>}
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={async () => {
          setSaving(true);
          setError("");
          try { await onSave(value); }
          catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          finally { setSaving(false); }
        }}
      >
        {saving ? "Saving…" : "Save connection"}
      </button>
    </div>
  );
}
