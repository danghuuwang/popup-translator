/**
 * Bing Microsoft Translator provider.
 * Bing's ttranslatev3 endpoint requires a short-lived token + IG key
 * obtained from a GET to the same URL. We cache the credentials for
 * 5 minutes to reduce overhead.
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, provider: string}>}
 */

let cachedCreds = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

async function getCreds() {
  const now = Date.now();
  if (cachedCreds && now - cachedAt < CACHE_MS) return cachedCreds;

  const res = await fetch("https://www.bing.com/ttranslatev3", {
    method: "GET",
    credentials: "include",
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`bing: token fetch http ${res.status}`);
  const html = await res.text();
  const igMatch = html.match(/IG:"([^"]+)"/);
  const keyMatch = html.match(/data-iid="([^"]+)"/) || html.match(/iid:"([^"]+)"/);
  if (!igMatch || !keyMatch) throw new Error("bing: failed to extract credentials");
  cachedCreds = { IG: igMatch[1], IID: keyMatch[1] };
  cachedAt = now;
  return cachedCreds;
}

export async function bingTranslate({ text, sl, tl }) {
  const { IG, IID } = await getCreds();
  const body = new URLSearchParams({
    text,
    fromLang: sl === "auto" ? "auto-detect" : sl,
    to: tl,
  });
  const res = await fetch(
    `https://www.bing.com/ttranslatev3?IG=${encodeURIComponent(IG)}&IID=${encodeURIComponent(IID)}`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: body.toString(),
    }
  );
  if (!res.ok) throw new Error(`bing: translate http ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data[0] || !Array.isArray(data[0].translations)) {
    throw new Error("bing: invalid response");
  }
  const translatedText = data[0].translations[0]?.text;
  if (!translatedText) throw new Error("bing: empty translation");
  const detectedSl = data[0].detectedLanguage?.language || null;
  return { translatedText, detectedSl, provider: "bing" };
}
