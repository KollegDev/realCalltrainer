// Captures the microphone, downsamples to 16 kHz mono PCM16, and emits base64
// chunks for the Gemini Live API. Also keeps a per-turn buffer of the raw audio
// (Float32 @ 16 kHz) so we can replay "your last response" through the phone filter.
//
// We use a ScriptProcessorNode on purpose: it is deprecated but works in every
// browser with zero extra files (no AudioWorklet module to load). For a local,
// single-user practice tool, "just works" beats "technically modern".

const TARGET_RATE = 16000;

export class AudioRecorder {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.onChunk = null; // (base64String) => void  -- sent to Gemini
    this.muted = false;

    // Per-turn capture for replay.
    this._currentTurn = []; // array of Float32Array @ 16k
    this._lastTurn = null; // Float32Array @ 16k (the snapshot you can replay)
  }

  async start(onChunk, opts = {}) {
    this.onChunk = onChunk;
    this.onLevel = opts.onLevel || null; // (peak) => void, for a live meter
    const audioConstraints = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
    if (opts.deviceId) audioConstraints.deviceId = { exact: opts.deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Diagnostic: which device did Chrome pick, and is the track live/unmuted?
    const track = this.stream.getAudioTracks()[0];
    console.debug('[CT] mic track:', track?.label || '(no label)',
      '| enabled:', track?.enabled, '| muted:', track?.muted, '| state:', track?.readyState);
    try { console.debug('[CT] mic settings:', JSON.stringify(track?.getSettings?.() || {})); } catch {}
    if (track) {
      track.onmute = () => console.debug('[CT] mic track MUTED event');
      track.onunmute = () => console.debug('[CT] mic track UNMUTED event');
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // Chrome quirk: a MediaStreamAudioSourceNode feeding a ScriptProcessorNode
    // often delivers all-zero samples unless the stream is also "pulled" by a
    // media element. Attach it to a muted <audio> sink to force the pump.
    this._sink = new Audio();
    this._sink.muted = true;
    this._sink.srcObject = this.stream;
    this._sink.play().catch(() => {});

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (this.muted) return;
      const input = e.inputBuffer.getChannelData(0); // Float32 @ ctx.sampleRate
      const down = downsample(input, this.ctx.sampleRate, TARGET_RATE);

      // Mic level diagnostic: log peak/RMS periodically so we can tell silence
      // (wrong/muted mic) from real signal.
      this._dbg = (this._dbg || 0) + 1;
      if (this._dbg % 6 === 1) {
        let peak = 0, sum = 0;
        for (let i = 0; i < down.length; i++) { const a = Math.abs(down[i]); if (a > peak) peak = a; sum += down[i] * down[i]; }
        const rms = Math.sqrt(sum / down.length);
        if (this.onLevel) this.onLevel(peak);
        if (this._dbg % 24 === 1) console.debug(`[CT] mic level: peak=${peak.toFixed(3)} rms=${rms.toFixed(4)} (ctxRate=${this.ctx.sampleRate})`);
      }

      // Buffer for replay.
      this._currentTurn.push(down);

      // Send to Gemini.
      if (this.onChunk) {
        const b64 = floatToBase64PCM16(down);
        this.onChunk(b64);
      }
    };

    this.source.connect(this.processor);
    // ScriptProcessor only fires when connected to a destination.
    this.processor.connect(this.ctx.destination);
  }

  setMuted(m) {
    this.muted = m;
  }

  // Snapshot whatever the user has said since the last snapshot as "the last turn",
  // then start a fresh buffer. Called when the AI starts replying.
  snapshotTurn() {
    if (this._currentTurn.length === 0) return;
    this._lastTurn = concatFloat32(this._currentTurn);
    this._currentTurn = [];
  }

  // Returns { samples: Float32Array, sampleRate } for the last captured turn, or null.
  getLastTurn() {
    if (!this._lastTurn || this._lastTurn.length === 0) return null;
    return { samples: this._lastTurn, sampleRate: TARGET_RATE };
  }

  async stop() {
    try { this.processor && this.processor.disconnect(); } catch {}
    try { this.source && this.source.disconnect(); } catch {}
    try { if (this._sink) { this._sink.pause(); this._sink.srcObject = null; this._sink = null; } } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && (await this.ctx.close()); } catch {}
    this.processor = this.source = this.stream = this.ctx = null;
  }
}

// --- helpers ---

function downsample(input, inRate, outRate) {
  if (outRate >= inRate) return Float32Array.from(input);
  const ratio = inRate / outRate;
  const newLen = Math.floor(input.length / ratio);
  const out = new Float32Array(newLen);
  let pos = 0;
  for (let i = 0; i < newLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0, count = 0;
    for (let j = start; j < end && j < input.length; j++) { sum += input[j]; count++; }
    out[pos++] = count ? sum / count : 0;
  }
  return out;
}

function floatToBase64PCM16(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
