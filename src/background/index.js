/**
 * Background service worker.
 * Routes messages from the content script. Message types:
 *
 *   - {type: "translate", ...}  translate a word/phrase with the
 *                                vendor selected in settings
 *                                (translatorVendor: google/bing/papago).
 *                                Accepts both the original keys
 *                                (word, translateTarget) and the
 *                                compat keys (text, sl, tl).
 *                                Target/source languages resolve to
 *                                stored settings (translateSource
 *                                defaults to "auto").
 *
 *   - {type: "lookup", word}    look up an English word in
 *                                the Free Dictionary API.
 */

import { googleTranslate } from "./translators/google.js";
import { bingTranslate } from "./translators/bing.js";
import { papagoTranslate } from "./translators/papago.js";
import { dictionaryLookup } from "./translators/dictionary.js";

const LOOKUP_PROVIDERS = [
  { name: "dictionary", fn: dictionaryLookup, timeout: 4000 },
];

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: timeout`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(
        { translateSource: "auto", sl: "auto", translatorVendor: "google" },
        (items) => resolve(items || {})
      );
    } catch (_e) {
      resolve({});
    }
  });
}

function pickVendor(name) {
  if (name === "bing") return { fn: bingTranslate, label: "bing" };
  if (name === "papago") return { fn: papagoTranslate, label: "papago" };
  return { fn: googleTranslate, label: "google" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "translate") {
    (async () => {
      // Support both original keys (word/translateTarget) and
      // compat keys (text/sl/tl).
      const text = msg.word ?? msg.text ?? "";
      const settings = await getSettings();
      const tl = msg.translateTarget ?? msg.tl ?? "vi";
      const sl = msg.sl ?? settings.sl ?? settings.translateSource ?? "auto";
      const vendorName = msg.vendor ?? settings.translatorVendor ?? "google";
      const { fn, label } = pickVendor(vendorName);
      try {
        const result = await withTimeout(
          fn({ text, sl, tl }),
          5000,
          label
        );
        sendResponse({
          translatedText: result.translatedText,
          detectedSl: result.detectedSl ?? result.detectedLang ?? null,
          detectedLang: result.detectedLang ?? result.detectedSl ?? null,
          sourceLang: result.detectedSl ?? result.detectedLang ?? sl,
          targetLang: tl,
          provider: result.provider,
        });
      } catch (err) {
        sendResponse({ error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "lookup") {
    (async () => {
      const tasks = LOOKUP_PROVIDERS.map((p) =>
        withTimeout(p.fn({ word: msg.word }), p.timeout, p.name).catch(
          (err) => ({ __error: err.message || String(err) })
        )
      );
      const settled = await Promise.all(tasks);
      const success = settled.find((r) => r && !r.__error);
      sendResponse(
        success || { error: settled.map((r) => r.__error).join("; ") }
      );
    })();
    return true;
  }

  return false;
});
