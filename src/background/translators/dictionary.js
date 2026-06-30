/**
 * Free Dictionary provider.
 * Uses https://api.dictionaryapi.dev (no key, no rate limit for
 * reasonable use). Returns phonetic, definitions grouped by
 * part of speech, and examples.
 *
 * English-only. The content script must short-circuit when the
 * target word is not ASCII (Vietnamese etc.) before calling
 * this provider.
 *
 * @param {{word: string}} params
 * @returns {Promise<{word: string, phonetic: string|null, entries: Array, provider: string}>}
 */
export async function dictionaryLookup({ word }) {
  const clean = (word || "").trim().toLowerCase();
  if (!clean) throw new Error("dictionary: empty word");
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    // 404 means "not found" for this word. Surface a clean error
    // so the content script can render "No definition".
    if (res.status === 404) {
      throw new Error("dictionary: 404");
    }
    throw new Error(`dictionary http ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("dictionary: empty response");
  }

  // Pick the first entry (Free Dictionary returns one item per
  // word; multiple only on rare redirects). Fold phonetics +
  // meanings into the shape the popup expects.
  const head = data[0];
  const wordText = (head && head.word) || clean;
  const phonetic = pickPhonetic(head.phonetics);
  const entries = (head.meanings || []).map((m) => ({
    partOfSpeech: m.partOfSpeech || "",
    definitions: (m.definitions || []).map((d) => ({
      text: d.definition || "",
      example: d.example || null,
    })),
  }));

  return { word: wordText, phonetic, entries, provider: "Free Dictionary" };
}

function pickPhonetic(phonetics) {
  if (!Array.isArray(phonetics)) return null;
  for (const p of phonetics) {
    if (p && typeof p.text === "string" && p.text.length > 0) return p.text;
  }
  return null;
}
