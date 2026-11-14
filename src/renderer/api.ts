import type { AppSettings, Clip, ClipSettings, Preset, Progress, Project, UpdateInfo } from '../shared/types';
import { mock } from './mock';

export interface ApiError {
  message: string;
  detail?: string;
}
export type Res<T = {}> = ({ ok: true } & T) | { ok: false; error: ApiError; project?: Project | null };

export interface Api {
  version(): Promise<string>;
  getSettings(): Promise<AppSettings>;
  setSettings(p: Partial<AppSettings>): Promise<AppSettings>;
  getPresets(): Promise<Preset[]>;
  savePreset(p: Preset): Promise<Preset[]>;
  deletePreset(n: string): Promise<Preset[]>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  deleteProject(id: string): Promise<void>;
  toolStatus(): Promise<{ ffmpeg: boolean; whisper: boolean; model: boolean; ytdlp: boolean }>;
  checkUpdate(): Promise<UpdateInfo>;
  testKey(k: string): Promise<{ ok: boolean; message?: string }>;
  openExternal(u: string): Promise<void>;
  openPath(p: string): Promise<string>;
  showInFolder(p: string): Promise<void>;
  pickVideo(): Promise<string | null>;
  pickMusic(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  cancel(jobId?: string): Promise<boolean>;
  makeClips(input: any, params: { count: number; minLen: number; maxLen: number }, jobId?: string): Promise<Res<{ project: Project }>>;
  recordStart(url: string): Promise<Res<{ title: string; isLive: boolean }>>;
  recordStop(title: string): Promise<Res<{ file: string; title: string }>>;
  renderClip(pid: string, cid: string): Promise<Res<{ project: Project }>>;
  exportClip(pid: string, cid: string): Promise<Res<{ project: Project }>>;
  updateClip(pid: string, cid: string, patch: { approved?: boolean; deleted?: boolean; posted?: Partial<Clip['posted']>; settings?: Partial<ClipSettings> }): Promise<Res<{ project: Project }>>;
  captionText(pid: string, cid: string): Promise<string>;
}

declare global {
  interface Window {
    clypper?: { pathFor?: (f: File) => string; call: (name: string, ...a: unknown[]) => Promise<any>; on: (ch: string, cb: (p: any) => void) => () => void };
  }
}

const bridge = window.clypper;
export const inElectron = !!bridge;

export const api: Api = new Proxy({} as Api, {
  get: (_t, name: string) => (...a: unknown[]) => (bridge ? bridge.call(name, ...a) : (mock as any)[name]?.(...a)),
});

export const onProgress = (cb: (p: Progress) => void) => (bridge ? bridge.on('progress', cb) : () => undefined);
export const onLive = (cb: (p: { sec: number; bytes: number }) => void) => (bridge ? bridge.on('live', cb) : () => undefined);

export const mediaUrl = (p?: string) => (p && bridge ? 'clypper://f/' + encodeURIComponent(p) : '');
