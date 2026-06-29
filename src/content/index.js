/**
 * Content script — hover any text to translate.
 *
 * Positioning model (mirrors the reference extension Từ điển ENVI):
 *   The popup is a single fixed-positioned div, updated on every
 *   mousemove via requestAnimationFrame. We compute (x, y) so that
 *   the popup sits *directly above* the cursor (no horizontal
 *   offset) and *horizontally centered* on the cursor's X. The
 *   popup's natural size is cached; we only re-measure when content
 *   changes. On regular mousemoves we update the transform in place,
 *   so the popup glides smoothly with no flicker.
 *
 * Text pickup (mirrors the reference extension):
 *   1. document.caretRangeFromPoint(x, y) anchors a Range at the
 *      caret under the cursor.
 *   2. If the start container is not a text node, abort.
 *   3. We do NOT call Range.expand("sentence"): that's Gecko-only
 *      and Chrome throws on it. Instead we enumerate the text
 *      node's clientRects, find the visual line that vertically
 *      contains the cursor's Y, take that line's text, then split
 *      on sentence terminators to deliver sentence-level
 *      granularity.
 */

import "./popup.css";

const POLL_MS = 200;
const DEBOUNCE_MS = 220;
const HOVER_DELAY_MS = 500;
const MIN_TEXT_LEN = 2;
const MAX_TEXT_LEN = 500;
const POPUP_OFFSET_Y = 12;
const POPUP_GUTTER = 8;
const POPUP_ID = "__pt_popup_root__";

/** @type {{sl: string, tl: string, hoverEnabled: boolean, theme: 'light'|'dark'|'system'}} */
let settings = {
  sl: "auto",
  tl: "vi",
  hoverEnabled: true,
  theme: "system",
};

let lastX = 0;
let lastY = 0;
let lastText = "";
let debounceTimer = null;
let hoverTimer = null;
let inFlight = 0;
let pendingPos = null;
let rafId = 0;
/** Cached size of the popup. */
let popupW = 320;
let popupH = 60;

console.log("[Popup Translator] content script loaded");

function getPopup() {
  let root = document.getElementById(POPUP_ID);
  if (root) return root;

  root = document.createElement("div");
  root.id = POPUP_ID;
  root.className = "pt-popup";
  root.setAttribute("role", "tooltip");
  root.setAttribute("aria-hidden", "true");

  const trans = document.createElement("div");
  trans.className = "pt-popup__trans";
  root.appendChild(trans);

  const provider = document.createElement("span");
  provider.className = "pt-popup__provider";
  root.appendChild(provider);

  (document.body || document.documentElement).appendChild(root);
  return root;
}

function readPopupSize() {
  const el = getPopup();
  popupW = el.offsetWidth || popupW || 320;
  popupH = el.offsetHeight || popupH || 60;
}

function showPopup() {
  const el = getPopup();
  el.classList.add("pt-popup--visible");
  el.setAttribute("aria-hidden", "false");
}

function hidePopup() {
  const el = document.getElementById(POPUP_ID);
  if (!el) return;
  el.classList.remove("pt-popup--visible");
  el.setAttribute("aria-hidden", "true");
}

function applyTheme() {
  const el = getPopup();
  let effective = settings.theme;
  if (!effective || effective === "system") {
    effective =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  el.classList.toggle("pt-popup--dark", effective === "dark");
}

// React to system theme changes when the user picked "system".
if (window.matchMedia) {
  try {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (!settings.theme || settings.theme === "system") applyTheme();
      });
  } catch (e) {
    // older browsers: ignore
  }
}

/**
 * Pick the sentence under (x, y). Returns "" if the cursor is not
 * over a text node.
 *
 * Strategy (matches the reference extension):
 *   1. document.caretRangeFromPoint anchors a Range at the caret.
 *   2. If startContainer is not a text node, abort.
 *   3. Try r.expand("sentence"). This is a Gecko-standard API that
 *      Chrome ≥ 109 also supports. It extends the Range to the
 *      nearest sentence boundaries, which is exactly what the
 *      reference extension does. If the browser doesn't support
 *      it (or throws), fall through to the rect-based splitter.
 *   4. Validate the expanded range's rect still contains the cursor
 *      before returning — otherwise the expansion drifted away.
 *   5. Fallback: enumerate the text node's clientRects, pick the
 *      visual line containing the cursor's Y, then split that line
 *      on sentence terminators and pick the sentence whose
 *      [start,end] band the cursor is over.
 */
