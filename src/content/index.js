/**
 * Content script — hover any text to translate.
 *
 * Two visual elements, both fixed-positioned at the document root:
 *   - The translation popup (.pt-popup) with the translated text.
 *   - The provider badge (.pt-popup__provider), docked directly
 *     above the popup's top edge with a small gap.
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
 *      popup keeps the same dimensions so it never jumps.
 *   4. Moving to a different text hides the popup right away; any
 *      in-flight response for the old text is dropped.
 *
 * Positioning:
 *   Both elements are updated on every mousemove via
 *   requestAnimationFrame. The popup sits above the cursor, centered
 *   horizontally. The provider badge is anchored to the popup's
 *   top edge, sitting just above it with a small gap.
 */

import "./popup.css";

const POLL_MS = 200;
const DEBOUNCE_MS = 220;
const HOVER_DELAY_MS = 500;
const MIN_TEXT_LEN = 2;
const MAX_TEXT_LEN = 500;
const POPUP_OFFSET_Y = 12;
const POPUP_GUTTER = 8;
const PROVIDER_GAP = 8;
const POPUP_ID = "__pt_popup_root__";
const PROVIDER_ID = "__pt_popup_provider__";

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
let providerW = 60;
let providerH = 18;
/** Cached current visible height so the popup doesn't jump when
 *  the skeleton is replaced with the real translation. */
let lockedH = 0;

console.log("[Popup Translator] content script loaded");

function getPopup() {
  let root = document.getElementById(POPUP_ID);
  if (root) return root;

  root = document.createElement("div");
  root.id = POPUP_ID;
  root.className = "pt-popup";
  root.setAttribute("role", "tooltip");
  root.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "pt-popup__body";
  root.appendChild(body);

  (document.body || document.documentElement).appendChild(root);
  return root;
}

function getProvider() {
  let p = document.getElementById(PROVIDER_ID);
  if (p) return p;
  p = document.createElement("span");
  p.id = PROVIDER_ID;
  p.className = "pt-popup__provider";
  p.textContent = "";
  (document.body || document.documentElement).appendChild(p);
  return p;
}

function readSizes() {
  const popup = getPopup();
  popupW = popup.offsetWidth || popupW || 320;
  popupH = popup.offsetHeight || popupH || 60;
  const prov = getProvider();
  providerW = prov.offsetWidth || providerW || 60;
  providerH = prov.offsetHeight || providerH || 18;
}

function showPopup() {
  const el = getPopup();
  el.classList.add("pt-popup--visible");
  el.setAttribute("aria-hidden", "false");
}

function hidePopup() {
  const el = document.getElementById(POPUP_ID);
  if (el) {
    el.classList.remove("pt-popup--visible");
    el.setAttribute("aria-hidden", "true");
  }
  const p = document.getElementById(PROVIDER_ID);
  if (p) {
    p.classList.remove("pt-popup--visible");
  }
  lockedH = 0;
}

function showProvider(text) {
  const p = getProvider();
  p.textContent = text || "";
  if (text) {
    p.classList.add("pt-popup--visible");
  } else {
    p.classList.remove("pt-popup--visible");
  }
  providerW = p.offsetWidth || providerW;
  providerH = p.offsetHeight || providerH;
}

