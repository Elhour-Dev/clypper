import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import { run, FriendlyError } from './run';
import { ensureDir, ffmpegPath, ytdlpPath } from './paths';

let cookiesBrowser = '';
/** Optional: let yt-dlp use this browser's login (for age-restricted / bot-checked videos). */
export const setCookiesBrowser = (b: string) => (cookiesBrowser = b === 'none' ? '' : b);
const ck = () => (cookiesBrowser ? ['--cookies-from-browser', cookiesBrowser] : []);

export interface LinkInfo {
  title: string;
  isLive: boolean;
  duration: number;
  id: string;
}

const friendlyYt = (detail: string): FriendlyError => {
  const d = detail.toLowerCase();
  if (d.includes('not a bot')) return new FriendlyError('YouTube is asking to confirm you are not a robot, so it blocked the download. Try again later, try a Twitch/Kick link, or download the video yourself and use the Video file tab.', detail);
  if (d.includes('confirm your age')) return new FriendlyError('This video is age-restricted, so it cannot be downloaded without signing in. Download it yourself and use the Video file tab.', detail);
  if (d.includes('private') || d.includes('sign in') || d.includes('login')) return new FriendlyError('This video is private or needs a login, so I cannot download it.', detail);
  if (d.includes('unsupported url')) return new FriendlyError('This link is not supported. Try a YouTube, Twitch or Kick video link.', detail);
  if (d.includes('not available') || d.includes('unavailable')) return new FriendlyError('This video is not available (removed or blocked in your country).', detail);
  if (d.includes('http error 429') || d.includes('too many')) return new FriendlyError('The site is limiting downloads right now. Wait a few minutes and try again.', detail);
  if (d.includes('unable to download') || d.includes('getaddrinfo') || d.includes('network')) return new FriendlyError('Could not reach the site. Check your internet.', detail);
  return new FriendlyError('Could not get this video from the link.', detail);
};

export async function linkInfo(url: string): Promise<LinkInfo> {
  const y = ytdlpPath();
  if (!y) throw new FriendlyError('The link downloader is not installed yet.');
  try {
    const { stdout } = await run(y, ['-J', '--no-playlist', '--no-warnings', ...ck(), url]);
    const j = JSON.parse(stdout);
    return { title: String(j.title || 'video'), isLive: !!j.is_live, duration: Number(j.duration || 0), id: String(j.id || Date.now()) };
  } catch (e: any) {
    throw friendlyYt(String(e?.detail || e));
  }
}

const safe = (s: string) => s.replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().slice(0, 60) || 'video';

/** Download a normal video (or a finished stream replay). Returns the mp4 path. */
export async function downloadLink(url: string, title: string, id: string, dir: string, onProgress: (pct: number, msg: string) => void, signal?: AbortSignal): Promise<string> {
  const y = ytdlpPath()!;
  ensureDir(dir);
  const base = path.join(dir, `${safe(title)} [${id.replace(/[^\w-]/g, '')}]`);
  const out = base + '.mp4';
  const ffDir = path.dirname(ffmpegPath()!);
  try {
    await run(
      y,
      [
        '--no-playlist',
        '--no-warnings',
        ...ck(),
        '--newline',
        '--ffmpeg-location',
        ffDir,
        '-N',
        '4',
        '--http-chunk-size',
        '10M',
        '-f',
        // prefer H.264 + AAC: decodes faster in every later step and works with the Intel encoder
        'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format',
        'mp4',
        '--progress-template',
        'download:CLYP %(progress._percent_str)s %(progress._speed_str)s',
        '-o',
        base + '.%(ext)s',
        url,
      ],
      {
        signal,
        collect: true,
        onStdout: (l) => {
          const m = /CLYP\s+([\d.]+)%\s*(.*)/.exec(l);
          if (m) onProgress(Number(m[1]), `Downloading video… ${m[1]}% ${m[2]}`.trim());
        },
      },
    );
  } catch (e: any) {
    if (e instanceof FriendlyError && /Cancelled/.test(e.friendly)) throw e;
    throw friendlyYt(String(e?.detail || e));
  }
  if (!fs.existsSync(out)) {
    const alt = fs.readdirSync(dir).find((f) => f.startsWith(path.basename(base)) && /\.(mp4|mkv|webm)$/.test(f));
    if (!alt) throw new FriendlyError('The download finished but I cannot find the file.');
    return path.join(dir, alt);
  }
  return out;
}

export interface LiveRecording {
  stop: () => Promise<string>; // resolves with the finished mp4 path
  file: string;
  seconds: () => number;
}

/** Record a live stream until stop() is called (or maxMinutes passes). */
export function recordLive(url: string, title: string, dir: string, maxMinutes: number, onTick: (sec: number, bytes: number) => void): LiveRecording {
  const y = ytdlpPath()!;
  const ff = ffmpegPath()!;
  ensureDir(dir);
  const ts = path.join(dir, `${safe(title)}-live-${Date.now().toString(36)}.ts`);
  const started = Date.now();
  const child: ChildProcess = spawn(
    y,
    ['--no-playlist', '--no-warnings', ...ck(), '--no-part', '--hls-use-mpegts', '--ffmpeg-location', path.dirname(ff), '-f', 'best[height<=1080]/best', '-o', ts, url],
    { windowsHide: true },
  );
  let err = '';
  child.stderr?.on('data', (b) => (err += b.toString()));
  const exited = new Promise<void>((r) => child.on('close', () => r()));
  const timer = setInterval(() => {
    const sec = (Date.now() - started) / 1000;
    let bytes = 0;
    try {
      bytes = fs.statSync(ts).size;
    } catch {
      /* not created yet */
    }
    onTick(sec, bytes);
    if (sec > maxMinutes * 60) {
      clearInterval(timer);
      killTree(child);
    }
  }, 1000);
  const stop = async () => {
    clearInterval(timer);
    killTree(child);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (!fs.existsSync(ts) || fs.statSync(ts).size < 200_000) {
      fs.rmSync(ts, { force: true });
      throw new FriendlyError('Too little was recorded. Record for at least 30 seconds, and check the stream is live.', err.slice(-800));
    }
    const mp4 = ts.replace(/\.ts$/, '.mp4');
    await run(ff, ['-y', '-v', 'error', '-i', ts, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', mp4]).catch(async () => {
      // some streams are not copy-friendly: re-encode quickly
      await run(ff, ['-y', '-v', 'error', '-i', ts, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', mp4]);
    });
    fs.rmSync(ts, { force: true });
    return mp4;
  };
  return { stop, file: ts, seconds: () => (Date.now() - started) / 1000 };
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.killed) return;
  // Windows: end yt-dlp and the ffmpeg it started, so the file is closed properly.
  execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
}
