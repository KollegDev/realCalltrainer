// Post-call scorecard — ported from the new callTrainer, trimmed to the
// metrics this app can actually measure.
//
// Runs on a *text* model over the transcript, not on the voice model:
// grading is the one part that is not latency-sensitive, so it is the
// cheapest call of the session. Hard metrics are computed locally and passed
// in as facts, so the model grades judgement rather than arithmetic.

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    verdict: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    mistakes: { type: 'array', items: { type: 'string' } },
    missedSignal: { type: 'string' },
    nextTime: { type: 'string' },
    bestLine: { type: 'string' },
    worstLine: { type: 'string' },
  },
  required: ['score', 'verdict', 'strengths', 'mistakes', 'nextTime'],
};

const SYS_DE = `Du bewertest einen simulierten Kaltakquise-Anruf. Du bist ein erfahrener Vertriebstrainer: direkt, konkret, ohne Schmeichelei und ohne Floskeln.

Regeln:
- Bewerte NUR den Anrufer, nie den Gesprächspartner.
- Beziehe dich auf konkrete Sätze aus dem Transkript, nicht auf Allgemeinplätze.
- "score" ist 0 bis 100. Ein durchschnittlicher echter Kaltakquise-Anruf liegt bei 40 bis 55. Sei streng.
- "verdict" ist ein einziger Satz.
- Maximal drei Stärken und drei Fehler, jeweils ein kurzer Satz.
- "missedSignal": das verdeckte Problem des Gesprächspartners und ob der Anrufer es erkannt hat.
- "nextTime": eine einzige konkrete Sache, die der Anrufer beim nächsten Mal anders macht.
- Antworte auf Deutsch.`;

const SYS_EN = `You are grading a simulated cold call. You are an experienced sales trainer: direct, specific, no flattery, no filler.

Rules:
- Grade ONLY the caller, never the prospect.
- Quote specific lines from the transcript rather than generalising.
- "score" is 0 to 100. An average real cold call sits at 40 to 55. Be strict.
- "verdict" is a single sentence.
- At most three strengths and three mistakes, one short sentence each.
- "missedSignal": the prospect's hidden problem and whether the caller found it.
- "nextTime": one single concrete thing the caller should do differently.
- Answer in English.`;

/**
 * report = {
 *   lang: 'de'|'en',
 *   role: { name, tag, prompt },
 *   history: [{ role:'user'|'model', text, t }],   t = Date.now() per turn
 *   durationSec, interruptionsByUser, outcome
 * }
 */
export async function gradeCall(llm, report) {
  const de = report.lang === 'de';
  const metrics = computeMetrics(report);

  const transcript = report.history
    .map(h => `${h.role === 'user' ? (de ? 'ANRUFER' : 'CALLER') : (de ? 'KUNDE' : 'PROSPECT')}: ${h.text}`)
    .join('\n');

  const factLines = de
    ? [
        `- Dauer: ${report.durationSec} Sekunden`,
        `- Redeanteil Anrufer (nach Wortzahl): ${metrics.talkRatioPct} Prozent`,
        `- Anrufer hat den Kunden unterbrochen: ${report.interruptionsByUser} mal`,
        `- Sekunden bis zum ersten klaren Grund des Anrufs: ${metrics.timeToPoint ?? 'nie genannt'}`,
        `- Fragen gestellt: ${metrics.questionsAsked}`,
        `- Ausgang: ${outcomeLabel(report.outcome, true)}`,
      ]
    : [
        `- Duration: ${report.durationSec} seconds`,
        `- Caller talk share (by word count): ${metrics.talkRatioPct} percent`,
        `- Caller interrupted prospect: ${report.interruptionsByUser} times`,
        `- Seconds until the caller stated a clear reason for calling: ${metrics.timeToPoint ?? 'never stated'}`,
        `- Questions asked: ${metrics.questionsAsked}`,
        `- Outcome: ${outcomeLabel(report.outcome, false)}`,
      ];

  const facts = (de
    ? 'HARTE KENNZAHLEN (bereits gemessen, nicht neu berechnen):\n'
    : 'HARD METRICS (already measured, do not recompute):\n') + factLines.join('\n');

  const user = `${de ? 'ROLLE' : 'ROLE'}: ${report.role.name} — ${report.role.tag}\n\n${facts}\n\n${de ? 'TRANSKRIPT' : 'TRANSCRIPT'}:\n${transcript}`;

  let out;
  try {
    out = await llm.json({ system: de ? SYS_DE : SYS_EN, user, schema: SCHEMA });
  } catch {
    out = null;
  }

  if (!out || typeof out.score !== 'number') {
    out = fallbackGrade(report, metrics, de);
  }

  return { ...out, metrics, report };
}

