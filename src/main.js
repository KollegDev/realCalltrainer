// App-Shell wiring: phases (idle/call/end), DE/EN i18n, sheets and drawer.
// The call engine flow is unchanged: ring → connect (waits for setupComplete)
// → stage-directed greeting → conversation → hangup → busy tone → scorecard.

import { GeminiCall } from './gemini.js';
import { AudioRecorder } from './audio-recorder.js';
import { AudioPlayer } from './audio-player.js';
import { playThroughPhoneFilter } from './phone-filter.js';
import { loadRoles, DIFFICULTY, saveRoleEdit, resetRole, isEdited } from './roles.js';
import { GeminiLLM } from './llm.js';
import { gradeCall, outcomeLabel } from './scorecard.js';
import { startRing, playBusy } from './tones.js';

/* ── i18n ───────────────────────────────────────────────────────────────── */

const LANG_KEY = 'ct.lang';
const INTRO_KEY = 'ct.intro.v1';
const CONSENT_KEY = 'ct.consent.v1';

const STR = {
  de: {
    replay: 'Letzte Antwort abspielen',
    pause: 'Pause', resume: 'Fortsetzen',
    callLabel: 'Anrufen', endLabel: 'Auflegen', gearCaption: 'Einstellungen',
    cfgTitle: 'Szenario', cfgRole: 'Gesprächspartner', cfgDiff: 'Schwierigkeit',
    cfgEdit: 'Rolle bearbeiten', cfgGreeting: 'Begrüßung beim Abheben',
    cfgPrompt: 'System-Prompt (inkl. verdeckter Spielregeln — frei anpassbar)',
    save: 'Speichern', reset: 'Auf Original zurücksetzen',
    editedBadge: 'angepasst',
    miIntro: 'Intro', miLang: 'Sprache', miMic: 'Mikrofon', miPrivacy: 'Datenschutz',
    miImpressum: 'Impressum',
    voteCaption: 'Gefällt dir CallTrainer? Stimm ab:',
    voteThanks: 'Danke für dein Feedback!',
    micLevelLabel: 'Pegel',
    micHint: 'Kopfhörer nutzen, damit die KI sich nicht selbst hört. Echtes Mikrofon wählen (kein virtuelles/VR-Gerät).',
    introTitle: 'CallTrainer',
    introBody: 'Kaltakquise üben. Mit authentischem menschlichem Verhalten. Wähle die Schwierigkeit für den Abschluss.',
    introOk: 'Los geht’s',
    consentTitle: 'Bevor es losgeht',
    consentIntro: 'Diese App nimmt deine Stimme auf, damit der simulierte Gesprächspartner in Echtzeit antworten kann.',
    consentWarnTitle: 'Wichtig im Testbetrieb',
    consentWarnBody: 'Der Test läuft über die kostenlose Stufe der Google-Gemini-API. Google nutzt die übertragenen Daten – auch deine Sprachaufnahmen – zur Verbesserung eigener Produkte. Sag deshalb keine echten Kundennamen, Preise oder vertraulichen Angaben. Denk dir Beispiele aus.',
    consentP1: 'Wir speichern deine Anrufe nicht auf unserem Server.',
    consentP2: 'Kein Konto, keine Anmeldung, kein Tracking.',
    consentP3: 'Deine Rollenänderungen bleiben nur in diesem Browser.',
    consentPrivacy: 'Vollständige Datenschutzerklärung',
    consentOk: 'Ich bin einverstanden und benutze nur erfundene Beispiele',
    consentAge: 'Ab 18 Jahren.',
    scoreTitle: 'Bewertung', scoreStrengths: 'Stärken', scoreMistakes: 'Fehler',
    scoreTranscript: 'Transkript', report: 'Inhalt melden',
    stReady: 'Bereit', stDialing: 'Wählen…', stRinging: 'Es klingelt…',
    stLive: 'Live — sprich los', stPaused: 'Pausiert',
    stReplay: 'Spiele deine letzte Antwort ab…',
    stHungup: 'Aufgelegt', stEnded: 'Anruf beendet', stGrading: 'Bewertung läuft…',
    stNextStep: 'Nächster Schritt vereinbart ✓',
    you: 'Du',
    errNoKey: 'Kein API-Schlüssel konfiguriert.',
    errStart: 'Start fehlgeschlagen: ',
    errGemini: 'Gemini-Fehler: ',
    errClosed: 'Verbindung getrennt: ',
    errNoReply: 'Keine Antwort vom Modell — Anruf abgebrochen.',
    errNothingToReplay: 'Noch nichts zum Abspielen — sag zuerst etwas.',
    reportSubject: 'Inhalt melden — Cold Call Trainer',
    reportIntro: 'Ich möchte eine KI-Antwort aus einem simulierten Anruf melden.',
    reportRole: 'Rolle', reportTime: 'Zeit', reportTranscript: 'Transkript',
    reportWhat: 'Was war anstößig?',
    caller: 'ANRUFER',
  },
  en: {
    replay: 'Replay my last answer',
    pause: 'Pause', resume: 'Resume',
    callLabel: 'Call', endLabel: 'Hang up', gearCaption: 'Settings',
    cfgTitle: 'Scenario', cfgRole: 'Prospect', cfgDiff: 'Difficulty',
    cfgEdit: 'Edit role', cfgGreeting: 'Greeting on pick-up',
    cfgPrompt: 'System prompt (incl. hidden rules — fully editable)',
    save: 'Save', reset: 'Reset to original',
    editedBadge: 'edited',
    miIntro: 'Intro', miLang: 'Language', miMic: 'Microphone', miPrivacy: 'Privacy',
    miImpressum: 'Legal notice',
    voteCaption: 'Enjoying CallTrainer? Vote:',
    voteThanks: 'Thanks for your feedback!',
    micLevelLabel: 'Level',
    micHint: 'Use headphones so the AI does not hear itself. Pick your real microphone (no virtual/VR device).',
    introTitle: 'CallTrainer',
    introBody: 'Practice cold calling. With authentic human behavior. Select the difficulty for making a sale.',
    introOk: 'Let’s go',
    consentTitle: 'Before we start',
    consentIntro: 'This app records your voice so the simulated prospect can answer in real time.',
    consentWarnTitle: 'Important during the test phase',
    consentWarnBody: 'The test runs on the free tier of the Google Gemini API. Google uses the transmitted data – including your voice recordings – to improve its own products. So do not say real customer names, prices or confidential details. Make up examples.',
    consentP1: 'We do not store your calls on our server.',
    consentP2: 'No account, no sign-in, no tracking.',
    consentP3: 'Your role edits stay in this browser only.',
    consentPrivacy: 'Full privacy policy',
    consentOk: 'I agree and will only use made-up examples',
    consentAge: 'Ages 18 and up.',
    scoreTitle: 'Evaluation', scoreStrengths: 'Strengths', scoreMistakes: 'Mistakes',
    scoreTranscript: 'Transcript', report: 'Report content',
    stReady: 'Ready', stDialing: 'Dialling…', stRinging: 'Ringing…',
    stLive: 'Live — go ahead', stPaused: 'Paused',
    stReplay: 'Playing your last answer…',
    stHungup: 'Hung up', stEnded: 'Call ended', stGrading: 'Grading…',
    stNextStep: 'Next step agreed ✓',
    you: 'You',
    errNoKey: 'No API key configured.',
    errStart: 'Start failed: ',
    errGemini: 'Gemini error: ',
    errClosed: 'Connection lost: ',
    errNoReply: 'No reply from the model — call aborted.',
    errNothingToReplay: 'Nothing to replay yet — say something first.',
    reportSubject: 'Report content — Cold Call Trainer',
    reportIntro: 'I want to report an AI reply from a simulated call.',
    reportRole: 'Role', reportTime: 'Time', reportTranscript: 'Transcript',
    reportWhat: 'What was offensive?',
    caller: 'CALLER',
  },
};

