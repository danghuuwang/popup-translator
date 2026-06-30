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

/** @type {{sl: string, hoverEnabled: boolean, dblclickEnabled: boolean, selectionEnabled: boolean, theme: 'light'|'dark'|'system'}} */
let settings = {
  sl: "auto",
  hoverEnabled: true,
  dblclickEnabled: true,
  selectionEnabled: true,
  theme: "system",
};

// Target language is hard-coded to Vietnamese. The extension is
// EN/auto -> VI only. There is no setting for this and no UI.
const TARGET_LANG = "vi";

// Set to true in this script (or via setting) to log every API
// response. Defaults to true so the user can debug whether
// detectedSl is being parsed correctly.
let __ptDebug = true;

let lastX = 0;
let lastY = 0;
let lastText = "";
let debounceTimer = null;
let hoverTimer = null;
let inFlight = 0;
let pendingPos = null;
let rafId = 0;
/** When true, onMouseMove does not reposition the popup. Set
 *  by the dictionary view (mouseup) so the popup stays anchored
 *  at the click position; cleared by hidePopup or the
 *  translate view (which does follow the cursor). */
let staticPosition = false;
let popupW = 320;
let popupH = 60;

/** LRU cache of recent translations. Key = text + sl + tl. We
 *  cap at 100 entries so the cache doesn't grow without bound
 *  during long browsing sessions. Lookup is O(1) and so is
 *  insertion. The map preserves insertion order, so deleting
 *  the oldest key is the first key in iteration order. */
const CACHE_MAX = 100;
const translationCache = new Map();

function cacheGet(text, sl, tl) {
  const key = text + "\u0001" + sl + "\u0001" + tl;
  const entry = translationCache.get(key);
  if (!entry) return null;
  // Refresh recency: delete + re-insert moves to the end.
  translationCache.delete(key);
  translationCache.set(key, entry);
  return entry;
}

function cachePut(text, sl, tl, payload) {
  const key = text + "\u0001" + sl + "\u0001" + tl;
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, payload);
  // Evict oldest entries until we're at the cap.
  while (translationCache.size > CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
}

/** Jaccard similarity over whitespace-separated word tokens,
 *  case-folded. Used as a fallback same-language detector when
 *  Google returns a paraphrase of the source (e.g. target=vi and
 *  the source is already Vietnamese). A 0.5 threshold catches a
 *  single-clause paraphrase that shares most of its words. */
function jaccardWords(a, b) {
  if (!a || !b) return 0;
  const tok = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[.,!?;:"'\u2018\u2019\u201C\u201D()\[\]{}]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

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
  staticPosition = false;
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
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) {
    if (window.__ptDebug) console.log("[PT] no text node at", x, y, "range=", r);
    return "";
  }

  // The cursor may be hovering over an empty area (padding, margin,
  // a gap between rows). In that case caretRangeFromPoint still
  // returns the nearest text node, which is misleading. Reject the
  // hit if the cursor is outside the rendered text glyphs.
  //
  // We use Range.getBoundingClientRect() on a range that spans the
  // whole text node. That gives us the union of all line boxes
  // for the actual rendered text, which is a tight fit around the
  // glyphs (much tighter than parentElement.getBoundingClientRect
  // for inline elements with padding, or for a parent block that
  // has whitespace-only children).
  let textRange = null;
  try {
    textRange = document.createRange();
    textRange.selectNodeContents(r.startContainer);
  } catch (e) {
    textRange = null;
  }
  if (textRange) {
    const rects = textRange.getClientRects();
    let hit = false;
    for (let i = 0; i < rects.length; i++) {
      const r2 = rects[i];
      if (r2.width === 0 && r2.height === 0) continue;
      if (x >= r2.left && x <= r2.right &&
          y >= r2.top  && y <= r2.bottom) {
        hit = true;
        break;
      }
    }
    if (!hit && rects.length > 0) {
      if (window.__ptDebug)
        console.log("[PT] cursor outside text rects at", x, y, "rects=", rects.length);
      return "";
    }
  }

  // Try to expand the range to the surrounding sentence. Chrome
  // supports Range.expand("sentence") and treats the result as
  // one logical unit. When the sentence lives inside a single
  // text node, this gives us the right span directly. When the
  // sentence is split across inline elements (e.g. a <p> with
  // an <a> and a <strong>), the expansion only covers the part
  // inside the current text node; the multi-node case is a known
  // limitation of the native API that the reference extension
  // (cflakfhockilljdbofnanaijpmpmfcol) accepts as well.
  const sentenceRange = r.cloneRange();
  try {
    sentenceRange.expand("sentence");
  } catch (e) {
    // Some pages throw if the range is detached; fall through.
  }
  let text = sentenceRange.toString();
  // Collapse runs of whitespace so a sentence that spans a line
  // break still reads as a single sentence.
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT_LEN) {
    // The sentence expansion may have ended up empty or single-
    // character; fall back to the caret's text node as-is.
    text = (r.startContainer.nodeValue || "").trim();
    if (text.length < MIN_TEXT_LEN) return "";
  }
  if (text.length > MAX_TEXT_LEN) return text.slice(0, MAX_TEXT_LEN);
  return text;
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
  // Translate popups follow the cursor; the dict popup stays
  // at the click position.
  staticPosition = false;
}

