/**
 * Popup settings script.
 * Renders language selects, wires change handlers to chrome.storage,
 * and shows a transient "Saved" hint on every update.
 */

const LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "vi", label: "Vietnamese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "th", label: "Thai" },
  { code: "id", label: "Indonesian" },
];

const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== "auto");

const KEYS = {
  sl: "pt-sl",
  tl: "pt-tl",
  hover: "pt-hover",
  theme: "pt-theme",
  status: "pt-status",
};

const DEFAULTS = { sl: "auto", tl: "vi", hoverEnabled: true, theme: false };

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
    fillSelect(document.getElementById(KEYS.sl), LANGUAGES, items.sl);
    fillSelect(document.getElementById(KEYS.tl), TARGET_LANGUAGES, items.tl);
    document.getElementById(KEYS.hover).checked = !!items.hoverEnabled;
    document.getElementById(KEYS.theme).checked = !!items.theme;
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
    .getElementById(KEYS.tl)
    .addEventListener("change", (e) => save({ tl: e.target.value }));
  document
    .getElementById(KEYS.hover)
    .addEventListener("change", (e) => save({ hoverEnabled: e.target.checked }));
  document
    .getElementById(KEYS.theme)
    .addEventListener("change", (e) =>
      save({ theme: e.target.checked ? "dark" : "light" })
    );
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  wire();
});
