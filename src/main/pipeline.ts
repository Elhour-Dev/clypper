import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Candidate, Clip, ClipSettings, Project, Transcript, Word } from '../shared/types';
import { FriendlyError } from './run';
import { planCuts } from './cuts';
import { cacheDir, dataDir, ensureDir, ffmpegPath, whisperModelPath } from './paths';
import { audioEnergy, extractWav, probe, sceneChanges } from './media';
import { transcribe, transcribeRange } from './transcribe';
import { findCandidates } from './analyze';
import { applyJudge, judge, writeKit } from './llm';
import { bestCover, renderClip, FacePoint } from './render';
import { kitText, mergeKit, templateKit } from './kit';
import { ensureSfx } from './sfx';
import { ensureTools, Report } from './tools';
import { getSettings, loadProject, projectFile, readProjectJson, saveProject, writeProjectJson } from './store';
import { downloadLink, linkInfo, setCookiesBrowser } from './ingest';
import { trackFaces } from './faces';
import { detectWebcam } from './webcam';

export type Input = { kind: 'file'; path: string } | { kind: 'url'; url: string } | { kind: 'recorded'; path: string; title: string };

const safe = (s: string) => s.replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().slice(0, 50) || 'clip';

let qsvOk: boolean | null = null;
async function hasQsv(): Promise<boolean> {
  if (qsvOk != null) return qsvOk;
  try {
    const { run } = await import('./run');
    await run(ffmpegPath()!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2', '-c:v', 'h264_qsv', '-f', 'null', '-']);
    qsvOk = true;
  } catch {
    qsvOk = false;
  }
  return qsvOk;
}

/** Extend a clip's end (to a word boundary) until the edited length reaches `params.minLen`. */
export function stretchToMin(words: Transcript['words'], start: number, end: number, params: { minLen: number; maxLen: number }, sourceDur: number, d: ClipSettings): number {
  const len = (e: number) => planCuts(words, start, e, { silence: d.removeSilence, fillers: d.removeFillers }).duration;
  let e = end;
  for (let i = 0; i < 8 && len(e) < params.minLen && e < sourceDur - 0.5; i++) {
    const need = params.minLen - len(e) + 0.3;
    const target = Math.min(sourceDur, e + need, start + Math.max(params.maxLen, params.minLen) + 20);
    const w = words.find((x) => x.e >= target); // finish on a word, not mid-word
    const next = Math.min(sourceDur, (w ? w.e : target) + 0.3);
    if (next <= e + 0.05) break;
    e = next;
  }
  return e;
}

export function previewKey(s: ClipSettings): string {
  return JSON.stringify(s);
}

export function wordsOf(projectId: string): Transcript {
  return readProjectJson<Transcript>(projectId, 'transcript.json', { words: [], language: 'en', duration: 0 });
}

const REFINE_MODEL = 'small.en-q5_1'; // quantised: about 180 MB, nearly as accurate as small.en

/** Names and topic words from the video title help the speech model spell names right (e.g. streamer names). */
export function titleHint(name: string): string {
  return name.replace(/[^\p{L}\p{N} '&-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Replace the words inside [a,b] with the freshly listened ones, keep everything else. */
export function mergeWords(old: Word[], fresh: Word[], a: number, b: number): Word[] {
  const mid = (w: Word) => (w.s + w.e) / 2;
  return [...old.filter((w) => mid(w) < a || mid(w) > b), ...fresh.filter((w) => mid(w) >= a && mid(w) <= b)].sort((x, y) => x.s - y.s);
}

export async function createProject(
  input: Input,
  params: { count: number; minLen: number; maxLen: number },
  report: Report,
  signal?: AbortSignal,
): Promise<Project> {
  const settings = getSettings();
  setCookiesBrowser(settings.cookiesBrowser);
  await ensureTools(settings.whisperModel, report, input.kind === 'url', settings.accurateCaptions ? REFINE_MODEL : undefined);
  await ensureSfx();
  const id = Date.now().toString(36);
  const workDir = ensureDir(path.join(dataDir(), 'projects', id));

  // 1. get the video
  let videoPath: string;
  let name: string;
  let label: string;
  if (input.kind === 'file') {
    if (!fs.existsSync(input.path)) throw new FriendlyError('I cannot find that file. Was it moved or deleted?');
    videoPath = input.path;
    name = path.parse(input.path).name;
    label = input.path;
  } else if (input.kind === 'recorded') {
    videoPath = input.path;
    name = input.title;
    label = 'Live recording';
  } else {
    report('download', 0, 'Checking the link…');
    const info = await linkInfo(input.url);
    if (info.isLive) throw new FriendlyError('This stream is live right now. Use "Record live" to capture it, then make clips.');
    report('download', 0, `Downloading "${info.title}"…`);
    videoPath = await downloadLink(input.url, info.title, info.id, ensureDir(path.join(settings.outputDir, '_sources')), (p, m) => report('download', p, m), signal);
    name = info.title;
    label = input.url;
  }

  report('prepare', -1, 'Reading the video…');
  const pr = await probe(videoPath);
  if (pr.duration < 20) throw new FriendlyError('This video is too short. I need at least 20 seconds.');

  // 2. transcribe
  const wav = path.join(workDir, 'audio.wav');
  report('audio', 0, 'Getting the sound ready…');
  await extractWav(videoPath, wav, (s) => report('audio', Math.min(100, (s / pr.duration) * 100), 'Getting the sound ready…'), signal);
  // scene scan runs while the speech is being transcribed (it is independent), so it adds no waiting time
  const scenesP: Promise<number[]> = pr.duration < 3 * 3600 ? sceneChanges(videoPath, 0.3, signal) : Promise.resolve([]);
  scenesP.catch(() => undefined);
  report('transcribe', 0, 'Listening to the speech (this can take a few minutes)…');
  const tr = await transcribe(wav, pr.duration, settings.whisperModel, (p) => report('transcribe', p, `Listening to the speech… ${p}%`), signal);
  writeProjectJson(id, 'transcript.json', tr);

  // 3. find moments (loudness is read from the small audio file, not by decoding the whole video again)
  report('analyze', 0, 'Finding the best moments…');
  const win = 0.5;
  const [energy, scenes] = await Promise.all([audioEnergy(wav, win, 8000, signal), scenesP]);
  fs.rmSync(wav, { force: true });
  report('analyze', 40, 'Looking for a webcam…');
  const cam = await detectWebcam(videoPath, pr.duration, pr.width, pr.height, signal).catch(() => null);
  let cands = findCandidates({ words: tr.words, duration: pr.duration, energy, win, scenes, count: params.count, minLen: params.minLen, maxLen: params.maxLen });
  if (!cands.length) throw new FriendlyError('I could not find a good clip of that length. Try a different length range.');
  if (settings.geminiKey) {
    report('analyze', 60, 'Asking the AI to rate the moments…');
    const items = cands.map((c, i) => ({ i, text: tr.words.filter((w) => w.s >= c.start && w.e <= c.end).map((w) => w.t).join(' ') }));
    cands = applyJudge(cands, [], await judge(settings.geminiKey, items));
  }
  cands = cands.sort((a, b) => b.score - a.score).slice(0, params.count);
  // cutting silences and fillers shortens a clip: stretch it so the FINAL length respects the minimum
  cands = cands.map((c) => ({ ...c, end: stretchToMin(tr.words, c.start, c.end, params, pr.duration, settings.defaults) }));

  // captions must be right: listen again to just the chosen clips with a bigger model (a few seconds each)
  if (settings.accurateCaptions && fs.existsSync(whisperModelPath(REFINE_MODEL))) {
    const margin = 4;
    for (let i = 0; i < cands.length; i++) {
      report('analyze', 80 + (i / cands.length) * 20, `Making captions more accurate (${i + 1} of ${cands.length})…`);
      const a = Math.max(0, cands[i].start - margin);
      const b = Math.min(pr.duration, cands[i].end + margin);
      const fresh = await transcribeRange(videoPath, a, b, REFINE_MODEL, signal, titleHint(name));
      if (fresh.length >= 5) tr.words = mergeWords(tr.words, fresh, a, b);
    }
    writeProjectJson(id, 'transcript.json', tr);
  }

  const clips: Clip[] = cands.map((c, i) => ({
    id: `${id}-${i + 1}`,
    n: i + 1,
    candidate: c,
    settings: { ...settings.defaults, start: c.start, end: c.end, hookTitle: c.hook, ...(cam ? { reframe: 'split' as const, cam, captionPos: 'middle' as const } : {}) },
    status: 'pending',
    approved: false,
    deleted: false,
    posted: { youtube: false, tiktok: false, instagram: false },
  }));
  const project: Project = {
    id,
    name,
    sourceLabel: label,
    videoPath,
    duration: pr.duration,
    width: pr.width,
    height: pr.height,
    createdAt: Date.now(),
    params,
    cam,
    clips,
  };
  saveProject(project);
  return project;
}

async function faceFor(p: Project, s: ClipSettings): Promise<FacePoint[] | null> {
  if (s.reframe !== 'track') return null;
  const key = `face-${s.start.toFixed(1)}-${s.end.toFixed(1)}.json`;
  const f = projectFile(p.id, key);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const pts = await trackFaces(p.videoPath, s.start, s.end, p.width, p.height).catch(() => null);
  if (pts) fs.writeFileSync(f, JSON.stringify(pts));
  return pts;
}

/** Re-read the project right before saving so edits made while a render ran are not lost. */
function commit(projectId: string, clipId: string, fn: (c: Clip) => void): Project {
  const fresh = loadProject(projectId);
  const c = fresh?.clips.find((x) => x.id === clipId);
  if (!fresh || !c) throw new FriendlyError('Project not found.');
  fn(c);
  saveProject(fresh);
  return fresh;
}

export async function renderPreview(projectId: string, clipId: string, report: (pct: number) => void, signal?: AbortSignal): Promise<Project> {
  const p = loadProject(projectId);
  if (!p) throw new FriendlyError('Project not found.');
  const clip = p.clips.find((c) => c.id === clipId);
  if (!clip) throw new FriendlyError('Clip not found.');
  const key = previewKey(clip.settings);
  if (clip.status === 'ready' && clip.previewKey === key && clip.previewPath && fs.existsSync(clip.previewPath)) return p;
  clip.status = 'rendering';
  saveProject(p);
  try {
    const out = path.join(ensureDir(path.join(dataDir(), 'projects', p.id, 'previews')), `${clip.id}-${Date.now()}.mp4`);
    const face = await faceFor(p, clip.settings);
    await renderClip({
      src: p.videoPath,
      srcW: p.width,
      srcH: p.height,
      words: wordsOf(p.id).words,
      settings: clip.settings,
      out,
      quality: 'preview',
      face,
      onProgress: report,
      signal,
    });
    return commit(projectId, clipId, (c) => {
      if (c.previewPath && c.previewPath !== out) fs.rmSync(c.previewPath, { force: true });
      c.previewPath = out;
      c.previewKey = key;
      c.status = previewKey(c.settings) === key ? 'ready' : 'pending'; // settings changed while rendering
      c.error = undefined;
    });
  } catch (e: any) {
    commit(projectId, clipId, (c) => {
      c.status = 'error';
      c.error = e instanceof FriendlyError ? e.friendly : 'Something went wrong while building this clip.';
    });
    if (e?.detail) fs.writeFileSync(path.join(dataDir(), 'last-error.txt'), String(e.detail));
    throw e;
  }
}

/** Final 1080x1920 export + cover + kit into one folder per clip. */
export async function exportClip(projectId: string, clipId: string, report: (stage: string, pct: number, msg: string) => void, signal?: AbortSignal): Promise<Project> {
  const p = loadProject(projectId);
  const clip = p?.clips.find((c) => c.id === clipId);
  if (!p || !clip) throw new FriendlyError('Clip not found.');
  const settings = getSettings();
  const folder = ensureDir(path.join(settings.outputDir, safe(p.name), `${String(clip.n).padStart(2, '0')} - ${safe(clip.settings.hookTitle || clip.candidate.hook)}`));
  const mp4 = path.join(folder, 'clip.mp4');
  const face = await faceFor(p, clip.settings);
  const qsv = settings.encoder === 'auto' && (await hasQsv());
  report('export', 0, `Exporting clip ${clip.n} (1080x1920)…`);
  const res = await renderClip({
    src: p.videoPath,
    srcW: p.width,
    srcH: p.height,
    words: wordsOf(p.id).words,
    settings: clip.settings,
    out: mp4,
    quality: 'final',
    face,
    qsv,
    onProgress: (x) => report('export', x * 0.9, `Exporting clip ${clip.n}… ${Math.round(x)}%`),
    signal,
  });
  report('export', 92, 'Picking the best cover frame…');
  await bestCover(mp4, path.join(folder, 'cover.jpg'), res.duration);

  report('export', 96, 'Writing the posting kit…');
  const text = res.plan.words.map((w) => w.t).join(' ');
  const base = templateKit({ ...clip.candidate, hook: clip.settings.hookTitle || clip.candidate.hook }, text);
  const kit = mergeKit(base, await writeKit(settings.geminiKey, text, clip.settings.hookTitle || clip.candidate.hook));
  kit.folder = folder;
  fs.writeFileSync(path.join(folder, 'kit.txt'), kitText(`${p.name} - clip ${clip.n}`, kit), 'utf8');
  const saved = commit(projectId, clipId, (c) => {
    c.kit = kit;
    c.exportPath = mp4;
    c.approved = true;
  });
  report('export', 100, 'Done');
  return saved;
}

export function updateClip(projectId: string, clipId: string, patch: { approved?: boolean; deleted?: boolean; posted?: Partial<Clip['posted']>; settings?: Partial<ClipSettings> }): Project {
  const p = loadProject(projectId);
  const clip = p?.clips.find((c) => c.id === clipId);
  if (!p || !clip) throw new FriendlyError('Clip not found.');
  if (patch.settings) {
    clip.settings = { ...clip.settings, ...patch.settings };
    clip.settings.start = Math.max(0, Math.min(clip.settings.start, p.duration - 5));
    clip.settings.end = Math.min(p.duration, Math.max(clip.settings.end, clip.settings.start + 5));
    if (clip.settings.end - clip.settings.start > 90) clip.settings.end = clip.settings.start + 90;
    clip.status = clip.previewKey === previewKey(clip.settings) ? 'ready' : 'pending';
  }
  if (patch.approved !== undefined) clip.approved = patch.approved;
  if (patch.deleted !== undefined) clip.deleted = patch.deleted;
  if (patch.posted) clip.posted = { ...clip.posted, ...patch.posted };
  saveProject(p);
  return p;
}

export { cacheDir, os };
export type { Candidate };

/** One still picture of the source video (for choosing the webcam box). Returns the jpg path. */
export async function sourceFrame(projectId: string, t: number): Promise<string> {
  const p = loadProject(projectId);
  if (!p) throw new FriendlyError('Project not found.');
  const at = Math.max(0, Math.min(p.duration - 0.5, t));
  const out = projectFile(projectId, `frame-${Math.round(at)}.jpg`);
  if (!fs.existsSync(out)) {
    const { run } = await import('./run');
    await run(ffmpegPath()!, ['-y', '-v', 'error', '-ss', String(at), '-i', p.videoPath, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', out], { collect: false });
  }
  return out;
}