// Default: the device language. No first-run popup — the user can switch it
// any time in the menu.
let lang = localStorage.getItem(LANG_KEY)
  || ((navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en');
const t = (key) => (STR[lang] && STR[lang][key]) || STR.de[key] || key;

/* ── elements ───────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const els = {
  menuBtn: $('menuBtn'), gearBtn: $('gearBtn'),
  roleName: $('roleName'), roleTag: $('roleTag'), roleDiff: $('roleDiff'),
  error: $('error'), dot: $('dot'), status: $('statusText'),
  replay: $('replayBtn'), pause: $('pauseBtn'), start: $('startBtn'), end: $('endBtn'),
  configOverlay: $('configOverlay'), menuOverlay: $('menuOverlay'),
  introOverlay: $('introOverlay'), consent: $('consent'), scoreOverlay: $('scoreOverlay'),
  scenario: $('scenario'), cfgRoleTag: $('cfgRoleTag'), editedBadge: $('editedBadge'),
  difficulty: $('difficulty'),
  editGreeting: $('editGreeting'), editPrompt: $('editPrompt'),
  saveRoleBtn: $('saveRoleBtn'), resetRoleBtn: $('resetRoleBtn'),
  miIntro: $('miIntro'), langDe: $('langDe'), langEn: $('langEn'),
  introLangDe: $('introLangDe'), introLangEn: $('introLangEn'), introOk: $('introOk'),
  mic: $('mic'), micLevel: $('micLevel'),
  consentBtn: $('consentBtn'), reportBtn: $('reportBtn'),
  voteCaption: $('voteCaption'), voteUp: $('voteUp'), voteDown: $('voteDown'), voteBalance: $('voteBalance'),
  transcript: $('transcript'),
  scoreNum: $('scoreNum'), scoreVerdict: $('scoreVerdict'), scoreOutcome: $('scoreOutcome'),
  scoreStrengths: $('scoreStrengths'), scoreMistakes: $('scoreMistakes'),
  scoreMissed: $('scoreMissed'), scoreNext: $('scoreNext'),
  scoreLines: $('scoreLines'), scoreMetrics: $('scoreMetrics'),
};

/* ── call state ─────────────────────────────────────────────────────────── */

let call = null;
let recorder = null;
let player = null;
let ring = null;
let paused = false;
let ending = false; // re-entrancy guard: prospect hangup + user hangup racing

// Mic gate during the pick-up greeting: the caller should not talk over the
// ring, and — without headphones — the greeting's echo would trip the server
// VAD as a barge-in and cut the greeting off.
let awaitingGreeting = false;
let greetWatchdog = null; // cleared in onTurnComplete and teardown

let history = [];              // [{ role:'user'|'model', text, t }]
let interruptionsByUser = 0;
let callStartedAt = 0;
let outcome = null;            // 'sale' | 'hangup_bot' | 'hangup_user' | 'error'
let agreedStep = '';

let repEntry = { value: null };
let prospectEntry = { value: null };

/* ── phases & overlays ──────────────────────────────────────────────────── */

function setPhase(p) { document.body.dataset.phase = p; }

function openOverlay(el) { el.classList.add('open'); }
function closeOverlay(el) { el.classList.remove('open'); }

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeOverlay($(btn.dataset.close)));
});
// Tap on the backdrop closes sheets (but not consent/intro — they have buttons).
[els.configOverlay, els.menuOverlay, els.scoreOverlay].forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(ov); });
});

