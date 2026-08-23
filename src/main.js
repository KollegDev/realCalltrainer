// Wires the UI to the audio + Gemini modules and manages the call lifecycle.
//
// Call flow (ported from the new callTrainer): ring tone → connect → the
// prospect picks up and speaks FIRST (stage-directed greeting + difficulty
// mood) → conversation → someone hangs up (the prospect can, via the
// end_call tool) → busy tone if the prospect hung up → scorecard.

import { GeminiCall } from './gemini.js';
import { AudioRecorder } from './audio-recorder.js';
import { AudioPlayer } from './audio-player.js';
import { playThroughPhoneFilter } from './phone-filter.js';
import { loadRoles, DIFFICULTY, saveRoleEdit, resetRole, isEdited, DEFAULT_ROLE } from './roles.js';
import { GeminiLLM } from './llm.js';
import { gradeCall, outcomeLabel } from './scorecard.js';
import { startRing, playBusy } from './tones.js';

const els = {
  scenario: document.getElementById('scenario'),
  roleTag: document.getElementById('roleTag'),
  difficulty: document.getElementById('difficulty'),
  editBtn: document.getElementById('editBtn'),
  editedBadge: document.getElementById('editedBadge'),
  editPanel: document.getElementById('editPanel'),
  editGreeting: document.getElementById('editGreeting'),
  editPrompt: document.getElementById('editPrompt'),
  saveRoleBtn: document.getElementById('saveRoleBtn'),
  resetRoleBtn: document.getElementById('resetRoleBtn'),
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
  scorecard: document.getElementById('scorecard'),
  scoreNum: document.getElementById('scoreNum'),
  scoreVerdict: document.getElementById('scoreVerdict'),
  scoreOutcome: document.getElementById('scoreOutcome'),
  scoreStrengths: document.getElementById('scoreStrengths'),
  scoreMistakes: document.getElementById('scoreMistakes'),
  scoreMissed: document.getElementById('scoreMissed'),
  scoreNext: document.getElementById('scoreNext'),
  scoreLines: document.getElementById('scoreLines'),
  scoreMetrics: document.getElementById('scoreMetrics'),
};

let call = null;
let recorder = null;
let player = null;
let ring = null;
let paused = false;
let ending = false; // re-entrancy guard: prospect hangup + user hangup racing

// Mic gate during the pick-up greeting. Two reasons: the caller should not
// talk over the ring, and — without headphones — the greeting's own echo
// would trip the server VAD as a barge-in and cut the greeting off.
let awaitingGreeting = false;
let greetWatchdog = null; // cleared in onTurnComplete and teardown

// Call report state.
let history = [];              // [{ role:'user'|'model', text, t }]
let interruptionsByUser = 0;
let callStartedAt = 0;
let outcome = null;            // 'sale' | 'hangup_bot' | 'hangup_user' | 'error'
let agreedStep = '';

// Live transcript accumulation (per turn) so streamed text fragments group nicely.
let repEntry = null;      // { el, rec } — DOM body element + history record
let prospectEntry = null;

/* ── role + difficulty UI ───────────────────────────────────────────────── */

function currentRole() {
  return loadRoles().find(r => r.id === els.scenario.value) || loadRoles()[0];
}

function populateRoles() {
  const roles = loadRoles();
  const prev = els.scenario.value || DEFAULT_ROLE;
  els.scenario.innerHTML = '';
  const groups = { de: document.createElement('optgroup'), en: document.createElement('optgroup') };
  groups.de.label = 'Deutsch';
  groups.en.label = 'English';
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name + (isEdited(r.id) ? ' *' : '');
    (groups[r.lang] || groups.de).appendChild(opt);
  }
  els.scenario.appendChild(groups.de);
  els.scenario.appendChild(groups.en);
  els.scenario.value = prev;
  if (!els.scenario.value) els.scenario.value = DEFAULT_ROLE;
  refreshRoleInfo();
}

function refreshRoleInfo() {
  const r = currentRole();
  els.roleTag.textContent = r.tag;
  els.editedBadge.textContent = isEdited(r.id) ? 'angepasst — Original per Reset wiederherstellbar' : '';
  if (els.editPanel.classList.contains('open')) fillEditPanel();
}

function fillEditPanel() {
  const r = currentRole();
  els.editGreeting.value = r.greeting;
  els.editPrompt.value = r.prompt;
}