/** Render a dictionary entry. The trans element gets a
 *  'pt-popup__dict' modifier and is populated with the head
 *  word, phonetic, and a definition list grouped by part of
 *  speech. */
function renderDictionary(payload) {
  const el = getPopup();
  const provider = el.querySelector(".pt-popup__provider");
  const trans = el.querySelector(".pt-popup__trans");

  // Reset the content container.
  while (trans.firstChild) trans.removeChild(trans.firstChild);
  trans.className = "pt-popup__trans pt-popup__trans--dict";

  provider.classList.remove("pt-popup__provider--skeleton");
  provider.classList.remove("pt-popup__provider--ready");
  provider.textContent = (payload && payload.provider) || "Dictionary";

  if (!payload || !payload.word) {
    trans.textContent = (payload && payload.error) || "No definition found";
    trans.classList.add("pt-popup__error");
  } else {
    // Head word + phonetic on the first row, Vietnamese
    // translation of the headword on its own line below. The VI
    // line is filled in later by fetchViTranslation(); we set up
    // a loading placeholder here so the layout is stable while
    // the second network call is in flight.
    const head = document.createElement("div");
    head.className = "pt-popup__head";
    const wordEl = document.createElement("span");
    wordEl.className = "pt-popup__word";
    wordEl.textContent = payload.word;
    head.appendChild(wordEl);
    if (payload.phonetic) {
      const ph = document.createElement("span");
      ph.className = "pt-popup__phonetic";
      ph.textContent = payload.phonetic;
      head.appendChild(ph);
    }
    const viEl = document.createElement("span");
    viEl.className = "pt-popup__vi pt-popup__vi--loading";
    viEl.dataset.role = "dict-vi";
    if (payload.vi) {
      viEl.textContent = payload.vi;
      viEl.classList.remove("pt-popup__vi--loading");
    } else {
      viEl.textContent = "Đang dịch…";
    }
    head.appendChild(viEl);
    trans.appendChild(head);

    // Definition groups.
    const list = document.createElement("div");
    list.className = "pt-popup__defs";
    let defCounter = 0;
    for (const group of payload.entries || []) {
      if (!group.definitions || group.definitions.length === 0) continue;
      const block = document.createElement("div");
      block.className = "pt-popup__defgroup";
      if (group.partOfSpeech) {
        const pos = document.createElement("div");
        pos.className = "pt-popup__pos";
        pos.textContent = group.partOfSpeech;
        block.appendChild(pos);
      }
      const ol = document.createElement("ol");
      ol.className = "pt-popup__deflist";
      for (const def of group.definitions) {
        const li = document.createElement("li");
        li.className = "pt-popup__defitem";
        const text = document.createElement("span");
        text.className = "pt-popup__deftext";
        text.textContent = def.text;
        li.appendChild(text);
        // Vietnamese translation of this specific definition.
        // Filled in by fetchDictViDefs() in the background; we
        // set a data-index so the updater can find this exact
        // defitem when the API call resolves.
        const viDef = document.createElement("div");
        viDef.className = "pt-popup__defvi pt-popup__defvi--loading";
        viDef.dataset.role = "dict-def-vi";
        viDef.dataset.idx = String(defCounter);
        if (def.vi) {
          viDef.textContent = def.vi;
          viDef.classList.remove("pt-popup__defvi--loading");
        } else {
          viDef.textContent = "Đang dịch…";
        }
        li.appendChild(viDef);
        if (def.example) {
          const ex = document.createElement("div");
          ex.className = "pt-popup__example";
          ex.textContent = `"${def.example}"`;
          li.appendChild(ex);
        }
        ol.appendChild(li);
        defCounter++;
      }
      block.appendChild(ol);
      list.appendChild(block);
    }
    trans.appendChild(list);
  }

  // Trigger layout then fade in.
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
  // The dictionary view is pinned to the click position; the
  // cursor is free to wander and the popup should not follow.
  staticPosition = true;
}

