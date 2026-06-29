# Popup Translator — Implementation Plan

> Chrome extension (Manifest V3) dịch text khi **hover** trên bất kỳ trang web nào.
> Build lại từ extension gốc `cflakfhockilljdbofnanaijpmpmfcol` v1.1.1 (Từ điển Anh Việt ENVI), giữ tính năng cốt lõi, bỏ các tính năng phụ.

- **Author:** danghuuwang
- **Co-author:** glm-5.2

---

## 0. Language Convention

All source code (`.js`, `.css`, `.html`), code comments, commit messages, and documentation (`README.md`, `PLAN.md` body) are written in **English only**. No Vietnamese in code/commits/docs. This applies to:

- Variable/function/file names
- JSDoc and inline comments
- README sections, PLAN sections (after this notice)
- `package.json` `description` field

User-facing strings rendered in the popup UI may remain in the target translation language (e.g. Vietnamese label "Dịch sang") since they are product content, not code.

---

## 1. Mục tiêu & Phạm vi

### Giữ
- Hover text → popup dịch xuất hiện cạnh con trỏ.
- Popup setting: chọn ngôn ngữ nguồn (auto) / đích, bật-tắt hover, dark/light theme popup.
- **Multi-provider**: Google + Bing + Papago (gọi song song, lấy kết quả nhanh nhất, fallback khi 1 provider block) — replicate logic gốc.

### Bỏ (so với extension gốc)
| Tính năng | Mục đích gốc | Lý do bỏ |
|---|---|---|
| OCR (Tesseract.js + OpenCV.js WASM) | Nhận diện chữ trong ảnh rồi dịch | Phức tạp nhất, ~5MB, ít dùng, ngoài scope hover text |
| Dịch PDF (pdf.js + pdfInject.js) | Thay viewer PDF, inject text-layer để hover dịch | Bundle ~3MB, logic riêng cho PDF |
| TTS (chrome.tts) | Phát âm từ/câu dịch | Tính năng phụ, tăng UI complexity |
| Context menu (chrome.contextMenus) | Chuột phải → dịch text chọn | Trùng use case hover |
| Omnibox (keyword "envi") | Gõ `envi <từ>` trên address bar | Khác use case hover |
| Reverse translate language | Phím tắt đảo source/target | Ngoài scope |
| Recent translated history | Lưu câu đã dịch để xem lại | Cần storage schema + UI list |
| Hold-key activation | Popup chỉ hiện khi giữ phím + hover | Dùng debounce + auto-detect thay thế |
| Exclude Language setting | Bỏ qua khi text đã ở ngôn ngữ đích | Tự check `detectedSl === tl` trong code |
| jQuery + Bootstrap tooltip + Popper + Vue/Vuetify | UI & định vị tooltip | DOM thường + CSS `position:fixed` đủ, giảm bundle ~2MB → ~15KB |

---

## 2. Stack kỹ thuật

- **Manifest V3** (service worker background).
- **Vanilla JS** (ES2020) + **Webpack 5** để bundle (hoặc Vite — chọn Webpack cho control manifest copy).
- **chrome.storage.local** lưu setting.
- **chrome.runtime.sendMessage** giao tiếp content ↔ background.
- Font system (`-apple-system, Segoe UI, Roboto`), không bundle font.
- Icons: SVG → PNG 16/32/48/128 (tạo bằng script `sharp` hoặc pre-render).

---

## 3. Cấu trúc project

```
popup-translator/
├── .gitignore
├── package.json
├── webpack.config.js
├── README.md
├── PLAN.md                     # file này
├── src/
│   ├── manifest.json
│   ├── icons/
│   │   ├── icon_16.png
│   │   ├── icon_32.png
│   │   ├── icon_48.png
│   │   └── icon_128.png
│   ├── background/
│   │   ├── index.js            # service worker: message router
│   │   └── translators/
│   │       ├── google.js       # translate.googleapis.com/translate_a/single (client=gtx)
│   │       ├── bing.js         # www.bing.com/ttranslatev3
│   │       └── papago.js       # papago.naver.com/apis/n2mt/translate
│   ├── content/
│   │   ├── index.js            # hover logic + popup DOM
│   │   └── popup.css           # style popup (inject via JS)
│   └── popup/
│       ├── popup.html          # UI setting 350x500
│       ├── popup.js
│       └── popup.css
└── dist/                       # output (gitignored) — load unpacked từ đây
```

