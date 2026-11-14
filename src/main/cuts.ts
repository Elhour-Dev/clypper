import type { Word } from '../shared/types';

export interface Seg {
  s: number;
  e: number;
}

export interface CutPlan {
  segments: Seg[]; // source time ranges to keep, in order
  words: Word[]; // words mapped onto the output timeline
  cutTimes: number[]; // output times where two segments were joined
  duration: number; // output duration
  removedFillers: number;
  removedSilence: number; // seconds
}

const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'eh']);
export const isFiller = (t: string) => FILLERS.has(t.toLowerCase().replace(/[^a-z]/g, ''));

export interface CutOpts {
  silence: boolean;
  fillers: boolean;
  maxGap?: number; // gaps longer than this are shortened
  pad?: number; // breathing room kept around speech
}

export function planCuts(allWords: Word[], start: number, end: number, o: CutOpts): CutPlan {
  const maxGap = o.maxGap ?? 0.5;
  const pad = o.pad ?? 0.12;
  const inRange = allWords.filter((w) => w.e > start && w.s < end);
  const kept: Word[] = [];
  const cutBefore = new Set<number>(); // index in kept that must start a new segment
  let sawFiller = false;
  let removedFillers = 0;
  for (const w of inRange) {
    if (o.fillers && isFiller(w.t)) {
      sawFiller = true;
      removedFillers++;
      continue;
    }
    if (sawFiller && kept.length) cutBefore.add(kept.length);
    sawFiller = false;
    const prev = kept[kept.length - 1];
    if (o.silence && prev && w.s - prev.e > maxGap) cutBefore.add(kept.length);
    kept.push({ t: w.t, s: Math.max(w.s, start), e: Math.min(w.e, end) });
  }
  if (!kept.length || (!o.silence && !o.fillers)) {
    const words = inRange.map((w) => ({ t: w.t, s: Math.max(w.s, start) - start, e: Math.min(w.e, end) - start }));
    return { segments: [{ s: start, e: end }], words, cutTimes: [], duration: end - start, removedFillers: 0, removedSilence: 0 };
  }

  // build segments around groups of kept words
  const groups: Word[][] = [];
  kept.forEach((w, i) => {
    if (i === 0 || cutBefore.has(i)) groups.push([]);
    groups[groups.length - 1].push(w);
  });
  const segs: Seg[] = groups.map((g, gi) => ({
    s: Math.max(start, g[0].s - (gi === 0 ? 0.2 : pad)),
    e: Math.min(end, g[g.length - 1].e + (gi === groups.length - 1 ? 0.3 : pad)),
  }));
  // merge touching/overlapping
  const merged: Seg[] = [];
  const groupSeg: number[] = [];
  segs.forEach((sg) => {
    const last = merged[merged.length - 1];
    if (last && sg.s <= last.e + 0.02) last.e = Math.max(last.e, sg.e);
    else merged.push({ ...sg });
    groupSeg.push(merged.length - 1);
  });

  // offsets
  const offs: number[] = [];
  let acc = 0;
  for (const m of merged) {
    offs.push(acc);
    acc += m.e - m.s;
  }
  const words: Word[] = [];
  groups.forEach((g, gi) => {
    const k = groupSeg[gi];
    for (const w of g) words.push({ t: w.t, s: offs[k] + (w.s - merged[k].s), e: offs[k] + (w.e - merged[k].s) });
  });
  const total = acc;
  return {
    segments: merged,
    words,
    cutTimes: offs.slice(1),
    duration: total,
    removedFillers,
    removedSilence: Math.max(0, end - start - total),
  };
}

const STRONG = new Set(
  'never always secret biggest huge million billion free best worst insane crazy shocking wrong mistake truth money stop nobody everyone literally actually amazing incredible hate love die dead killed'.split(' '),
);

export interface Zoom {
  t: number; // when the step starts (output timeline, seconds)
  d: number; // how long the snap takes
  amt: number; // change of zoom level (+ zoom in, - zoom out), e.g. 0.1 = 10 %
  emph?: boolean; // zoom on an emphasised word (gets a pop sound)
}

/**
 * Zooms the way current short clips do it: a quick snap-in that is HELD (not a pulse back),
 * then a snap back out on the next sentence / jump cut. Bigger snap on emphasised words.
 * Steps are at least 1.8 s apart and there is always some movement at least every ~5 s.
 */
export function planZooms(words: Word[], duration: number, cutTimes: number[] = []): Zoom[] {
  type Ev = { t: number; strong: boolean };
  const evs: Ev[] = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const clean = w.t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!prev || /[.!?]$/.test(prev.t) || w.s - prev.e > 0.6) evs.push({ t: w.s, strong: false });
    if (STRONG.has(clean) || /[!?]$/.test(w.t) || /^\d/.test(w.t)) evs.push({ t: Math.max(0, w.s - 0.05), strong: true });
  });
  cutTimes.forEach((t) => evs.push({ t, strong: false }));
  evs.sort((a, b) => a.t - b.t);

  const out: Zoom[] = [];
  let level = 0;
  let last = -10;
  const base = 0.1;
  const big = 0.17;
  const push = (t: number, target: number, strong: boolean) => {
    const amt = target - level;
    if (Math.abs(amt) < 0.01) return;
    out.push({ t, d: amt > 0 ? 0.14 : 0.22, amt, emph: strong && amt > 0 });
    level = target;
    last = t;
  };
  for (const e of evs) {
    if (e.t < 0.5 || e.t > duration - 0.8) continue;
    if (e.t - last < 1.8) continue;
    if (e.strong) push(e.t, big, true);
    else push(e.t, level > 0.01 ? 0 : base, false);
  }
  // keep it alive: nothing moves for more than ~5 s -> add a gentle step at the next word
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.s < 0.5 || w.s > duration - 0.8 || w.s - last < 5) continue;
    const at = out.findIndex((z) => z.t > w.s);
    const before = at < 0 ? out.length : at;
    const lvl = out.slice(0, before).reduce((a, z) => a + z.amt, 0);
    out.splice(before, 0, { t: w.s, d: lvl > 0.01 ? 0.22 : 0.14, amt: lvl > 0.01 ? -lvl : base });
    last = w.s;
    // recompute following steps' levels is not needed: later steps use deltas relative to the running level
    break;
  }
  return out;
}