/* ── local metrics ──────────────────────────────────────────────────────── */

const POINT_MARKERS = /(ich rufe an,? weil|der grund meines anrufs|es geht (um|darum)|ich melde mich,? weil|i'?m calling because|the reason (i'?m calling|for my call)|this is about|i'?ll be quick)/i;

export function computeMetrics(report) {
  const userTurns = report.history.filter(h => h.role === 'user');
  const modelTurns = report.history.filter(h => h.role === 'model');
  const t0 = report.history[0]?.t ?? 0;

  let timeToPoint = null;
  for (const turn of userTurns) {
    if (POINT_MARKERS.test(turn.text)) { timeToPoint = Math.round((turn.t - t0) / 1000); break; }
  }

  const questionsAsked = userTurns.reduce((n, t) => n + (t.text.match(/\?/g) || []).length, 0);
  const count = arr => arr.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  const callerWords = count(userTurns);
  const prospectWords = count(modelTurns);
  const total = callerWords + prospectWords;

  return {
    timeToPoint,
    questionsAsked,
    callerWords,
    wordsPerTurn: userTurns.length ? Math.round(callerWords / userTurns.length) : 0,
    talkRatioPct: total ? Math.round((callerWords / total) * 100) : 0,
  };
}

/** Used when the grading call fails — the user still gets the hard numbers. */
function fallbackGrade(report, m, de) {
  let score = 50;
  if (m.talkRatioPct > 65) score -= 12;
  if (m.talkRatioPct < 35) score -= 6;
  if (m.questionsAsked === 0) score -= 15; else score += Math.min(10, m.questionsAsked * 3);
  if (m.timeToPoint === null) score -= 10; else if (m.timeToPoint < 15) score += 8;
  if (report.outcome === 'sale') score += 25;
  if (report.outcome === 'hangup_bot') score -= 12;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    verdict: de
      ? 'Automatische Bewertung ohne Sprachmodell — nur die harten Kennzahlen.'
      : 'Automatic grading without the language model — hard metrics only.',
    strengths: [],
    mistakes: [
      ...(m.questionsAsked === 0 ? [de ? 'Keine einzige Frage gestellt.' : 'Did not ask a single question.'] : []),
      ...(m.talkRatioPct > 65 ? [de ? 'Zu hoher Redeanteil.' : 'Talked too much.'] : []),
      ...(m.timeToPoint === null ? [de ? 'Grund des Anrufs nie klar genannt.' : 'Never stated the reason for the call.'] : []),
    ],
    nextTime: de
      ? 'Grund des Anrufs in den ersten zehn Sekunden nennen, dann eine Frage stellen.'
      : 'State the reason for the call in the first ten seconds, then ask a question.',
  };
}

export function outcomeLabel(outcome, de) {
  const map = {
    sale:        de ? 'Abschluss / klarer nächster Schritt' : 'Deal / clear next step',
    hangup_bot:  de ? 'Der Kunde hat aufgelegt' : 'The prospect hung up',
    hangup_user: de ? 'Du hast aufgelegt' : 'You hung up',
    error:       de ? 'Verbindung abgebrochen' : 'Connection lost',
  };
  return map[outcome] || outcome;
}
