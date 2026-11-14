import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, FriendlyError } from './run';
import { whisperPath, whisperModelPath } from './paths';
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
  return { words, language: json.result?.language || 'en', duration };
}

export async function transcribe(
  wav: string,
  duration: number,
  model: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const exe = whisperPath();
  const mp = whisperModelPath(model);
  if (!exe || !fs.existsSync(mp)) throw new FriendlyError('The speech tool is not installed yet.');
  const outBase = path.join(os.tmpdir(), `clypper-w-${Date.now()}`);
  const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
  const lang = model.endsWith('.en') ? 'en' : 'auto';
  await run(exe, ['-m', mp, '-f', wav, '-oj', '-of', outBase, '-ml', '1', '-sow', '-t', String(threads), '-pp', '-l', lang, '-nf', '-bs', '1', '-bo', '1'], {
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
