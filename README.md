# CallTrainer

A local, single-user sales-call trainer. You hold a live, speech-to-speech
conversation with an AI **prospect** (powered by the Gemini Live API), and at any
point you can **replay your own last response** played back through a telephone
filter — so you hear how you actually sounded on the line.

This is an MVP focused on **easy local run and minimal build risk**, not production polish.

## What it does

- Live voice call against an AI prospect (3 scenarios: cold skeptic, price-focused buyer, gatekeeper).
- The prospect talks back, raises objections, and reacts to how you handle them.
- **Replay my last response** — hear your previous turn with a phone-line (300–3400 Hz) filter.
- **Pause / Resume** the call.
- Live transcript of both sides.

## Requirements

- [Node.js](https://nodejs.org) 18+ (you have it if `node -v` prints a version).
- A free Gemini API key: https://aistudio.google.com/apikey
- **Headphones** (so the AI doesn't hear its own voice through your mic).

## Setup (one time)

```bash
cd CallTrainer
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` and paste your key:

```
VITE_GEMINI_API_KEY=your-real-key-here
```

## Run

```bash
npm run dev
```

Your browser opens at `http://localhost:5173`. Click **Start call**, allow the
microphone, and start talking. Click **Replay my last response** any time after
you've spoken.

> If you change `.env`, stop the server (Ctrl+C) and run `npm run dev` again —
> Vite only reads env vars at startup.

## How it works (quick map)

| File | Role |
|------|------|
| `src/gemini.js` | Connects to the Gemini Live API (`gemini-3.1-flash-live-preview`), streams audio in/out, exposes transcripts + interruption events. |
| `src/audio-recorder.js` | Captures the mic, downsamples to PCM16 @ 16 kHz, base64-encodes for Gemini, and buffers each turn for replay. |
| `src/audio-player.js` | Plays the prospect's PCM16 @ 24 kHz audio; flushes instantly on barge-in. |
| `src/phone-filter.js` | Replays your captured turn through a band-pass "telephone" filter. |
| `src/persona.js` | The prospect personas (system instructions). |
| `src/main.js` | UI wiring + call lifecycle. |

## Tuning

- **Different prospect behaviour** → edit `src/persona.js`.
- **Phone sound** → tweak `highpass`/`lowpass` frequencies and the drive amount in `src/phone-filter.js`.
- **A different voice** → add `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` to the `config` in `src/gemini.js`.

## Troubleshooting

- **"No API key"** → you didn't create `.env` or didn't restart the dev server.
- **No prospect audio** → check the browser console; make sure your key has Live API access and you're on a current model name (see `MODEL` in `src/gemini.js`).
- **It hears itself / interrupts constantly** → use headphones.
- **Robotic/garbled replay** → expected to be band-limited (that's the phone effect); if it's worse than that, your browser's mic sample rate may be unusual — the downsampler handles common rates but you can lower the drive in `phone-filter.js`.

## Cost

Gemini Live (`gemini-3.1-flash-live-preview`) bills per minute of audio in/out — a
few cents per practice call at single-user volume. Keep calls short and close the
tab when done. (Sessions also auto-limit: ~15 min of audio without compression.)

## Deploying later (only if you want others to use it)

Right now the API key is embedded in the browser bundle — **fine for local use, not
for public deployment**. To deploy, switch to **ephemeral tokens**: add a tiny
backend endpoint that mints a short-lived token, and have the client connect with
that instead of the raw key. See:
https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens

## Roadmap (next)

- End-of-call scoring (feed the transcript to a cheap text model for a rubric score).
- "True redo" — delete your last exchange so the prospect re-reacts to a new attempt.
- Save/replay whole sessions.

## License

MIT, see [LICENSE](LICENSE).