---

## 4. Logic hoạt động (chi tiết)

### 4.1. Content script (`content/index.js`)
- Inject mọi frame: `all_frames: true`, `run_at: document_idle`, match `<all_urls>`.
- Cache setting từ `chrome.storage.local` (sl, tl, hoverEnabled, theme). Lắng nghe `chrome.storage.onChanged` để cập nhật live.
- Lắng nghe `mousemove` trên `document`:
  1. Lấy element dưới con trỏ (`document.elementFromPoint(clientX, clientY)`).
  2. Trickle lên tìm node có text: nếu element là TEXT_NODE hoặc `textContent.trim()` có giá trị → lấy text (giới hạn ~280 ký tự, trim multiline).
  3. Debounce 300ms (cancel timer nếu mousemove sang node khác).
  4. Nếu `hoverEnabled` && text đủ dài (≥2 ký tự) && không phải popup self → gửi message.
- `chrome.runtime.sendMessage({type:"translate", text, sl, tl})`.
- Nhận response → `renderPopup(x, y, src, translated, theme)`.
- `mouseup` với selection có text → cũng trigger (backup khi hover không bắt được).
- Tránh double popup: check `document.querySelector('.pt-popup')` trước khi tạo; di chuyển popup nếu đã tồn tại.
- Ẩn popup khi `mouseleave` khỏi node gốc + sau timeout 1.5s, hoặc khi hover node mới.

### 4.2. Background (`background/index.js` + translators)
- `chrome.runtime.onMessage` → switch `msg.type`:
  - `"translate"` → gọi song song 3 provider bằng `Promise.race` + fallback.
- **Multi-provider strategy:**
  - Promise.race([google(), bing(), papago()]) nhưng mỗi provider có timeout 3s.
  - Ai resolve đầu → trả kết quả ngay.
  - Nếu 1 reject → vẫn chờ các provider khác.
  - Nếu tất cả reject → trả `{error}`.
- Mỗi provider export `translate({text, sl, tl}) → Promise<{translatedText, detectedSl?}>`.

#### Google (`translators/google.js`)
```
GET https://translate.googleapis.com/translate_a/single
  ?client=gtx&sl={sl}&tl={tl}&dt=t&q={encodeURIComponent(text)}
```
Parse: `response[0]` là mảng `[[translatedSegment, originalSegment, ...], ...]`. Ghép `translatedSegment` (phần tử `[i][0]`) → `translatedText`. `detectedSl = response[2]`.
Fallback: nếu `gtx` fail → thử `client=dict` (`translate_a/t?client=dict&sl&tl&q` → parse `[[src, dst]]`).

#### Bing (`translators/bing.js`)
```
POST https://www.bing.com/ttranslatev3
body: { text, fromLang: sl==="auto"?"auto-detect":sl, to: tl }
```
Parse: `response[0].translations[0].text`, `detectedSl = response[0].detectedLanguage.language`.
(Yêu cầu token `token` + `key` từ `/ttranslatev3` GET trước — replicate logic gốc.)

#### Papago (`translators/papago.js`)
```
POST https://papago.naver.com/apis/n2mt/translate
body: { source: sl==="auto"?detectFirst:sl, target: tl, text }
```
Detect trước nếu `sl==="auto"`: `POST /apis/langs/dect` body `{query: text}` → `langCode`.
Parse: `response.translatedText`.
(Lưu ý: Papago thường cần header `x-naver-client-id` — extension gốc có thể dùng public endpoint không cần key; em sẽ test, nếu block thì bỏ Papago khỏi race nhưng giữ Google+Bing.)

