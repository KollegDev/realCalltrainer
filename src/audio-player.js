// Plays the AI prospect's audio. Gemini Live returns raw PCM16 mono @ 24 kHz.
// We schedule chunks back-to-back on a dedicated AudioContext so playback is smooth,
// and we can flush the whole queue instantly when the model is interrupted.

const OUTPUT_RATE = 24000;

export class AudioPlayer {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUTPUT_RATE });
    this.nextStartTime = 0;
    this.sources = new Set();
  }

  // base64 string of PCM16 little-endian mono @ 24 kHz
  enqueue(base64) {
    const float32 = base64PCM16ToFloat32(base64);
    if (float32.length === 0) return;

    const buffer = this.ctx.createBuffer(1, float32.length, OUTPUT_RATE);
    buffer.copyToChannel(float32, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  // Called when the model is interrupted (barge-in). Stop everything immediately.
  flush() {
    for (const src of this.sources) {
      try { src.stop(); } catch {}
    }
    this.sources.clear();
    this.nextStartTime = this.ctx.currentTime;
  }

  async resume() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async close() {
    this.flush();
    try { await this.ctx.close(); } catch {}
  }
}

function base64PCM16ToFloat32(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const sampleCount = Math.floor(len / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}
