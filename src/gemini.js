// Thin wrapper around the Gemini Live API (@google/genai).
// Live API is WebSocket-based; the SDK manages the socket for us.
// Model + audio formats per the official Live API docs (model: gemini-3.1-flash-live-preview;
// input PCM16 @16k, output PCM16 @24k).

import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = 'gemini-3.1-flash-live-preview';

export class GeminiCall {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
    this.handlers = {
      onAudio: () => {},          // (base64) => void   model audio chunk
      onModelTurnStart: () => {}, // ()        => void   first audio of a model reply
      onInterrupted: () => {},    // ()        => void   barge-in: flush playback
      onUserText: () => {},       // (text)    => void   input transcription
      onModelText: () => {},      // (text)    => void   output transcription
      onTurnComplete: () => {},   // ()        => void
      onError: () => {},          // (message) => void
      onClose: () => {},          // (reason)  => void
    };
    this._modelSpeaking = false;
  }

  on(handlers) {
    Object.assign(this.handlers, handlers);
    return this;
  }

  async connect(systemInstructionText) {
    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: { languageCode: 'de-DE' },
    };

    this.session = await this.ai.live.connect({
      model: MODEL,
      config,
      callbacks: {
        onopen: () => console.debug('[CT] live session open'),
        onmessage: (msg) => this._handleMessage(msg),
        onerror: (e) => { console.debug('[CT] live error', e); this.handlers.onError(e?.message || String(e)); },
        onclose: (e) => { console.debug('[CT] live close', e?.code, e?.reason); this.handlers.onClose(e?.reason || ''); },
      },
    });

    return this;
  }

  _handleMessage(msg) {
    // Raw diagnostic: what is the server actually sending?
    try {
      console.debug('[CT] msg keys:', Object.keys(msg || {}),
        '| serverContent:', msg?.serverContent ? Object.keys(msg.serverContent) : null,
        '| setupComplete:', !!msg?.setupComplete,
        '| toolCall:', !!msg?.toolCall);
    } catch {}

    const content = msg.serverContent;
    if (!content) return;

    // Interruption (user barged in): stop playback and reset turn state.
    if (content.interrupted) {
      this._modelSpeaking = false;
      this.handlers.onInterrupted();
    }

    // Audio + any other parts. Process ALL parts (an event may carry several).
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          if (!this._modelSpeaking) {
            this._modelSpeaking = true;
            this.handlers.onModelTurnStart(); // marks end of the user's turn
          }
          this.handlers.onAudio(part.inlineData.data);
        }
      }
    }

    // Transcripts.
    if (content.inputTranscription?.text) {
      this.handlers.onUserText(content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.handlers.onModelText(content.outputTranscription.text);
    }

    if (content.turnComplete) {
      this._modelSpeaking = false;
      this.handlers.onTurnComplete();
    }
  }

  // Send a chunk of mic audio (base64 PCM16 @16k).
  sendAudio(base64) {
    if (!this.session) return;
    this.session.sendRealtimeInput({
      audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
    });
  }

  // Tell the model the mic stream paused, so it flushes any buffered audio.
  endAudioStream() {
    if (!this.session) return;
    try { this.session.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
  }

  close() {
    try { this.session && this.session.close(); } catch {}
    this.session = null;
  }
}
