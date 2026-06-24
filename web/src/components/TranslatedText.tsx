"use client";

import { useState } from "react";

const LANG_NAMES: Record<string, string> = {
  en: "English",
  ar: "العربية",
  zh: "中文",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  ru: "Русский",
};

interface Props {
  translated: string;
  original: string | null;
  originalLang: string | null;
  as?: "p" | "span";
  style?: React.CSSProperties;
}

export default function TranslatedText({ translated, original, originalLang, as = "p", style }: Props) {
  const [showOriginal, setShowOriginal] = useState(false);

  if (!original) {
    const Tag = as;
    return <Tag style={style}>{translated}</Tag>;
  }

  const langName = LANG_NAMES[originalLang || ""] || (originalLang?.toUpperCase() || "original");

  return (
    <span>
      {showOriginal ? (
        <span>
          <span style={style}>{original}</span>
          <button
            onClick={() => setShowOriginal(false)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", border: "none",
              background: "none", padding: 0, margin: "4px 0 0", fontSize: 11.5, fontWeight: 600,
              color: "#8b2e1f", textDecoration: "underline", textUnderlineOffset: 2,
            }}
          >
            Tampilkan terjemahan Indonesia →
          </button>
        </span>
      ) : (
        <span>
          <span style={style}>{translated}</span>
          <button
            onClick={() => setShowOriginal(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", border: "none",
              background: "none", padding: 0, margin: "4px 0 0", fontSize: 11.5, fontWeight: 600,
              color: "#8b2e1f", textDecoration: "underline", textUnderlineOffset: 2,
            }}
          >
            Lihat teks asli ({langName}) →
          </button>
        </span>
      )}
    </span>
  );
}