### 4.3. Popup setting (`popup/popup.html`)
- 350x500 px, layout dọc.
- Fields:
  - `<select>` Translate From (default `auto`, list ngôn ngữ phổ biến).
  - `<select>` Translate Into (default `vi`).
  - `<toggle>` Bật hover dịch (default on).
  - `<toggle>` Dark popup (default off).
- Lưu vào `chrome.storage.local` khi change → content script auto-update qua `storage.onChanged`.

---

## 5. Popup style (white/black, blur, radius, border)

```css
.pt-popup {
  position: fixed;
  z-index: 2147483647;
  max-width: 320px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  color: #111;
  font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.pt-popup__src   { color: #666; font-size: 11px; margin-bottom: 4px; }
.pt-popup__trans { color: #000; font-weight: 500; }

/* Dark theme */
.pt-popup--dark {
  background: rgba(20, 20, 20, 0.72);
  color: #fafafa;
  border-color: rgba(255, 255, 255, 0.16);
}
.pt-popup--dark .pt-popup__src   { color: #999; }
.pt-popup--dark .pt-popup__trans { color: #fff; }
```
- Border-radius: 10px. Border: 1px solid. Backdrop blur: 12px. Tone: trắng-đen chủ đạo.
- Vị trí: `pageX + 14`, `pageY + 18`; nếu vượt viewport phải/dưới → flip sang trái/trên.

---

## 6. Git & Versioning

- `git init` đã xong. Author: `danghuuwang`.
- Co-author trailer mỗi commit: `Co-Authored-By: glm-5.2` (không email).
- Mỗi milestone tăng patch version trong `package.json` + `src/manifest.json`:
  - **v1.0.0** — scaffold (package.json, webpack, .gitignore, PLAN.md, README). ← commit này
  - **v1.0.1** — manifest + background + translators (Google/Bing/Papago).
  - **v1.0.2** — content script hover + popup DOM/CSS.
  - **v1.0.3** — popup setting UI + storage sync.
  - **v1.0.4** — icons + README docs + polish + final test.
- Commit style: Conventional Commits (`feat:`, `chore:`, `docs:`...).

---

## 7. Verification

1. `npm install` → `npm run build` → kiểm tra `dist/`:
   - `manifest.json`, `background.js`, `content.js`, `popup.html/js/css`, `icons/`.
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked `dist/`.
3. Test cases:
   - Hover câu English trên trang web → popup Việt xuất hiện cạnh con trỏ.
   - Hover sang câu khác → popup di chuyển / cập nhật.
   - Mở popup setting → đổi `Translate Into` sang `ja` → hover lại → popup tiếng Nhật.
   - Tắt hover → di chuột → không popup.
   - Bật dark theme → popup nền đen chữ trắng.
   - Fallback provider: block Google (DevTools → Network block) → vẫn dịch được qua Bing/Papago.
4. Không có console error ở content/background/popup.

---

## 8. Rủi ro & xử lý

| Rủi ro | Xử lý |
|---|---|
| Google `gtx` rate-limit | Fallback `client=dict`; race với Bing/Papago |
| Bing cần token GET trước | Cache token 5 phút, refresh khi 401 |
| Papago cần client-id | Test trước; nếu block → bỏ khỏi race, giữ Google+Bing |
| `all_frames:true` double popup | Check `.pt-popup` tồn tại trước tạo; 1 popup/element gốc |
| CSP trang chặn `backdrop-filter` | Không — chạy trên trang web (không phải extension page), CSP trang không hạn chế backdrop-filter |
| Text node rời rạc (PDF-like) | Giới hạn scope: chỉ hover text HTML thường, không support PDF |

---

## 9. Thứ tự implement

1. **Commit v1.0.0** (scaffold) — file này + .gitignore + package.json + webpack config + README stub.
2. **Commit v1.0.1** — manifest + background + 3 translators.
3. **Commit v1.0.2** — content script + popup hover CSS.
4. **Commit v1.0.3** — popup setting UI + storage.
5. **Commit v1.0.4** — icons + docs + test + polish.

Hết.
