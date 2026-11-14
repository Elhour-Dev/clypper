import { describe, expect, it } from 'vitest';
import { isFiller, planCuts, planZooms } from '../src/main/cuts';
import { buildAss, groupWords } from '../src/main/ass';
import { findCandidates, sentences, textScore } from '../src/main/analyze';
import { keywords, mergeKit, suggestPostTime, templateKit, kitText } from '../src/main/kit';
import { isNewer } from '../src/main/update';
import { parseWhisperJson } from '../src/main/transcribe';
import { applyCaptionText, cropCommands, zoomExpr, srcToOut } from '../src/main/render';
import { chooseSpeakers, nms } from '../src/main/faces';
import type { Word } from '../src/shared/types';

const mk = (spec: [string, number, number][]): Word[] => spec.map(([t, s, e]) => ({ t, s, e }));

describe('cuts', () => {
  const words = mk([['Hello', 1, 1.3], ['um', 1.4, 1.8], ['world.', 1.9, 2.3], ['Long', 4.0, 4.3], ['pause.', 4.4, 4.8]]);
  it('detects fillers', () => {
    expect(isFiller('Um,')).toBe(true);
    expect(isFiller('umbrella')).toBe(false);
  });
  it('removes fillers and long silences and shortens duration', () => {
    const p = planCuts(words, 0.5, 5.2, { silence: true, fillers: true });
    expect(p.removedFillers).toBe(1);
    expect(p.words.map((w) => w.t)).toEqual(['Hello', 'world.', 'Long', 'pause.']);
    expect(p.duration).toBeLessThan(4.7);
    expect(p.segments.length).toBeGreaterThanOrEqual(2);
    expect(p.cutTimes.length).toBe(p.segments.length - 1);
    // output words never overlap and stay inside the output duration
    p.words.forEach((w, i) => {
      expect(w.e).toBeLessThanOrEqual(p.duration + 0.01);
      if (i) expect(w.s).toBeGreaterThanOrEqual(p.words[i - 1].s);
    });
  });
  it('keeps everything when both options are off', () => {
    const p = planCuts(words, 0.5, 5.2, { silence: false, fillers: false });
    expect(p.segments).toEqual([{ s: 0.5, e: 5.2 }]);
    expect(p.words.length).toBe(5);
    expect(p.duration).toBeCloseTo(4.7);
  });
  it('maps source time to output time', () => {
    const p = planCuts(words, 0.5, 5.2, { silence: true, fillers: true });
    expect(srcToOut(p, 4.0, 0.5)).toBeGreaterThan(0);
    expect(srcToOut(p, 4.0, 0.5)).toBeLessThan(p.duration);
  });
  it('plans held zoom steps that alternate in and out, spaced apart', () => {
    const w = mk([['This', 0.6, 0.9], ['is', 0.9, 1.1], ['never', 2.2, 2.6], ['good!', 2.7, 3.1], ['Next', 5, 5.3], ['thing', 5.3, 5.6], ['here.', 5.6, 6]]);
    const z = planZooms(w, 8);
    expect(z.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < z.length; i++) expect(z[i].t - z[i - 1].t).toBeGreaterThanOrEqual(1.7);
    expect(z[0].amt).toBeGreaterThan(0);
    expect(z.reduce((a, x) => a + x.amt, 0)).toBeLessThan(0.2); // never zooms past ~18 %
    expect(zoomExpr(z)).toContain('clip((t-');
  });
});

