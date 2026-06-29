/**
 * Background service worker.
 * Routes incoming messages from the content script to the Google
 * Translate provider. Bing and Papago were removed: Bing's
 * ttranslatev3 endpoint stopped returning results in the user's
 * environment, and Papago's public n2mt endpoint returns 404.
 */

import { googleTranslate } from "./translators/google.js";

const PROVIDERS = [
  { name: "google", fn: googleTranslate, timeout: 3000 },
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