for (const [key, d] of Object.entries(DIFFICULTY)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = d.labelDe;
  if (key === 'normal') opt.selected = true;
  els.difficulty.appendChild(opt);
}

populateRoles();
els.scenario.addEventListener('change', refreshRoleInfo);

els.editBtn.addEventListener('click', () => {
  const open = els.editPanel.classList.toggle('open');
  els.editBtn.textContent = open ? 'Editor schließen' : 'Rolle bearbeiten';
  if (open) fillEditPanel();
});
els.saveRoleBtn.addEventListener('click', () => {
  const r = currentRole();
  saveRoleEdit(r.id, { greeting: els.editGreeting.value.trim() || r.greeting, prompt: els.editPrompt.value });
  populateRoles();
});
els.resetRoleBtn.addEventListener('click', () => {
  resetRole(currentRole().id);
  populateRoles();
  fillEditPanel();
});

/* ── microphone picker ──────────────────────────────────────────────────── */

async function populateMics() {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let mics = devices.filter((d) => d.kind === 'audioinput');
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
      opt.textContent = m.label || `Mikrofon ${i + 1}`;
      els.mic.appendChild(opt);
    });
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
  els.micLevel.style.color = peak > 0.01 ? 'var(--good)' : (peak > 0.002 ? 'var(--warn)' : 'var(--danger)');
}

/* ── helpers ────────────────────────────────────────────────────────────── */

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
  label.textContent = who === 'rep' ? 'Du' : currentRole().name;
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(label);
  div.appendChild(body);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  const rec = { role: who === 'rep' ? 'user' : 'model', text, t: Date.now() };
  history.push(rec);
  return { el: body, rec };
}

function addText(entryRef, who, fragment) {
  let entry = entryRef.value;
  if (!entry) entry = entryRef.value = appendTurn(who, '');
  entry.rec.text += fragment;
  entry.el.textContent = entry.rec.text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/* ── start call ─────────────────────────────────────────────────────────── */

async function startCall() {
  showError('');
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey === 'paste-your-key-here') {
    showError('Kein API-Schlüssel. Kopiere .env.example nach .env, trage VITE_GEMINI_API_KEY ein und starte `npm run dev` neu.');
    return;
  }

  const role = currentRole();
  const diff = DIFFICULTY[els.difficulty.value] || DIFFICULTY.normal;
  const de = role.lang === 'de';

  // Fresh report state.
  history = [];
  interruptionsByUser = 0;
  outcome = null;
  agreedStep = '';
  ending = false;
  awaitingGreeting = true;
  repEntry = { value: null };
  prospectEntry = { value: null };
  els.transcript.innerHTML = '';
  els.scorecard.classList.remove('open');

  setControls({ start: false, pause: false, replay: false, end: false });
  setStatus('Wählen…', 'ringing');

  try {
    player = new AudioPlayer();
    await player.resume();
    ring = startRing(player.ctx);
    setStatus('Es klingelt…', 'ringing');

    recorder = new AudioRecorder();

    window.__ct = { sent: 0, recv: 0, snapshots: 0, replays: 0 };

    call = new GeminiCall(apiKey).on({
      onAudio: (b64) => {
        window.__ct.recv++;
        player && player.enqueue(b64);
      },
      onModelTurnStart: () => {
        // First voice = the prospect picked up. Stop the ring exactly here —
        // this handler runs before the first audio chunk is enqueued, so ring
        // and voice can never overlap.
        if (ring) { ring.stop(); ring = null; }
        // The prospect started replying => the user's turn just ended. Snapshot it.
        recorder && recorder.snapshotTurn();
        window.__ct.snapshots++;
        // No replay for the empty pre-greeting buffer; enable from then on.
        els.replay.disabled = awaitingGreeting;
        prospectEntry.value = null; // start a fresh prospect bubble
      },
      onInterrupted: () => {
        interruptionsByUser++;
        if (player) player.flush();
      },
      onUserText: (t) => addText(repEntry, 'rep', t),
      onModelText: (t) => addText(prospectEntry, 'prospect', t),
      onTurnComplete: () => {
        repEntry.value = null;
        // Greeting finished — open the mic and go live.
        if (awaitingGreeting) {
          awaitingGreeting = false;
          if (greetWatchdog) { clearTimeout(greetWatchdog); greetWatchdog = null; }
          callStartedAt = Date.now();
          setStatus('Live — sprich los', 'live');
          setControls({ start: false, pause: true, replay: false, end: true });
        }
      },
      onToolCall: ({ name, args }) => {
        if (name === 'agree_next_step') {
          outcome = 'sale';
          agreedStep = args.next_step || '';
          setStatus('Nächster Schritt vereinbart ✓ — Gespräch läuft', 'live');
        } else if (name === 'end_call') {
          if (outcome !== 'sale') outcome = 'hangup_bot';
          endByProspect(args.reason || '');
        }
      },
      onError: (m) => showError('Gemini-Fehler: ' + m),
      onClose: (r) => { if (r && !ending) showError('Verbindung getrennt: ' + r); },
    });

    // Mic first, while it "rings": the permission prompt happens under the
    // ring tone instead of delaying the greeting. Chunks are gated — nothing
    // is sent until the greeting has finished (awaitingGreeting).
    await recorder.start(
      (b64) => {
        if (!paused && !awaitingGreeting && call) {
          call.sendAudio(b64);
          window.__ct.sent++;
        }
      },
      { deviceId: els.mic.value || undefined, onLevel: setMeter }
    );
    populateMics(); // refresh labels now that permission is granted

    // connect() resolves only after the server confirmed setupComplete, so
    // the greeting directive below cannot be dropped anymore.
    await call.connect({ systemInstruction: role.prompt, voice: role.voice, lang: role.lang });

    call.sendDirective(de
      ? `[REGIE — nicht vorlesen] Du hast gerade abgenommen. Melde dich genau so und nur so: "${role.greeting}". Sag sonst nichts. Deine Laune heute: ${diff.de}`
      : `[STAGE DIRECTION — do not read out] You have just picked up. Answer exactly and only with: "${role.greeting}". Say nothing else. Your mood today: ${diff.en}`);

    // The ring keeps ringing until the first greeting audio arrives
    // (stopped in onModelTurnStart). Status flips to Live in onTurnComplete.
    // If no greeting arrives at all, don't ring forever.
    greetWatchdog = setTimeout(() => {
      if (awaitingGreeting && !ending) {
        showError('Keine Antwort vom Modell — Anruf abgebrochen.');
        endCall();
      }
    }, 15000);
    paused = false;
    setControls({ start: false, pause: false, replay: false, end: true });
  } catch (err) {
    console.error(err);
    showError('Start fehlgeschlagen: ' + (err?.message || err));
    if (ring) { ring.stop(); ring = null; }
    await teardown();
    setStatus('Bereit');
    setControls({ start: true, pause: false, replay: false, end: false });
  }
}

