import type { CaptionStyleId, Word } from '../shared/types';

export interface StyleDef {
  id: CaptionStyleId;
  label: string;
  font: string;
  size: number;
  upper: boolean;
  group: number; // max words per group (1 = one word at a time)
  primary: string; // RGB hex for normal words
  active: string; // active word colour
  outline: string;
  outlineW: number;
  box?: boolean;
}

export const STYLES: Record<CaptionStyleId, StyleDef> = {
  hormozi: { id: 'hormozi', label: 'Hormozi', font: 'Poppins ExtraBold', size: 86, upper: true, group: 3, primary: 'FFFFFF', active: 'FFE600', outline: '000000', outlineW: 9 },
  mrbeast: { id: 'mrbeast', label: 'MrBeast', font: 'Bangers', size: 150, upper: true, group: 2, primary: 'FFFFFF', active: '3DFF7A', outline: '000000', outlineW: 12 },
  pop: { id: 'pop', label: 'Pop', font: 'Poppins ExtraBold', size: 92, upper: true, group: 3, primary: 'FFFFFF', active: 'FFE600', outline: '000000', outlineW: 7 },
  karaoke: { id: 'karaoke', label: 'Karaoke', font: 'Poppins ExtraBold', size: 80, upper: false, group: 4, primary: 'FFFFFF', active: '3DFF7A', outline: '000000', outlineW: 6 },
  boxed: { id: 'boxed', label: 'Boxed', font: 'Poppins Bold', size: 74, upper: false, group: 4, primary: 'FFFFFF', active: '42E8FF', outline: '000000', outlineW: 16, box: true },
  kinetic: { id: 'kinetic', label: 'Kinetic', font: 'Anton', size: 190, upper: true, group: 1, primary: 'FFFFFF', active: 'FF3D6E', outline: '000000', outlineW: 8 },
  minimal: { id: 'minimal', label: 'Minimal', font: 'Bebas Neue', size: 96, upper: true, group: 4, primary: 'FFFFFF', active: 'FFFFFF', outline: '000000', outlineW: 3 },
  comic: { id: 'comic', label: 'Comic', font: 'Bangers', size: 104, upper: true, group: 3, primary: 'FFD400', active: 'FFFFFF', outline: '1A1A1A', outlineW: 8 },
};

/** ASS colour: &HBBGGRR& */
const col = (rgb: string) => `&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`;

function t(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
}

const esc = (s: string) => s.replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ');

export function groupWords(words: Word[], max: number): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    if (prev && (w.s - prev.e > 0.6 || /[.!?]$/.test(prev.t))) flush();
    cur.push(w);
    const chars = cur.reduce((n, x) => n + x.t.length + 1, 0);
    if (cur.length >= max || chars > 24 || (i < words.length - 1 && /[.!?,]$/.test(w.t) && cur.length >= 2)) flush();
  });
  flush();
  return groups;
}

// "lower": just under the middle, above the platform buttons/description area (the usual spot in viral clips)
const ALIGN = { bottom: { a: 2, mv: 330 }, lower: { a: 2, mv: 560 }, middle: { a: 5, mv: 0 }, top: { a: 8, mv: 260 } };

/** Words worth highlighting in a different colour (numbers, money, strong emotion). */
const KEY_WORDS = /^(\$?\d[\d,.]*[kKmM%]?|money|million|billion|free|never|always|secret|crazy|insane|best|worst|wrong|truth|stop|why|how|win|lose|rich|broke|died|dead|love|hate|fear|biggest|every|nobody|everyone|mistake|shocking|real|fake)$/i;
const BRIGHT = ['3DFF7A', 'FFE600', '42E8FF', 'FF3D6E', 'FF9A1F'];

export interface AssOpts {
  style: CaptionStyleId;
  pos: 'bottom' | 'lower' | 'middle' | 'top';
  words: Word[]; // output timeline
  duration: number;
  hook?: string;
  W?: number;
  H?: number;
}

