/**
 * Papago (Naver) provider.
 * Replicates the original extension's function q(): language detect
 * via /apis/langs/dect followed by /apis/n2mt/translate. Auth uses
 * HMAC-MD5 (base64) over "uuid\nurl\ntimestamp" with the hashing key
 * v1.7.0_0d2601d5cf — the original's PapaCrypto.getHash, which is
 * createHmac("md5", key).update(msg).digest("base64"). SubtleCrypto
 * has no MD5, so a compact pure-JS MD5 is bundled (no dependencies).
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, detectedLang: string|null, provider: string}>}
 */

const HASHING_KEY = "v1.7.0_0d2601d5cf";
const C_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
const UA =
  "Mozilla/5.0 (Macintosh Intel Mac OS X 11_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.67 Safari/537.36";

// Papago lang map (var x={...} in background.js) and its inverse.
const PAPAGO_LANGS = {
  auto: "detect",
  ar: "ar",
  en: "en",
  fa: "fa",
  fr: "fr",
  de: "de",
  hi: "hi",
  id: "id",
  it: "it",
  ja: "ja",
  ko: "ko",
  my: "mm",
  pt: "pt",
  ru: "ru",
  es: "es",
  th: "th",
  vi: "vi",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
};

function invertMap(t) {
  const e = {};
  for (const r in t) e[t[r]] = r;
  return e;
}
const PAPAGO_LANGS_INV = invertMap(PAPAGO_LANGS);

