# Slop Gauge for YouTube (Chrome / Brave, Manifest V3)

Overlays a small badge on every YouTube thumbnail:

    2025 · 4.3/wk · 820          (amber/red, flagged items underlined)
    2014 · 0.6/wk · 1.2M         (green)

Hover the badge for details (creation date, uploads counted, exact subscriber count).

| Signal | Default flag | Source |
|---|---|---|
| Channel created | on/after 2025-01-01 | `channels.snippet.publishedAt` |
| Uploads per week since 2026-01-01 | > 2 | uploads playlist dates |
| Subscribers | < 10,000 (hidden counts not flagged) | `channels.statistics` |

Colour: green = 0 flags, amber = 1, red = 2+, grey = no data. All thresholds are editable in Options.

## Trust and block

Click any badge to open a small menu:

- **Trust this channel** – badge turns blue (`✓ trusted`); no more API lookups for it.
- **Block this channel** – its videos are hidden everywhere (or dimmed, see Options → *Blocked channels*).
- **Remove from … list** – undo.

In *Hide* mode a blocked tile has no badge to click, so unblock from the Options page,
which lists both sets with links and Remove buttons. *Export lists* / *Import lists* save and
restore them as JSON (import merges; imported entries win). Lists live in `chrome.storage.local`,
so they stay on this browser profile – use export/import to move them between machines.

## Setup

1. **Get an API key** – <https://console.cloud.google.com/> → create a project → *APIs & Services → Library* →
   enable **YouTube Data API v3** → *Credentials → Create credentials → API key*.
   Restrict the key to "YouTube Data API v3" (API restrictions). It's free.
2. **Load the extension** – unzip, open `chrome://extensions` (or `brave://extensions`), enable
   *Developer mode*, *Load unpacked*, choose the `YouTubeSlopGauge` folder.
3. The options page opens on install: paste the key, click **Test key**.
4. Reload YouTube.

## Quota

Free quota is 10,000 units/day. Per *new* channel: 1 unit (channel) + 1 per 50 uploads scanned
(capped by "Max upload pages", default 4). A typical home page of ~30 channels costs ~40–60 units;
results are cached for 7 days, so a day of normal browsing uses a small fraction. If the quota runs
out, badges go grey and the extension pauses API calls for an hour.

## Notes / limitations

- **The DOM selectors are the fragile part.** YouTube reshuffles its markup regularly. If badges stop
  appearing, update `SG_ITEM_SELECTOR` / `SG_THUMB_SELECTOR` in `common.js`.
- Upload counts include Shorts and livestream VODs (that's what the uploads playlist contains) –
  which is usually what you want for slop detection, but a busy Shorts creator will score high.
- These are heuristics, not proof: a new, prolific, small channel can be a legit human creator.
- Set *Console logging* in Options (Off / Errors / Warnings / Notes / Trace) to control what shows in the DevTools console; *Trace* adds entry/exit lines
  (page console for `content.js`; *Inspect service worker* on the extensions page for `background.js`).

## Files

- `manifest.json` – MV3 manifest
- `common.js` – defaults, named constants and user-facing text, logging, cache-key and trust/block list helpers (shared)
- `background.js` – API calls, caching, quota backoff (service worker; holds the key)
- `content.js` / `content.css` – tile detection and badge rendering
- `options.html` / `options.js` – settings page
- `LICENSE` – MIT license

## License

MIT – see [LICENSE](LICENSE). Use at your own risk: no warranties, neither express nor implied.