describe('captions (ASS)', () => {
  const w = mk([['Why', 0, 0.3], ['does', 0.3, 0.6], ['this', 0.6, 0.9], ['work?', 0.9, 1.3], ['Because', 1.5, 2], ['math.', 2, 2.5]]);
  it('groups words and breaks on sentence ends', () => {
    const g = groupWords(w, 3);
    expect(g[0].map((x) => x.t)).toEqual(['Why', 'does', 'this']);
    expect(g.flat().length).toBe(6);
  });
  for (const style of ['pop', 'karaoke', 'boxed', 'kinetic', 'minimal', 'comic'] as const) {
    it(`builds valid ${style} ass with one event per word`, () => {
      const a = buildAss({ style, pos: 'middle', words: w, duration: 3, hook: 'My hook' });
      expect(a).toContain('[Events]');
      expect(a.split('\n').filter((l) => l.startsWith('Dialogue: 1')).length).toBe(6);
      expect(a).toContain('My hook'.toUpperCase());
      expect(a).toContain('PlayResY: 1920');
    });
  }
  it('escapes override braces in user text', () => {
    const a = buildAss({ style: 'pop', pos: 'bottom', words: mk([['a{b}', 0, 1]]), duration: 2 });
    expect(a).not.toMatch(/a\{b\}/);
  });
  it('edits caption text keeping timing when counts match', () => {
    const r = applyCaptionText(w.slice(0, 3), 'A B C');
    expect(r.map((x) => x.t)).toEqual(['A', 'B', 'C']);
    expect(r[1].s).toBe(w[1].s);
    expect(applyCaptionText(w.slice(0, 3), 'only two').length).toBe(2);
  });
});

describe('moment finding', () => {
  const sp = (text: string, t0: number, wps = 3): Word[] =>
    text.split(' ').map((t, i) => ({ t, s: t0 + i / wps, e: t0 + (i + 0.8) / wps }));
  const boring = sp('so this is a normal sentence about the weather today and nothing else really.', 0);
  const hooky = sp("Why does nobody tell you this secret? It is insane and crazy, you will never believe the money! Stop and listen to this right now.", 40);
  const filler = sp('we keep talking about small stuff for a while until the end of this part ok.', 80);
  const words = [...boring, ...hooky, ...filler];
  it('splits sentences', () => {
    expect(sentences(words).length).toBeGreaterThanOrEqual(3);
  });
  it('scores hooks higher than boring text', () => {
    const a = textScore(hooky, 'Why does nobody tell you this secret?').score;
    const b = textScore(boring, boring.map((x) => x.t).join(' ')).score;
    expect(a).toBeGreaterThan(b + 15);
  });
  it('picks the hooky window first, within length limits, no overlaps', () => {
    const c = findCandidates({ words, duration: 100, energy: new Array(200).fill(0.1), win: 0.5, scenes: [], count: 2, minLen: 5, maxLen: 12 });
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].start).toBeGreaterThanOrEqual(38);
    expect(c[0].start).toBeLessThan(60);
    expect(c[0].reason.length).toBeGreaterThan(5);
    c.forEach((x) => {
      expect(x.end - x.start).toBeLessThanOrEqual(13);
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(100);
    });
    for (let i = 1; i < c.length; i++) expect(c[i].start >= c[i - 1].end || c[i].end <= c[i - 1].start).toBe(true);
  });
});

describe('posting kit', () => {
  const cand = { start: 0, end: 30, score: 80, reason: '', hook: 'Why does nobody tell you this', signals: { text: 1, audio: 1, scene: 1 } };
  it('extracts keywords', () => {
    expect(keywords('money money money invest invest the and secret')[0]).toBe('money');
  });
  it('builds 3 titles per platform with hashtags and a future time', () => {
    const now = new Date(2026, 10, 14, 10, 0, 0);
    const k = templateKit(cand, 'money is the secret of investing money well', now);
    expect(k.youtube.titles).toHaveLength(3);
    expect(k.tiktok.titles).toHaveLength(3);
    expect(k.instagram!.titles).toHaveLength(3);
    expect(k.instagram!.hashtags).toContain('#reels');
    expect(k.instagram!.hashtags.length).toBeLessThanOrEqual(6);
    expect(kitText('x', k)).toContain('INSTAGRAM REELS');
    expect(k.youtube.hashtags.every((h) => h.startsWith('#'))).toBe(true);
    expect(k.youtube.hashtags).toContain('#shorts');
    expect(k.tiktok.hashtags).toContain('#fyp');
    expect(k.youtube.titles.every((t) => t.length <= 70)).toBe(true);
    expect(k.youtube.postTime).toMatch(/PM|AM/);
  });
  it('suggests a later time and skips Sunday for YouTube', () => {
    const sat = new Date(2026, 10, 14, 21, 30); // Saturday night
    expect(suggestPostTime('youtube', sat)).toMatch(/Monday/);
  });
  it('merges LLM text but falls back when it is incomplete', () => {
    const base = templateKit(cand, 'money secret');
    expect(mergeKit(base, null)).toBe(base);
    const m = mergeKit(base, { youtube: { titles: ['a', 'b'], description: 'd', hashtags: ['x'], caption: 'c' }, tiktok: { titles: ['1', '2', '3'], description: 'd', hashtags: ['#y'], caption: 'c' } });
    expect(m.youtube.titles).toEqual(base.youtube.titles);
    expect(m.tiktok.titles).toEqual(['1', '2', '3']);
    expect(m.tiktok.hashtags).toEqual(['#y']);
  });
  it('writes the text file', () => {
    const t = kitText('demo', templateKit(cand, 'money secret'));
    expect(t).toContain('YOUTUBE SHORTS');
    expect(t).toContain('TIKTOK');
    expect(t).toContain('BEST TIME TO POST');
  });
});