els.menuBtn.addEventListener('click', () => openOverlay(els.menuOverlay));
els.gearBtn.addEventListener('click', () => openOverlay(els.configOverlay));

/* ── i18n application ───────────────────────────────────────────────────── */

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  els.pause.textContent = paused ? t('resume') : t('pause');
  [els.langDe, els.introLangDe].forEach((b) => b.classList.toggle('on', lang === 'de'));
  [els.langEn, els.introLangEn].forEach((b) => b.classList.toggle('on', lang === 'en'));
  if (sessionStorage.getItem('ct.voted')) els.voteCaption.textContent = t('voteThanks');
  populateRoles();
  populateDifficulty();
  if (!call) setStatus(t('stReady'), '');
}

function setLang(next) {
  if (lang === next) return;
  lang = next;
  localStorage.setItem(LANG_KEY, lang);
  applyLang();
}

els.langDe.addEventListener('click', () => setLang('de'));
els.langEn.addEventListener('click', () => setLang('en'));
els.introLangDe.addEventListener('click', () => setLang('de'));
els.introLangEn.addEventListener('click', () => setLang('en'));

/* ── intro (first run + menu) ───────────────────────────────────────────── */

els.miIntro.addEventListener('click', () => {
  closeOverlay(els.menuOverlay);
  openOverlay(els.introOverlay);
});
els.introOk.addEventListener('click', () => {
  localStorage.setItem(INTRO_KEY, 'seen');
  closeOverlay(els.introOverlay);
});
// First run: the intro doubles as the language picker. The chosen language
// drives everything downstream — UI strings, the role list, and thus the
// language the prospect speaks and is graded in.
if (localStorage.getItem(INTRO_KEY) !== 'seen') openOverlay(els.introOverlay);

