import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClipSettings, Word } from '../shared/types';
import { planCuts, planZooms, CutPlan } from './cuts';
import { buildAss } from './ass';
import { dropSpans, findOffTopic } from './offtopic';
import { run, FriendlyError } from './run';
import { parseTime } from './media';
import { cacheDir, ensureDir, ffmpegPath, fontsDir } from './paths';

export interface FacePoint {
  t: number; // source seconds
  x: number; // 0..1 horizontal centre of the speaker
}

export interface RenderJob {
  src: string;
  srcW: number;
  srcH: number;
  words: Word[]; // full transcript words (source time)
  settings: ClipSettings;
  out: string;
  quality: 'preview' | 'final';
  face?: FacePoint[] | null;
  qsv?: boolean;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  duration: number;
  plan: CutPlan;
  filter: string;
  usedReframe: string;
}

const q = (s: string) => `'${s}'`;
const n3 = (x: number) => (Math.round(x * 1000) / 1000).toString();

export function renderWorkDir() {
  const d = ensureDir(path.join(cacheDir(), 'render'));
  const fd = ensureDir(path.join(d, 'fonts'));
  if (fs.existsSync(fontsDir())) {
    for (const f of fs.readdirSync(fontsDir())) {
      if (/\.(ttf|otf)$/i.test(f) && !fs.existsSync(path.join(fd, f))) fs.copyFileSync(path.join(fontsDir(), f), path.join(fd, f));
    }
  }
  return d;
}

/** Map a source time onto the output timeline using the kept segments. */
export function srcToOut(plan: CutPlan, t: number, start: number): number {
  let acc = 0;
  for (const s of plan.segments) {
    if (t < s.s) return acc;
    if (t <= s.e) return acc + (t - s.s);
    acc += s.e - s.s;
  }
  return acc;
}

function outToSrc(plan: CutPlan, t: number): number {
  let acc = 0;
  for (const s of plan.segments) {
    const d = s.e - s.s;
    if (t <= acc + d) return s.s + (t - acc);
    acc += d;
  }
  return plan.segments[plan.segments.length - 1].e;
}

/** Smooth crop-centre path on the output timeline: returns commands "time x" for the crop filter. */
export function cropCommands(plan: CutPlan, face: FacePoint[], srcW: number, srcH: number, cw: number): string {
  const lines: string[] = [];
  const maxX = srcW - cw;
  // remove one-frame detection glitches before following the face
  face = face.map((p, i) => {
    const xs = face.slice(Math.max(0, i - 2), i + 3).map((q) => q.x).sort((a, b) => a - b);
    return { t: p.t, x: xs[Math.floor(xs.length / 2)] };
  });
  const sample = (ts: number) => {
    // nearest-in-time face point, linear interpolation
    let a = face[0];
    let b = face[face.length - 1];
    for (let i = 0; i < face.length; i++) {
      if (face[i].t <= ts) a = face[i];
      if (face[i].t >= ts) {
        b = face[i];
        break;
      }
    }
    if (b.t === a.t) return a.x;
    return a.x + ((b.x - a.x) * (ts - a.t)) / (b.t - a.t);
  };
  // "virtual camera": holds still while the speaker stays near the middle (dead zone), then glides to follow
  // with a critically damped spring, so there are no stops and jumps. Updated 30 times per second.
  // The speed adapts to the clip: a calm talker gets a slow, steady camera; a fast-moving one a quicker camera.
  const dt = 1 / 30;
  const path0: number[] = [];
  for (let t = 0; t < plan.duration + 0.1; t += dt) path0.push(sample(outToSrc(plan, t)) * srcW);
  let travel = 0;
  for (let i = 1; i < path0.length; i++) travel += Math.abs(path0[i] - path0[i - 1]);
  const speed = Math.min(1.5, travel / Math.max(1, plan.duration) / cw); // crop widths per second the face really moves
  const tau = Math.max(0.16, Math.min(0.5, 0.5 - 1.1 * speed));
  const dead = cw * (speed > 0.3 ? 0.04 : 0.07);
  const omega = 2 / tau;
  const vmax = cw * (1.2 + 2 * speed);
  const lead = tau * 0.6; // look slightly ahead so the camera is not late
  let cam = -1;
  let v = 0;
  let last = -1;
  for (let t = 0; t < plan.duration + 0.1; t += dt) {
    const target = Math.max(0, Math.min(maxX, sample(outToSrc(plan, t + lead)) * srcW - cw / 2));
    if (cam < 0) cam = target;
    const off = target - cam;
    const goal = Math.abs(off) > dead ? target - Math.sign(off) * dead * 0.5 : cam;
    v += (omega * omega * (goal - cam) - 2 * omega * v) * dt;
    v = Math.max(-vmax, Math.min(vmax, v));
    cam = Math.max(0, Math.min(maxX, cam + v * dt));
    const xi = Math.round(cam);
    if (xi !== last) lines.push(`${t.toFixed(3)} crop@c x ${xi};`);
    last = xi;
  }
  return lines.join('\n');
}

