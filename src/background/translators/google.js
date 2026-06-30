/**
 * Google Translate provider.
 * Uses the free public endpoint translate_a/single (client=gtx),
 * which does not require an API key or token. Falls back to client=dict
 * if gtx is unavailable.
 *
 * @param {{text: string, sl: string, tl: string}} params
 * @returns {Promise<{translatedText: string, detectedSl: string|null, provider: string}>}
 */
export async function googleTranslate({ text, sl, tl }) {
  const buildUrl = (client) => {
    const u = new URL("https://translate.googleapis.com/translate_a/single");
    u.searchParams.set("client", client);
    u.searchParams.set("sl", sl || "auto");
    u.searchParams.set("tl", tl);
    u.searchParams.set("dt", "t");
    u.searchParams.set("q", text);
    return u.toString();
  };

  const tryParse = (data, client) => {
    if (client === "gtx") {
      // Response: [[[translated, original, null, null, 10], ...], null, detectedSl]
      if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new Error("google: invalid gtx response");
      }
      const translated = data[0]
        .map((seg) => (Array.isArray(seg) ? seg[0] : ""))
        .filter(Boolean)
        .join("");
      const detectedSl =
        typeof data[2] === "string" && data[2].length > 0 ? data[2] : null;
      if (!translated) throw new Error("google: empty gtx translation");
      return { translatedText: translated, detectedSl };
    }
    // client=dict shape: [[[src, dst, ...], ...], null, detectedSl, ...].
    // The slot at data[2] is the detected source language, same
    // convention as the gtx client. Parse it so callers can
    // detect same-language hits (e.g. target=vi and detected=vi).
    if (Array.isArray(data) && data[0]) {
      const translated = data[0]
        .map((row) => (Array.isArray(row) ? row[1] ?? row[0] : ""))
        .filter(Boolean)
        .join("");
      if (!translated) throw new Error("google: empty dict translation");
      const detectedSl =
        typeof data[2] === "string" && data[2].length > 0 ? data[2] : null;
      return { translatedText: translated, detectedSl };
    }
    throw new Error("google: invalid dict response");
  };

  for (const client of ["gtx", "dict"]) {
    try {
      const res = await fetch(buildUrl(client), { method: "GET" });
      if (!res.ok) throw new Error(`google http ${res.status}`);
      const data = await res.json();
      return { ...tryParse(data, client), provider: "Google" };
    } catch (err) {
      // try next client
      if (client === "dict") throw err;
    }
  }
  throw new Error("google: all clients failed");
}
