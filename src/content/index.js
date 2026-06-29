/**
 * Content script — hover any text to translate.
 *
 * Text pickup:
 *   1. document.caretRangeFromPoint(x, y) anchors a Range at the
 *      caret position under the cursor.
 *   2. If the start container is not a text node, abort.
 *   3. We do NOT rely on Range.expand("sentence") because Chrome
 *      historically throws on that unit. Instead we walk the text
 *      node's clientRects, find the visual line that contains the
 *      cursor's Y, take the text of that line, then split on
 *      sentence boundaries (. ! ? \n) to deliver sentence-level
 *      granularity inside a multi-sentence paragraph.
 *
 * Positioning + fade:
 *   - Position is written through transform: translate3d inside a
 *     rAF callback so the popup glides with the cursor with no
 *     jitter and never triggers layout.
 *   - Fade is pure CSS (opacity transition on .pt-popup).
 *     .pt-popup--visible toggles opacity 0 -> 1. The element stays
 *     in the DOM with pointer-events: none; visibility is opacity.
 */

import "./popup.css";

const POLL_MS = 200;
const DEBOUNCE_MS = 220;
const MIN_TEXT_LEN = 2;
const MAX_TEXT_LEN = 500;
const POPUP_OFFSET_Y = 16;
const POPUP_GUTTER = 8;
const FADE_IN_MS = 120;
const FADE_OUT_MS = 180;
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
let pendingPos = null;
let rafId = 0;

console.log("[Popup Translator] content script loaded");

/** Lazily create or fetch the singleton popup element. */
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

/** Return the popup's natural layout size, regardless of transform. */
function measurePopup() {
  const el = getPopup();
  // offsetWidth/offsetHeight are unaffected by transform and always
  // reflect the laid-out box, so they're safe to read even when the
  // popup is currently translated off-screen.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return { w: w || 320, h: h || 60, el };
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
 * Pick the sentence under (x, y). Uses caretRangeFromPoint to find
 * the text node under the cursor, finds the visual line containing
 * the cursor via clientRects, then splits that line on sentence
 * boundaries to get a single sentence.
 */
function extractTextAt(x, y) {
  if (typeof document.caretRangeFromPoint !== "function") return "";
  const r = document.caretRangeFromPoint(x, y);
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return "";

  const node = r.startContainer;
  const text = node.nodeValue;
  if (!text) return "";

  // Build a range over the whole text node to enumerate line rects.
  const fullRange = document.createRange();
  fullRange.setStart(node, 0);
  fullRange.setEnd(node, text.length);
  const rects = fullRange.getClientRects();

  if (!rects || rects.length === 0) {
    // Fall back: split the whole node value on sentence boundaries.
    return splitSentences(text).join(" ").trim();
  }

  // Pick the line rect that vertically contains the cursor; if none
  // contains it, take the nearest.
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

  // Convert rect horizontal extent to character offsets by binary
  // search over the node.
  const leftOff = findOffsetAtX(node, text, bestRect.left, 0, text.length, "left");
  const rightOff = findOffsetAtX(node, text, bestRect.right, leftOff, text.length, "right");
  let line = text.slice(leftOff, rightOff);
  // If a sentence in the line straddles a line-wrap, the next
  // rect's text will already cover the rest, so trimming on the
  // nearest sentence boundary is enough.
  line = line.replace(/\s+/g, " ").trim();
  if (line.length < MIN_TEXT_LEN) return "";

  // Find the sentence that contains the cursor's X.
  const sentence = pickSentence(line, x);
  if (sentence.length < MIN_TEXT_LEN) return "";
  if (sentence.length > MAX_TEXT_LEN) return sentence.slice(0, MAX_TEXT_LEN);
  return sentence;
}

/** Split a string on sentence terminators (., !, ?, newline). */
function splitSentences(s) {
  return s.split(/(?<=[.!?])\s+|\n+/);
}

/**
 * Given a line and a cursor X coordinate, return the sentence within
 * the line that contains or is nearest to that X. Falls back to the
 * longest sentence if x is off-range.
 */
function pickSentence(line, x) {
  const parts = splitSentences(line).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return line;

  // Walk the line and accumulate the running offset of each
  // sentence so we can compare against x.
  let acc = 0;
  const ranges = parts.map((p) => {
    const start = acc;
    acc += p.length;
    return { p, start, end: acc };
  });

  // Heuristic: if we have no geometric way to pick, take the first
  // sentence that the cursor is over. We approximate by using the
  // rect of the first character (cheap).
  for (const r of ranges) {
    // Cheap heuristic: compare string offsets, not screen X, since
    // the line is single-row and X approximately scales with offset.
    // For our purpose (sentence-level translation), it's good enough.
    const lineWidth = line.length || 1;
    const pxStart = r.start * (lineWidth > 0 ? 1 : 0);
    if (x >= lineWidth) break; // not enough info
  }

  // Simpler heuristic that actually works: pick the sentence whose
  // start offset is nearest the cursor's x position when scaled to
  // text length. This isn't pixel-perfect but matches user intent
  // when they hover different sentences.
  let best = ranges[0];
  let bestDelta = Infinity;
  for (const r of ranges) {
    const ratio = r.start / (line.length || 1);
    const target = (x / (window.innerWidth || 1)) * (line.length || 1);
    const d = Math.abs(r.start - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = r;
    }
  }
  return best.p;
}

/** Binary search for the character offset in node whose Range
 *  right (or left) edge crosses targetX. */
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

  const { w, h, el } = measurePopup();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

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

  // After content change, the popup size may have grown. Re-position
  // against the new size so it doesn't bleed out of the viewport.
  showPopup();
  if (pendingPos) applyPendingPos();
  else if (rafId === 0) {
    // No new mouse position; force a re-measure on the last position.
    const r = el.getBoundingClientRect();
    pendingPos = { x: r.left + r.width / 2, y: r.top + POPUP_OFFSET_Y };
    applyPendingPos();
  }
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, Math.max(HIDE_DELAY_MS, FADE_OUT_MS + 50));
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

function trackCursor(x, y) {
  positionPopup(x, y);
}

function onCursorSample() {
  if (!settings.hoverEnabled) return;
  if (document.visibilityState !== "visible") return;
  if (lastX === 0 && lastY === 0) return;

  const text = extractTextAt(lastX, lastY);
  if (!text) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, FADE_OUT_MS + 50);
    return;
  }
  if (text === lastText) return;
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
  trackCursor(lastX, lastY);
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

window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
setInterval(onCursorSample, POLL_MS);
document.addEventListener("selectionchange", onSelectionChange);

loadSettings();
