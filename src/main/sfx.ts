import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from './run';
import { cacheDir, ensureDir, ffmpegPath } from './paths';

/** Generate royalty-free sound effects and a calm music pad with FFmpeg itself (no copyright issues). */
export async function ensureSfx() {
  const ff = ffmpegPath();
  if (!ff) return;
  const dir = ensureDir(path.join(cacheDir(), 'sfx'));
  const jobs: [string, string[]][] = [
    [
      'whoosh.wav',
      ['-f', 'lavfi', '-i', 'anoisesrc=d=0.5:c=pink:a=0.9:r=48000', '-af', 'bandpass=f=1800:w=1.2,tremolo=f=6:d=0.5,afade=t=in:d=0.22,afade=t=out:st=0.22:d=0.28,volume=1.4'],
    ],
    ['pop.wav', ['-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*(1100-4200*t)*t)*exp(-t*26)':d=0.18:s=48000", '-af', 'volume=1.6']],
    [
      'pad.m4a',
      [
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.07*(sin(2*PI*110*t)+sin(2*PI*130.81*t)+sin(2*PI*164.81*t)+0.6*sin(2*PI*220*t)+0.5*sin(2*PI*261.63*t))*(0.65+0.35*sin(2*PI*0.15*t))':d=24:s=48000",
        '-af',
        'lowpass=f=1800,aecho=0.7:0.6:350:0.4,afade=t=in:d=2,afade=t=out:st=22:d=2',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
      ],
    ],
  ];
  for (const [name, args] of jobs) {
    const out = path.join(dir, name);
    if (fs.existsSync(out)) continue;
    await run(ff, ['-y', '-v', 'error', ...args, out]).catch(() => undefined);
  }
}
