// Thin wrapper around the Gemini Live API (@google/genai).
// Live API is WebSocket-based; the SDK manages the socket for us.
// Model + audio formats per the official Live API docs (model: gemini-3.1-flash-live-preview;
// input PCM16 @16k, output PCM16 @24k).

import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Ending the call and agreeing to a next step are decisions, not words, so
 * they are tools rather than text tokens. With a speech-to-speech model a
 * literal "[HANGUP]" in the output would simply be read out loud.
 * (Ported from the new callTrainer.)
 */
export function callTools(lang) {
  const de = lang === 'de';
  return [{
    functionDeclarations: [
      {
        name: 'end_call',
        description: de
          ? 'Beende das Telefonat sofort. Rufe das auf, NACHDEM du dich verabschiedet hast, wenn du keine Lust mehr hast, keine Zeit hast oder kein Interesse besteht.'
          : 'End the phone call immediately. Call this AFTER saying goodbye, when you have lost patience, have no time, or are not interested.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: de ? 'Kurzer Grund, warum du auflegst.' : 'Short reason for hanging up.',
            },
          },
          required: ['reason'],
        },
      },
      {
        name: 'agree_next_step',
        description: de
          ? 'Rufe das auf, wenn der Anrufer dein echtes Problem getroffen und einen konkreten nächsten Schritt vorgeschlagen hat, dem du zustimmst.'
          : 'Call this when the caller has hit your real problem and proposed a concrete next step that you agree to.',
        parameters: {
          type: 'object',
          properties: {
            next_step: {
              type: 'string',
              description: de ? 'Was genau vereinbart wurde.' : 'What exactly was agreed.',
            },
          },
          required: ['next_step'],
        },
      },
    ],
  }];
}

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
      onToolCall: () => {},       // ({name, args}) => void  end_call / agree_next_step
      onError: () => {},          // (message) => void
      onClose: () => {},          // (reason)  => void
    };
    this._modelSpeaking = false;
  }

  on(handlers) {
    Object.assign(this.handlers, handlers);
    return this;
  }

  async connect({ systemInstruction, voice = 'Charon', lang = 'de' }) {
    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        languageCode: lang === 'de' ? 'de-DE' : 'en-US',
      },
      tools: callTools(lang),
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

  /**
   * Stage direction ([REGIE]): a client text turn the model treats as
   * instruction, not as something the caller said. Used for the pick-up
   * greeting and the difficulty mood. turnComplete=true makes the model
   * respond immediately — that is what produces the greeting audio.
   */
  sendDirective(text, { respond = true } = {}) {
    if (!this.session) return;
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: respond,
      });
    } catch (e) {
      console.debug('[CT] sendDirective failed', e);
    }
  }

  _handleMessage(msg) {
    // Tool calls: the prospect decided to hang up or to agree a next step.
    if (msg.toolCall?.functionCalls?.length) {
      for (const fc of msg.toolCall.functionCalls) {
        console.debug('[CT] toolCall:', fc.name, fc.args);
        // Acknowledge so the model is not left waiting on the response.
        try {
          this.session?.sendToolResponse({
            functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true } }],
          });
        } catch {}
        this.handlers.onToolCall({ name: fc.name, args: fc.args || {} });
      }
      return;
    }

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
