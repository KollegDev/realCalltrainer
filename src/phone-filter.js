// Plays a captured Float32 audio buffer back through a "telephone" filter so you
// hear your own last response the way it sounded on the line.
//
// The classic telephone voice band is ~300–3400 Hz. We chain a high-pass + low-pass
// to carve out that band, add a gentle drive (waveshaper) for the compressed/“tinny”
// line feel, and a touch of makeup gain.

export async function playThroughPhoneFilter(turn) {
  if (!turn || !turn.samples || turn.samples.length === 0) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();

  const buffer = ctx.createBuffer(1, turn.samples.length, turn.sampleRate);
  buffer.copyToChannel(turn.samples, 0);

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // Band-pass via high-pass -> low-pass (steeper / more telephone-like than one bandpass).
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3400;

  // Slight drive for the compressed handset feel.
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDriveCurve(8);

  const gain = ctx.createGain();
  gain.value = 1.4; // makeup gain — the band-pass removes energy

  src.connect(hp);
  hp.connect(lp);
  lp.connect(shaper);
  shaper.connect(gain);
  gain.connect(ctx.destination);

  return new Promise((resolve) => {
    src.onended = async () => {
      try { await ctx.close(); } catch {}
      resolve();
    };
    src.start();
  });
}

function makeDriveCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); // soft saturation
  }
  return curve;
}
