// Wires the UI to the audio + Gemini modules and manages the call lifecycle.

import { GeminiCall } from './gemini.js';
import { AudioRecorder } from './audio-recorder.js';
import { AudioPlayer } from './audio-player.js';
import { playThroughPhoneFilter } from './phone-filter.js';
import { PERSONAS, DEFAULT_PERSONA } from './persona.js';

const els = {
  scenario: document.getElementById('scenario'),
  start: document.getElementById('startBtn'),
  pause: document.getElementById('pauseBtn'),
  replay: document.getElementById('replayBtn'),
  end: document.getElementById('endBtn'),
  dot: document.getElementById('dot'),
  status: document.getElementById('statusText'),
  error: document.getElementById('error'),
  transcript: document.getElementById('transcript'),
  mic: document.getElementById('mic'),
  micLevel: document.getElementById('micLevel'),
};

let call = null;
let recorder = null;
let player = null;
let paused = false;

// Live transcript accumulation (per turn) so streamed text fragments group nicely.
let repTurnEl = null;
let prospectTurnEl = null;

// --- scenario dropdown ---
for (const [key, p] of Object.entries(PERSONAS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = p.label;
  if (key === DEFAULT_PERSONA) opt.selected = true;
  els.scenario.appendChild(opt);
}

// --- microphone picker ---
async function populateMics() {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let mics = devices.filter((d) => d.kind === 'audioinput');
    // Labels are hidden until mic permission is granted once. If they're blank,
    // do a quick permission probe, then re-enumerate.
    if (mics.length && !mics[0].label) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        mics = devices.filter((d) => d.kind === 'audioinput');
      } catch {}
    }
    const prev = els.mic.value;
    els.mic.innerHTML = '';
    mics.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microphone ${i + 1}`;
      els.mic.appendChild(opt);
    });
    // Auto-avoid obvious virtual/VR devices when first choosing a default.
    if (!prev) {
      const real = mics.find((m) => !/virtual|oculus|vb-audio|cable|stereo mix|aggregate/i.test(m.label));
      if (real) els.mic.value = real.deviceId;
    } else {
      els.mic.value = prev;
    }
  } catch (e) {
    console.debug('[CT] enumerate mics failed', e);
  }
}
populateMics();
navigator.mediaDevices.addEventListener?.('devicechange', populateMics);

function setMeter(peak) {
  if (!els.micLevel) return;
  const pct = Math.min(100, Math.round(peak * 300));
  els.micLevel.textContent = peak > 0.002 ? `${pct}%  ${'▮'.repeat(Math.max(1, Math.round(pct / 8)))}` : 'still';
  els.micLevel.style.color = peak > 0.01 ? 'var(--good)' : (peak > 0.002 ? '#f5c542' : 'var(--danger)');
}

// --- helpers ---
function setStatus(text, state) {
  els.status.textContent = text;
  els.dot.className = 'dot' + (state ? ' ' + state : '');
}
function showError(msg) {
  els.error.textContent = msg || '';
}
function setControls({ start, pause, replay, end }) {
  els.start.disabled = !start;
  els.pause.disabled = !pause;
  els.replay.disabled = !replay;
  els.end.disabled = !end;
}
function appendTurn(who, text) {
  const div = document.createElement('div');
  div.className = 'turn ' + who;
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'rep' ? 'Du' : 'Kunde';
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(label);
  div.appendChild(body);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return body;
}

// --- start call ---
async function startCall() {
  showError('');
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey === 'paste-your-key-here') {
    showError('Kein API-Schlüssel. Kopiere .env.example nach .env, trage VITE_GEMINI_API_KEY ein und starte `npm run dev` neu.');
    return;
  }

  setControls({ start: false, pause: false, replay: false, end: false });
  setStatus('Verbinde…');

  try {
    player = new AudioPlayer();
    await player.resume();

    recorder = new AudioRecorder();

    window.__ct = { sent: 0, recv: 0, snapshots: 0, replays: 0 };

    call = new GeminiCall(apiKey).on({
      onAudio: (b64) => {
        window.__ct.recv++;
        if (window.__ct.recv % 25 === 1) console.debug('[CT] model audio chunks recv:', window.__ct.recv);
        player.enqueue(b64);
      },
      onModelTurnStart: () => {
        // The prospect started replying => the user's turn just ended. Snapshot it.
        recorder.snapshotTurn();
        const t = recorder.getLastTurn();
        window.__ct.snapshots++;
        console.debug('[CT] model turn start → snapshot #' + window.__ct.snapshots,
          t ? `(${t.samples.length} samples @ ${t.sampleRate}Hz)` : '(empty)');
        els.replay.disabled = false;
        prospectTurnEl = null; // start a fresh prospect bubble
      },
      onInterrupted: () => { if (player) player.flush(); },
      onUserText: (t) => {
        if (!repTurnEl) repTurnEl = appendTurn('rep', '');
        repTurnEl.textContent += t;
        els.transcript.scrollTop = els.transcript.scrollHeight;
      },
      onModelText: (t) => {
        if (!prospectTurnEl) prospectTurnEl = appendTurn('prospect', '');
        prospectTurnEl.textContent += t;
        els.transcript.scrollTop = els.transcript.scrollHeight;
      },
      onTurnComplete: () => { repTurnEl = null; },
      onError: (m) => showError('Gemini-Fehler: ' + m),
      onClose: (r) => { if (r) showError('Verbindung getrennt: ' + r); },
    });

    const persona = PERSONAS[els.scenario.value]?.text || PERSONAS[DEFAULT_PERSONA].text;
    await call.connect(persona);

    await recorder.start(
      (b64) => {
        if (!paused) {
          call.sendAudio(b64);
          window.__ct.sent++;
          if (window.__ct.sent % 50 === 1) console.debug('[CT] mic chunks sent:', window.__ct.sent);
        }
      },
      { deviceId: els.mic.value || undefined, onLevel: setMeter }
    );
    // Refresh labels now that permission is definitely granted.
    populateMics();

    paused = false;
    setStatus('Live — sprich los', 'live');
    setControls({ start: false, pause: true, replay: false, end: true });
  } catch (err) {
    console.error(err);
    showError('Start fehlgeschlagen: ' + (err?.message || err));
    await teardown();
    setStatus('Bereit');
    setControls({ start: true, pause: false, replay: false, end: false });
  }
}

// --- pause / resume ---
function togglePause() {
  if (!call) return;
  paused = !paused;
  if (recorder) recorder.setMuted(paused);
  if (paused) {
    call.endAudioStream(); // flush buffered audio on the server side
    setStatus('Pausiert', 'paused');
    els.pause.textContent = 'Fortsetzen';
  } else {
    setStatus('Live — sprich los', 'live');
    els.pause.textContent = 'Pause';
  }
}

// --- replay my last response (phone-filtered) ---
async function replayLast() {
  if (!recorder) return;
  const turn = recorder.getLastTurn();
  if (!turn) { showError('Noch nichts zum Abspielen — sag zuerst etwas.'); return; }
  showError('');
  const wasPaused = paused;
  if (!wasPaused) { paused = true; recorder.setMuted(true); } // avoid feeding replay back in
  els.replay.disabled = true;
  setStatus('Spiele deine letzte Antwort ab…', 'paused');
  if (window.__ct) window.__ct.replays++;
  console.debug('[CT] replay start:', `${turn.samples.length} samples @ ${turn.sampleRate}Hz`,
    `(~${(turn.samples.length / turn.sampleRate).toFixed(1)}s)`);
  try {
    await playThroughPhoneFilter(turn);
    console.debug('[CT] replay done');
  } finally {
    els.replay.disabled = false;
    if (!wasPaused) { paused = false; recorder.setMuted(false); setStatus('Live — sprich los', 'live'); }
    else setStatus('Pausiert', 'paused');
  }
}

// --- end call ---
async function endCall() {
  await teardown();
  setStatus('Anruf beendet', '');
  setControls({ start: true, pause: false, replay: false, end: false });
  els.pause.textContent = 'Pause';
}

async function teardown() {
  try { recorder && (await recorder.stop()); } catch {}
  try { player && (await player.close()); } catch {}
  try { call && call.close(); } catch {}
  recorder = player = call = null;
  paused = false;
  repTurnEl = prospectTurnEl = null;
}

// --- events ---
els.start.addEventListener('click', startCall);
els.pause.addEventListener('click', togglePause);
els.replay.addEventListener('click', replayLast);
els.end.addEventListener('click', endCall);

setStatus('Bereit');
setControls({ start: true, pause: false, replay: false, end: false });
