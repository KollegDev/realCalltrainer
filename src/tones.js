// Ring and busy tones (German network standard: 425 Hz).
// Ring: 1 s on / 4 s off. Busy: 480 ms on / 480 ms off.
//
// Lesson from the new callTrainer (its invariant 16): audio dies with its
// owner — whoever starts a sound stops it, in the same place, visibly. Both
// tones return a handle with stop(); nothing here outlives its caller via a
// hidden timer holding the graph open.

const FREQ = 425;

function tone(ctx, dest, { on, off, gain = 0.08 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = FREQ;
  osc.connect(g);
  g.connect(dest);

  const period = on + off;
  const t0 = ctx.currentTime + 0.02;
  // Schedule a generous number of cycles up front; stop() cancels the rest.
  for (let i = 0; i < 30; i++) {
    const t = t0 + i * period;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.setValueAtTime(gain, t + on - 0.01);
    g.gain.linearRampToValueAtTime(0, t + on);
  }
  osc.start(t0);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { g.gain.cancelScheduledValues(ctx.currentTime); } catch {}
      try { g.gain.setValueAtTime(0, ctx.currentTime); } catch {}
      try { osc.stop(); } catch {}
      try { osc.disconnect(); g.disconnect(); } catch {}
    },
  };
}

/** Ringing while the "call" connects. Caller must stop() it.
 *  Cadence tightened from the 1s/4s network standard to 1s/2.5s so a second
 *  ring is audible within the ~3s minimum ring window before pick-up. */
export function startRing(ctx, dest = ctx.destination) {
  return tone(ctx, dest, { on: 1.0, off: 2.5 });
}

/**
 * Busy tone after the prospect hangs up. Plays for `seconds`, then stops
 * itself and resolves — the one deliberate case of a sound outliving the
 * call, bounded and audible.
 */
export function playBusy(ctx, dest = ctx.destination, seconds = 3) {
  const h = tone(ctx, dest, { on: 0.48, off: 0.48, gain: 0.1 });
  return new Promise(resolve => {
    setTimeout(() => { h.stop(); resolve(); }, seconds * 1000);
  });
}