export function buildAss(o: AssOpts): string {
  const W = o.W ?? 1080;
  const H = o.H ?? 1920;
  const st = STYLES[o.style];
  const al = ALIGN[o.pos];
  const scale = W / 1080;
  const sz = Math.round(st.size * scale);
  const back = st.box ? '&H99000000&' : '&H00000000&';
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${st.font},${sz},${col(st.primary)},${col(st.active)},${col(st.outline)},${back},0,0,0,0,100,100,0,0,${st.box ? 3 : 1},${st.outlineW * scale},${st.box ? 0 : 3},${al.a},60,60,${Math.round(al.mv * scale)},1`,
    `Style: Hook,Anton,${Math.round(104 * scale)},${col('FFFFFF')},${col('FFFFFF')},${col('000000')},&H00000000&,0,0,0,0,100,100,0,0,1,${8 * scale},3,8,70,70,${Math.round(210 * scale)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev: string[] = [];
  const cap = (w: string) => esc(st.upper ? w.toUpperCase() : w);

  if (o.hook) {
    const end = Math.min(o.duration, 3.2);
    ev.push(`Dialogue: 2,${t(0)},${t(end)},Hook,,0,0,0,,{\\fad(120,250)\\fscx80\\fscy80\\t(0,160,\\fscx100\\fscy100)}${esc(o.hook.toUpperCase())}`);
  }

  const groups = groupWords(o.words, st.group);
  groups.forEach((g, gi) => {
    const gEnd = Math.min(o.duration, (groups[gi + 1]?.[0].s ?? g[g.length - 1].e + 0.35));
    g.forEach((w, wi) => {
      const s = w.s;
      let e = wi < g.length - 1 ? g[wi + 1].s : Math.max(w.e, Math.min(gEnd, w.e + 0.25));
      if (e <= s + 0.03) e = s + 0.06;
      let text: string;
      if (o.style === 'kinetic') {
        const rot = ((gi * 7) % 9) - 4;
        const color = [st.primary, st.active, 'FFE600', '3DFF7A', '42E8FF'][gi % 5];
        text = `{\\an5\\pos(${W / 2},${Math.round(H * 0.5)})\\c${col(color)}\\frz${rot}\\fscx45\\fscy45\\t(0,110,\\fscx118\\fscy118)\\t(110,200,\\fscx100\\fscy100)}${cap(w.t)}`;
      } else {
        text = g
          .map((x, xi) => {
            const key = KEY_WORDS.test(x.t.replace(/[^\p{L}\p{N}$%.,]/gu, '').replace(/[.,]+$/, ''));
            if (xi !== wi) return o.style === 'hormozi' && key ? `{\\c${col('3DFF7A')}}${cap(x.t)}{\\r}` : cap(x.t);
            const pop =
              o.style === 'mrbeast'
                ? '\\fscx70\\fscy70\\t(0,90,\\fscx130\\fscy130)\\t(90,180,\\fscx108\\fscy108)'
                : o.style === 'hormozi'
                  ? '\\fscx92\\fscy92\\t(0,80,\\fscx114\\fscy114)\\t(80,160,\\fscx104\\fscy104)'
                  : o.style === 'comic' ? '\\fscx80\\fscy80\\t(0,90,\\fscx118\\fscy118)\\t(90,170,\\fscx105\\fscy105)' : '\\fscx90\\fscy90\\t(0,80,\\fscx112\\fscy112)\\t(80,150,\\fscx104\\fscy104)';
            const hue = o.style === 'hormozi' ? (key ? '3DFF7A' : st.active) : o.style === 'mrbeast' ? BRIGHT[(gi + wi) % BRIGHT.length] : st.active;
            const color = o.style === 'minimal' ? '' : `\\c${col(hue)}`;
            return `{${color}${pop}}${cap(x.t)}{\\r}`;
          })
          .join(' ');
      }
      ev.push(`Dialogue: 1,${t(s)},${t(e)},Cap,,0,0,0,,${text}`);
    });
  });
  return header.concat(ev, ['']).join('\n');
}
