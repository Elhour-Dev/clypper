import type { Candidate, Kit, PlatformKit } from '../shared/types';
import type { KitText } from './llm';

const STOP = new Set('the a an and or but if then so of to in on at for with is are was were be been it this that these those you your i we they he she as by from not no yes just very really about what when where who how'.split(' '));

export function keywords(text: string, n = 6): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z']{3,}/g) || []) {
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w.replace(/'/g, ''));
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Best next posting slots (local time). YouTube Shorts: lunch/evening; TikTok: evening. */
export function suggestPostTime(platform: 'youtube' | 'tiktok', from = new Date()): string {
  const hours = platform === 'youtube' ? [12, 15, 19] : [19, 20, 21];
  const d = new Date(from);
  for (let add = 0; add < 3; add++) {
    for (const h of hours) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, h, 0, 0);
      const wd = c.getDay();
      if (c.getTime() > from.getTime() + 30 * 60e3 && (platform === 'tiktok' || wd !== 0)) {
        const day = c.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const time = c.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${day}, ${time} (your local time)`;
      }
    }
  }
  return 'Evening, around 7 PM your time';
}

export function templateKit(c: Candidate, text: string, now = new Date()): Kit {
  const kws = keywords(text);
  const topic = kws[0] ? titleCase(kws[0]) : 'This';
  const hook = c.hook.replace(/[.,;:!?]+$/, '');
  const tags = kws.map((k) => k.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const sentence = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 180);
  const yt: PlatformKit = {
    titles: [`${titleCase(hook)}`.slice(0, 70), `${topic}: What Nobody Tells You`.slice(0, 70), `Watch This Before You Try ${topic}`.slice(0, 70)],
    description: `${sentence}\n\nFollow for more short clips like this.`,
    hashtags: ['shorts', ...tags.slice(0, 5), 'viral'].map((t) => '#' + t),
    caption: hook,
    postTime: suggestPostTime('youtube', now),
  };
  const tt: PlatformKit = {
    titles: [titleCase(hook).slice(0, 90), `${topic} hits different`, `Wait for the end: ${topic}`],
    description: `${hook} 👀 Follow for more`.slice(0, 150),
    hashtags: ['fyp', 'foryou', ...tags.slice(0, 4), 'viral'].map((t) => '#' + t),
    caption: hook,
    postTime: suggestPostTime('tiktok', now),
  };
  return { youtube: yt, tiktok: tt };
}

export function mergeKit(base: Kit, llm: KitText | null, now = new Date()): Kit {
  if (!llm) return base;
  const tag = (a: string[]) => a.map((t) => '#' + String(t).replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter((t) => t.length > 1);
  const fix = (p: KitText['youtube'], b: PlatformKit, pf: 'youtube' | 'tiktok'): PlatformKit => ({
    titles: (p.titles || []).slice(0, 3).length === 3 ? p.titles.slice(0, 3) : b.titles,
    description: p.description || b.description,
    hashtags: tag(p.hashtags || []).length ? tag(p.hashtags) : b.hashtags,
    caption: p.caption || b.caption,
    postTime: suggestPostTime(pf, now),
  });
  return { youtube: fix(llm.youtube, base.youtube, 'youtube'), tiktok: fix(llm.tiktok, base.tiktok, 'tiktok') };
}

export function kitText(name: string, kit: Kit): string {
  const block = (label: string, p: PlatformKit) =>
    [
      `=== ${label} ===`,
      'TITLE OPTIONS:',
      ...p.titles.map((t, i) => `  ${i + 1}. ${t}`),
      '',
      'DESCRIPTION:',
      p.description,
      '',
      'HASHTAGS:',
      p.hashtags.join(' '),
      '',
      'CAPTION:',
      p.caption,
      '',
      `BEST TIME TO POST: ${p.postTime}`,
      '',
    ].join('\n');
  return [`Posting kit - ${name}`, '', block('YOUTUBE SHORTS', kit.youtube), block('TIKTOK', kit.tiktok), 'Files in this folder: clip.mp4, cover.jpg, kit.txt', ''].join('\n');
}