function extractTextAt(x, y) {
  if (typeof document.caretRangeFromPoint !== "function") return "";
  const r = document.caretRangeFromPoint(x, y);
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return "";

  const node = r.startContainer;
  const text = node.nodeValue;
  if (!text) return "";

  // 1) Try Range.expand("sentence") — the reference extension's
  //    approach. Works on Firefox always, and on Chrome 109+.
  try {
    if (typeof r.expand === "function") {
      r.expand("sentence");
      const rect = r.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 &&
          rect.left <= x && rect.right >= x &&
          rect.top <= y && rect.bottom >= y) {
        const out = r.toString().replace(/\s+/g, " ").trim();
        if (out.length >= MIN_TEXT_LEN) {
          return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out;
        }
      }
    }
  } catch (_) {
    // "sentence" unit not supported; fall through.
  }

  // 2) Fallback: line-rect + sentence splitter.
  const fullRange = document.createRange();
  fullRange.setStart(node, 0);
  fullRange.setEnd(node, text.length);
  const rects = fullRange.getClientRects();
  if (!rects || rects.length === 0) {
    return pickSentence(text, x, 0, text.length, node);
  }

  let bestRect = null;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.height === 0 || rect.width === 0) continue;
    if (y >= rect.top && y <= rect.bottom) {
      bestRect = rect;
      break;
    }
    const mid = (rect.top + rect.bottom) / 2;
    const d = Math.abs(mid - y);
    if (d < bestDist) {
      bestDist = d;
      bestRect = rect;
    }
  }
  if (!bestRect) bestRect = rects[0];

  const lo = findOffsetAtX(node, text, bestRect.left, 0, text.length, "left");
  const hi = findOffsetAtX(node, text, bestRect.right, lo, text.length, "right");
  return pickSentence(text, x, lo, hi, node);
}

/** Return the sentence in text[lo..hi] that the cursor is over. */
function pickSentence(text, x, lo, hi, node) {
  const slice = text.slice(lo, hi).replace(/\s+/g, " ").trim();
  if (slice.length < MIN_TEXT_LEN) return "";
  const sentences = slice
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= 1) {
    return slice.length > MAX_TEXT_LEN ? slice.slice(0, MAX_TEXT_LEN) : slice;
  }

  // Map the cursor's X to a relative position within the line, then
  // pick the sentence whose [startRatio, endRatio] band contains it
  // (or the nearest one).
  let lineLeft = 0;
  let lineRight = 1;
  if (node) {
    const r1 = document.createRange();
    r1.setStart(node, lo);
    r1.setEnd(node, lo + 1);
    lineLeft = r1.getBoundingClientRect().left;
    const r2 = document.createRange();
    r2.setStart(node, hi - 1);
    r2.setEnd(node, hi);
    lineRight = r2.getBoundingClientRect().right;
  }
  const lineWidth = Math.max(1, lineRight - lineLeft);
  const ratio = Math.max(0, Math.min(1, (x - lineLeft) / lineWidth));

  let acc = 0;
  let best = sentences[0];
  let bestDelta = Infinity;
  for (const s of sentences) {
    const startRatio = acc / slice.length;
    const endRatio = (acc + s.length) / slice.length;
    const d =
      ratio < startRatio
        ? startRatio - ratio
        : ratio > endRatio
        ? ratio - endRatio
        : 0;
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
    acc += s.length;
  }

  return best.length > MAX_TEXT_LEN ? best.slice(0, MAX_TEXT_LEN) : best;
}

/** Binary search for the char offset whose Range right (or left)
 *  edge crosses targetX. */
function findOffsetAtX(node, text, targetX, lo, hi, side) {
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    const r = document.createRange();
    r.setStart(node, lo);
    r.setEnd(node, mid);
    const rect = r.getBoundingClientRect();
    const x = side === "left" ? rect.left : rect.right;
    if (x < targetX) lo = mid;
    else hi = mid;
  }
  return lo;
}

function positionPopup(x, y) {
  pendingPos = { x, y };
  if (rafId) return;
  rafId = requestAnimationFrame(applyPendingPos);
}

