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

  // r.startOffset is the exact character index of the caret within
  // the text node. We split the node value on sentence terminators,
  // walk the resulting segments, and return the one whose [start,
  // end] range contains r.startOffset. This is precise and
  // independent of the cursor's X — the caret offset is the
  // authoritative position.
  const caret = Math.max(0, Math.min(text.length, r.startOffset));
  const segments = splitSentencesWithOffsets(text);
  for (const seg of segments) {
    if (caret >= seg.start && caret <= seg.end) {
      const out = seg.text;
      if (out.length < MIN_TEXT_LEN) return "";
      return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out;
    }
  }
  // Fallback if the offset falls in a gap between segments.
  return "";
}

/** Split text on sentence terminators and remember each segment's
 *  [start, end) character offsets in the original string. */
function splitSentencesWithOffsets(text) {
  const segments = [];
  // Regex matches either a sentence terminator followed by
  // whitespace, or a run of whitespace / newlines. We walk
  // matches and build segments in between.
  const re = /[.!?]+["')\]]*\s+|\n+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const seg = text.slice(last, m.index + m[0].search(/\S|$/));
    const trimmed = seg.replace(/\s+/g, " ").trim();
    if (trimmed) {
      // Compute offset of the trimmed start in the original text.
      const leadingWs = seg.match(/^\s*/)[0].length;
      const start = last + leadingWs;
      const end = m.index + m[0].length;
      segments.push({ text: trimmed, start, end });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const seg = text.slice(last);
    const trimmed = seg.replace(/\s+/g, " ").trim();
    if (trimmed) {
      const leadingWs = seg.match(/^\s*/)[0].length;
      segments.push({
        text: trimmed,
        start: last + leadingWs,
        end: text.length,
      });
    }
  }
  return segments;
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
  // Strip any leftover classes from the previous render so the
  // element is a clean .pt-popup__trans container again.
  contentEl.className = "pt-popup__trans";
  // Show it immediately; the skeleton lines are real DOM spans
  // with their own animated background, so they read as content
  // even before any text arrives.
  contentEl.classList.add("pt-popup__trans--ready");
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
  // Provider chip is in skeleton state: a small animated bar
  // (50px wide) instead of a label.
  provider.classList.remove("pt-popup__provider--ready");
  provider.classList.add("pt-popup__provider--skeleton");
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
  trans.className = "pt-popup__trans";

  if (payload && payload.translatedText) {
    trans.textContent = payload.translatedText;
  } else {
    trans.textContent = (payload && payload.error) || "Translation failed";
    trans.classList.add("pt-popup__error");
  }

  // Update provider chip.
  provider.classList.remove("pt-popup__provider--skeleton");
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
