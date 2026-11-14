import type { Candidate, Word } from '../shared/types';

const HOOK_PHRASES = [
  "you won't believe",
  'you will not believe',
  'the secret',
  'the truth',
  'here is',
  "here's",
  'biggest mistake',
  'nobody',
  'never',
  'stop',
  'wait',
  'listen',
  'imagine',
  'what if',
  'the reason',
  'how to',
  'why ',
  'this is',
  'let me tell you',
  'number one',
  'the best',
  'the worst',
];
const EMOTION = new Set(
  'love hate crazy insane amazing incredible unbelievable shocking terrifying scary angry furious happy sad cry crying laugh laughing funny hilarious dead died kill killed hurt pain scared afraid wow omg damn fire best worst wrong mistake secret truth lie lied money million billion rich broke free fail failed win won lost fight war epic huge massive disgusting beautiful perfect worst nightmare dream'.split(
    ' ',
  ),
);
const CURIOSITY = new Set('secret truth reason why how mistake nobody everyone never always actually literally exactly'.split(' '));

export interface Sentence {
  words: Word[];
  s: number;
  e: number;
  text: string;
}

export function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ words: cur, s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((w) => w.t).join(' ') });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.!?]["')]?$/.test(w.t) || (next && next.s - w.e > 0.8) || cur.length > 40) flush();
  });
  flush();
  return out;
}

const clamp = (x: number, a = 0, b = 100) => Math.max(a, Math.min(b, x));

export function textScore(ws: Word[], firstSentence: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const text = ws.map((w) => w.t).join(' ').toLowerCase();
  const first = firstSentence.toLowerCase();
  let s = 30;
  if (/\?/.test(first)) {
    s += 14;
    notes.push('opens with a question');
  }
  if (HOOK_PHRASES.some((p) => first.includes(p))) {
    s += 16;
    notes.push('strong hook phrase at the start');
  }
  if (/\d/.test(first)) {
    s += 5;
    notes.push('opens with a number');
  }
  const n = Math.max(1, ws.length);
  let emo = 0;
  let cur = 0;
  const emoWords: string[] = [];
  for (const w of ws) {
    const c = w.t.toLowerCase().replace(/[^a-z]/g, '');
    if (EMOTION.has(c)) {
      emo++;
      if (emoWords.length < 3 && !emoWords.includes(c)) emoWords.push(c);
    }
    if (CURIOSITY.has(c)) cur++;
  }
  const emoRate = (emo / n) * 100;
  if (emoRate > 1) {
    s += clamp(emoRate * 4, 0, 20);
    notes.push(`emotional words (${emoWords.join(', ')})`);
  }
  s += clamp((cur / n) * 100 * 3, 0, 8);
  const ex = (text.match(/!/g) || []).length;
  const q = (text.match(/\?/g) || []).length;
  s += clamp(ex * 3 + q * 2, 0, 10);
  if (ex >= 2) notes.push('excited delivery');
  const dur = ws[ws.length - 1].e - ws[0].s;
  const wps = n / Math.max(1, dur);
  if (wps >= 2.2 && wps <= 4) s += 6;
  else if (wps < 1.4) s -= 12;
  if (!/[.!?]["')]?$/.test(ws[ws.length - 1].t)) s -= 6; // clean ending matters
  return { score: clamp(s), notes };
}

function percentile(sorted: number[], v: number) {
  if (!sorted.length) return 0;
  let lo = 0,
    hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo / sorted.length;
}

export interface AnalyzeInput {
  words: Word[];
  duration: number;
  energy: number[]; // per `win` seconds
  win: number;
  scenes: number[];
  count: number;
  minLen: number;
  maxLen: number;
}

export function findCandidates(inp: AnalyzeInput, extra = 2): Candidate[] {
  const sents = sentences(inp.words);
  if (!sents.length) return [];
  const sortedE = [...inp.energy].sort((a, b) => a - b);
  const target = Math.min(inp.maxLen, (inp.minLen + inp.maxLen) / 2 + (inp.maxLen - inp.minLen) * 0.15);
  const hasScene = inp.scenes.length > 0;

  const all: Candidate[] = [];
  for (let i = 0; i < sents.length; i++) {
    // choose end sentence whose end is closest to target length, but within [minLen,maxLen]
    let best = -1;
    let bestD = Infinity;
    for (let j = i; j < sents.length; j++) {
      const dur = sents[j].e - sents[i].s;
      if (dur > inp.maxLen) break;
      if (dur >= inp.minLen) {
        const d = Math.abs(dur - target);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    if (best < 0) continue;
    const start = Math.max(0, sents[i].s - 0.25);
    const end = Math.min(inp.duration, sents[best].e + 0.35);
    const ws = inp.words.filter((w) => w.s >= sents[i].s - 0.01 && w.e <= sents[best].e + 0.01);
    if (ws.length < 8) continue;
    const ts = textScore(ws, sents[i].text);

    // audio: mean loudness percentile + how many peaks
    const a0 = Math.floor(start / inp.win);
    const a1 = Math.min(inp.energy.length, Math.ceil(end / inp.win));
    const seg = inp.energy.slice(a0, a1);
    let audio = 40;
    const aNotes: string[] = [];
    if (seg.length) {
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
      const p90 = sortedE[Math.floor(sortedE.length * 0.9)] || 0;
      const peaks = seg.filter((x) => x >= p90).length / seg.length;
      audio = clamp(percentile(sortedE, mean) * 70 + peaks * 60);
      if (audio > 68) aNotes.push('loud, energetic delivery');
    }
    let scene = 0;
    if (hasScene) {
      const n = inp.scenes.filter((t) => t >= start && t <= end).length;
      scene = clamp((n / ((end - start) / 10)) * 25);
      if (scene > 50) aNotes.push('lots of visual changes');
    }
    const score = hasScene ? ts.score * 0.58 + audio * 0.27 + scene * 0.15 : ts.score * 0.65 + audio * 0.35;
    const reasons = [...ts.notes, ...aNotes];
    const hook = sents[i].words.slice(0, 7).map((w) => w.t).join(' ').replace(/[.,;:]+$/, '');
    all.push({
      start,
      end,
      score: Math.round(clamp(score)),
      reason: reasons.length ? capitalise(reasons.slice(0, 3).join('; ')) + '.' : 'Steady, clear talking with a complete thought.',
      hook,
      signals: { text: Math.round(ts.score), audio: Math.round(audio), scene: Math.round(scene) },
    });
  }
  // greedy pick, no overlap
  all.sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  for (const c of all) {
    if (picked.length >= inp.count + extra) break;
    if (picked.every((p) => c.end <= p.start - 1 || c.start >= p.end + 1)) picked.push(c);
  }
  return picked;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
