/**
 * Popup settings script.
 * Renders the source-language select, wires change handlers to
 * chrome.storage, and shows a transient "Saved" hint on every
 * update. The target language is locked to Vietnamese; only
 * the source is configurable.
 */

const SOURCE_LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "th", label: "Thai" },
  { code: "id", label: "Indonesian" },
  { code: "vi", label: "Vietnamese" },
];

const KEYS = {
  sl: "pt-sl",
  hover: "pt-hover",
  dblclick: "pt-dblclick",
  selection: "pt-selection",
  theme: "pt-theme",
  status: "pt-status",
};

const DEFAULTS = {
  sl: "auto",
  hoverEnabled: true,
  dblclickEnabled: true,
  selectionEnabled: true,
  theme: "system",
};

function fillSelect(selectEl, list, current) {
  selectEl.innerHTML = "";
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item.code;
    opt.textContent = item.label;
    if (item.code === current) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function setSelectValue(selectEl, value) {
  if (!selectEl) return;
  const opts = selectEl.options;
  for (let i = 0; i < opts.length; i++) {
    if (opts[i].value === value) {
      selectEl.selectedIndex = i;
      return;
    }
  }
}

function flashSaved() {
  const status = document.getElementById(KEYS.status);
  if (!status) return;
  status.classList.add("pt-settings__status--show");
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => {
    status.classList.remove("pt-settings__status--show");
  }, 900);
}

function load() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    fillSelect(document.getElementById(KEYS.sl), SOURCE_LANGUAGES, items.sl);
    document.getElementById(KEYS.hover).checked = !!items.hoverEnabled;
    document.getElementById(KEYS.dblclick).checked = !!items.dblclickEnabled;
    document.getElementById(KEYS.selection).checked = !!items.selectionEnabled;
    setSelectValue(document.getElementById(KEYS.theme), items.theme || "system");
  });
}

function save(patch) {
  chrome.storage.local.set(patch, flashSaved);
}

function wire() {
  document
    .getElementById(KEYS.sl)
    .addEventListener("change", (e) => save({ sl: e.target.value }));
  document
    .getElementById(KEYS.hover)
    .addEventListener("change", (e) => save({ hoverEnabled: e.target.checked }));
  document
    .getElementById(KEYS.dblclick)
    .addEventListener("change", (e) => save({ dblclickEnabled: e.target.checked }));
  document
    .getElementById(KEYS.selection)
    .addEventListener("change", (e) => save({ selectionEnabled: e.target.checked }));
  document
    .getElementById(KEYS.theme)
    .addEventListener("change", (e) => save({ theme: e.target.value }));
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  wire();
});
