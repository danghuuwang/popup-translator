# Popup Translator

A Chrome extension (Manifest V3) that translates any text on a web page by hovering. No clicks, no full-page redirect — just hover, get a popup.

## Features

- **Hover-to-translate.** Move your cursor over text, see a small translation popup appear next to the cursor.
- **Multi-provider race.** Sends each request to Google Translate, Bing Microsoft Translator, and Naver Papago in parallel; the fastest successful response wins, slow or failing providers are dropped via per-request timeout. No API keys required.
- **Clean visual style.** White/black tone, backdrop blur, 10px border-radius, 1px border. Light and dark themes.
- **Settings popup.** Choose source language (default auto-detect), target language (default Vietnamese), toggle hover, switch theme.
- **Live reconfigure.** Changes apply immediately on the active tab — no reload needed.

## Project layout

```
popup-translator/
├── PLAN.md                       Implementation plan & rationale
├── README.md                     This file
├── package.json
├── webpack.config.js
├── scripts/
│   └── generate-icons.js         One-off PNG icon generator (no extra deps)
└── src/
    ├── manifest.json
    ├── icons/                    16/32/48/128 PNG icons
    ├── background/
    │   ├── index.js              Service worker: message router + race
    │   └── translators/
    │       ├── google.js         translate_a/single (gtx + dict fallback)
    │       ├── bing.js           ttranslatev3 with credential cache
    │       └── papago.js         n2mt with /dect auto-detect
    ├── content/
    │   ├── index.js              Hover detection + popup render
    │   └── popup.css             Hover-popup styling
    └── popup/
        ├── popup.html            Settings UI
        ├── popup.css
        └── popup.js              chrome.storage sync
```

## Build

The project ships as plain ES2020 source and is bundled by Webpack.

```bash
npm install
npm run build       # outputs to dist/
npm run dev         # watch mode
```

After `npm run build`, load the extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.

To regenerate icons (only needed if you change the design):

```bash
node scripts/generate-icons.js
```

## How it works

1. **Content script** injects on every frame and listens to `mousemove`. After a 300ms debounce, it extracts the text under the cursor (clamped to 280 chars) and sends `{type:"translate", text, sl, tl}` to the background.
2. **Background service worker** receives the message and fires all three translators in parallel. Each has a 3-second timeout. The first to resolve wins.
3. **Content script** receives the result and renders a styled popup at `cursorX + 14, cursorY + 18`, flipping to the opposite side if it would clip the viewport edge. The popup auto-hides after 1.5s of idle.
4. **Settings popup** is a 350x500 form that reads and writes `chrome.storage.local`. The content script listens to `chrome.storage.onChanged` and updates behavior live.

## Configuration

Stored in `chrome.storage.local`:

| Key | Type | Default | Description |
|---|---|---|---|
| `sl` | string | `"auto"` | Source language code |
| `tl` | string | `"vi"` | Target language code |
| `hoverEnabled` | boolean | `true` | Master switch for hover translation |
| `theme` | `"light"` \| `"dark"` | `"light"` | Popup visual theme |

## Notes on providers

- **Google** uses the public `translate_a/single` endpoint with `client=gtx`. If that fails (rate-limit, network), it falls back to `client=dict`. No token, no API key.
- **Bing** fetches a short-lived token from `ttranslatev3`, caches it for 5 minutes, then POSTs the translation request.
- **Papago** calls `/apis/langs/dect` to detect the source language when `sl=auto`, then `/apis/n2mt/translate` for the result. Public web endpoint, may be region-restricted; the race naturally falls through to other providers if it fails.

## License

MIT.

## Author

- **Author:** danghuuwang
- **Co-author:** glm-5.2

See [PLAN.md](./PLAN.md) for the original implementation plan and feature-rationale.
