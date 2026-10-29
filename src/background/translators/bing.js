/**
 * Bing Translator provider.
 * Replicates the original extension's function S(t,e,r): fetches a
 * token from https://www.bing.com/translator (parsed out of the page
 * HTML), then POSTs to ttranslatev3. Token state is cached in module
 * scope like the original's `_` variable.
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, detectedLang: string|null, provider: string}>}
 */

// Lang map from the original (var v={...} in background.js).
const BING_LANGS = {
  auto: "auto-detect",
  af: "af",
  am: "am",
  ar: "ar",
  az: "az",
  bg: "bg",
  bs: "bs",
  ca: "ca",
  cs: "cs",
  cy: "cy",
  da: "da",
  de: "de",
  el: "el",
  en: "en",
  es: "es",
  et: "et",
  fa: "fa",
  fi: "fi",
  fr: "fr",
  ga: "ga",
  gu: "gu",
  hi: "hi",
  hmn: "mww",
  hr: "hr",
  ht: "ht",
  hu: "hu",
  hy: "hy",
  id: "id",
  is: "is",
  it: "it",
  iw: "he",
  ja: "ja",
  kk: "kk",
  km: "km",
  kn: "kn",
  ko: "ko",
  ku: "ku",
  lo: "lo",
  lt: "lt",
  lv: "lv",
  mg: "mg",
  mi: "mi",
  ml: "ml",
  mr: "mr",
  ms: "ms",
  mt: "mt",
  my: "my",
  ne: "ne",
  nl: "nl",
  no: "nb",
  pa: "pa",
  pl: "pl",
  ps: "ps",
  pt: "pt",
  ro: "ro",
  ru: "ru",
  sk: "sk",
  sl: "sl",
  sm: "sm",
  sq: "sq",
  sr: "sr-Cyrl",
  sv: "sv",
  sw: "sw",
  ta: "ta",
  te: "te",
  th: "th",
  tl: "fil",
  tr: "tr",
  uk: "uk",
  ur: "ur",
  vi: "vi",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

// Inverse map (M(v) in the original).
function invertMap(t) {
  const e = {};
  for (const r in t) e[t[r]] = r;
  return e;
}
const BING_LANGS_INV = invertMap(BING_LANGS);

// Cached token state (the original's `_`).
let tokenCache;

async function fetchBingToken() {
  try {
    if (
      !tokenCache ||
      Date.now() - tokenCache.tokenTs > tokenCache.tokenExpiryInterval
    ) {
      const html = await fetch("https://www.bing.com/translator").then((t) =>
        t.text()
      );
      const ig = html.match(/IG:"([^"]+)"/)[1];
      const iid = html.match(/data-iid="([^"]+)"/)[1];
      // params_AbusePreventionHelper = [key, token, expiryInterval]
      const [key, token, expiry] = JSON.parse(
        html.match(/params_AbusePreventionHelper\s?=\s?([^\]]+\])/)[1]
      );
      // Note: the original stores tokenTs as the key string, which
      // makes the expiry check always false (NaN comparison), so the
      // token is effectively cached forever. We store Date.now()
      // instead so expiry actually works.
      tokenCache = {
        IG: ig,
        IID: iid,
        key,
        token,
        tokenTs: Date.now(),
        tokenExpiryInterval: expiry,
        isAuthv2: undefined,
        count: 0,
      };
    }
    return tokenCache;
  } catch (err) {
    console.log(err);
    return tokenCache;
  }
}

export async function bingTranslate({ text, sl, tl }) {
  const { token, key, IG, IID } = await fetchBingToken();
  const body = {
    text,
    fromLang: BING_LANGS[sl] || BING_LANGS.auto,
    to: BING_LANGS[tl] || tl,
    token,
    key,
    IG,
    IID: IID && IID.length ? IID + "." + tokenCache.count++ : "",
  };
  // The original appends the params to the URL and POSTs with no
  // body; replicate that exactly.
  const res = await fetch(
    "https://www.bing.com/ttranslatev3?isVertical=1&&" +
      new URLSearchParams(body),
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`bing http ${res.status}`);
  const data = await res.json().catch((err) => console.log(err));
  if (data && data[0]) {
    const detected = BING_LANGS_INV[data[0].detectedLanguage.language];
    return {
      translatedText: data[0].translations[0].text,
      detectedSl: detected || null,
      detectedLang: detected || null,
      provider: "Bing",
    };
  }
  throw new Error("bing: empty response");
}
