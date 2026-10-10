export const OUTPUT_LANGUAGE_CHOICES = [
  { id: "auto", label: "Auto (follow source language)" },
  { id: "zh-CN", label: "简体中文 (Simplified Chinese)" },
  { id: "zh-TW", label: "繁體中文 (Traditional Chinese)" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語 (Japanese)" },
  { id: "ko", label: "한국어 (Korean)" },
  { id: "es", label: "Español (Spanish)" },
  { id: "fr", label: "Français (French)" },
  { id: "de", label: "Deutsch (German)" },
  { id: "pt", label: "Português (Portuguese)" },
  { id: "ru", label: "Русский (Russian)" },
  { id: "ar", label: "العربية (Arabic)" },
] as const;

export type OutputLanguage = typeof OUTPUT_LANGUAGE_CHOICES[number]["id"];

/** Existing installations and unknown saved values keep the automatic behavior. */
export function normalizeOutputLanguage(value: unknown): OutputLanguage {
  return OUTPUT_LANGUAGE_CHOICES.find((choice) => choice.id === value)?.id ?? "auto";
}
