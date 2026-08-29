export type UserLanguage = "zh" | "en";

export function normalizeUserLanguage(value: unknown): UserLanguage | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["zh", "zh-cn", "zh_hans", "zh-hans", "chinese", "中文", "简体中文"].includes(normalized)) {
    return "zh";
  }
  if (["en", "en-us", "en-gb", "english", "英文", "英语"].includes(normalized)) {
    return "en";
  }
  return null;
}

export function detectUserLanguage(text: string): UserLanguage | null {
  const visible = text.replace(/\s+/g, "");
  if (visible.length < 2) return null;

  const cjk = [...visible].filter((ch) => /[\u3400-\u9fff]/u.test(ch)).length;
  const latin = [...visible].filter((ch) => /[A-Za-z]/u.test(ch)).length;

  if (cjk >= 2 && cjk >= Math.max(2, latin * 0.25)) return "zh";
  if (latin >= 12 && cjk === 0) return "en";
  return null;
}

export function languageDisplayName(language: UserLanguage | null | undefined): string {
  switch (language) {
    case "zh":
      return "Simplified Chinese";
    case "en":
      return "English";
    default:
      return "Simplified Chinese";
  }
}

export function languageProfileEvidence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length >= 4) return trimmed.slice(0, 120);
  return "";
}