// --- Minimal MD5 (RFC 1321) over a byte array. ---
function md5Block(bytes) {
  function rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }
  function addU(x, y) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function f(x, y, z) {
    return (x & y) | (~x & z);
  }
  function g(x, y, z) {
    return (x & z) | (y & ~z);
  }
  function h(x, y, z) {
    return x ^ y ^ z;
  }
  function i(x, y, z) {
    return y ^ (x | ~z);
  }
  function mix(fn, a, b, c, d, x, s, ac) {
    a = addU(a, addU(addU(fn(b, c, d), x), ac));
    return addU(rotl(a, s), b);
  }
  const bitLen = bytes.length * 8;
  const words = [];
  for (let n = 0; n < bytes.length; n++) {
    words[n >> 2] = words[n >> 2] || 0;
    words[n >> 2] |= bytes[n] << ((n % 4) << 3);
  }
  words[bytes.length >> 2] = words[bytes.length >> 2] || 0;
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) << 3);
  words[(((bytes.length + 8) >> 6) << 4) + 14] = bitLen;
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  for (let j = 0; j < words.length; j += 16) {
    const oa = a;
    const ob = b;
    const oc = c;
    const od = d;
    a = mix(f, a, b, c, d, words[j + 0] | 0, 7, 0xd76aa478);
    d = mix(f, d, a, b, c, words[j + 1] | 0, 12, 0xe8c7b756);
    c = mix(f, c, d, a, b, words[j + 2] | 0, 17, 0x242070db);
    b = mix(f, b, c, d, a, words[j + 3] | 0, 22, 0xc1bdceee);
    a = mix(f, a, b, c, d, words[j + 4] | 0, 7, 0xf57c0faf);
    d = mix(f, d, a, b, c, words[j + 5] | 0, 12, 0x4787c62a);
    c = mix(f, c, d, a, b, words[j + 6] | 0, 17, 0xa8304613);
    b = mix(f, b, c, d, a, words[j + 7] | 0, 22, 0xfd469501);
    a = mix(f, a, b, c, d, words[j + 8] | 0, 7, 0x698098d8);
    d = mix(f, d, a, b, c, words[j + 9] | 0, 12, 0x8b44f7af);
    c = mix(f, c, d, a, b, words[j + 10] | 0, 17, 0xffff5bb1);
    b = mix(f, b, c, d, a, words[j + 11] | 0, 22, 0x895cd7be);
    a = mix(f, a, b, c, d, words[j + 12] | 0, 7, 0x6b901122);
    d = mix(f, d, a, b, c, words[j + 13] | 0, 12, 0xfd987193);
    c = mix(f, c, d, a, b, words[j + 14] | 0, 17, 0xa679438e);
    b = mix(f, b, c, d, a, words[j + 15] | 0, 22, 0x49b40821);
    a = mix(g, a, b, c, d, words[j + 1] | 0, 5, 0xf61e2562);
    d = mix(g, d, a, b, c, words[j + 6] | 0, 9, 0xc040b340);
    c = mix(g, c, d, a, b, words[j + 11] | 0, 14, 0x265e5a51);
    b = mix(g, b, c, d, a, words[j + 0] | 0, 20, 0xe9b6c7aa);
    a = mix(g, a, b, c, d, words[j + 5] | 0, 5, 0xd62f105d);
    d = mix(g, d, a, b, c, words[j + 10] | 0, 9, 0x2441453);
    c = mix(g, c, d, a, b, words[j + 15] | 0, 14, 0xd8a1e681);
    b = mix(g, b, c, d, a, words[j + 4] | 0, 20, 0xe7d3fbc8);
    a = mix(g, a, b, c, d, words[j + 9] | 0, 5, 0x21e1cde6);
    d = mix(g, d, a, b, c, words[j + 14] | 0, 9, 0xc33707d6);
    c = mix(g, c, d, a, b, words[j + 3] | 0, 14, 0xf4d50d87);
    b = mix(g, b, c, d, a, words[j + 8] | 0, 20, 0x455a14ed);
    a = mix(g, a, b, c, d, words[j + 13] | 0, 5, 0xa9e3e905);
    d = mix(g, d, a, b, c, words[j + 2] | 0, 9, 0xfcefa3f8);
    c = mix(g, c, d, a, b, words[j + 7] | 0, 14, 0x676f02d9);
    b = mix(g, b, c, d, a, words[j + 12] | 0, 20, 0x8d2a4c8a);
    a = mix(h, a, b, c, d, words[j + 5] | 0, 4, 0xfffa3942);
    d = mix(h, d, a, b, c, words[j + 8] | 0, 11, 0x8771f681);
    c = mix(h, c, d, a, b, words[j + 11] | 0, 16, 0x6d9d6122);
    b = mix(h, b, c, d, a, words[j + 14] | 0, 23, 0xfde5380c);
    a = mix(h, a, b, c, d, words[j + 1] | 0, 4, 0xa4beea44);
    d = mix(h, d, a, b, c, words[j + 4] | 0, 11, 0x4bdecfa9);
    c = mix(h, c, d, a, b, words[j + 7] | 0, 16, 0xf6bb4b60);
    b = mix(h, b, c, d, a, words[j + 10] | 0, 23, 0xbebfbc70);
    a = mix(h, a, b, c, d, words[j + 13] | 0, 4, 0x289b7ec6);
    d = mix(h, d, a, b, c, words[j + 0] | 0, 11, 0xeaa127fa);
    c = mix(h, c, d, a, b, words[j + 3] | 0, 16, 0xd4ef3085);
    b = mix(h, b, c, d, a, words[j + 6] | 0, 23, 0x4881d05);
    a = mix(h, a, b, c, d, words[j + 9] | 0, 4, 0xd9d4d039);
    d = mix(h, d, a, b, c, words[j + 12] | 0, 11, 0xe6db99e5);
    c = mix(h, c, d, a, b, words[j + 15] | 0, 16, 0x1fa27cf8);
    b = mix(h, b, c, d, a, words[j + 2] | 0, 23, 0xc4ac5665);
    a = mix(i, a, b, c, d, words[j + 0] | 0, 6, 0xf4292244);
    d = mix(i, d, a, b, c, words[j + 7] | 0, 10, 0x432aff97);
    c = mix(i, c, d, a, b, words[j + 14] | 0, 15, 0xab9423a7);
    b = mix(i, b, c, d, a, words[j + 5] | 0, 21, 0xfc93a039);
    a = mix(i, a, b, c, d, words[j + 12] | 0, 6, 0x655b59c3);
    d = mix(i, d, a, b, c, words[j + 3] | 0, 10, 0x8f0ccc92);
    c = mix(i, c, d, a, b, words[j + 10] | 0, 15, 0xffeff47d);
    b = mix(i, b, c, d, a, words[j + 1] | 0, 21, 0x85845dd1);
    a = mix(i, a, b, c, d, words[j + 8] | 0, 6, 0x6fa87e4f);
    d = mix(i, d, a, b, c, words[j + 15] | 0, 10, 0xfe2ce6e0);
    c = mix(i, c, d, a, b, words[j + 6] | 0, 15, 0xa3014314);
    b = mix(i, b, c, d, a, words[j + 13] | 0, 21, 0x4e0811a1);
    a = mix(i, a, b, c, d, words[j + 4] | 0, 6, 0xf7537e82);
    d = mix(i, d, a, b, c, words[j + 11] | 0, 10, 0xbd3af235);
    c = mix(i, c, d, a, b, words[j + 2] | 0, 15, 0x2ad7d2bb);
    b = mix(i, b, c, d, a, words[j + 9] | 0, 21, 0xeb86d391);
    a = addU(a, oa);
    b = addU(b, ob);
    c = addU(c, oc);
    d = addU(d, od);
  }
  const out = [];
  for (const x of [a, b, c, d]) {
    for (let k = 0; k < 4; k++) out.push((x >>> (k * 8)) & 0xff);
  }
  return out;
}

