import type { Candidate } from '../shared/types';

/** Inside the app use Chromium's network stack (honours the Windows proxy/VPN settings); plain fetch otherwise. */
function netFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    if (!process.versions.electron) return fetch(url, init);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { net } = require('electron');
    if (net?.fetch) return net.fetch(url, init as any) as Promise<Response>;
  } catch {
    /* not running inside Electron */
  }
  return fetch(url, init);
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

/** Ask Google which models this key can use, and rank stable Flash models (fast, free-tier friendly), newest first. */
export function rankModels(names: string[]): string[] {
  const rows = names
    .map((n) => /^models\/(gemini-(\d+(?:\.\d+)?)-flash(-lite)?)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ id: m[1], ver: parseFloat(m[2]), lite: !!m[3] }));
  rows.sort((a, b) => Number(b.lite) - Number(a.lite) || b.ver - a.ver);
  return rows.map((r) => r.id);
}

const modelCache = new Map<string, string[]>();
async function modelsFor(key: string): Promise<string[]> {
  const hit = modelCache.get(key);
  if (hit) return hit;
  let list: string[] = [];
  try {
    const res = await netFetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j: any = await res.json();
      list = rankModels((j.models || []).filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m: any) => m.name));
    }
  } catch {
    /* fall back to the built-in list below */
  }
  if (!list.length) list = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
  modelCache.set(key, list);
  return list;
}

async function gemini<T>(key: string, prompt: string): Promise<T> {
  let lastErr: unknown = new GeminiError(0, 'no model');
  for (const model of (await modelsFor(key)).slice(0, 3)) {
    try {
      const res = await netFetch(`${BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.8 } }),
        signal: AbortSignal.timeout(30000), // never hang the app on a slow model
      });
      if (!res.ok) {
        lastErr = new GeminiError(res.status, `Gemini ${res.status}`);
        if (res.status === 401 || res.status === 403 || res.status === 429) break; // another model will not help
        continue; // 400/404/5xx: try the next model
      }
      const j: any = await res.json();
      const txt = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
      return JSON.parse(txt.replace(/^```json|```$/g, ''));
    } catch (e) {
      lastErr = e; // timeout or bad reply: try the next model
    }
  }
  throw lastErr;
}

export async function testKey(key: string): Promise<{ ok: boolean; message?: string }> {
  try {
    // Listing models only checks the key: instant, no model choice, no generation
    const res = await netFetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return { ok: true };
    if (res.status === 429) return { ok: true, message: 'Key is valid, but the free limit is used up for now. It will work again later.' };
    if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, message: 'Google rejected this key. Copy it again from aistudio.google.com/apikey (no spaces).' };
    return { ok: false, message: `Google answered with an error (${res.status}). Try again in a minute.` };
  } catch (e: any) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false,
      message: timeout
        ? 'Google did not answer in 20 seconds. If you use a VPN or proxy, try turning it off.'
        : `Could not reach Google (${String(e?.cause?.code || e?.message || 'network error').slice(0, 60)}). Check your internet, VPN or firewall.`,
    };
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
  instagram?: { titles: string[]; description: string; hashtags: string[]; caption: string };
}

export async function writeKit(key: string, text: string, hook: string): Promise<KitText | null> {
  if (!key) return null;
  try {
    const prompt = `Write posting copy for a short vertical video. Transcript: """${text.slice(0, 1800)}""". Working title: "${hook}".
Return JSON: {"youtube":{"titles":[3 different titles, max 70 chars, curiosity-driven, no clickbait lies],"description":"2-3 sentences ending with a call to action","hashtags":[6-8 tags without #, include shorts],"caption":"one short on-screen/post caption line"},"tiktok":{"titles":[3 titles max 90 chars],"description":"one short caption under 150 chars","hashtags":[5-7 tags without #, include fyp],"caption":"one short caption line"},"instagram":{"titles":[3 opening hook lines for a Reel caption, max 80 chars],"description":"Reel caption: hook line, 2 short sentences, call to action to save/share, under 300 chars","hashtags":[3-5 tags without #, include reels],"caption":"one short on-screen caption line"}}. Use plain words. No emojis in titles.`;
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
