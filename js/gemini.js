// Analiza filmu: Gemini „ogląda” film z YouTube po linku i zwraca zwroty jako JSON.
import { watchUrl } from './youtube.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    is_french: { type: 'BOOLEAN' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          fr: { type: 'STRING' },
          pl: { type: 'STRING' },
          sentence_fr: { type: 'STRING' },
          match: { type: 'STRING' },
          sentence_pl: { type: 'STRING' },
          note: { type: 'STRING' },
          t: { type: 'NUMBER' },
          level: { type: 'STRING' },
        },
        required: ['fr', 'pl', 'sentence_fr', 'sentence_pl', 't'],
      },
    },
  },
  required: ['title', 'is_french', 'items'],
};

function buildPrompt(count, known) {
  const knownList = known.length ? known.join(' | ') : '(brak)';
  return `You help a native Polish speaker (French level B1/B2) learn French from this YouTube video.
Listen to the French speech in the video and pick the ${count} most useful expressions to learn.

Prefer: multi-word expressions, idioms, collocations, verb + preposition constructions, colloquial phrases people really say, and useful B1–C1 vocabulary — all actually spoken in the video.
Skip: trivial A1–A2 words, proper names, and anything already in the KNOWN list below.

For each expression return:
- fr: the expression in dictionary/base form (verbs in the infinitive, e.g. "en avoir marre", "se rendre compte de").
- pl: a natural Polish equivalent with the meaning it has in THIS context (not a word-by-word translation).
- sentence_fr: the exact sentence (or fragment of max 20 words) from the video where it is used, as spoken.
- match: the exact words of the expression as they appear (conjugated) inside sentence_fr, copied verbatim, so they can be highlighted.
- sentence_pl: a natural Polish translation of that sentence.
- note: a very short note in Polish only if genuinely helpful (register like "potoczne", a grammar point, a false friend); otherwise "".
- t: the time in seconds when that sentence starts in the video.
- level: B1, B2 or C1.

Also return "title" (the video's title or a short description) and "is_french" (false if the video is not mainly in French).
Order the expressions from most to least useful.

KNOWN: ${knownList}`;
}

export class GeminiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function call(model, key, body, signal) {
  let res;
  try {
    res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError('Analiza trwała za długo. Spróbuj jeszcze raz.', 'timeout');
    throw new GeminiError('Brak połączenia z internetem.', 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const status = data.error?.status || '';
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) throw new GeminiError('Klucz Gemini jest nieprawidłowy. Sprawdź go w ustawieniach.', 'key');
    if (res.status === 429) throw new GeminiError('Darmowy limit Gemini chwilowo się wyczerpał. Spróbuj za minutę (albo krótszy filmik).', 'quota');
    if (res.status === 404) throw new GeminiError(msg, 'model');
    throw new GeminiError(msg, status || 'api');
  }
  return data;
}

function extractJson(data) {
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || 'pusta odpowiedź';
    throw new GeminiError(`Gemini nie zwrócił wyniku (${reason}). Filmik może być prywatny, z ograniczeniem wieku albo za długi.`, 'empty');
  }
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new GeminiError('Gemini zwrócił niepoprawny format. Spróbuj jeszcze raz.', 'parse');
  }
}

export async function analyzeVideo({ videoId, key, model, count, known, timeoutMs = 240000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const body = {
    contents: [{
      parts: [
        { fileData: { fileUri: watchUrl(videoId) } },
        { text: buildPrompt(count, known) },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
    },
  };

  const models = [model || DEFAULT_MODEL, ...FALLBACK_MODELS.filter(m => m !== model)];
  try {
    let lastErr;
    for (const m of models) {
      try {
        let data;
        try {
          data = await call(m, key, body, ctrl.signal);
        } catch (e) {
          // Starsze modele mogą nie znać mediaResolution — ponów bez niego.
          if (e.code === 'INVALID_ARGUMENT' && /media/i.test(e.message)) {
            delete body.generationConfig.mediaResolution;
            data = await call(m, key, body, ctrl.signal);
          } else throw e;
        }
        const result = extractJson(data);
        return { ...result, model: m, items: cleanItems(result.items) };
      } catch (e) {
        lastErr = e;
        if (e.code !== 'model') throw e;
      }
    }
    throw lastErr;
  } finally {
    clearTimeout(timer);
  }
}

function cleanItems(items) {
  return (items || [])
    .filter(i => i && i.fr && i.pl)
    .map(i => ({
      fr: String(i.fr).trim(),
      pl: String(i.pl).trim(),
      sentence_fr: String(i.sentence_fr || '').trim(),
      match: String(i.match || '').trim(),
      sentence_pl: String(i.sentence_pl || '').trim(),
      note: String(i.note || '').trim(),
      t: Number.isFinite(+i.t) ? Math.max(0, +i.t) : 0,
      level: String(i.level || '').trim(),
    }));
}

// Szybki test klucza: lista modeli nic nie kosztuje.
export async function testKey(key) {
  const res = await fetch(`${API}/models?pageSize=50`, { headers: { 'x-goog-api-key': key } });
  if (res.ok) return true;
  const data = await res.json().catch(() => ({}));
  throw new GeminiError(data.error?.message || `HTTP ${res.status}`, 'key');
}
