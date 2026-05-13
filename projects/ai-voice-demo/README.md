# Now Assist — AI Voice Omnibar Prototype

A clickable HTML prototype demonstrating how an AI voice omnibar moves
between four UI states (hero / dock / transcript / orb) with a persistent
multi-instance waveform and live Gemini / OpenAI voice conversations.

## Run it

There's no build step — but the prototype uses ES modules and `fetch()`
to load assets, so it has to be served over `http://` (not `file://`).

### macOS (one click)

Double-click `run.command` in Finder. It starts a local server on
http://localhost:8765 and opens your browser. Press `Ctrl+C` in the
terminal window to stop.

### Linux / Mac terminal

```bash
./run.sh
```

### Windows (or any system with Python)

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 in any modern browser.

### VS Code

Install the **Live Server** extension, right-click `index.html` → "Open
with Live Server".

---

## Voice conversation setup (optional)

1. Open the app → click the **waveform icon** in the side nav.
2. In the popover, choose **Gemini** (or OpenAI).
3. Paste your API key → click **Save key**. The key is stored in your
   browser's `localStorage` only — it never leaves your machine.
4. Click any **green mic button** to start the conversation. Grant the
   browser's microphone prompt.

Without an API key, the mic button still works as a local-VAD demo — the
waveform reacts to your voice but no AI is involved.

---

## What's in here

- `index.html` — single-page shell with all four omnibar states + home /
  inbox / canvas views
- `assets/js/`
  - `app.js` — view routing + page transitions
  - `omnibar.js` — state machine for the four omnibar shapes
  - `waveform.js` — single state machine driving N synchronized bar instances
  - `voice-client.js` — facade over Gemini / OpenAI realtime clients
  - `transcript-log.js` — live chat-bubble renderer with typewriter pacing
  - `icons.js` — inline SVG / Lottie hydration
  - `voice/` — Gemini and OpenAI WebSocket clients
- `assets/css/` — design tokens, base styles, omnibar state styles
- `assets/icons/` — static SVG icons (Horizon 2 + supplementary)
- `assets/lottie/` — animated nav icons (JSON)
- `assets/fonts/` — ServiceNow Sans family (TTF)

## Browser support

Tested in Chrome, Edge, and Safari (current versions). The voice
conversation features require a browser that supports WebSocket +
`getUserMedia` + `AudioContext` — all current browsers do.