function utf8ToBytes(s) {
  return Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// PapaCrypto.getHash: createHmac("md5", key).update(msg).digest("base64").
function getHash(msg, key) {
  let k = utf8ToBytes(key);
  if (k.length > 64) k = md5Block(k);
  while (k.length < 64) k.push(0);
  const opad = k.map((b) => b ^ 0x5c);
  const ipad = k.map((b) => b ^ 0x36);
  const inner = md5Block(ipad.concat(utf8ToBytes(msg)));
  return bytesToBase64(md5Block(opad.concat(inner)));
}

// PapaCrypto.toFormData: keys joined with "=" unencoded.
function toFormData(obj) {
  const parts = [];
  for (const r in obj) parts.push(r + "=" + obj[r]);
  return parts.join("&");
}

function newUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback v4 UUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function postForm(url, form, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) throw new Error(`papago http ${res.status}`);
  return res.json();
}

// LangDetector.getLangCode from the original.
async function detectLangCode(text) {
  const timestamp = Date.now();
  const uuid = newUuid();
  const url = "https://papago.naver.com/apis/langs/dect";
  const hash = getHash(uuid + "\n" + url + "\n" + timestamp, HASHING_KEY);
  const headers = {
    Authorization: "PPG " + uuid + ":" + hash,
    "Content-Type": C_TYPE,
    "User-Agent": UA,
    Timestamp: String(timestamp),
  };
  const data = await postForm(url, toFormData({ query: text }), headers);
  return data.langCode;
}

export async function papagoTranslate({ text, sl, tl }) {
  const source = PAPAGO_LANGS[sl || "auto"] || "detect";
  const target = PAPAGO_LANGS[tl] || tl;
  const timestamp = Date.now();
  const uuid = newUuid();
  const url = "https://papago.naver.com/apis/n2mt/translate";
  const hash = getHash(uuid + "\n" + url + "\n" + timestamp, HASHING_KEY);
  const auth = "PPG " + uuid + ":" + hash;

  let resolvedSource = source;
  if (resolvedSource === "detect") {
    resolvedSource = await detectLangCode(text);
  }
  const headers = {
    Authorization: auth,
    "Content-Type": C_TYPE,
    Timestamp: String(timestamp),
    "User-Agent": UA,
  };
  // Note the original's "authroization" typo in the form body.
  const form = toFormData({
    deviceId: uuid,
    locale: "ko",
    dict: true,
    dictDisplay: 30,
    honorific: false,
    instant: false,
    paging: false,
    source: resolvedSource,
    target,
    text,
    authroization: auth,
    timestamp,
  });
  // verbose=true in the original: full object returned.
  const data = await postForm(url, form, headers);
  if (!data || !data.translatedText) throw new Error("papago: empty response");
  const detected = PAPAGO_LANGS_INV[data.srcLangType] || null;
  return {
    translatedText: data.translatedText,
    detectedSl: detected,
    detectedLang: detected,
    provider: "Papago",
  };
}

