/**
 * Content script — hover any text to translate.
 * Listens for mousemove (captured at window level for reliability),
 * debounces 300ms, sends a translate request to the background
 * service worker, and renders a styled popup near the cursor. The
 * popup shows only the translated text plus a small provider tag
 * beneath; no source text and no intermediate loading state.
 */

import "./popup.css";

const DEBOUNCE_MS = 300;
const MAX_TEXT_LEN = 500;
const MIN_TEXT_LEN = 2;
const HIDE_DELAY_MS = 1500;
const OFFSET_X = 14;
const OFFSET_Y = 18;
const POPUP_ID = "__pt_popup_root__";

/** @type {{sl: string, tl: string, hoverEnabled: boolean, theme: 'light'|'dark'}} */
let settings = {
  sl: "auto",
  tl: "vi",
  hoverEnabled: true,
  theme: "light",
};

let currentNode = null;
let lastText = "";
let debounceTimer = null;
let hideTimer = null;
let inFlight = 0;

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

/** Extract a meaningful text snippet from the hovered element. */
function extractText(el) {
  if (!el) return "";
  if (el.closest && el.closest(`#${POPUP_ID}`)) return "";
  if (el.nodeType === Node.TEXT_NODE) {
    el = el.parentElement;
  }
  if (!el || !el.textContent) return "";

  const raw = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  if (raw.length < MIN_TEXT_LEN) return "";
  if (raw.length > MAX_TEXT_LEN) return raw.slice(0, MAX_TEXT_LEN);
  return raw;
}

function positionPopup(clientX, clientY) {
  const el = getPopup();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const w = rect.width || 280;
  const h = rect.height || 60;

  let x = clientX + OFFSET_X;
  let y = clientY + OFFSET_Y;
  if (x + w > vw - 8) x = clientX - w - OFFSET_X;
  if (y + h > vh - 8) y = clientY - h - OFFSET_Y;
  if (x < 8) x = 8;
  if (y < 8) y = 8;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
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
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, HIDE_DELAY_MS);
}

async function requestTranslation(text, clientX, clientY) {
  const callId = ++inFlight;
  hidePopup();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "translate",
      text,
      sl: settings.sl,
      tl: settings.tl,
    });
    if (callId !== inFlight) return; // a newer request superseded this one
    positionPopup(clientX, clientY);
    renderPayload(res || {});
  } catch (err) {
    if (callId !== inFlight) return;
    positionPopup(clientX, clientY);
    renderPayload({ error: err?.message || String(err) });
  }
}

function onMouseMove(e) {
  if (!settings.hoverEnabled) return;

  // Always reposition the popup so it tracks the cursor smoothly,
  // even while waiting for a new translation. This is the behavior
  // the reference extension ships: the tooltip follows the mouse.
  positionPopup(e.clientX, e.clientY);

  const target = e.target;
  if (!target) return;

  const text = extractText(target);
  if (!text) {
    scheduleHide();
    return;
  }
  if (text === lastText && target === currentNode) return;
  lastText = text;
  currentNode = target;

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    requestTranslation(text, e.clientX, e.clientY);
  }, DEBOUNCE_MS);
}

function onSelectionChange() {
  if (!settings.hoverEnabled) return;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (text.length < MIN_TEXT_LEN) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    requestTranslation(text, window.innerWidth / 2, window.innerHeight / 2);
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

// Capture phase + window for cross-frame reliability and to beat
// page-level handlers that may call stopPropagation.
window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
document.addEventListener("selectionchange", onSelectionChange);

loadSettings();
