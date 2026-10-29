/**
 * Google Translate provider.
 * Replicates the original extension's function A(t,e,r): a GET to
 * https://translate.googleapis.com/translate_a/t with client=te_lib
 * and a tk token computed by the classic token algorithm
 * (key 448487.932609646). The response HTML is entity-decoded and
 * the inner <b>...</b> segments are joined as the translation.
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, detectedLang: string|null, provider: string}>}
 */

// Shift/xor mixer from the original (function k).
function tkMixer(t, e) {
  for (let r = 0; r < e.length - 2; r += 3) {
    let i = e.charAt(r + 2);
    i = "a" <= i ? i.charCodeAt(0) - 87 : Number(i);
    i = "+" === e.charAt(r + 1) ? t >>> i : t << i;
    if ("+" === e.charAt(r)) {
      t += 4294967295 & i;
    } else {
      t ^= i;
    }
  }
  return t;
}

// UTF-8 byte encoding of the query, as in the original.
function utf8Bytes(t) {
  const e = [];
  let r = 0;
  for (let i = 0; i < t.length; i++) {
    let n = t.charCodeAt(i);
    if (128 > n) {
      e[r++] = n;
    } else {
      if (2048 > n) {
        e[r++] = (n >> 6) | 192;
      } else if (
        55296 === (64512 & n) &&
        i + 1 < t.length &&
        56320 === (64512 & t.charCodeAt(i + 1))
      ) {
        n = 65536 + ((1023 & n) << 10) + (1023 & t.charCodeAt(++i));
        e[r++] = (n >> 18) | 240;
        e[r++] = ((n >> 12) & 63) | 128;
      } else {
        e[r++] = (n >> 12) | 224;
      }
      e[r++] = ((n >> 6) & 63) | 128;
      e[r++] = (63 & n) | 128;
    }
  }
  return e;
}

// Token generator: tk(query) with key 448487.932609646.
function tkToken(t) {
  const parts = "448487.932609646".split(".");
  const hi = Number(parts[0]) || 0;
  const lo = Number(parts[1]) || 0;
  const bytes = utf8Bytes(t);
  let a = hi;
  for (let i = 0; i < bytes.length; i++) {
    a += bytes[i];
    a = tkMixer(a, "+-a^+6");
  }
  a = tkMixer(a, "+-3^+b+-f");
  a ^= lo;
  if (a <= 0) a = 2147483648 + (2147483647 & a);
  const s = a % 1e6;
  return s.toString() + "." + (s ^ hi);
}

// Minimal HTML-entity decoder (replaces the original g.decode from
// the entities bundle). Handles numeric refs and common named refs.
function decodeEntities(s) {
  if (typeof s !== "string") return s;
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isNaN(code)) {
        try {
          return String.fromCodePoint(code);
        } catch (_e) {
          return m;
        }
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(named, body) ? named[body] : m;
  });
}

export async function googleTranslate({ text, sl, tl }) {
  const src = sl || "auto";
  const params = {
    client: "te_lib",
    sl: src,
    tl,
    hl: tl,
    anno: 3,
    format: "html",
    v: 1,
    tc: 1,
    sr: 1,
    mode: 1,
    q: text,
    tk: tkToken(text),
  };
  const res = await fetch(
    "https://translate.googleapis.com/translate_a/t?" +
      new URLSearchParams(params),
    { method: "GET" }
  );
  if (!res.ok) throw new Error(`google http ${res.status}`);
  const data = await res.json();
  if (!(data && data[0] && data[0][0])) throw new Error("google: empty response");

  let raw;
  let detected;
  if ("auto" === src) {
    raw = data[0][0];
    detected = data[0][1];
  } else {
    raw = data[0];
    detected = src;
  }
  // te_lib returns per-segment arrays; fold to a string first.
  if (Array.isArray(raw)) {
    raw = raw
      .map((seg) => (Array.isArray(seg) ? seg[0] : seg))
      .filter((x) => typeof x === "string")
      .join(" ");
  }
  let out = decodeEntities(raw);
  const hits = typeof out === "string" ? out.match(/(?<=<b>).+?(?=<\/b>)/g) : null;
  if (hits && hits[0]) out = hits.join(" ");
  if (!out) throw new Error("google: empty translation");
  return {
    translatedText: out,
    detectedSl: detected || null,
    detectedLang: detected || null,
    provider: "Google",
  };
}
