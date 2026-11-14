import { spawn } from 'node:child_process';
import { run, FriendlyError } from './run';
import { ffmpegPath, ffprobePath } from './paths';

export interface Probe {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
}

export async function probe(file: string): Promise<Probe> {
  const ff = ffprobePath();
  if (!ff) throw new FriendlyError('Video tools are not installed yet.');
  let json: any;
  try {
    const { stdout } = await run(ff, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    json = JSON.parse(stdout);
  } catch (e: any) {
    throw new FriendlyError('This file could not be read as a video. Try another file.', String(e?.detail || e));
  }
  const v = (json.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (json.streams || []).find((s: any) => s.codec_type === 'audio');
  if (!a) throw new FriendlyError('This video has no sound, so I cannot find spoken moments.');
  const [n, d] = String(v?.avg_frame_rate || '30/1').split('/').map(Number);
  // phone videos are often stored sideways with a rotation flag: use the size people actually see
  const rot = Math.abs(Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [vw, vh] = rot === 90 ? [v?.height || 0, v?.width || 0] : [v?.width || 0, v?.height || 0];
  return {
    duration: Number(json.format?.duration || v?.duration || 0),
    width: vw,
    height: vh,
    hasAudio: !!a,
    fps: d ? n / d : 30,
  };
}

/** Parse ffmpeg `-progress pipe:1` style output into seconds. */
export function parseTime(line: string): number | null {
  const m = /out_time_ms=(\d+)/.exec(line);
  if (m) return Number(m[1]) / 1e6;
  const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  return null;
}

export async function extractWav(src: string, out: string, onProgress?: (sec: number) => void, signal?: AbortSignal) {
  await run(ffmpegPath()!, ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', out], {
    signal,
    collect: false,
    onStdout: (l) => {
      const t = parseTime(l);
      if (t != null) onProgress?.(t);
    },
  });
}

/** RMS energy per window (seconds -> array of 0..1 loudness values). Streams PCM so memory stays small. */
export function audioEnergy(src: string, win = 0.5, sr = 8000, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath()!, ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { windowsHide: true });
    const per = Math.round(win * sr);
    const out: number[] = [];
    let acc = 0,
      n = 0,
      carry: Buffer | null = null;
    p.stdout.on('data', (buf: Buffer) => {
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) carry = buf.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v;
        if (++n === per) {
          out.push(Math.sqrt(acc / per));
          acc = 0;
          n = 0;
        }
      }
    });
    p.on('error', reject);
    signal?.addEventListener('abort', () => p.kill());
    p.on('close', () => (signal?.aborted ? reject(new FriendlyError('Cancelled.')) : resolve(out)));
  });
}

/** Scene-change timestamps (seconds). Uses a tiny low-fps proxy so it is fast. */
export async function sceneChanges(src: string, threshold = 0.3, signal?: AbortSignal): Promise<number[]> {
  const times: number[] = [];
  try {
    await run(
      ffmpegPath()!,
      ['-v', 'info', '-i', src, '-an', '-vf', `fps=4,scale=160:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
      {
        signal,
        collect: false,
        onStderr: (l) => {
          const m = /pts_time:([\d.]+)/.exec(l);
          if (m && /Parsed_showinfo/.test(l)) times.push(Number(m[1]));
        },
      },
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    /* scene info is optional */
  }
  return times;
}

/** Average speaker-region x position (0..1) over time using a cheap sampled brightness/motion centroid fallback is handled elsewhere. */