/** Patch the Vietnamese translation into an already-rendered
 *  dictionary popup. The placeholder element was created with
 *  data-role="dict-vi" inside the head row; we look it up and
 *  replace the "Đang dịch…" text with the real translation.
 *  If the popup is no longer showing a dict, or the element is
 *  gone, this is a no-op (the user has moved on). */
function updateDictionaryVi(vi) {
  const el = getPopup();
  const viEl = el.querySelector('[data-role="dict-vi"]');
  if (!viEl) return;
  if (!vi) {
    viEl.remove();
    return;
  }
  viEl.textContent = vi;
  viEl.classList.remove("pt-popup__vi--loading");
}

/** Patch a Vietnamese definition translation into a single
 *  defitem. Each defvi element has a data-idx attribute set
 *  at render time so we can find the right one. */
function updateDictDefVi(idx, vi) {
  const el = getPopup();
  const viEl = el.querySelector(
    `[data-role="dict-def-vi"][data-idx="${idx}"]`
  );
  if (!viEl) return;
  if (!vi) {
    viEl.remove();
    return;
  }
  viEl.textContent = vi;
  viEl.classList.remove("pt-popup__defvi--loading");
}

/** Look up an English word in the Free Dictionary API. Skipped
 *  entirely if the word is not ASCII (Vietnamese etc.) since
 *  the API is English-only. Trailing/leading punctuation is
 *  stripped so 'end.' still looks up 'end'. After the dict
 *  result is in, we also kick off a Vietnamese translation of
 *  the headword via the existing Google translator and patch
 *  it into the popup when it resolves. The two calls run in
 *  parallel; the user sees English definitions immediately and
 *  the VI translation appears a moment later. */
async function requestLookup(word) {
  const callId = ++inFlight;
  const clean = (word || "").trim().toLowerCase();
  if (!clean) return;
  const core = clean.replace(/^[^a-z']+|[^a-z']+$/g, "");
  if (!core || !/^[a-z'-]+$/.test(core)) {
    // Not an English word; do nothing. The user can still
    // translate it by selecting it (selection flow) or by
    // hovering the sentence (hover flow).
    hidePopup();
    return;
  }
  const lookupWord = core;

  const cached = cacheGet("\u0001DICT\u0001" + lookupWord, "dict", "vi");
  if (cached) {
    if (callId !== inFlight) return;
    renderDictionary(cached);
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "lookup",
      word: lookupWord,
    });
    if (callId !== inFlight) return;
    if (res && res.word) {
      cachePut("\u0001DICT\u0001" + lookupWord, "dict", "vi", res);
    }
    // 404 from the dict API means the word is not in the
    // English dictionary. The popup would just show a
    // "dictionary: 404" error string, which is noise — the
    // user did not get a definition, they got a failure.
    // Hide the popup entirely so the UI does not get in the
    // way. The user can still get a translation by selecting
    // the word with the selection flow.
    if (res && res.error && /404/.test(res.error)) {
      hidePopup();
      return;
    }
    renderDictionary(res || {});

    // Fire the VI translations in the background. We do not
    // await it; the user already has the English defs on
    // screen. When each call resolves we patch the placeholder.
    if (res && res.word) {
      fetchDictViAll(res.word, res.entries, callId);
    }
  } catch (err) {
    if (callId !== inFlight) return;
    renderDictionary({ error: err?.message || String(err) });
  }
}

/** Fetch the Vietnamese translations for a dictionary entry:
 *  one for the headword and one for each English definition.
 *  All calls run in parallel via Promise.all. Each resolution
 *  patches the popup in place; the user sees the English
 *  definitions immediately and the Vietnamese lines stream in
 *  as the calls resolve. Results are cached back into the dict
 *  cache entry (per definition) so a re-lookup re-renders
 *  without hitting the network. */
