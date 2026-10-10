import { useState } from "react";
import { hasApiConfiguration, type ApiSettings } from "@homepage/agent-core";
import { ApiConnectionFields } from "./ApiConnectionFields";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  apiSettings,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  apiSettings: ApiSettings;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string, settings: ApiSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [connection, setConnection] = useState(apiSettings);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 120,
            boxSizing: "border-box",
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <div style={{ marginTop: 16 }}><ApiConnectionFields value={connection} onChange={setConnection} /></div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "24 hours (daily)" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once your homepage is this old, so
          your next tab shows a fresh one (uses your API key).
        </p>
        {error && <p role="alert" style={{ color: "#a02620" }}>{error}</p>}
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button disabled={saving || !hasApiConfiguration(connection)} onClick={async () => {
            setSaving(true);
            setError("");
            try { await onSave(draft, connection); }
            catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            finally { setSaving(false); }
          }} style={{ ...btn, opacity: hasApiConfiguration(connection) ? 1 : 0.5 }}>
            {saving ? "Saving…" : "Save & rebuild"}
          </button>
        </div>
      </div>
    </div>
  );
}
