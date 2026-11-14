import * as fs from 'node:fs';
import * as path from 'node:path';

/** Set once by main.ts at startup. */
export const env = {
  userData: process.env.CLYPPER_DATA || path.join(process.env.APPDATA || '.', 'Clypper'),
  appRoot: process.env.CLYPPER_ROOT || process.cwd(),
  isDev: !!process.env.CLYPPER_DEV,
};

export function configure(o: Partial<typeof env>) {
  Object.assign(env, o);
}

export const toolsDir = () =>
  process.env.CLYPPER_TOOLS || (env.isDev ? path.join(env.appRoot, 'tools') : path.join(env.userData, 'tools'));
export const dataDir = () => path.join(env.userData, 'data');
export const cacheDir = () => path.join(env.userData, 'cache');
export const assetsDir = () => path.join(env.appRoot, 'assets');
export const fontsDir = () => path.join(assetsDir(), 'fonts');

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function onPath(exe: string): string | null {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, exe);
    if (d && fs.existsSync(f)) return f;
  }
  return null;
}

function findFirst(dir: string, name: string, depth = 4): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
  }
  if (depth <= 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const r = findFirst(path.join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// Own downloaded copies first (known versions), PATH only as a dev fallback.
export const ffmpegPath = () => findFirst(path.join(toolsDir(), 'ffmpeg'), 'ffmpeg.exe') || onPath('ffmpeg.exe');
export const ffprobePath = () => findFirst(path.join(toolsDir(), 'ffmpeg'), 'ffprobe.exe') || onPath('ffprobe.exe');
export const ytdlpPath = () => {
  const p = path.join(toolsDir(), 'yt-dlp.exe');
  return fs.existsSync(p) ? p : onPath('yt-dlp.exe');
};
export const whisperPath = () => findFirst(path.join(toolsDir(), 'whisper'), 'whisper-cli.exe');
export const whisperModelPath = (model: string) => path.join(toolsDir(), 'whisper', `ggml-${model}.bin`);