async function fetchDictViAll(headword, entries, callId) {
  const cacheKey = "\u0001DICT\u0001" + headword.toLowerCase();
  const cached = cacheGet(cacheKey, "dict", "vi");

  // Build the list of (idx, text) pairs that still need a
  // translation. The headword is idx -1 (sentinel) so the
  // updater can distinguish it from the defs.
  const headwordCached = cached && cached.vi;
  const tasks = [];
  if (!headwordCached) {
    tasks.push({ idx: -1, text: headword });
  } else {
    updateDictionaryVi(cached.vi);
  }
  let defCounter = 0;
  for (const group of entries || []) {
    for (const def of group.definitions || []) {
      if (def.vi) {
        updateDictDefVi(defCounter, def.vi);
      } else {
        tasks.push({ idx: defCounter, text: def.text });
      }
      defCounter++;
    }
  }

  if (tasks.length === 0) return;

  // Fire all translates in parallel. A single failed call only
  // kills its own VI line, not the others.
  const promises = tasks.map((t) =>
    chrome.runtime
      .sendMessage({
        type: "translate",
        text: t.text,
        sl: "en",
        tl: "vi",
      })
      .then((res) => ({ idx: t.idx, vi: (res && res.translatedText) || "" }))
      .catch(() => ({ idx: t.idx, vi: "" }))
  );
  const results = await Promise.all(promises);
  if (callId !== inFlight) return;

  // Patch each result into the popup and backfill the cache
  // entry so a re-lookup skips the network.
  const entry = cacheGet(cacheKey, "dict", "vi") || { word: headword };
  for (const { idx, vi } of results) {
    if (!vi) continue;
    if (idx === -1) {
      updateDictionaryVi(vi);
      entry.vi = vi;
    } else {
      updateDictDefVi(idx, vi);
      // Backfill the def.vi on the entry so renderDictionary
      // can render it directly on the next cache hit.
      let i = 0;
      outer: for (const group of entry.entries || entries || []) {
        for (const def of group.definitions || []) {
          if (i === idx) {
            def.vi = vi;
            break outer;
          }
          i++;
        }
      }
    }
  }
  cachePut(cacheKey, "dict", "vi", entry);
}

async function requestTranslation(text) {
  const callId = ++inFlight;
  const sl = settings.sl;
  const tl = TARGET_LANG;

  // Cache hit: render immediately, skip the network.
  const cached = cacheGet(text, sl, tl);
  if (cached) {
    if (callId !== inFlight) return;
    if (cached.noop) {
      // Previously-detected target-language hit. The popup
      // mirrors the source verbatim, which is just noise. Hide
      // it instead of re-rendering.
      hidePopup();
      return;
    }
    renderPayload(cached);
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "translate",
      text,
      sl,
      tl,
    });
    if (callId !== inFlight) return;

    // Skip path: server tells us the source is already in the
    // target language. We honour three signals, in priority:
    //
    //   1. detectedSl === tl. The most authoritative signal.
    //      Google can be wrong on short fragments or domain-
    //      specific text, so this is not enough on its own.
    //
    //   2. Verbatim match. translatedText is byte-equal to the
    //      source. This means Google had nothing to translate.
    //
    //   3. High similarity. The translation is a paraphrase of
    //      the source, e.g. "So sánh hai đối tượng..." vs
    //      "So sánh là hành động...". The two strings are
    //      recognisably the same sentence, so the source is
    //      already in the target language. We compute a quick
    //      Jaccard similarity over word tokens. Threshold 0.5
    //      catches a paraphrase with one or two words changed.
    const detected = (res && res.detectedSl) || "";
    const translated = (res && res.translatedText) || "";
    const isTargetByLang =
      detected && (detected === tl || detected.startsWith(tl + "-"));
    const isTargetByText = translated && translated.trim() === text.trim();
    const isTargetBySim = isTargetByLang
      ? false
      : translated
        ? jaccardWords(text, translated) >= 0.5
        : false;
    const isTarget = isTargetByLang || isTargetByText || isTargetBySim;
    if (typeof __ptDebug !== "undefined" && __ptDebug) {
      console.log("[PT] response", {
        text,
        tl,
        detected,
        translated,
        isTargetByLang,
        isTargetByText,
        isTarget,
      });
    }
    if (isTarget) {
      // Cache the no-op so a re-hover does not hit the API again.
      const noop = {
        translatedText: text,
        detectedSl: detected,
        provider: (res && res.provider) || "Google",
        noop: true,
      };
      cachePut(text, sl, tl, noop);
      // For target-language hits we do not show a popup at all;
      // the user already understands the text. Hiding feels less
      // noisy than a popup that mirrors the source verbatim.
      hidePopup();
      return;
    }

    if (res && res.translatedText) {
      cachePut(text, sl, tl, res);
    }
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

  // The mouseup-selection flow is currently showing its popup.
  // The cursor is on top of the same text, but the hover flow
  // must NOT touch the popup. The user releases the pin by
  // clicking outside any selection (the mousedown listener
  // clears pinnedText on a click with no selection). Until then,
  // the hover flow stays out of the way.
  if (pinnedText) return;

  const text = extractTextAt(lastX, lastY);
  if (!text) {
    // Cursor over empty space. Reset lastText so the next hover
    // into the same text node is treated as a fresh hit.
    hidePopup();
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    lastText = "";
    return;
  }
  if (text === lastText) return;
  lastText = text;

  hidePopup();
  inFlight++;

  if (hoverTimer) clearTimeout(hoverTimer);
  // Snapshot the inFlight counter so the deferred callback can
  // detect that a newer hover has superseded this one. inFlight
  // was already bumped above to invalidate any earlier request.
  const callId = inFlight;
  hoverTimer = setTimeout(() => {
    if (callId !== inFlight) return;
    // Re-check the pin: the user may have made a selection
    // between scheduling and firing.
    if (pinnedText) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (callId !== inFlight) return;
      if (pinnedText) return;
      requestTranslation(text);
    }, DEBOUNCE_MS);
  }, HOVER_DELAY_MS);
}

