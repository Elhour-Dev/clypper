import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AppSettings, ClipSettings, Preset, Project } from '../shared/types';
import { dataDir, ensureDir } from './paths';

export const DEFAULT_CLIP: ClipSettings = {
  start: 0,
  end: 30,
  captions: true,
  captionStyle: 'pop',
  captionPos: 'middle',
  reframe: 'track',
  removeSilence: true,
  removeFillers: true,
  zoom: true,
  sfx: true,
  music: 'none',
  musicVolume: 0.18,
  hookTitle: '',
  showHook: true,
  progressBar: true,
};

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    outputDir: path.join(os.homedir(), 'Videos', 'Clypper'),
    geminiKey: '',
    whisperModel: 'base.en',
    clipCount: 5,
    minLen: 20,
    maxLen: 45,
    defaults: { ...DEFAULT_CLIP },
    encoder: 'auto',
  };
}

const file = (name: string) => path.join(ensureDir(dataDir()), name);

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(p: string, v: unknown) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, p);
}

export function getSettings(): AppSettings {
  const d = defaultSettings();
  const s = readJson<Partial<AppSettings>>(file('settings.json'), {});
  return { ...d, ...s, defaults: { ...d.defaults, ...(s.defaults || {}) } };
}
export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  writeJson(file('settings.json'), next);
  return next;
}

const BUILTIN_PRESETS: Preset[] = [
  { name: 'Fast & punchy', settings: { captionStyle: 'pop', zoom: true, sfx: true, removeSilence: true, removeFillers: true, progressBar: true } },
  { name: 'Kinetic words', settings: { captionStyle: 'kinetic', captionPos: 'middle', zoom: true, sfx: true } },
  { name: 'Clean & calm', settings: { captionStyle: 'minimal', captionPos: 'bottom', zoom: false, sfx: false, progressBar: false, music: 'builtin' } },
];
export function getPresets(): Preset[] {
  return [...BUILTIN_PRESETS, ...readJson<Preset[]>(file('presets.json'), [])];
}
export function savePreset(p: Preset) {
  const mine = readJson<Preset[]>(file('presets.json'), []).filter((x) => x.name !== p.name);
  mine.push(p);
  writeJson(file('presets.json'), mine);
  return getPresets();
}
export function deletePreset(name: string) {
  writeJson(file('presets.json'), readJson<Preset[]>(file('presets.json'), []).filter((x) => x.name !== name));
  return getPresets();
}

const projDir = (id: string) => path.join(dataDir(), 'projects', id);
export function saveProject(p: Project) {
  writeJson(path.join(projDir(p.id), 'project.json'), p);
}
export function loadProject(id: string): Project | null {
  return readJson<Project | null>(path.join(projDir(id), 'project.json'), null);
}
export function listProjects(): Project[] {
  const root = path.join(dataDir(), 'projects');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => loadProject(id))
    .filter((p): p is Project => !!p)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function deleteProject(id: string) {
  fs.rmSync(projDir(id), { recursive: true, force: true });
}
export const projectFile = (id: string, name: string) => path.join(ensureDir(projDir(id)), name);
export const readProjectJson = <T>(id: string, name: string, fb: T) => readJson<T>(projectFile(id, name), fb);
export const writeProjectJson = (id: string, name: string, v: unknown) => writeJson(projectFile(id, name), v);