/* ── pause / resume ─────────────────────────────────────────────────────── */

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

/* ── replay my last response (phone-filtered) ───────────────────────────── */

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
  try {
    await playThroughPhoneFilter(turn);
  } finally {
    els.replay.disabled = false;
    if (!wasPaused) { paused = false; recorder.setMuted(false); setStatus('Live — sprich los', 'live'); }
    else setStatus('Pausiert', 'paused');
  }
}

/* ── ending the call ────────────────────────────────────────────────────── */

// The prospect hung up (end_call tool): mic off, busy tone, then scorecard.
async function endByProspect(reason) {
  if (ending) return;
  ending = true;
  if (ring) { ring.stop(); ring = null; }
  awaitingGreeting = false;
  setControls({ start: false, pause: false, replay: false, end: false });
  setStatus('Aufgelegt' + (reason ? ` — ${reason}` : ''), '');
  try { recorder && (await recorder.stop()); } catch {}
  try { call && call.close(); } catch {}
  call = null; recorder = null;
  if (player) {
    try { player.flush(); await playBusy(player.ctx); } catch {}
    try { await player.close(); } catch {}
    player = null;
  }
  paused = false;
  els.pause.textContent = 'Pause';
  setControls({ start: true, pause: false, replay: false, end: false });
  await grade();
}

// The user hung up.
async function endCall() {
  if (ending) return;
  ending = true;
  if (outcome === null) outcome = 'hangup_user';
  await teardown();
  setStatus('Anruf beendet', '');
  setControls({ start: true, pause: false, replay: false, end: false });
  els.pause.textContent = 'Pause';
  await grade();
}

