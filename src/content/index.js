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

  const node = r.startContainer;
  const text = node.nodeValue;
  if (!text) return "";

  // Walk up to the nearest block-level container so we can stitch
  // together all the text nodes that belong to the same logical
  // paragraph. A single <p> can contain inline elements like
  // <strong> that split the text into multiple text nodes; if we
  // only look at the node under the cursor, we'd only translate
  // the part inside the <strong> and miss the trailing clause
  // (", phan con lai") that lives in the next text node.
  const block = closestBlock(node);
  if (!block) {
    return pickSentenceFromNode(node, r.startOffset);
  }

  // Enumerate descendant text nodes in DOM order and build a
  // stitched string. Track the cumulative offset of each text
  // node so we can map r.startOffset (which is local to node)
  // into the stitched string.
  const textNodes = collectTextNodes(block);
  if (textNodes.length === 0) return "";

  let stitched = "";
  const nodeRanges = []; // [{node, start, end}]
  for (const tn of textNodes) {
    const start = stitched.length;
    stitched += tn.nodeValue;
    nodeRanges.push({ node: tn, start, end: stitched.length });
  }

  // Find the range that contains our text node, then compute the
  // caret's offset in the stitched string.
  let caretInStitched = -1;
  for (const nr of nodeRanges) {
    if (nr.node === node) {
      caretInStitched = nr.start + r.startOffset;
      break;
    }
  }
  if (caretInStitched < 0) {
    // Fallback: the text node wasn't in our enumeration (rare);
    // just use the local caret.
    caretInStitched = r.startOffset;
  }

  const segments = splitSentencesWithOffsets(stitched);
  for (const seg of segments) {
    if (caretInStitched >= seg.start && caretInStitched <= seg.end) {
      const out = seg.text;
      if (out.length < MIN_TEXT_LEN) return "";
      return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out;
    }
  }
  return "";
}

/** Pick a sentence from a single text node using the local caret
 *  offset. Used when we cannot find a sensible block ancestor. */
function pickSentenceFromNode(node, offset) {
  const text = node.nodeValue || "";
  if (!text) return "";
  const caret = Math.max(0, Math.min(text.length, offset));
  const segments = splitSentencesWithOffsets(text);
  for (const seg of segments) {
    if (caret >= seg.start && caret <= seg.end) {
      const out = seg.text;
      if (out.length < MIN_TEXT_LEN) return "";
      return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) : out;
    }
  }
  return "";
}

/** Walk up from a node to the nearest block-level ancestor. We
 *  treat <p>, <div>, <li>, <blockquote>, <h1>-<h6>, and elements
 *  with display:block as blocks. Falls back to the immediate
 *  parent if nothing matches. */
function closestBlock(node) {
  let cur = node;
  // First skip past the text node itself.
  if (cur.nodeType === Node.TEXT_NODE) cur = cur.parentElement;
  if (!cur) return null;
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "BLOCKQUOTE", "PRE",
    "H1", "H2", "H3", "H4", "H5", "H6",
    "ARTICLE", "SECTION", "MAIN", "HEADER", "FOOTER", "TD", "TH",
  ]);
  let probe = cur;
  // Look up the tree for a known block tag.
  while (probe && probe !== document.body) {
    if (BLOCK_TAGS.has(probe.tagName)) return probe;
    probe = probe.parentElement;
  }
  // Fallback: use the element's bounding rect as a heuristic.
  // If the element is wider than 200px and contains at least one
  // text node, treat it as a block.
  if (cur && cur !== document.body) {
    const rect = cur.getBoundingClientRect();
    if (rect.width > 200) return cur;
  }
  return cur;
}

/** Collect descendant text nodes in DOM order. */
function collectTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // Skip text inside our own popup elements.
      if (n.parentElement && n.parentElement.closest("#" + POPUP_ID)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.trim().length > 0) {
      out.push(n);
    }
  }
  return out;
}