function applyPendingPos() {
  rafId = 0;
  if (!pendingPos) return;
  const { x, y } = pendingPos;
  pendingPos = null;

  const el = getPopup();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // Read layout size at every rAF. offsetWidth/Height are not
  // affected by the current transform, so this is safe to do
  // without ever moving the popup off-screen — no flicker.
  readPopupSize();

  // Center horizontally on the cursor; clamp to viewport gutters.
  let px = x - popupW / 2;
  if (px < POPUP_GUTTER) px = POPUP_GUTTER;
  if (px + popupW > vw - POPUP_GUTTER) px = vw - popupW - POPUP_GUTTER;

  // Place directly above the cursor (offset_y = distance from the
  // cursor to the popup's bottom edge). Flip below if it would
  // clip the top of the viewport.
  let py = y - popupH - POPUP_OFFSET_Y;
  if (py < POPUP_GUTTER) py = y + POPUP_OFFSET_Y;
  if (py + popupH > vh - POPUP_GUTTER) py = vh - popupH - POPUP_GUTTER;
  if (py < POPUP_GUTTER) py = POPUP_GUTTER;

  el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
}

function renderPayload(payload) {
  const el = getPopup();
  const trans = el.querySelector(".pt-popup__trans");
  const provider = el.querySelector(".pt-popup__provider");

  trans.classList.remove("pt-popup__error");

  if (payload && payload.translatedText) {
    trans.textContent = payload.translatedText;
    provider.textContent = payload.provider || "";
    provider.style.display = payload.provider ? "inline-block" : "none";
  } else {
    trans.textContent = (payload && payload.error) || "Translation failed";
    trans.classList.add("pt-popup__error");
    provider.style.display = "none";
  }

  // Show the popup, then re-apply position so it lands at the
  // cursor with the new content size.
  showPopup();
  if (pendingPos) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  } else {
    // No fresh mousemove is queued; re-position with the last
    // known mouse position so the popup doesn't sit at the
    // pre-render coordinates.
    pendingPos = { x: lastX, y: lastY };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  }
}

async function requestTranslation(text) {
  const callId = ++inFlight;
  hidePopup();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "translate",
      text,
      sl: settings.sl,
      tl: settings.tl,
    });
    if (callId !== inFlight) return;
    renderPayload(res || {});
  } catch (err) {
    if (callId !== inFlight) return;
    renderPayload({ error: err?.message || String(err) });
  }
}

function onCursorSample() {
  if (!settings.hoverEnabled) return;
  if (document.visibilityState !== "visible") return;
  if (lastX === 0 && lastY === 0) return;

  const text = extractTextAt(lastX, lastY);
  if (!text) {
    hidePopup();
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    return;
  }
  if (text === lastText) return;
  lastText = text;

  // Text under the cursor just changed. Hide the old popup right
  // away — it will be replaced by the new translation once the
  // dwell timer fires.
  hidePopup();
  if (inFlight) {
    // Mark any in-flight request as stale by bumping the counter;
    // its response will be ignored.
    inFlight++;
  }

  // Require the cursor to rest on the same text for HOVER_DELAY_MS
  // before we even consider showing the popup.
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      requestTranslation(text);
    }, DEBOUNCE_MS);
  }, HOVER_DELAY_MS);
}

function onMouseMove(e) {
  lastX = e.clientX;
  lastY = e.clientY;
  positionPopup(lastX, lastY);
  // Do not extract or invalidate the hover timer here. The polling
  // tick (onCursorSample) is the single source of truth for "what
  // text is under the cursor" and for arming/clearing the dwell
  // timer. Running expensive Range operations on every mousemove
  // would also stall the page.
}

function onSelectionChange() {
  if (!settings.hoverEnabled) return;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (text.length < MIN_TEXT_LEN) return;
  if (text === lastText) return;
  lastText = text;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    requestTranslation(text);
  }, DEBOUNCE_MS);
}

function loadSettings() {
  try {
    chrome.storage.local.get(
      { sl: "auto", tl: "vi", hoverEnabled: true, theme: "system" },
      (items) => {
        if (chrome.runtime.lastError) return;
        settings = { ...settings, ...items };
        applyTheme();
      }
    );
  } catch (e) {
    // storage may not be available on some pages
  }
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (key in settings) {
        settings[key] = changes[key].newValue;
      }
    }
    applyTheme();
  });
} catch (e) {}

window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
setInterval(onCursorSample, POLL_MS);
document.addEventListener("selectionchange", onSelectionChange);

loadSettings();
