/**
 * Naver Papago N2MT provider.
 * Papago's public web endpoint is rate-limited and may require a
 * client-id header depending on region. We attempt the request and
 * fall through to the next provider on failure.
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, provider: string}>}
 */

const PAPAGO_LANGS = {
  ko: "ko", en: "en", ja: "ja", zh: "zh-CN", "zh-CN": "zh-CN", "zh-TW": "zh-TW",
  vi: "vi", th: "th", id: "id", es: "es", fr: "fr", de: "de", ru: "ru",
};

async function detect(text) {
  const res = await fetch("https://papago.naver.com/apis/langs/dect", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query: text }).toString(),
  });
  if (!res.ok) throw new Error(`papago: detect http ${res.status}`);
  const data = await res.json();
  return data?.langCode || null;
}

export async function papagoTranslate({ text, sl, tl }) {
  let source = sl;
  if (sl === "auto" || !sl) {
    const d = await detect(text);
    if (!d) throw new Error("papago: detect failed");
    source = d;
  }
  const target = PAPAGO_LANGS[tl] || tl;

  const res = await fetch("https://papago.naver.com/apis/n2mt/translate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ source, target, text }).toString(),
  });
  if (!res.ok) throw new Error(`papago: translate http ${res.status}`);
  const data = await res.json();
  const translatedText = data?.translatedText;
  if (!translatedText) throw new Error("papago: empty translation");
  return {
    translatedText,
    detectedSl: sl === "auto" ? source : null,
    provider: "papago",
  };
}
