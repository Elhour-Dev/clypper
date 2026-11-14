import { spawn } from 'node:child_process';
import type { Cam } from '../shared/types';
import { detectBoxes } from './faces';
import { ffmpegPath } from './paths';

const FW = 1280;
const SAMPLES = 20;
const RW = 320;
const RH = 240;

/** Fraction of the frame that each corner search window covers. */
const WIN = 0.42;

/** Output top half is 1080 x 960, so the webcam crop must have this width/height ratio (in pixels). */
export const CAM_ASPECT = 1080 / 960;

/** Height (as a fraction of the frame) of a webcam crop for a given width fraction, keeping the 1080:960 ratio. */
export const camHeight = (w: number, srcW: number, srcH: number) => (w * srcW) / (CAM_ASPECT * srcH);

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** Cut a window out of an RGB frame and shrink it (nearest neighbour) to what the face detector expects. */
function windowOf(frame: Buffer, fh: number, rx: number, ry: number, rw: number, rh: number): Buffer {
  const out = Buffer.alloc(RW * RH * 3);
  for (let y = 0; y < RH; y++) {
    const sy = Math.min(fh - 1, ry + Math.floor((y * rh) / RH));
    for (let x = 0; x < RW; x++) {
      const sx = Math.min(FW - 1, rx + Math.floor((x * rw) / RW));
      const s = (sy * FW + sx) * 3;
      const d = (y * RW + x) * 3;
      out[d] = frame[s];
      out[d + 1] = frame[s + 1];
      out[d + 2] = frame[s + 2];
    }
  }
  return out;
}

export interface FaceHit {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * Decide from many small faces found in one corner whether there is a stream webcam there.
 * Needs the same spot in most samples; large faces (a talking head filling the frame) never count.
 */
export function camFromHits(hits: FaceHit[], samples: number, srcW: number, srcH: number): Cam | null {
  if (hits.length < Math.max(4, samples * 0.35)) return null;
  const mcx = median(hits.map((h) => h.cx));
  const mcy = median(hits.map((h) => h.cy));
  const same = hits.filter((h) => Math.abs(h.cx - mcx) < 0.05 && Math.abs(h.cy - mcy) < 0.07);
  if (same.length < Math.max(4, samples * 0.35) || same.length < hits.length * 0.6) return null;
  const fh = median(same.map((h) => h.h));
  const fw = median(same.map((h) => h.w));
  if (fh > 0.3 || fh < 0.035) return null;
  // the webcam picture is a bit bigger than the face: face plus shoulders and some background
  const ch = fh * 2.6;
  let w = (ch * srcH * CAM_ASPECT) / srcW;
  w = Math.max(w, fw * 2.2);
  w = Math.min(w, 0.6);
  const h = camHeight(w, srcW, srcH);
  const x = Math.max(0, Math.min(1 - w, mcx - w / 2));
  const y = Math.max(0, Math.min(1 - h, mcy - h * 0.45));
  return { x, y, w, h };
}

/**
 * Look for a streamer webcam (a small face in a corner of a landscape screen capture).
 * Returns null for normal videos, so only gameplay-with-webcam streams get the split layout.
 */
export async function detectWebcam(src: string, duration: number, srcW: number, srcH: number, signal?: AbortSignal): Promise<Cam | null> {
  if (srcH >= srcW || duration < 10) return null;
  const FH = Math.round((FW * srcH) / srcW / 2) * 2;
  const frameBytes = FW * FH * 3;
  const corners = [
    { rx: 0, ry: 0 },
    { rx: Math.round(FW * (1 - WIN)), ry: 0 },
    { rx: 0, ry: Math.round(FH * (1 - WIN)) },
    { rx: Math.round(FW * (1 - WIN)), ry: Math.round(FH * (1 - WIN)) },
  ];
  const rw = Math.round(FW * WIN);
  const rh = Math.round(FH * WIN);
  const hits: FaceHit[][] = corners.map(() => []);
  let frames = 0;

  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      ffmpegPath()!,
      ['-v', 'error', '-ss', String(duration * 0.03), '-t', String(duration * 0.94), '-i', src, '-an', '-vf', `fps=${SAMPLES / (duration * 0.94)},scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { windowsHide: true },
    );
    signal?.addEventListener('abort', () => p.kill());
    let buf = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    p.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= frameBytes) {
        const frame = Buffer.from(buf.subarray(0, frameBytes));
        buf = buf.subarray(frameBytes);
        chain = chain.then(async () => {
          frames++;
          for (let i = 0; i < corners.length; i++) {
            const { rx, ry } = corners[i];
            const boxes = await detectBoxes(windowOf(frame, FH, rx, ry, rw, rh), 0.8);
            for (const b of boxes) {
              hits[i].push({
                cx: (rx + ((b.x1 + b.x2) / 2) * rw) / FW,
                cy: (ry + ((b.y1 + b.y2) / 2) * rh) / FH,
                w: ((b.x2 - b.x1) * rw) / FW,
                h: ((b.y2 - b.y1) * rh) / FH,
              });
            }
          }
        });
      }
    });
    p.on('error', reject);
    p.on('close', () => chain.then(() => resolve(), reject));
  });

  let best: Cam | null = null;
  let bestN = 0;
  for (const h of hits) {
    const cam = camFromHits(h, frames, srcW, srcH);
    if (cam && h.length > bestN) {
      best = cam;
      bestN = h.length;
    }
  }
  return best;
}
