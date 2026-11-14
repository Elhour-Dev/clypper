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

/** Pick output-timeline moments for punch-in zooms (key words). */
export function planZooms(words: Word[], duration: number): { t: number; d: number; amt: number }[] {
  const out: { t: number; d: number; amt: number }[] = [];
  let last = -10;
  for (const w of words) {
    const clean = w.t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = STRONG.has(clean) || /[!?]$/.test(w.t) || /^\d/.test(w.t);
    if (key && w.s - last >= 2.6 && w.s > 0.6 && w.s < duration - 1) {
      out.push({ t: Math.max(0, w.s - 0.05), d: 0.7, amt: out.length % 2 ? 0.1 : 0.14 });
      last = w.s;
    }
  }
  return out;
}
