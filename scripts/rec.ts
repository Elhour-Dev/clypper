// Records a live stream for N seconds then runs the normal pipeline on it. Usage: node dist-electron/rec.js <url> <seconds> <outdir>
import * as path from 'node:path';
import { configure } from '../src/main/paths';
import { recordLive, linkInfo } from '../src/main/ingest';
import { createProject, exportClip } from '../src/main/pipeline';
import { setSettings } from '../src/main/store';

const [, , url, secs, out] = process.argv;
configure({ isDev: true, appRoot: process.cwd(), userData: process.env.CLYPPER_DATA || path.join(process.cwd(), 'out', 'data') });
setSettings({ outputDir: path.resolve(out) });
(async () => {
  const info = await linkInfo(url);
  console.log('live:', info.isLive, info.title);
  const rec = recordLive(url, info.title, path.join(path.resolve(out), '_sources'), 10, (s, b) => process.stdout.write(`\rrec ${Math.round(s)}s ${(b / 1e6).toFixed(1)}MB`));
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const file = await rec.stop();
  console.log('\nrecorded', file);
  const p = await createProject({ kind: 'recorded', path: file, title: info.title }, { count: 2, minLen: 15, maxLen: 30 }, (s, pc, m) => process.stdout.write(`\r[${s}] ${Math.round(pc)}% ${m}`.padEnd(90)));
  console.log('\nclips', p.clips.map((c) => `${c.candidate.start.toFixed(0)}-${c.candidate.end.toFixed(0)} s${c.candidate.score}`).join(' | '));
  await exportClip(p.id, p.clips[0].id, () => undefined);
  console.log('export ok');
})().catch((e) => { console.error('FAILED:', e?.friendly || e, e?.detail || ''); process.exit(1); });