/* ── roles & difficulty ─────────────────────────────────────────────────── */

function rolesForLang() { return loadRoles().filter((r) => r.lang === lang); }

function currentRole() {
  return rolesForLang().find((r) => r.id === els.scenario.value) || rolesForLang()[0];
}

function populateRoles() {
  const roles = rolesForLang();
  const prev = els.scenario.value;
  els.scenario.innerHTML = '';
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name + (isEdited(r.id) ? ' *' : '');
    els.scenario.appendChild(opt);
  }
  els.scenario.value = roles.some((r) => r.id === prev) ? prev : roles[0].id;
  refreshRoleInfo();
}

function populateDifficulty() {
  const prev = els.difficulty.value || 'normal';
  els.difficulty.innerHTML = '';
  for (const [key, d] of Object.entries(DIFFICULTY)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = lang === 'de' ? d.labelDe : d.labelEn;
    els.difficulty.appendChild(opt);
  }
  els.difficulty.value = prev;
  refreshRoleInfo();
}

function refreshRoleInfo() {
  const r = currentRole();
  if (!r) return;
  els.roleName.textContent = r.name;
  els.roleTag.textContent = r.tag;
  const d = DIFFICULTY[els.difficulty.value] || DIFFICULTY.normal;
  els.roleDiff.textContent = lang === 'de' ? d.labelDe : d.labelEn;
  els.cfgRoleTag.textContent = r.tag;
  els.editedBadge.textContent = isEdited(r.id) ? '· ' + t('editedBadge') : '';
  fillEditPanel();
}

function fillEditPanel() {
  const r = currentRole();
  if (!r) return;
  els.editGreeting.value = r.greeting;
  els.editPrompt.value = r.prompt;
}

