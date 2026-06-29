/**
 * Content script — hover any text to translate.
 *
 * Text pickup (mirrors the reference extension Từ điển ENVI):
 *   1. document.caretRangeFromPoint(x, y) → a Range anchored at the
 *      caret position under the cursor.
 *   2. If startContainer is not a text node, abort (extension
 *      original also bails out in this case).
 *   3. Range.expand("sentence") extends the range to the closest
 *      sentence boundaries, which gives line-by-line granularity
 *      inside multi-sentence paragraphs.
 *   4. Discard the result if the range's bounding rect no longer
 *      contains the cursor (handles edge cases at line breaks).
 *
 * Positioning: tracked in a single rAF callback, applied with
 * transform: translate3d so the popup glides with the cursor and
 * never triggers layout. The popup sits above the cursor,
 * horizontally centered on it, and flips below if it would clip
 * the top edge.
 */

import "./popup.css";

const POLL_MS = 250;          // 4Hz position poll, matches reference ext (700ms was too slow)
const DEBOUNCE_MS = 220;      // debounce rapid text changes
const MIN_TEXT_LEN = 2;
const MAX_TEXT_LEN = 500;
const HIDE_DELAY_MS = 1500;
const POPUP_OFFSET_Y = 16;
const POPUP_GUTTER = 8;
const POPUP_ID = "__pt_popup_root__";

/** @type {{sl: string, tl: string, hoverEnabled: boolean, theme: 'light'|'dark'}} */
let settings = {
  sl: "auto",
  tl: "vi",
  hoverEnabled: true,
  theme: "light",
};

let lastX = 0;
let lastY = 0;
let lastText = "";
let debounceTimer = null;
let hideTimer = null;
let inFlight = 0;
let pollTimer = 0;
let pendingPos = null;
let rafId = 0;

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
  el.classList.toggle("pt-popup--dark", settings.theme === "dark");
}

/**
 * Pick the text of the sentence under (x, y). Returns "" if the
 * point is not over a text node or the resulting range's rect
 * doesn't contain the cursor.
 */
function extractTextAt(x, y) {
  if (typeof document.caretRangeFromPoint !== "function") return "";
  const r = document.caretRangeFromPoint(x, y);
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return "";

  // Expand to sentence boundaries. This is the key line that gives
  // line-by-line (or rather sentence-by-sentence) translation inside
  // a multi-sentence paragraph.
  try {
    if (typeof r.expand === "function") {
      r.expand("sentence");
    }
  } catch (_) {
    // some browsers throw if the range cannot be expanded; ignore.
  }

  const rect = r.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return "";
  if (rect.left > x || rect.right < x || rect.top > y || rect.bottom < y) {
    return "";
  }

  let txt = r.toString().replace(/\s+/g, " ").trim();
  if (txt.length < MIN_TEXT_LEN) return "";
  if (txt.length > MAX_TEXT_LEN) txt = txt.slice(0, MAX_TEXT_LEN);
  return txt;
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

  // Park off-screen while we measure, so getBoundingClientRect
  // returns the natural size with the new content.
  el.style.transform = "translate3d(-9999px, -9999px, 0)";
  const rect = el.getBoundingClientRect();
  const w = rect.width || 320;
  const h = rect.height || 60;

  let px = x - w / 2;
  if (px < POPUP_GUTTER) px = POPUP_GUTTER;
  if (px + w > vw - POPUP_GUTTER) px = vw - w - POPUP_GUTTER;

  // Above the cursor; flip below if it would clip the top.
  let py = y - h - POPUP_OFFSET_Y;
  if (py < POPUP_GUTTER) py = y + POPUP_OFFSET_Y;
  if (py + h > vh - POPUP_GUTTER) py = vh - h - POPUP_GUTTER;
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
  showPopup();
  // Re-measure + re-position immediately so the new content
  // doesn't bleed out of the viewport.
  if (pendingPos) applyPendingPos();
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, HIDE_DELAY_MS);
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

/** Position-only update (no text extraction, no debounce). */
function trackCursor(x, y) {
  lastX = x;
  lastY = y;
  positionPopup(x, y);
}

/** Full update: track + extract + maybe translate. */
function onCursorSample() {
  if (!settings.hoverEnabled) return;
  if (document.visibilityState !== "visible") return;
  if (document.getElementById(POPUP_ID) && document.activeElement === document.getElementById(POPUP_ID)) return;

  trackCursor(lastX, lastY);

  const text = extractTextAt(lastX, lastY);
  if (!text) {
    scheduleHide();
    return;
  }
  if (text === lastText) {
    // Same sentence as last sample; nothing to do.
    return;
  }
  lastText = text;

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    requestTranslation(text);
  }, DEBOUNCE_MS);
}

function onMouseMove(e) {
  lastX = e.clientX;
  lastY = e.clientY;
  // Move the popup immediately on every mouse event for max
  // smoothness; extract text only on the polling tick.
  trackCursor(lastX, lastY);
}

function onMouseLeaveWindow() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  scheduleHide();
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
      { sl: "auto", tl: "vi", hoverEnabled: true, theme: "light" },
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

// Move the popup on every mouse event (smoothest possible).
window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
window.addEventListener("mouseout", (e) => {
  if (!e.relatedTarget && !e.toElement) onMouseLeaveWindow();
});
// Poll for text under the cursor at POLL_MS intervals, like the
// reference extension does. mousemove is too noisy to run
// extractTextAt on every event.
pollTimer = setInterval(onCursorSample, POLL_MS);
document.addEventListener("selectionchange", onSelectionChange);

loadSettings();
