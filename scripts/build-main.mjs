import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info', format: 'cjs' };
const only = process.argv[2];

if (!only || only === 'app') {
  await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', external: ['electron', 'onnxruntime-node'] });
  await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js', external: ['electron'] });
}
if ((only === 'smoke' || !only) && existsSync('scripts/smoke.ts')) {
  await build({ ...common, entryPoints: ['scripts/smoke.ts'], outfile: 'dist-electron/smoke.js', external: ['electron', 'onnxruntime-node'] });
}