async function teardown() {
  if (ring) { ring.stop(); ring = null; }
  if (greetWatchdog) { clearTimeout(greetWatchdog); greetWatchdog = null; }
  awaitingGreeting = false;
  try { recorder && (await recorder.stop()); } catch {}
  try { player && (await player.close()); } catch {}
  try { call && call.close(); } catch {}
  recorder = player = call = null;
  paused = false;
  repEntry = { value: null };
  prospectEntry = { value: null };
}

/* ── scorecard ──────────────────────────────────────────────────────────── */

async function grade() {
  const role = currentRole();
  const userTurns = history.filter(h => h.role === 'user' && h.text.trim());
  if (userTurns.length < 1) return; // nothing to grade

  setStatus('Bewertung läuft…', 'paused');
  const report = {
    lang: role.lang,
    role: { name: role.name, tag: role.tag },
    history: history.filter(h => h.text.trim()),
    durationSec: Math.max(1, Math.round((Date.now() - callStartedAt) / 1000)),
    interruptionsByUser,
    outcome: outcome || 'hangup_user',
  };

  const llm = new GeminiLLM({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
  const result = await gradeCall(llm, report);
  renderScorecard(result, role.lang === 'de');
  setStatus('Anruf beendet — Bewertung unten', '');
}

function renderScorecard(r, de) {
  els.scoreNum.textContent = r.score;
  els.scoreNum.className = 'score-num ' + (r.score >= 70 ? 'good' : r.score >= 45 ? 'mid' : 'bad');
  els.scoreVerdict.textContent = r.verdict || '';
  els.scoreOutcome.textContent =
    outcomeLabel(r.report.outcome, de) +
    (agreedStep ? ` — ${de ? 'Vereinbart' : 'Agreed'}: ${agreedStep}` : '');

  const fill = (ul, items) => {
    ul.innerHTML = '';
    for (const s of items || []) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    }
    if (!items || !items.length) {
      const li = document.createElement('li');
      li.textContent = '—';
      ul.appendChild(li);
    }
  };
  fill(els.scoreStrengths, r.strengths);
  fill(els.scoreMistakes, r.mistakes);

  els.scoreMissed.innerHTML = '';
  if (r.missedSignal) {
    els.scoreMissed.innerHTML = `<b>${de ? 'Verdecktes Signal' : 'Hidden signal'}</b><br>`;
    els.scoreMissed.append(r.missedSignal);
  }
  els.scoreNext.innerHTML = `<b>${de ? 'Nächstes Mal' : 'Next time'}</b><br>`;
  els.scoreNext.append(r.nextTime || '—');

  els.scoreLines.innerHTML = '';
  if (r.bestLine || r.worstLine) {
    els.scoreLines.innerHTML = `<b>${de ? 'Beste / schwächste Zeile' : 'Best / weakest line'}</b><br>`;
    els.scoreLines.append(`${r.bestLine ? '+ „' + r.bestLine + '“' : ''}${r.bestLine && r.worstLine ? '\n' : ''}${r.worstLine ? '− „' + r.worstLine + '“' : ''}`);
  }

  const m = r.metrics;
  els.scoreMetrics.innerHTML = '';
  const metricDefs = [
    [de ? 'Dauer' : 'Duration', `${r.report.durationSec}s`],
    [de ? 'Redeanteil' : 'Talk share', `${m.talkRatioPct}%`],
    [de ? 'Fragen' : 'Questions', m.questionsAsked],
    [de ? 'Unterbrochen' : 'Interrupted', r.report.interruptionsByUser],
    [de ? 'Zeit bis zum Punkt' : 'Time to point', m.timeToPoint === null ? (de ? 'nie' : 'never') : `${m.timeToPoint}s`],
  ];
  for (const [label, val] of metricDefs) {
    const div = document.createElement('div');
    div.className = 'metric';
    const b = document.createElement('b');
    b.textContent = String(val);
    div.appendChild(b);
    div.append(label);
    els.scoreMetrics.appendChild(div);
  }

  els.scorecard.classList.add('open');
  els.scorecard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── events ─────────────────────────────────────────────────────────────── */

els.start.addEventListener('click', startCall);
els.pause.addEventListener('click', togglePause);
els.replay.addEventListener('click', replayLast);
els.end.addEventListener('click', endCall);

setStatus('Bereit');
setControls({ start: true, pause: false, replay: false, end: false });

// PWA: register the service worker in production builds only — a SW in dev
// serves stale modules and turns every change into a caching mystery.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.debug('[CT] sw register failed', e));
}
