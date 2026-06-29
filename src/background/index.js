/**
 * Background service worker.
 * Routes incoming messages from the content script to the multi-provider
 * translation pipeline. The race strategy resolves with the first
 * successful response; slow providers are dropped via per-request timeout.
 */

import { googleTranslate } from "./translators/google.js";
import { bingTranslate } from "./translators/bing.js";
import { papagoTranslate } from "./translators/papago.js";

const PROVIDERS = [
  { name: "google", fn: googleTranslate, timeout: 3000 },
  { name: "bing", fn: bingTranslate, timeout: 3000 },
  { name: "papago", fn: papagoTranslate, timeout: 3000 },
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

async function translateRace({ text, sl, tl }) {
  const tasks = PROVIDERS.map((p) =>
    withTimeout(p.fn({ text, sl, tl }), p.timeout, p.name).catch((err) => {
      return { __error: err.message || String(err) };
    })
  );
  const settled = await Promise.all(tasks);
  const success = settled.find((r) => r && !r.__error);
  if (success) return success;
  return { error: settled.map((r) => r.__error).join("; ") };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "translate") return false;

  translateRace(msg)
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ error: err?.message || String(err) })
    );
  return true; // keep channel open for async response
});