/** Split text on sentence terminators and remember each segment's
 *  [start, end) character offsets in the original string. The
 *  terminator is kept inside the segment so it survives into the
 *  translation request (we want to send "Hello." not "Hello"). */
function splitSentencesWithOffsets(text) {
  const segments = [];
  // We split AFTER a terminator only when it is followed by
  // whitespace, a newline, or end-of-string. The terminator
  // itself stays in the previous segment.
  //   - Lookbehind:  one or more terminators + optional closing
  //     punctuation (".", "!?", "!??"), but not in the middle of
  //     an abbreviation like "e.g." or "U.S.A." (handled by
  //     requiring whitespace or end-of-string on the right).
  //   - Lookahead:   whitespace, newline, or end-of-string.
  const re = /[.!?]+["')\]]*(?=\s|\n|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Include the terminator in the segment by extending to the
    // end of the match (re.lastIndex already points past it).
    const endOfTerminator = m.index + m[0].length;
    const seg = text.slice(last, endOfTerminator);
    const trimmed = seg.replace(/\s+/g, " ").trim();
    if (trimmed) {
      const leadingWs = seg.match(/^\s*/)[0].length;
      segments.push({
        text: trimmed,
        start: last + leadingWs,
        end: endOfTerminator,
      });
    }
    // Skip any whitespace / newlines that follow the terminator
    // so the next segment starts on the first real character.
    while (
      re.lastIndex < text.length &&
      /\s/.test(text[re.lastIndex])
    ) {
      re.lastIndex++;
    }
    last = re.lastIndex;
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
    // Head word + phonetic on the same row.
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
    trans.appendChild(head);

    // Definition groups.
    const list = document.createElement("div");
    list.className = "pt-popup__defs";
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
        if (def.example) {
          const ex = document.createElement("div");
          ex.className = "pt-popup__example";
          ex.textContent = `"${def.example}"`;
          li.appendChild(ex);
        }
        ol.appendChild(li);
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
}

/** Look up an English word in the Free Dictionary API. Skipped
 *  entirely if the word is not ASCII (Vietnamese etc.) since
 *  the API is English-only. */
async function requestLookup(word) {
  const callId = ++inFlight;
  const clean = (word || "").trim().toLowerCase();
  if (!clean) return;
  if (!/^[a-z'-]+$/.test(clean)) {
    // Not an English word; do nothing. The user can still
    // translate it by selecting it (selection flow) or by
    // hovering the sentence (hover flow).
    hidePopup();
    return;
  }

  const cached = cacheGet("\u0001DICT\u0001" + clean, "dict", "vi");
  if (cached) {
    if (callId !== inFlight) return;
    renderDictionary(cached);
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "lookup",
      word: clean,
    });
    if (callId !== inFlight) return;
    if (res && res.word) {
      cachePut("\u0001DICT\u0001" + clean, "dict", "vi", res);
    }
    renderDictionary(res || {});
  } catch (err) {
    if (callId !== inFlight) return;
    renderDictionary({ error: err?.message || String(err) });
  }
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

  const text = extractTextAt(lastX, lastY);
  if (!text) {
    hidePopup();
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    // Reset lastText so the next hover into the same text node
    // is treated as a fresh hit. Without this, hovering away
    // and back onto identical text would early-return on the
    // "text === lastText" guard and never show the popup again.
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
    if (debounceTimer) clearTimeout(debounceTimer);
    // No skeleton: the popup is shown only when there is real
    // content to display (a translated string from the API, or
    // a cached entry). The 500ms hover delay is enough of a
    // "this is what I'm reading" signal on its own; a flashing
    // skeleton would just be noise during the brief request
    // window, and it makes the target-language skip path look
    // broken (skeleton appears, then vanishes).
    debounceTimer = setTimeout(() => {
      if (callId !== inFlight) return;
      requestTranslation(text);
    }, DEBOUNCE_MS);
  }, HOVER_DELAY_MS);
}

function onMouseMove(e) {
  lastX = e.clientX;
  lastY = e.clientY;
  positionPopup(lastX, lastY);
}

