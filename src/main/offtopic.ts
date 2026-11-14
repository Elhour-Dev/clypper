import type { Word } from '../shared/types';

export interface Span {
  s: number;
  e: number;
}

/** Words that start a stream alert / donation read ("John donated 5 dollars and says ..."). */
const ALERT = /^(donat(?:ed|es|ion|ions)|tipped|subscribed|resubbed|gifted|gifting|cheered|superchat)$/i;
/** Second signal near the alert word, so normal talk like "he donated to charity" is kept. */
const PROOF = /(\$\s?\d|\d\s*\$|\b\d[\d,.]*\s*(dollars?|euros?|bucks|bits|subs?|months?)\b|\b(says|saying|message|just|thank you|thanks for)\b)/i;

const clean = (w: string) => w.replace(/[^\p{L}\p{N}$.,]/gu, '').replace(/[.,]+$/, '');

/**
 * Find stretches that are stream alerts or donation messages read by a text-to-speech voice.
 * They are not the streamer's own words, so they get no captions.
 * Rule: an alert word starts a span a few words earlier (the donor name); the span lasts
 * until the next real pause (>= 1.2 s) or 25 s at most.
 */
export function findOffTopic(words: Word[]): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!ALERT.test(clean(words[i].t))) continue;
    const near = words.slice(Math.max(0, i - 3), i + 8).map((x) => x.t).join(' ');
    if (!PROOF.test(near)) continue;
    // go back to the donor name (up to 4 words, not across a pause)
    let a = i;
    while (a > 0 && i - a < 4 && words[a].s - words[a - 1].e < 0.5) a--;
    // go forward until a real pause
    let b = i;
    while (b + 1 < words.length && words[b + 1].s - words[b].e < 1.2 && words[b + 1].e - words[a].s < 25) b++;
    spans.push({ s: words[a].s, e: words[b].e });
    i = b;
  }
  const out: Span[] = [];
  for (const sp of spans.sort((x, y) => x.s - y.s)) {
    const last = out[out.length - 1];
    if (last && sp.s <= last.e + 0.5) last.e = Math.max(last.e, sp.e);
    else out.push({ ...sp });
  }
  return out;
}

/** Drop words that fall inside any off-topic span. */
export function dropSpans(words: Word[], spans: Span[]): Word[] {
  if (!spans.length) return words;
  return words.filter((w) => {
    const m = (w.s + w.e) / 2;
    return !spans.some((s) => m >= s.s && m <= s.e);
  });
}