/** Zoom level over time: each step eases out over its duration (fast snap, soft landing) and is then held. */
export function zoomExpr(zs: { t: number; d: number; amt: number }[]): string {
  return zs
    .map((z) => {
      const x = `clip((t-${n3(z.t)})/${n3(z.d)},0,1)`;
      return `${n3(z.amt)}*(1-(1-${x})*(1-${x}))`;
    })
    .join('+');
}

export async function renderClip(job: RenderJob): Promise<RenderResult> {
  const ff = ffmpegPath();
  if (!ff) throw new FriendlyError('Video tools are not installed yet.');
  const st = job.settings;
  const prev = job.quality === 'preview';
  const W = prev ? 540 : 1080;
  const H = prev ? 960 : 1920;
  const k = W / 1080;
  const plan = planCuts(job.words, st.start, st.end, { silence: st.removeSilence, fillers: st.removeFillers });
  // apply user-edited caption text
  // donation / alert messages are not part of the clip: no captions for them (found on the source timeline)
  const srcWords = st.skipDonations === false ? plan.words : dropSpans(plan.words, findOffTopic(job.words).map((sp) => ({ s: srcToOut(plan, sp.s, st.start), e: srcToOut(plan, sp.e, st.start) })));
  let capWords = srcWords;
  if (st.captionText && st.captionText.trim()) capWords = applyCaptionText(srcWords, st.captionText);
  const zooms = st.zoom ? planZooms(plan.words, plan.duration, plan.cutTimes) : [];
  const dur = plan.duration;
  if (dur < 1) throw new FriendlyError('This clip is too short. Make it longer.');

  const work = renderWorkDir();
  const tag = `${process.pid}-${Date.now()}`;
  const assName = `cap-${tag}.ass`;
  const cmdName = `crop-${tag}.txt`;
  const flName = `graph-${tag}.txt`;
  const splitOn = st.reframe === 'split' && !!st.cam && job.srcW > job.srcH;
  const assOn = st.captions && capWords.length > 0;
  const hook = st.showHook && st.hookTitle.trim() ? st.hookTitle.trim() : undefined;
  if (assOn || hook) {
    fs.writeFileSync(path.join(work, assName), buildAss({ style: st.captionStyle, pos: splitOn && st.captionPos === 'lower' ? 'middle' : st.captionPos, words: assOn ? capWords : [], duration: dur, hook, W, H }), 'utf8');
  }

  const S0 = st.start;
  const parts: string[] = [];
  const N = plan.segments.length;
  plan.segments.forEach((sg, i) => {
    const a = n3(sg.s - S0);
    const b = n3(sg.e - S0);
    const d = sg.e - sg.s;
    parts.push(`[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`);
    const fades = N > 1 ? `,afade=t=in:d=0.012,afade=t=out:st=${n3(Math.max(0, d - 0.012))}:d=0.012` : '';
    parts.push(`[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,aresample=48000${fades}[a${i}]`);
  });
  if (N > 1) {
    parts.push(`${plan.segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${N}:v=1:a=1[vc][voice]`);
  } else {
    parts.push('[v0]null[vc]', '[a0]anull[voice]');
  }

  // ---- reframe ----
  const portrait = job.srcH > job.srcW;
  let reframe = st.reframe;
  let zoomDone = false;
  if (reframe === 'split' && !splitOn) reframe = 'track'; // no webcam box: fall back to the normal speaker crop
  const cw = Math.floor((job.srcH * 9) / 16 / 2) * 2;
  if (reframe === 'track' && (!job.face || job.face.length < 2 || cw >= job.srcW)) reframe = portrait ? 'center' : 'blur';
  if (portrait && reframe === 'blur') reframe = 'center';
  if (reframe === 'split') {
    // streamer layout: webcam on the top half, gameplay on the bottom half
    const cam = st.cam!;
    const ev = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    const cwp = Math.min(job.srcW, ev(cam.w * job.srcW));
    const chp = Math.min(job.srcH, ev(cam.h * job.srcH));
    const cx = Math.max(0, Math.min(job.srcW - cwp, Math.round(cam.x * job.srcW)));
    const cy = Math.max(0, Math.min(job.srcH - chp, Math.round(cam.y * job.srcH)));
    const Hh = H / 2;
    parts.push(
      `[vc]split[sa][sb]`,
      `[sa]crop=${cwp}:${chp}:${cx}:${cy},scale=${W}:${Hh}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${Hh}[top]`,
      `[sb]scale=-2:${Hh}:flags=bilinear,crop=${W}:${Hh}[bot0]`,
    );
    if (zooms.length) {
      const z = zoomExpr(zooms);
      parts.push(`[bot0]scale=w=${q(`max(${W},${W}*(1+${z}))`)}:h=${q(`max(${Hh},${Hh}*(1+${z}))`)}:eval=frame:flags=bilinear,crop=${W}:${Hh}[bot]`);
    } else parts.push('[bot0]null[bot]');
    parts.push('[top][bot]vstack[vr]');
    zoomDone = true;
  } else if (reframe === 'track') {
    fs.writeFileSync(path.join(work, cmdName), cropCommands(plan, job.face!, job.srcW, job.srcH, cw), 'utf8');
    parts.push(`[vc]sendcmd=f=${cmdName},crop@c=w=${cw}:h=${job.srcH}:x=0:y=0,scale=${W}:${H}:flags=bilinear[vr]`);
  } else if (reframe === 'center') {
    parts.push(`[vc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H}[vr]`);
  } else {
    const sw = Math.round(W / 6 / 2) * 2;
    const sh = Math.round(H / 6 / 2) * 2;
    parts.push(
      `[vc]split[bg0][fg0]`,
      `[bg0]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=5:2,scale=${W}:${H},eq=brightness=-0.1[bg]`,
      `[fg0]scale=${W}:-2:flags=bilinear[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[vr]`,
    );
  }
  let vlast = 'vr';

  // ---- punch-in zooms ----
  if (zooms.length && !zoomDone) {
    const z = zoomExpr(zooms);
    parts.push(`[${vlast}]scale=w=${q(`max(${W},${W}*(1+${z}))`)}:h=${q(`max(${H},${H}*(1+${z}))`)}:eval=frame:flags=bilinear,crop=${W}:${H}[vz]`);
    vlast = 'vz';
  }
  // ---- captions / hook ----
  if (assOn || hook) {
    parts.push(`[${vlast}]ass=${assName}:fontsdir=fonts[vt]`);
    vlast = 'vt';
  }
  // ---- progress bar ----
  if (st.progressBar) {
    const bh = Math.max(4, Math.round(14 * k));
    parts.push(`color=c=0xFFE600:s=${W}x${bh}:r=30:d=${n3(dur + 1)}[bar]`);
    parts.push(`[${vlast}][bar]overlay=x=${q(`-w+w*t/${n3(dur)}`)}:y=H-h:shortest=1[vp]`);
    vlast = 'vp';
  }
  parts.push(`[${vlast}]fps=30,format=yuv420p[vout]`);

  // ---- audio ----
  const extraInputs: string[] = [];
  let nIn = 1;
  const sfxDir = path.join(cacheDir(), 'sfx');
  const events: { t: number; kind: 'whoosh' | 'pop'; vol: number }[] = [];
  if (st.sfx) {
    // sounds only where the picture moves: soft whoosh on a zoom-in, a pop on emphasised words, nothing on zoom-outs
    zooms.filter((z) => z.amt > 0).forEach((z) => events.push({ t: Math.max(0, z.t - 0.04), kind: z.emph ? 'pop' : 'whoosh', vol: z.emph ? 0.4 : 0.3 }));
  }
  const sfxLabels: string[] = [];
  if (events.length && fs.existsSync(path.join(sfxDir, 'whoosh.wav'))) {
    for (const kind of ['whoosh', 'pop'] as const) {
      const ev = events.filter((e) => e.kind === kind);
      if (!ev.length) continue;
      extraInputs.push('-i', path.join(sfxDir, `${kind}.wav`));
      const idx = nIn++;
      const labels = ev.map((_, i) => `[s_${kind}${i}]`);
      parts.push(ev.length > 1 ? `[${idx}:a]asplit=${ev.length}${labels.join('')}` : `[${idx}:a]anull${labels[0]}`);
      ev.forEach((e, i) => {
        const ms = Math.round(e.t * 1000);
        parts.push(`${labels[i]}adelay=${ms}|${ms},volume=${e.vol}[d_${kind}${i}]`);
        sfxLabels.push(`[d_${kind}${i}]`);
      });
    }
  }
  let alast = 'voice';
  const musicFile = st.music === 'builtin' ? path.join(sfxDir, 'pad.m4a') : st.music !== 'none' ? st.music : '';
  if (musicFile && fs.existsSync(musicFile)) {
    extraInputs.push('-stream_loop', '-1', '-i', musicFile);
    const idx = nIn++;
    parts.push(`[${idx}:a]aresample=48000,atrim=0:${n3(dur)},volume=${n3(st.musicVolume)},afade=t=in:d=1,afade=t=out:st=${n3(Math.max(0, dur - 1.5))}:d=1.5[mus]`);
    parts.push(`[voice]asplit[vo1][vo2]`);
    parts.push(`[mus][vo2]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=400:makeup=1[duck]`);
    parts.push(`[vo1][duck]amix=inputs=2:duration=first:normalize=0[vm]`);
    alast = 'vm';
  }
  if (sfxLabels.length) {
    parts.push(`[${alast}]${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=first:normalize=0[am]`);
    alast = 'am';
  }
  // previews use quick one-pass loudnorm; finals are measured and corrected precisely afterwards
  parts.push(`[${alast}]${prev ? 'loudnorm=I=-14:TP=-1.5:LRA=11,' : ''}aresample=48000,atrim=0:${n3(dur)}[aout]`);

  const graph = parts.join(';\n');
  fs.writeFileSync(path.join(work, flName), graph, 'utf8');

  const useQsv = job.qsv && !prev;
  const venc = useQsv
    ? ['-c:v', 'h264_qsv', '-global_quality', '23', '-preset', 'veryfast']
    : prev
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  const args = [
    '-y',
    '-v',
    'error',
    '-ss',
    n3(S0),
    '-t',
    n3(st.end - S0 + 0.5),
    '-i',
    job.src,
    ...extraInputs,
    '-/filter_complex',
    flName,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...venc,
    '-c:a',
    'aac',
    '-b:a',
    prev ? '96k' : '160k',
    '-movflags',
    '+faststart',
    '-t',
    n3(dur),
    '-progress',
    'pipe:1',
    job.out,
  ];
  ensureDir(path.dirname(job.out));
  const attempt = (a: string[]) =>
    run(ff, a, {
      cwd: work,
      signal: job.signal,
      collect: true,
      onStdout: (l) => {
        const t = parseTime(l);
        if (t != null) job.onProgress?.(Math.min(99, (t / dur) * 100));
      },
    });
  try {
    try {
      await attempt(args);
    } catch (e: any) {
      if (!useQsv || job.signal?.aborted) throw e;
      // Intel hardware encoder not available: use the normal one.
      const i = args.indexOf('h264_qsv');
      const cpu = [...args];
      cpu.splice(i - 1, 6, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
      await attempt(cpu);
    }
  } catch (e: any) {
    if (e instanceof FriendlyError && /Cancelled/.test(e.friendly)) throw e;
    throw new FriendlyError('Could not build this clip. Try a different caption style or turn off an effect.', (e?.detail || String(e)) + '\n--- graph ---\n' + graph);
  } finally {
    for (const f of [assName, cmdName, flName]) fs.rmSync(path.join(work, f), { force: true });
  }
  if (!prev) await normalizeLoudness(job.out, job.signal).catch((e) => {
    if (job.signal?.aborted) throw e; // a loudness hiccup must not fail an otherwise finished export
  });
  job.onProgress?.(100);
  return { duration: dur, plan, filter: graph, usedReframe: reframe };
}

/** Loudness to about -14 LUFS (YouTube/TikTok level): measure, apply gain, then peak-limit. Video is copied. */
export async function normalizeLoudness(file: string, signal?: AbortSignal) {
  const ff = ffmpegPath()!;
  const m = await run(ff, ['-v', 'info', '-i', file, '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { signal });
  let j: any;
  try {
    const txt = m.stderr.slice(m.stderr.lastIndexOf('{'));
    j = JSON.parse(txt.slice(0, txt.indexOf('}') + 1));
  } catch {
    return; // keep the un-normalised audio rather than failing the export
  }
  const lufs = Number(j.input_i);
  if (!isFinite(lufs)) return;
  const measure = async (f: string) => {
    const r = await run(ff, ['-v', 'info', '-i', f, '-vn', '-af', 'loudnorm=I=-14:print_format=json', '-f', 'null', '-'], { signal });
    return Number(JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{')).replace(/}[\s\S]*$/, '}')).input_i);
  };
  // Speech peaks are limited to -1.5 dB, which costs some loudness, so measure the result and correct once or twice.
  let gain = -14 - lufs;
  const tmp = file.replace(/\.mp4$/, '.norm.mp4');
  try {
  for (let i = 0; i < 3; i++) {
    gain = Math.max(-12, Math.min(20, gain));
    const af = `volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:attack=3:release=60:level=disabled,aresample=48000`;
    await run(ff, ['-y', '-v', 'error', '-i', file, '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp], { signal });
    const got = await measure(tmp).catch(() => NaN);
    if (!isFinite(got) || Math.abs(got + 14) < 0.6 || i === 2) break;
    gain += -14 - got;
  }
  fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Replace caption words with user-edited text; keeps timing when counts match, else spreads evenly. */
export function applyCaptionText(words: Word[], text: string): Word[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || !toks.length) return words;
  if (toks.length === words.length) return words.map((w, i) => ({ ...w, t: toks[i] }));
  const s = words[0].s;
  const e = words[words.length - 1].e;
  const step = (e - s) / toks.length;
  return toks.map((t, i) => ({ t, s: s + i * step, e: s + (i + 1) * step }));
}

export async function bestCover(clip: string, out: string, duration: number): Promise<void> {
  const ff = ffmpegPath()!;
  const tmp = ensureDir(path.join(cacheDir(), 'cover-' + Date.now()));
  try {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push(duration * (0.12 + (i * 0.76) / 9));
    const sizes: { f: string; size: number }[] = [];
    for (let i = 0; i < times.length; i++) {
      const f = path.join(tmp, `f${i}.jpg`);
      await run(ff, ['-y', '-v', 'error', '-ss', n3(times[i]), '-i', clip, '-frames:v', '1', '-q:v', '3', f]);
      if (fs.existsSync(f)) sizes.push({ f, size: fs.statSync(f).size });
    }
    // JPEG size is a cheap detail/sharpness proxy: busy sharp frames compress worse.
    sizes.sort((a, b) => b.size - a.size);
    if (!sizes.length) throw new FriendlyError('Could not pick a cover frame for this clip.');
    fs.copyFileSync(sizes[0].f, out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