describe('misc', () => {
  it('compares versions', () => {
    expect(isNewer('v1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });
  it('parses whisper word json and merges punctuation', () => {
    const seg = (text: string, a: number, b: number) => ({ text, offsets: { from: a, to: b } });
    const t = parseWhisperJson({ transcription: [seg('', 0, 100), seg(' Hello', 100, 500), seg(',', 500, 520), seg(' world', 600, 900), seg('.', 900, 910), seg(' [MUSIC]', 1000, 1200), seg(' fine', 1300, 1500)] }, 10);
    expect(t.words.map((w) => w.t)).toEqual(['Hello,', 'world.', 'fine']);
    expect(t.words[0].s).toBeCloseTo(0.1);
  });
  it('builds crop commands that stay inside the frame and follow the face', () => {
    const plan = planCuts([], 0, 10, { silence: false, fillers: false });
    const face = Array.from({ length: 61 }, (_, i) => ({ t: i / 6, x: i / 6 < 4 ? 0.2 : 0.8 }));
    const lines = cropCommands(plan, face, 1920, 1080, 606).split('\n');
    const xs = lines.map((l) => Number(/x (\d+);/.exec(l)![1]));
    // smooth: no single step is bigger than a few pixels (30 updates per second)
    expect(Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])))).toBeLessThan(40);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1920 - 606);
    expect(xs[xs.length - 1]).toBeGreaterThan(xs[0]);
  });
  it('merges overlapping face boxes and sticks to the current speaker', () => {
    const box = (x: number, w: number, s = 0.9) => ({ x1: x, y1: 0.2, x2: x + w, y2: 0.2 + w, s });
    expect(nms([box(0.1, 0.2), box(0.11, 0.2, 0.8), box(0.7, 0.2)]).length).toBe(2);
    const frames = [[box(0.1, 0.2)], [box(0.1, 0.2), box(0.7, 0.22)], [box(0.1, 0.2), box(0.7, 0.22)], [box(0.7, 0.4), box(0.1, 0.2)]];
    const pts = chooseSpeakers(frames, 0.33, 0)!;
    expect(pts[2].x).toBeLessThan(0.4); // stays with first (second face only slightly bigger)
    expect(pts[3].x).toBeGreaterThan(0.6); // switches when clearly bigger
    expect(chooseSpeakers([[], [], [], [], []], 0.3, 0)).toBeNull();
  });
});

describe('min length after cuts', () => {
  it('stretches a clip so the edited length reaches the minimum', async () => {
    const { stretchToMin } = await import('../src/main/pipeline');
    // speech with a 3 s silence in the middle: cutting it shortens the clip
    const w: Word[] = [];
    for (let i = 0; i < 40; i++) w.push({ t: 'w' + i, s: i * 0.5 + (i >= 10 ? 3 : 0), e: i * 0.5 + 0.4 + (i >= 10 ? 3 : 0) });
    const d = { removeSilence: true, removeFillers: true } as any;
    const end = stretchToMin(w, 0, 14, { minLen: 15, maxLen: 30 }, 60, d);
    expect(end).toBeGreaterThan(14);
    expect(planCuts(w, 0, end, { silence: true, fillers: true }).duration).toBeGreaterThanOrEqual(14.5);
  });
});