els.scenario.addEventListener('change', refreshRoleInfo);
els.difficulty.addEventListener('change', refreshRoleInfo);
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
        s.getTracks().forEach((tr) => tr.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        mics = devices.filter((d) => d.kind === 'audioinput');
      } catch {}
    }
    const prev = els.mic.value;
    els.mic.innerHTML = '';
    mics.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Mic ${i + 1}`;
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
  els.micLevel.textContent = peak > 0.002 ? `${pct}%` : '—';
  els.micLevel.style.color = peak > 0.01 ? 'var(--good)' : (peak > 0.002 ? 'var(--warn)' : 'var(--danger)');
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function setStatus(text, state) {
  els.status.textContent = text;
  els.dot.className = 'dot' + (state ? ' ' + state : '');
}
function showError(msg) { els.error.textContent = msg || ''; }

// All four buttons stay visible (like the original version); only their
// enabled state changes with the call phase.
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
  label.textContent = who === 'rep' ? t('you') : currentRole().name;
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
  // Consent gate: the free Gemini tier means Google trains on the submitted
  // audio. Must be acknowledged before the first recording; the disclosure
  // stays while the app runs on the free tier.
  if (localStorage.getItem(CONSENT_KEY) !== 'yes') {
    openOverlay(els.consent);
    return;
  }
  showError('');
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey === 'paste-your-key-here') {
    showError(t('errNoKey'));
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
  closeOverlay(els.scoreOverlay);
  closeOverlay(els.configOverlay);
  closeOverlay(els.menuOverlay);

  setPhase('call');
  setControls({ start: false, pause: false, replay: false, end: true });
  setStatus(t('stDialing'), 'ringing');
  track('call_started');

  try {
    player = new AudioPlayer();
    await player.resume();
    ring = startRing(player.ctx);
    const ringStartedAt = Date.now();
    setStatus(t('stRinging'), 'ringing');

    recorder = new AudioRecorder();

    window.__ct = { sent: 0, recv: 0, snapshots: 0, replays: 0 };

    call = new GeminiCall(apiKey).on({
      onAudio: (b64) => {
        window.__ct.recv++;
        player && player.enqueue(b64);
      },
      onModelTurnStart: () => {
        // First voice = the prospect picked up. Stop the ring exactly here —
        // this runs before the first chunk is enqueued, so ring and voice
        // can never overlap.
        if (ring) { ring.stop(); ring = null; }
        recorder && recorder.snapshotTurn();
        window.__ct.snapshots++;
        els.replay.disabled = awaitingGreeting;
        prospectEntry.value = null;
      },
      onInterrupted: () => {
        interruptionsByUser++;
        if (player) player.flush();
      },
      onUserText: (txt) => addText(repEntry, 'rep', txt),
      onModelText: (txt) => addText(prospectEntry, 'prospect', txt),
      onTurnComplete: () => {
        repEntry.value = null;
        // Greeting finished — open the mic and go live.
        if (awaitingGreeting) {
          awaitingGreeting = false;
          if (greetWatchdog) { clearTimeout(greetWatchdog); greetWatchdog = null; }
          callStartedAt = Date.now();
          setStatus(t('stLive'), 'live');
          els.pause.disabled = false;
        }
      },
      onToolCall: ({ name, args }) => {
        if (name === 'agree_next_step') {
          outcome = 'sale';
          agreedStep = args.next_step || '';
          setStatus(t('stNextStep'), 'live');
        } else if (name === 'end_call') {
          if (outcome !== 'sale') outcome = 'hangup_bot';
          endByProspect(args.reason || '');
        }
      },
      onError: (m) => showError(t('errGemini') + m),
      onClose: (r) => { if (r && !ending) showError(t('errClosed') + r); },
    });

    // Mic first, while it "rings": the permission prompt happens under the
    // ring tone. Chunks are gated until the greeting has finished.
    await recorder.start(
      (b64) => {
        if (!paused && !awaitingGreeting && call) {
          call.sendAudio(b64);
          window.__ct.sent++;
        }
      },
      { deviceId: els.mic.value || undefined, onLevel: setMeter }
    );
    populateMics();

    // connect() resolves only after the server confirmed setupComplete, so
    // the greeting directive below cannot be dropped.
    await call.connect({ systemInstruction: role.prompt, voice: role.voice, lang: role.lang });

    // Let it ring for at least ~3 seconds before the prospect picks up —
    // instant pick-up feels wrong and cuts the ring after a fraction.
    const ringLeft = 3000 - (Date.now() - ringStartedAt);
    if (ringLeft > 0) await new Promise((r) => setTimeout(r, ringLeft));
    if (ending || !call) return; // user hung up while it was still ringing

    call.sendDirective(de
      ? `[REGIE — nicht vorlesen] Du hast gerade abgenommen. Melde dich genau so und nur so: "${role.greeting}". Sag sonst nichts. Deine Laune heute: ${diff.de}`
      : `[STAGE DIRECTION — do not read out] You have just picked up. Answer exactly and only with: "${role.greeting}". Say nothing else. Your mood today: ${diff.en}`);

    // Ring keeps ringing until the first greeting audio (onModelTurnStart).
    // If no greeting arrives at all, don't ring forever.
    greetWatchdog = setTimeout(() => {
      if (awaitingGreeting && !ending) {
        showError(t('errNoReply'));
        endCall();
      }
    }, 15000);
    paused = false;
    els.pause.textContent = t('pause');
  } catch (err) {
    console.error(err);
    showError(t('errStart') + (err?.message || err));
    await teardown();
    setPhase('idle');
    setStatus(t('stReady'), '');
  }
}

/* ── pause / resume ─────────────────────────────────────────────────────── */

function togglePause() {
  if (!call) return;
  paused = !paused;
  if (recorder) recorder.setMuted(paused);
  if (paused) {
    call.endAudioStream();
    setStatus(t('stPaused'), 'paused');
    els.pause.textContent = t('resume');
  } else {
    setStatus(t('stLive'), 'live');
    els.pause.textContent = t('pause');
  }
}

/* ── replay my last response (phone-filtered) ───────────────────────────── */

async function replayLast() {
  if (!recorder) return;
  const turn = recorder.getLastTurn();
  if (!turn) { showError(t('errNothingToReplay')); return; }
  showError('');
  const wasPaused = paused;
  if (!wasPaused) { paused = true; recorder.setMuted(true); }
  els.replay.disabled = true;
  setStatus(t('stReplay'), 'paused');
  if (window.__ct) window.__ct.replays++;
  try {
    await playThroughPhoneFilter(turn);
  } finally {
    els.replay.disabled = false;
    if (!wasPaused) { paused = false; recorder.setMuted(false); setStatus(t('stLive'), 'live'); }
    else setStatus(t('stPaused'), 'paused');
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
  setStatus(t('stHungup') + (reason ? ` — ${reason}` : ''), '');
  try { recorder && (await recorder.stop()); } catch {}
  try { call && call.close(); } catch {}
  call = null; recorder = null;
  if (player) {
    try { player.flush(); await playBusy(player.ctx); } catch {}
    try { await player.close(); } catch {}
    player = null;
  }
  paused = false;
  els.pause.textContent = t('pause');
  setPhase('idle');
  setControls({ start: true, pause: false, replay: false, end: false });
  await grade();
}

// The user hung up.
async function endCall() {
  if (ending) return;
  ending = true;
  if (outcome === null) outcome = 'hangup_user';
  await teardown();
  setPhase('idle');
  setControls({ start: true, pause: false, replay: false, end: false });
  setStatus(t('stEnded'), '');
  els.pause.textContent = t('pause');
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

let lastGradedRole = null;

async function grade() {
  const role = currentRole();
  lastGradedRole = role;
  const userTurns = history.filter((h) => h.role === 'user' && h.text.trim());
  if (userTurns.length < 1) { setStatus(t('stReady'), ''); return; }

  setStatus(t('stGrading'), 'paused');
  const report = {
    lang: role.lang,
    role: { name: role.name, tag: role.tag },
    history: history.filter((h) => h.text.trim()),
    durationSec: Math.max(1, Math.round((Date.now() - callStartedAt) / 1000)),
    interruptionsByUser,
    outcome: outcome || 'hangup_user',
  };

  track('call_ended');
  const llm = new GeminiLLM({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
  const result = await gradeCall(llm, report);
  renderScorecard(result, role.lang === 'de');
  setStatus(t('stReady'), '');
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
    els.scoreMissed.innerHTML = `<b>${de ? 'Verdecktes Signal' : 'Hidden signal'}</b>`;
    els.scoreMissed.append(r.missedSignal);
  }
  els.scoreNext.innerHTML = `<b>${de ? 'Nächstes Mal' : 'Next time'}</b>`;
  els.scoreNext.append(r.nextTime || '—');

  els.scoreLines.innerHTML = '';
  if (r.bestLine || r.worstLine) {
    els.scoreLines.innerHTML = `<b>${de ? 'Beste / schwächste Zeile' : 'Best / weakest line'}</b>`;
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

  openOverlay(els.scoreOverlay);
}

/* ── consent & report ───────────────────────────────────────────────────── */

els.consentBtn.addEventListener('click', () => {
  localStorage.setItem(CONSENT_KEY, 'yes');
  closeOverlay(els.consent);
  startCall();
});

// In-app report path for offensive AI output (Play AI-content policy).
// Opens a mail draft with the transcript; nothing is sent automatically.
els.reportBtn.addEventListener('click', () => {
  const role = lastGradedRole || currentRole();
  const transcript = history
    .filter((h) => h.text.trim())
    .map((h) => `${h.role === 'user' ? t('caller') : role.name}: ${h.text}`)
    .join('\n');
  const body = encodeURIComponent(
    `${t('reportIntro')}\n\n${t('reportRole')}: ${role.name} (${role.id})\n${t('reportTime')}: ${new Date().toISOString()}\n\n--- ${t('reportTranscript')} ---\n${transcript}\n\n--- ${t('reportWhat')} ---\n`
  );
  window.location.href =
    `mailto:info@supershipper.ai?subject=${encodeURIComponent(t('reportSubject'))}&body=${body}`;
});

/* ── votes & anonymous tracking ─────────────────────────────────────────── */
// A random id per browser — no account, no personal data; documented in the
// privacy policy. Votes are gameable by design ("just an indicator").

const SID_KEY = 'ct.sid';
const VOTED_KEY = 'ct.voted'; // sessionStorage: once per session
let sid = localStorage.getItem(SID_KEY);
if (!sid) {
  sid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 16);
  localStorage.setItem(SID_KEY, sid);
}

async function api(pathname, body) {
  try {
    const res = await fetch(pathname, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } // dev server has no API; fail silently
}

const track = (event) => { api('/api/track', { event, sid, lang }); };

function renderVotes(v) {
  if (!v) return;
  els.voteBalance.textContent = String(v.up - v.down);
}

function markVoted(dir) {
  els.voteUp.disabled = true;
  els.voteDown.disabled = true;
  if (dir) (dir === 'up' ? els.voteUp : els.voteDown).classList.add('voted');
  els.voteCaption.textContent = t('voteThanks');
}

async function vote(dir) {
  if (sessionStorage.getItem(VOTED_KEY)) return;
  sessionStorage.setItem(VOTED_KEY, dir);
  markVoted(dir);
  renderVotes(await api('/api/vote', { dir, sid }));
}

els.voteUp.addEventListener('click', () => vote('up'));
els.voteDown.addEventListener('click', () => vote('down'));

(async () => {
  renderVotes(await api('/api/votes'));
  const prev = sessionStorage.getItem(VOTED_KEY);
  if (prev) markVoted(prev);
})();
track('visit');

/* ── events & boot ──────────────────────────────────────────────────────── */

els.start.addEventListener('click', startCall);
els.pause.addEventListener('click', togglePause);
els.replay.addEventListener('click', replayLast);
els.end.addEventListener('click', endCall);

setPhase('idle');
applyLang();

// PWA: register the service worker in production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.debug('[CT] sw register failed', e));
}
