// Minimal text-LLM client for the scorecard. Uses the same key as the Live
// session. Grading is not latency-sensitive, so it runs on cheap Flash.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RELAXED_SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

export class GeminiLLM {
  constructor({ apiKey, model = 'gemini-2.5-flash' } = {}) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async json({ system, user, schema }) {
    if (!this.apiKey) throw new Error('NO_API_KEY');
    const res = await fetch(`${GEMINI_BASE}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
        safetySettings: RELAXED_SAFETY,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`LLM_${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    try { return JSON.parse(raw); } catch { return {}; }
  }
}