describe('gemini model picking', () => {
  it('prefers newest stable flash-lite, then flash, and skips previews/images', async () => {
    const { rankModels } = await import('../src/main/llm');
    const r = rankModels(['models/gemini-3.5-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-3-flash-preview', 'models/gemini-2.5-flash', 'models/gemini-3.1-flash-lite', 'models/gemini-3.5-flash-image', 'models/gemma-4-31b-it']);
    expect(r).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash']);
  });
});

import { findOffTopic, dropSpans } from '../src/main/offtopic';
import { collapseLoops } from '../src/main/transcribe';

describe('donations, loops, new styles', () => {
  const seq = (txt: string, t0 = 0, gap = 0.3): Word[] => txt.split(' ').map((t, i) => ({ t, s: t0 + i * gap, e: t0 + i * gap + 0.25 }));
  it('finds a donation read and keeps normal talk', () => {
    const w = [...seq('so this is crazy man'), ...seq('Mike donated 5 dollars and says you are the goat', 3), ...seq('bro thank you so much', 8)];
    const spans = findOffTopic(w);
    expect(spans.length).toBe(1);
    const kept = dropSpans(w, spans).map((x) => x.t).join(' ');
    expect(kept).toContain('crazy');
    expect(kept).toContain('thank you');
    expect(kept).not.toContain('donated');
    expect(findOffTopic(seq('he donated to charity last year and it was great'))).toEqual([]);
  });
  it('collapses repeated-word loops but keeps real repeats', () => {
    const loop = Array.from({ length: 12 }, (_, i) => ({ t: 'okay', s: i * 0.3, e: i * 0.3 + 0.2 }));
    expect(collapseLoops(loop).length).toBe(3);
    expect(collapseLoops(seq('no no no way')).length).toBe(4);
  });
  it('builds hormozi and mrbeast captions', () => {
    for (const style of ['hormozi', 'mrbeast'] as const) {
      const ass = buildAss({ style, pos: 'lower', words: seq('this made me ten million dollars'), duration: 5 });
      expect(ass).toContain('Dialogue: 1');
    }
  });
});

import { camFromHits } from '../src/main/webcam';
import { mergeWords, titleHint } from '../src/main/pipeline';

describe('split layout and caption refine', () => {
  const hit = (cx: number, cy: number, h: number) => ({ cx, cy, w: h * 0.6, h });
  it('finds a webcam that stays in one corner and ignores big faces', () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit(0.88 + (i % 3) * 0.003, 0.8, 0.14));
    const cam = camFromHits(hits, 20, 1920, 1080)!;
    expect(cam).not.toBeNull();
    expect(cam.x + cam.w).toBeLessThanOrEqual(1.0001);
    expect((cam.w * 1920) / (cam.h * 1080)).toBeCloseTo(1080 / 960, 1);
    expect(camFromHits(hits.slice(0, 2), 20, 1920, 1080)).toBeNull();
    expect(camFromHits(hits.map((h) => ({ ...h, h: 0.5 })), 20, 1920, 1080)).toBeNull();
  });
  it('replaces words in a re-listened range and keeps the rest', () => {
    const old = mk([['a', 0, 0.5], ['b', 5, 5.5], ['c', 9, 9.5]]);
    const fresh = mk([['B1', 5, 5.3], ['B2', 5.3, 5.6]]);
    expect(mergeWords(old, fresh, 4, 7).map((w) => w.t)).toEqual(['a', 'B1', 'B2', 'c']);
    expect(titleHint('IShowSpeed: GTA 6 LIVE 🔴')).toBe('IShowSpeed GTA 6 LIVE');
  });
});
