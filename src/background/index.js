/**
 * Background service worker.
 * Routes incoming messages from the content script. Two message
 * types are supported:
 *
 *   - {type: "translate", text, sl}   run Google and reply with
 *                                      the translation. The target
 *                                      language is hard-coded in
 *                                      the content script to vi.
 *
 *   - {type: "lookup", word}          look up an English word in
 *                                      the Free Dictionary API and
 *                                      reply with the entries.
 */

import { googleTranslate } from "./translators/google.js";
import { dictionaryLookup } from "./translators/dictionary.js";

const TRANSLATE_PROVIDERS = [
  { name: "google", fn: googleTranslate, timeout: 3000 },
];

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

async function raceProviders(msg, providers) {
  const tasks = providers.map((p) =>
    withTimeout(p.fn(msg), p.timeout, p.name).catch((err) => ({
      __error: err.message || String(err),
    }))
  );
  const settled = await Promise.all(tasks);
  const success = settled.find((r) => r && !r.__error);
  if (success) return success;
  return { error: settled.map((r) => r.__error).join("; ") };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "translate") {
    raceProviders({ text: msg.text, sl: msg.sl, tl: "vi" }, TRANSLATE_PROVIDERS)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ error: err?.message || String(err) })
      );
    return true;
  }

  if (msg.type === "lookup") {
    raceProviders({ word: msg.word }, LOOKUP_PROVIDERS)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ error: err?.message || String(err) })
      );
    return true;
  }

  return false;
});
