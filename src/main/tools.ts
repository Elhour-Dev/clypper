import * as fs from 'node:fs';
import * as path from 'node:path';
import { run, FriendlyError } from './run';
import { ensureDir, toolsDir, ffmpegPath, ffprobePath, ytdlpPath, whisperPath, whisperModelPath, vadModelPath } from './paths';

export type Report = (stage: string, pct: number, msg: string) => void;

const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';
const MODEL_URL =(m: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`;
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

/** Download with resume: a dropped connection continues where it stopped (up to 8 tries) instead of starting over. */
async function download(url: string, dest: string, label: string, report: Report) {
  ensureDir(path.dirname(dest));
  const tmp = dest + '.part';
  let lastErr = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Clypper', ...(have ? { Range: `bytes=${have}-` } : {}) } });
    } catch (e: any) {
      lastErr = String(e?.cause?.code || e?.message || e);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 416) {
      // already complete
      fs.renameSync(tmp, dest);
      return;
    }
    if (!res.ok || !res.body) {
      lastErr = `${res.status}`;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const resumed = res.status === 206 && have > 0;
    const part = Number(res.headers.get('content-length') || 0);
    const total = part ? part + (resumed ? have : 0) : 0;
    let got = resumed ? have : 0;
    const out = fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' });
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        report('setup', total ? (got / total) * 100 : -1, `Downloading ${label}… ${(got / 1e6).toFixed(0)} MB`);
      }
      await new Promise<void>((r) => out.end(r));
      if (total && got < total) throw new Error('connection closed early');
      fs.renameSync(tmp, dest);
      return;
    } catch (e: any) {
      lastErr = String(e?.cause?.code || e?.message || e);
      await new Promise<void>((r) => out.end(r));
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new FriendlyError('Could not finish downloading a needed tool. Check your internet and try again.', `${url} -> ${lastErr}`);
}

async function unzip(zip: string, dest: string) {
  ensureDir(dest);
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  await run(tar, ['-xf', zip, '-C', dest]);
  fs.rmSync(zip, { force: true });
}

export function toolStatus(model: string) {
  return {
    ffmpeg: !!ffmpegPath() && !!ffprobePath(),
    whisper: !!whisperPath(),
    model: fs.existsSync(whisperModelPath(model)),
    ytdlp: !!ytdlpPath(),
  };
}

/** Download whatever is missing. `needLink` also fetches yt-dlp. */
export async function ensureTools(model: string, report: Report, needLink = true, refineModel?: string) {
  const dir = ensureDir(toolsDir());
  if (!ffmpegPath() || !ffprobePath()) {
    report('setup', 0, 'Finding the video tool (FFmpeg)…');
    const rel = await (await fetch('https://api.github.com/repos/GyanD/codexffmpeg/releases/latest', { headers: { 'User-Agent': 'Clypper' } })).json();
    const asset = (rel.assets || []).find((a: any) => /essentials_build\.zip$/.test(a.name));
    if (!asset) throw new FriendlyError('Could not find the video tool to download.');
    const zip = path.join(dir, 'ffmpeg.zip');
    await download(asset.browser_download_url, zip, 'video tool (FFmpeg)', report);
    report('setup', -1, 'Unpacking FFmpeg…');
    await unzip(zip, path.join(dir, 'ffmpeg'));
  }
  if (!whisperPath()) {
    const zip = path.join(dir, 'whisper.zip');
    await download(WHISPER_ZIP, zip, 'speech tool', report);
    await unzip(zip, path.join(dir, 'whisper'));
  }
  const mp = whisperModelPath(model);
  if (!fs.existsSync(mp)) await download(MODEL_URL(model), mp, `speech model (${model})`, report);
  // bigger model used only on the chosen clips (more accurate captions). Optional: a failed download is not fatal.
  if (refineModel && refineModel !== model && !fs.existsSync(whisperModelPath(refineModel))) await download(MODEL_URL(refineModel), whisperModelPath(refineModel), `accurate caption model (${refineModel})`, report).catch(() => undefined);
  // tiny voice-activity model (<1 MB): skips music/noise/silence so whisper does not invent or repeat words. Optional.
  const vad = vadModelPath();
  if (!fs.existsSync(vad)) await download(VAD_URL, vad, 'speech detector', report).catch(() => undefined);
  if (needLink && !ytdlpPath()) await download(YTDLP_URL, path.join(dir, 'yt-dlp.exe'), 'link downloader', report);
  if (!ffmpegPath() || !whisperPath()) throw new FriendlyError('Setup did not finish. Please try again.');
}
