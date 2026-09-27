# Digital Footprint Monitor (Chrome extension)

A small popup extension that tracks estimated data usage **per website**
and converts it into energy, water and CO2e using the same model as the
original desktop tool:

```
energy (kWh) = GB transferred x 0.06 kWh/GB
water  (L)   = energy x 0.50 L/kWh
co2e   (g)   = energy x 400 g/kWh
```

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension and click its icon to open the popup.

## What it tracks

- Every network request made while a tab is open is attributed to that
  tab's current website (hostname) — not to a generic "app" the way the
  original process-based tool did.
- **Download** bytes come from the `Content-Length` response header when
  a server sends one. **Upload** bytes come from the outgoing request
  body when present. Traffic without a `Content-Length` (some streamed
  or chunked responses) is under-counted, so treat these numbers as an
  estimate — exactly as the original tool's coefficients were estimates,
  not a metered reading.

## Two views, one history

- **Session** — usage since Chrome was actually started (a fresh
  browser launch), not since the popup or background worker last woke
  up.
- **All-time** — every byte recorded since the extension was installed,
  persisted in `chrome.storage.local`. This survives closing Chrome,
  restarting your computer, and the extension's background worker being
  unloaded — it is only cleared if you click **Reset all-time**.

## Files

- `manifest.json` — MV3 manifest, permissions and popup/icon wiring.
- `background.js` — service worker: listens to `webRequest`, aggregates
  bytes per hostname, persists to storage, and answers the popup's
  `GET_SNAPSHOT` / `RESET_ALL_TIME` messages.
- `popup.html` / `popup.css` / `popup.js` — the popup UI.
- `icons/` — toolbar icons.

## Known limitations

- Byte counts are an estimate (see above), not a precise packet-level
  measurement like the original `scapy`-based tool. Chrome extensions
  don't have raw packet access, so `webRequest` header/body sizes are
  the closest approximation available in-browser.
- Requests made outside any tab (tabId `-1`) aren't attributed to a
  site and are excluded from the totals.
