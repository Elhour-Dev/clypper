import type { Candidate } from '../shared/types';

// Tried in order; a model that does not exist for this key (404) falls through to the next one.
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

export class GeminiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function gemini<T>(key: string, prompt: string): Promise<T> {
  let res: Response | null = null;
  for (const model of MODELS) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
      }),
      signal: AbortSignal.timeout(20000), // never hang the app on a slow network
    });
    if (res.status !== 404) break;
  }
  if (!res || !res.ok) throw new GeminiError(res?.status ?? 0, `Gemini ${res?.status}`);
  const j: any = await res.json();
  const txt = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  return JSON.parse(txt.replace(/^```json|```$/g, ''));
}

export async function testKey(key: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await gemini<any>(key, 'Reply with JSON {"ok":true}');
    return { ok: true };
  } catch (e: any) {
    if (e instanceof SyntaxError) return { ok: true }; // Google answered, the reply just was not JSON
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, message: 'Google did not answer in time. Check your internet and try again.' };
    const st = e instanceof GeminiError ? e.status : 0;
    if (st === 400 || st === 401 || st === 403) return { ok: false, message: 'Google rejected this key. Copy it again from aistudio.google.com/apikey (no spaces).' };
    if (st === 429) return { ok: true, message: 'Key is valid, but the free limit is used up for now. It will work again later.' };
    if (st === 404) return { ok: false, message: 'No supported Gemini model found for this key.' };
    return { ok: false, message: 'Could not reach Google. Check your internet and try again.' };
  }
}

/** Ask the LLM to judge candidates. Only transcript text leaves the PC. Returns null on any failure. */
export async function judge(key: string, items: { i: number; text: string }[]) {
  if (!key) return null;
  try {
    const prompt = `You pick viral short-video clips (YouTube Shorts / TikTok). For each numbered transcript excerpt, rate its viral potential 0-100 (strong hook in first seconds, emotion, curiosity, standalone story, payoff), give a one-sentence reason (max 18 words) and a punchy hook title of at most 6 words (no emojis, no quotes). Return JSON array: [{"i":number,"score":number,"reason":string,"hook":string}].\n\n${items.map((x) => `#${x.i}: ${x.text.slice(0, 1400)}`).join('\n\n')}`;
    const r = await gemini<{ i: number; score: number; reason: string; hook: string }[]>(key, prompt);
    return Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

export interface KitText {
  youtube: { titles: string[]; description: string; hashtags: string[]; caption: string };
  tiktok: { titles: string[]; description: string; hashtags: string[]; caption: string };
}

export async function writeKit(key: string, text: string, hook: string): Promise<KitText | null> {
  if (!key) return null;
  try {
    const prompt = `Write posting copy for a short vertical video. Transcript: """${text.slice(0, 1800)}""". Working title: "${hook}".
Return JSON: {"youtube":{"titles":[3 different titles, max 70 chars, curiosity-driven, no clickbait lies],"description":"2-3 sentences ending with a call to action","hashtags":[6-8 tags without #, include shorts],"caption":"one short on-screen/post caption line"},"tiktok":{"titles":[3 titles max 90 chars],"description":"one short caption under 150 chars","hashtags":[5-7 tags without #, include fyp],"caption":"one short caption line"}}. Use plain words. No emojis in titles.`;
    const r = await gemini<KitText>(key, prompt);
    if (r?.youtube?.titles?.length && r?.tiktok?.titles?.length) return r;
    return null;
  } catch {
    return null;
  }
}

export function applyJudge(cands: Candidate[], texts: string[], res: Awaited<ReturnType<typeof judge>>) {
  if (!res) return cands;
  return cands.map((c, i) => {
    const r = res.find((x) => x.i === i);
    if (!r || typeof r.score !== 'number') return c;
    return {
      ...c,
      score: Math.round(c.score * 0.45 + Math.max(0, Math.min(100, r.score)) * 0.55),
      reason: r.reason || c.reason,
      hook: r.hook || c.hook,
    };
  });
}
