# Popup Translator

Chrome extension (MV3) — dịch text khi hover trên bất kỳ trang web nào.

## Features
- Hover text → popup dịch cạnh con trỏ
- Multi-provider: Google + Bing + Papago (race, fallback)
- Popup style: white/black tone, backdrop blur, border-radius, border
- Setting popup: chọn ngôn ngữ, bật/tắt hover, dark/light theme

## Dev
```bash
npm install
npm run build      # output to dist/
npm run dev        # watch mode
```
Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → chọn `dist/`.

## Stack
- Manifest V3, vanilla JS, Webpack 5
- chrome.storage.local, chrome.runtime.sendMessage

## Author
danghuuwang — co-authored by glm-5.2

See [PLAN.md](./PLAN.md) for full implementation detail.