function onMouseMove(e) {
  lastX = e.clientX;
  lastY = e.clientY;
  // The dictionary view is anchored to the click position, not
  // the cursor. Skipping positionPopup while a dict is showing
  // keeps the popup stable when the user moves the mouse off
  // the selected word to read the definition.
  if (staticPosition) return;
  positionPopup(lastX, lastY);
}

/** Text the popup was last shown for, either by the hover flow
 *  or by a mouseup selection. Used to suppress duplicate
 *  lookups when the user releases the mouse on text we already
 *  translated. */
let lastSelectedText = "";

/** Text the popup is "pinned" to after a mouseup selection.
 *  While pinned, the hover flow refuses to translate this
 *  text (the cursor is still on top of it and would otherwise
 *  schedule a translation a moment later that overwrites the
 *  popup). The pin is cleared when the user clicks outside
 *  any selection. */
let pinnedText = "";

function loadSettings() {
  try {
    chrome.storage.local.get(
      {
        sl: "auto",
        hoverEnabled: true,
        dblclickEnabled: true,
        selectionEnabled: true,
        theme: "system",
      },
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

function onMouseUp(e) {
  if (document.visibilityState !== "visible") return;
  // Skip if this mouseup is on our own popup (don't re-trigger
  // when the user clicks inside the translated popup).
  if (e.target && e.target.closest && e.target.closest("#" + POPUP_ID)) {
    return;
  }
  const sel =
    (window.getSelection && window.getSelection().toString().trim()) || "";
  if (!sel) {
    // Selection collapsed or empty: the user is not selecting
    // anything. Hide the popup so it does not linger after a
    // click on empty space.
    hidePopup();
    pinnedText = "";
    return;
  }
  if (sel.length < MIN_TEXT_LEN || sel.length > MAX_TEXT_LEN) return;
  if (sel === lastSelectedText) return;
  lastSelectedText = sel;

  // Cancel any in-flight hover translation so the selection view
  // wins. Pin the popup to the selected text so the hover flow
  // does not re-translate it on the next cursor poll.
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  inFlight++;
  lastText = "";
  lastX = e.clientX;
  lastY = e.clientY;
  pinnedText = sel;

  // Single ASCII word + dblclick enabled => dictionary lookup.
  // Multi-word selection => translation.
  if (settings.dblclickEnabled && isSingleWord(sel)) {
    requestLookup(sel);
  } else if (settings.selectionEnabled) {
    requestTranslation(sel);
  }
}

/** A "single word" for the purposes of the dblclick/mouseup
 *  arbitration: ASCII letters, hyphens, and apostrophes, with
 *  optional trailing/leading punctuation. The dictionary flow
 *  only handles English words, so this check matches what the
 *  Free Dictionary provider would accept. We strip the
 *  selection to just the alphabetic core before testing. */
function isSingleWord(s) {
  if (!s) return false;
  if (s.length > 40) return false;
  const core = s.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, "");
  if (!core) return false;
  if (/\s/.test(core)) return false;
  return /^[a-zA-Z'-]+$/.test(core);
}

window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
setInterval(onCursorSample, POLL_MS);
document.addEventListener("mouseup", onMouseUp);
// Hide the popup on a click outside the popup and outside any
// selection. Listening on mousedown (not click) means we beat the
// page's own click handlers, and we never fire on a click that
// landed inside our own popup (we filter below).
document.addEventListener("mousedown", (e) => {
  if (e.target && e.target.closest && e.target.closest("#" + POPUP_ID)) return;
  // The mouseup handler will run after this; if it picks up a
  // non-empty selection it will re-render the popup. We only
  // need to hide the popup here for clicks that produced no
  // selection at all.
  // We delay by a tick to let the page settle the selection
  // first, then re-check.
  setTimeout(() => {
    const sel =
      (window.getSelection && window.getSelection().toString().trim()) || "";
    if (!sel) {
      hidePopup();
      pinnedText = "";
    }
  }, 0);
});


loadSettings();