function applyTheme() {
  const popup = getPopup();
  const prov = getProvider();
  let effective = settings.theme;
  if (!effective || effective === "system") {
    effective =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  const isDark = effective === "dark";
  popup.classList.toggle("pt-popup--dark", isDark);
  prov.classList.toggle("pt-popup__provider--dark", isDark);
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

/**
 * Pick the sentence under (x, y). Returns "" if the cursor is not
 * over a text node.
 */
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
 *  translation. Number of lines is a function of the source
 *  text length so a short sentence shows 1 line, a long
 *  paragraph shows 3-4. */
function buildSkeleton(sourceText) {
  const body = document.createElement("div");
  body.className = "pt-popup__body pt-popup__body--skeleton";

  const len = (sourceText || "").length;
  let n;
  if (len < 30) n = 1;
  else if (len < 80) n = 2;
  else if (len < 160) n = 3;
  else n = 4;

  // Distribute widths: first/last lines often shorter, middle full.
  const widths = ["long", "medium", "long", "medium"];
  for (let i = 0; i < n; i++) {
    const line = document.createElement("span");
    line.className = "pt-popup__line pt-popup__line--" + widths[i];
    body.appendChild(line);
  }
  return body;
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
  const prov = getProvider();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // Center horizontally on the cursor; clamp to gutters.
  let px = x - popupW / 2;
  if (px < POPUP_GUTTER) px = POPUP_GUTTER;
  if (px + popupW > vw - POPUP_GUTTER) px = vw - popupW - POPUP_GUTTER;

  // Place above the cursor; flip below if it would clip the top.
  let py = y - popupH - POPUP_OFFSET_Y;
  if (py < POPUP_GUTTER) py = y + POPUP_OFFSET_Y;
  if (py + popupH > vh - POPUP_GUTTER) py = vh - popupH - POPUP_GUTTER;
  if (py < POPUP_GUTTER) py = POPUP_GUTTER;

  el.style.transform = `translate3d(${px}px, ${py}px, 0)`;

  // Provider badge sits directly above the popup's top edge, with a
  // small gap so the two are visually separate. The badge's bottom
  // is at popup.top - PROVIDER_GAP, i.e. badge.top = popup.top -
  // providerH - PROVIDER_GAP.
  let ppx = px + 6;
  let ppy = py - providerH - PROVIDER_GAP;
  if (ppx + providerW > vw - POPUP_GUTTER) ppx = vw - providerW - POPUP_GUTTER;
  if (ppx < POPUP_GUTTER) ppx = POPUP_GUTTER;
  if (ppy < POPUP_GUTTER) ppy = POPUP_GUTTER;

  prov.style.transform = `translate3d(${ppx}px, ${ppy}px, 0)`;
}

/** Show the popup immediately with a skeleton sized to the
 *  expected translation. */
function showSkeleton(sourceText) {
  const el = getPopup();
  const oldBody = el.querySelector(".pt-popup__body");
  const newBody = buildSkeleton(sourceText);
  if (oldBody) el.replaceChild(newBody, oldBody);
  else el.appendChild(newBody);
  // Hide provider while loading.
  showProvider("");
  // Force layout to measure the skeleton before positioning.
  void el.offsetHeight;
  readSizes();
  showPopup();
  if (pendingPos) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  } else {
    pendingPos = { x: lastX, y: lastY };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  }
}

function renderPayload(payload) {
  const el = getPopup();
  // Replace the skeleton with the real text element. The text
  // starts with opacity:0 then transitions to 1, while the
  // skeleton (if still in the DOM) is removed in the same tick,
  // giving a clean cross-fade.
  const oldBody = el.querySelector(".pt-popup__body");
  const newBody = document.createElement("div");
  newBody.className = "pt-popup__body";

  const trans = document.createElement("div");
  trans.className = "pt-popup__trans";
  if (payload && payload.translatedText) {
    trans.textContent = payload.translatedText;
  } else {
    trans.textContent = (payload && payload.error) || "Translation failed";
    trans.classList.add("pt-popup__error");
  }
  newBody.appendChild(trans);

  if (oldBody) el.replaceChild(newBody, oldBody);
  else el.appendChild(newBody);

  // Trigger layout so the transition fires from the freshly
  // inserted node, then add the ready class on the next frame.
  void trans.offsetHeight;
  requestAnimationFrame(() => {
    trans.classList.add("pt-popup__trans--ready");
  });

  showProvider(payload && payload.provider ? payload.provider : "");
  readSizes();
  showPopup();
  if (pendingPos) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  } else {
    pendingPos = { x: lastX, y: lastY };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyPendingPos);
  }
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
