/**
 * Content script — hover any text to translate.
 *
 * Visual model: a single fixed-positioned popup (.pt-popup) that
 * holds both the provider chip and the translated text. The chip
 * sits inside the popup at the top, so the two are always glued
 * together. The popup's height grows naturally with the number of
 * lines in the translation; the layout is flex column with no
 * fixed height.
 *
 * Hover flow:
 *   1. document.caretRangeFromPoint finds the text node under the
 *      cursor. The text is split on sentence terminators to give
 *      sentence-level granularity inside a multi-sentence paragraph.
 *   2. Once the cursor has rested on the same text for HOVER_DELAY_MS
 *      (500ms), the popup appears with a skeleton placeholder whose
 *      size approximates the expected translation. The translation
 *      request fires in parallel.
 *   3. When the response arrives, the skeleton is cross-faded out
 *      and the real text fades in (CSS opacity transition). The
 *      provider chip fades in too. The popup's natural size grows
 *      with the number of text lines.
 *   4. Moving to a different text hides the popup right away; any
 *      in-flight response for the old text is dropped.
 *
 * Positioning:
 *   The popup is updated on every mousemove via
 *   requestAnimationFrame. It sits above the cursor, centered
 *   horizontally, with a 14px gap from the cursor.
 */

import "./popup.css";

const POLL_MS = 200;
const DEBOUNCE_MS = 220;
const HOVER_DELAY_MS = 500;
const MIN_TEXT_LEN = 2;
const MAX_TEXT_LEN = 500;
const POPUP_OFFSET_Y = 14;
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

  const provider = document.createElement("span");
  provider.className = "pt-popup__provider";
  provider.textContent = "";
  root.appendChild(provider);

  const trans = document.createElement("div");
  trans.className = "pt-popup__trans";
  trans.textContent = " ";
  root.appendChild(trans);

  (document.body || document.documentElement).appendChild(root);
  return root;
}

function readSizes() {
  const popup = getPopup();
  popupW = popup.offsetWidth || popupW || 320;
  popupH = popup.offsetHeight || popupH || 60;
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
  const popup = getPopup();
  let effective = settings.theme;
  if (!effective || effective === "system") {
    effective =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  popup.classList.toggle("pt-popup--dark", effective === "dark");
}

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

function extractTextAt(x, y) {
  if (typeof document.caretRangeFromPoint !== "function") return "";
  const r = document.caretRangeFromPoint(x, y);
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return "";

  const node = r.startContainer;
  const text = node.nodeValue;
  if (!text) return "";

  try {
    if (typeof r.expand === "function") {
      r.expand("sentence");
      const rect = r.getBoundingClientRect();
      if (
        rect.width > 0 && rect.height > 0 &&
        rect.left <= x && rect.right >= x &&
        rect.top <= y && rect.bottom >= y
      ) {
        const out = r.toString().replace(/\s+/g, " ").trim();
        if (out.length >= MIN_TEXT_LEN) {
          return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out;
        }
      }
    }
  } catch (_) {
    // "sentence" unit not supported; fall through.
  }

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

/** Build skeleton lines sized to roughly match the expected
 *  translation. Returns an array of width classes. */
function skeletonLineClasses(sourceText) {
  const len = (sourceText || "").length;
  let n;
  if (len < 30) n = 1;
  else if (len < 80) n = 2;
  else if (len < 160) n = 3;
  else n = 4;
  const widths = ["long", "medium", "long", "medium"];
  return widths.slice(0, n);
}

function setSkeleton(contentEl, sourceText) {
  contentEl.className = "pt-popup__trans";
  contentEl.textContent = "";
  const widths = skeletonLineClasses(sourceText);
  for (const w of widths) {
    const line = document.createElement("span");
    line.className = "pt-popup__line pt-popup__line--" + w;
    contentEl.appendChild(line);
  }
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

  readSizes();
  const el = getPopup();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let px = x - popupW / 2;
  if (px < POPUP_GUTTER) px = POPUP_GUTTER;
  if (px + popupW > vw - POPUP_GUTTER) px = vw - popupW - POPUP_GUTTER;

  let py = y - popupH - POPUP_OFFSET_Y;
  if (py < POPUP_GUTTER) py = y + POPUP_OFFSET_Y;
  if (py + popupH > vh - POPUP_GUTTER) py = vh - popupH - POPUP_GUTTER;
  if (py < POPUP_GUTTER) py = POPUP_GUTTER;

  el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
}

function showSkeleton(sourceText) {
  const el = getPopup();
  const provider = el.querySelector(".pt-popup__provider");
  const trans = el.querySelector(".pt-popup__trans");
  provider.classList.remove("pt-popup__provider--ready");
  provider.textContent = "";
  setSkeleton(trans, sourceText);
  // Force layout to measure the skeleton before positioning.
  void el.offsetHeight;
  readSizes();
  showPopup();
  if (!pendingPos) pendingPos = { x: lastX, y: lastY };
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(applyPendingPos);
}

function renderPayload(payload) {
  const el = getPopup();
  const provider = el.querySelector(".pt-popup__provider");
  const trans = el.querySelector(".pt-popup__trans");

  // Reset trans to a clean text container.
  while (trans.firstChild) trans.removeChild(trans.firstChild);
  trans.classList.remove("pt-popup__line", "pt-popup__line--short", "pt-popup__line--medium", "pt-popup__line--long");

  if (payload && payload.translatedText) {
    trans.textContent = payload.translatedText;
  } else {
    trans.textContent = (payload && payload.error) || "Translation failed";
    trans.classList.add("pt-popup__error");
  }

  // Update provider chip.
  provider.classList.remove("pt-popup__provider--ready");
  provider.textContent = payload && payload.provider ? payload.provider : "";

  // Trigger layout then fade in on the next frame.
  void el.offsetHeight;
  requestAnimationFrame(() => {
    trans.classList.add("pt-popup__trans--ready");
    if (provider.textContent) {
      provider.classList.add("pt-popup__provider--ready");
    }
  });

  readSizes();
  showPopup();
  if (!pendingPos) pendingPos = { x: lastX, y: lastY };
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(applyPendingPos);
}

async function requestTranslation(text) {
  const callId = ++inFlight;
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

  hidePopup();
  inFlight++;

  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    showSkeleton(text);
    debounceTimer = setTimeout(() => {
      requestTranslation(text);
    }, DEBOUNCE_MS);
  }, HOVER_DELAY_MS);
}

function onMouseMove(e) {
  lastX = e.clientX;
  lastY = e.clientY;
  positionPopup(lastX, lastY);
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
    showSkeleton(text);
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
