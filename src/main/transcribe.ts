import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, FriendlyError } from './run';
import { whisperPath, whisperModelPath, vadModelPath } from './paths';
import { extractWavRange } from './media';
import type { Transcript, Word } from '../shared/types';

/** Turn whisper.cpp one-token-per-segment JSON into clean words. */
export function parseWhisperJson(json: any, duration: number): Transcript {
  const words: Word[] = [];
  for (const seg of json.transcription || []) {
    const raw: string = String(seg.text || '');
    const text = raw.trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text) || /^[♪\s]+$/.test(text)) continue; // [MUSIC] etc.
    const s = (seg.offsets?.from ?? 0) / 1000;
    const e = Math.max(s + 0.04, (seg.offsets?.to ?? 0) / 1000);
    const startsNew = /^\s/.test(raw) || words.length === 0;
    const hasLetters = /[\p{L}\p{N}]/u.test(text);
    const prev = words[words.length - 1];
    if (prev && (!hasLetters || !startsNew)) {
      prev.t += text; // glue punctuation / sub-word pieces to previous word
      prev.e = Math.max(prev.e, e);
    } else if (hasLetters) {
      words.push({ t: text, s, e });
    }
  }
  // make sure timings are monotonic
  for (let i = 1; i < words.length; i++) {
    if (words[i].s < words[i - 1].e - 0.001) words[i - 1].e = Math.max(words[i - 1].s + 0.03, words[i].s);
  }
  return { words: collapseLoops(words), language: json.result?.language || 'en', duration };
}

/** Whisper sometimes gets stuck and repeats one word (or a short phrase) over and over. Keep real repeats ("no no no"), drop loops. */
export function collapseLoops(words: Word[]): Word[] {
  const norm = (w: Word) => w.t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let out = words;
  for (const n of [1, 2, 3]) {
    const res: Word[] = [];
    let i = 0;
    while (i < out.length) {
      let reps = 1;
      while (i + (reps + 1) * n <= out.length && out.slice(i, i + n).every((w, k) => norm(w) === norm(out[i + reps * n + k]))) reps++;
      const limit = n === 1 ? 3 : 2;
      if (reps > limit) {
        res.push(...out.slice(i, i + n * limit));
        i += reps * n;
      } else {
        res.push(out[i]);
        i++;
      }
    }
    out = res;
  }
  return out;
}

export async function transcribe(
  wav: string,
  duration: number,
  model: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
  prompt?: string,
  accurate = false,
): Promise<Transcript> {
  const exe = whisperPath();
  const mp = whisperModelPath(model);
  if (!exe || !fs.existsSync(mp)) throw new FriendlyError('The speech tool is not installed yet.');
  const outBase = path.join(os.tmpdir(), `clypper-w-${Date.now()}`);
  const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
  const lang = /\.en(\b|-)/.test(model) ? 'en' : 'auto';
  await run(exe, ['-m', mp, '-f', wav, '-oj', '-of', outBase, '-ml', '1', '-sow', '-t', String(threads), '-pp', '-l', lang, '-nf', ...(accurate ? ['-bs', '5', '-bo', '5'] : ['-bs', '1', '-bo', '1']), '-mc', '0', '-sns', ...(prompt ? ['--prompt', prompt.slice(0, 200)] : []), ...(fs.existsSync(vadModelPath()) ? ['--vad', '-vm', vadModelPath(), '-vsd', '300'] : [])], {
    cwd: path.dirname(exe),
    signal,
    collect: false,
    onStderr: (l) => {
      const m = /progress\s*=\s*(\d+)%/.exec(l);
      if (m) onProgress(Number(m[1]));
    },
  });
  const jf = outBase + '.json';
  const json = JSON.parse(fs.readFileSync(jf, 'utf8'));
  fs.rmSync(jf, { force: true });
  const t = parseWhisperJson(json, duration);
  if (t.words.length < 5) throw new FriendlyError('I could not hear enough speech in this video to find clips.');
  return t;
}

/** Re-listen to one stretch of the video with a bigger, more accurate model. Times are on the source timeline. */
export async function transcribeRange(video: string, a: number, b: number, model: string, signal?: AbortSignal, prompt?: string): Promise<Word[]> {
  const wav = path.join(os.tmpdir(), `clypper-r-${process.pid}-${Date.now()}.wav`);
  try {
    await extractWavRange(video, wav, a, b, signal);
    const t = await transcribe(wav, b - a, model, () => undefined, signal, prompt, true).catch(() => null);
    return (t?.words || []).map((w) => ({ ...w, s: w.s + a, e: w.e + a }));
  } finally {
    fs.rmSync(wav, { force: true });
  }
}
