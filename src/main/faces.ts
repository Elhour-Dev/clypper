import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FacePoint } from './render';
import { assetsDir, ffmpegPath } from './paths';

const W = 320;
const H = 240;
const FPS = 3;

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  s: number;
}

function iou(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = ix * iy;
  return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i || 1);
}

export function nms(boxes: Box[], thr = 0.3): Box[] {
  const out: Box[] = [];
  for (const b of [...boxes].sort((a, c) => c.s - a.s)) if (out.every((o) => iou(o, b) < thr)) out.push(b);
  return out;
}

/** Pick the speaker per frame: biggest face, but stay with the previous one unless another is clearly bigger. */
export function chooseSpeakers(frames: Box[][], dt: number, t0: number): FacePoint[] | null {
  const pts: FacePoint[] = [];
  let prev: number | null = null;
  let hits = 0;
  frames.forEach((fs_, i) => {
    if (!fs_.length) return;
    hits++;
    const area = (b: Box) => (b.x2 - b.x1) * (b.y2 - b.y1);
    const big = [...fs_].sort((a, b) => area(b) - area(a))[0];
    let pick = big;
    if (prev != null) {
      const near = fs_.find((b) => Math.abs((b.x1 + b.x2) / 2 - prev!) < 0.15);
      if (near && area(big) < area(near) * 1.6) pick = near;
    }
    prev = (pick.x1 + pick.x2) / 2;
    pts.push({ t: t0 + i * dt, x: prev });
  });
  if (hits < Math.max(3, frames.length * 0.15)) return null;
  return pts;
}

let session: any = null;
async function getSession() {
  if (session) return session;
  const ort = await import('onnxruntime-node');
  const modelPath = path.join(assetsDir(), 'models', 'face.onnx');
  if (!fs.existsSync(modelPath)) throw new Error('face model missing');
  session = { ort, s: await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }) };
  return session;
}

/** Find the speaker's horizontal position over time. Returns null when there are no faces (caller uses blurred fit). */
export async function trackFaces(src: string, start: number, end: number, srcW: number, srcH: number): Promise<FacePoint[] | null> {
  if (srcH > srcW) return null; // already portrait: nothing to track
  const { ort, s } = await getSession();
  const frames: Box[][] = [];
  const frameBytes = W * H * 3;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegPath()!, ['-v', 'error', '-ss', String(start), '-t', String(end - start), '-i', src, '-an', '-vf', `fps=${FPS},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    let buf = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    p.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= frameBytes) {
        const frame = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        const copy = Buffer.from(frame);
        chain = chain.then(async () => {
          const f32 = new Float32Array(3 * H * W);
          for (let i = 0; i < H * W; i++) {
            f32[i] = (copy[i * 3] - 127) / 128;
            f32[H * W + i] = (copy[i * 3 + 1] - 127) / 128;
            f32[2 * H * W + i] = (copy[i * 3 + 2] - 127) / 128;
          }
          const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, H, W]) });
          const scores = out[s.outputNames[0]].data as Float32Array;
          const boxes = out[s.outputNames[1]].data as Float32Array;
          const cand: Box[] = [];
          for (let i = 0; i < scores.length / 2; i++) {
            if (scores[i * 2 + 1] > 0.7) cand.push({ x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3], s: scores[i * 2 + 1] });
          }
          frames.push(nms(cand));
        });
      }
    });
    p.on('error', reject);
    p.on('close', () => chain.then(() => resolve(), reject));
  });
  return chooseSpeakers(frames, 1 / FPS, start);
}
