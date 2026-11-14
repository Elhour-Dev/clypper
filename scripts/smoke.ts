// Headless end-to-end check of the pipeline (no UI). Usage: node dist-electron/smoke.js <video> [count]
import * as path from 'node:path';
import { configure } from '../src/main/paths';
import { createProject, exportClip, renderPreview } from '../src/main/pipeline';
import { setSettings } from '../src/main/store';

const [, , input, countArg, outArg] = process.argv;
configure({ isDev: true, appRoot: process.cwd(), userData: process.env.CLYPPER_DATA || path.join(process.cwd(), 'out', 'data') });
if (outArg) setSettings({ outputDir: path.resolve(outArg) });

(async () => {
  const rep = (s: string, p: number, m: string) => process.stdout.write(`\r[${s}] ${p >= 0 ? Math.round(p) + '%' : ''} ${m}`.padEnd(100));
  const isUrl = /^https?:/.test(input);
  const p = await createProject(isUrl ? { kind: 'url', url: input } : { kind: 'file', path: path.resolve(input) }, { count: Number(countArg || 3), minLen: 15, maxLen: 40 }, rep);
  console.log('\nclips:', p.clips.map((c) => `${c.n}: ${c.candidate.start.toFixed(1)}-${c.candidate.end.toFixed(1)} score ${c.candidate.score} (${c.candidate.reason})`).join('\n'));
  const first = p.clips[0];
  await renderPreview(p.id, first.id, (x) => process.stdout.write(`\rpreview ${Math.round(x)}%`));
  console.log('\npreview ok');
  await exportClip(p.id, first.id, rep);
  console.log('\nexport ok', p.id);
})().catch((e) => {
  console.error('\nFAILED:', e?.friendly || e?.message || e, '\n', e?.detail || '');
  process.exit(1);
});