/** Source of the last selection update. The popup should only
 *  be hidden on deselect when the previous selection was made
 *  via the selection-translate flow (mouseup). A dblclick sets
 *  this to 'dblclick' and the selectionchange handler then
 *  leaves the popup alone, so the dictionary view does not
 *  flicker out the moment the browser adjusts the selection. */
let lastSelectedSource = "";
let lastSelectedText = "";

function onSelectionChange() {
  if (!settings.selectionEnabled) return;
  if (lastSelectedSource !== "mouseup") return;
  // selectionchange fires for many reasons: user drag, page
  // script moving the selection, focus shift. We use it only
  // to hide the popup on deselect. Translation is triggered
  // from mouseup, not from this event, to avoid double-firing.
  const sel =
    (window.getSelection && window.getSelection().toString().trim()) || "";
  if (!sel && lastSelectedText) {
    lastSelectedText = "";
    lastSelectedSource = "";
    hidePopup();
  }
}

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

function onDoubleClick(e) {
  if (!settings.dblclickEnabled) return;
  if (document.visibilityState !== "visible") return;
  // Use the current selection (the browser has just selected the
  // double-clicked word). Fall back to looking up the text node
  // at the click position if for some reason the selection is
  // empty.
  const sel =
    (window.getSelection && window.getSelection().toString().trim()) || "";
  if (sel) {
    // Tag the selection as 'dblclick' so the selectionchange
    // handler does not hide the dictionary popup when the
    // browser adjusts the selection right after the dblclick.
    lastSelectedText = sel;
    lastSelectedSource = "dblclick";
    // Make sure the hover flow doesn't immediately overwrite the
    // dictionary view: cancel any pending hover translation.
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    inFlight++;
    lastText = "";
    lastX = e.clientX;
    lastY = e.clientY;
    requestLookup(sel);
    return;
  }
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
  if (r && r.startContainer.nodeType === Node.TEXT_NODE) {
    const word = (r.startContainer.nodeValue || "").trim();
    if (word) {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      inFlight++;
      lastText = "";
      lastX = e.clientX;
      lastY = e.clientY;
      requestLookup(word);
    }
  }
}

function onMouseUp(e) {
  if (!settings.selectionEnabled) return;
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
    // deselect.
    if (lastSelectedText) {
      lastSelectedText = "";
      hidePopup();
    }
    return;
  }
  if (sel === lastSelectedText) return;
  lastSelectedText = sel;
  lastSelectedSource = "mouseup";
  if (sel.length < MIN_TEXT_LEN || sel.length > MAX_TEXT_LEN) return;

  // When the user double-clicks a single word, the browser also
  // fires a mouseup for the second click of the pair. We don't
  // want the selection view to race the dictionary view: if
  // dblclick is enabled and the selection is a single ASCII
  // token, defer to the dictionary flow. The user will see the
  // popup render with definitions instead of a translation.
  if (settings.dblclickEnabled && isSingleWord(sel)) {
    return;
  }

  // Cancel any in-flight hover translation so the selection
  // view wins.
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  inFlight++;
  lastText = "";
  lastX = e.clientX;
  lastY = e.clientY;
  requestTranslation(sel);
}

/** A "single word" for the purposes of the dblclick/mouseup
 *  arbitration: ASCII letters, hyphens, and apostrophes, with
 *  no whitespace. The dictionary flow only handles English
 *  words, so this check matches what the Free Dictionary
 *  provider would accept. */
function isSingleWord(s) {
  if (!s) return false;
  if (/\s/.test(s)) return false;
  if (s.length > 40) return false;
  return /^[a-zA-Z'-]+$/.test(s);
}

window.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
setInterval(onCursorSample, POLL_MS);
document.addEventListener("dblclick", onDoubleClick);
document.addEventListener("mouseup", onMouseUp);
// selectionchange is also listened to so we can hide the popup
// the moment the user deselects (clears the selection by clicking
// elsewhere or pressing an arrow key).
document.addEventListener("selectionchange", onSelectionChange);

loadSettings();
