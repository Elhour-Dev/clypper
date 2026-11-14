import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Menu } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { configure, dataDir } from '../src/main/paths';
import { FriendlyError } from '../src/main/run';
import { createProject, exportClip, renderPreview, sourceFrame, updateClip, wordsOf } from '../src/main/pipeline';
import { deletePreset, deleteProject, getPresets, getSettings, listProjects, loadProject, savePreset, setSettings } from '../src/main/store';
import { ensureTools, toolStatus } from '../src/main/tools';
import { linkInfo, recordLive, setCookiesBrowser, LiveRecording } from '../src/main/ingest';
import { testKey } from '../src/main/llm';
import { planCuts } from '../src/main/cuts';
import { checkForUpdate } from '../src/main/update';
import type { ClipSettings, Progress } from '../src/shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'clypper', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } }]);

const isDev = !app.isPackaged && !!process.env.VITE_DEV;
configure({
  isDev: !app.isPackaged,
  appRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
  userData: app.getPath('userData'),
});

let win: BrowserWindow | null = null;
let abort: AbortController | null = null;
const jobs = new Map<string, AbortController>();
let live: LiveRecording | null = null;
let starting = false;
let busy: Promise<unknown> = Promise.resolve();

const send = (ch: string, payload: unknown) => win?.webContents.send(ch, payload);
const progress = (jobId: string) => (stage: string, pct: number, message: string) => send('progress', { jobId, stage, pct, message } as Progress);

/** Run heavy jobs one at a time so a slow PC is never overloaded. */
function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = busy.then(fn, fn);
  busy = next.catch(() => undefined);
  return next;
}

function friendly(e: any) {
  if (e instanceof FriendlyError) return { message: e.friendly, detail: e.detail };
  return { message: 'Something unexpected went wrong. Please try again.', detail: String(e?.stack || e) };
}

/** Only let the UI open files inside Clypper's own folders (output and app data). */
function allowedPath(p: string): boolean {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const roots = [getSettings().outputDir, dataDir()].map((r) => path.resolve(r).toLowerCase() + path.sep);
  const x = path.resolve(p).toLowerCase() + path.sep;
  return roots.some((r) => x.startsWith(r));
}

const api: Record<string, (...a: any[]) => any> = {
  version: () => app.getVersion(),
  getSettings: () => getSettings(),
  setSettings: (p: any) => setSettings(p),
  getPresets: () => getPresets(),
  savePreset: (p: any) => savePreset(p),
  deletePreset: (n: string) => deletePreset(n),
  listProjects: () => listProjects(),
  getProject: (id: string) => loadProject(id),
  deleteProject: (id: string) => deleteProject(id),
  toolStatus: () => toolStatus(getSettings().whisperModel),
  checkUpdate: () => checkForUpdate(app.getVersion()),
  testKey: (k: string) => testKey(k),
  openExternal: (u: string) => (/^https:\/\//.test(u) ? shell.openExternal(u) : undefined),
  openPath: (p: string) => (allowedPath(p) ? shell.openPath(p) : ''),
  showInFolder: (p: string) => (allowedPath(p) ? shell.showItemInFolder(p) : undefined),
  pickVideo: async () => {
    if (process.env.CLYPPER_TEST_PICK) return process.env.CLYPPER_TEST_PICK; // automated tests only
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a video', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'flv'] }] });
    return r.canceled ? null : r.filePaths[0];
  },
  pickMusic: async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose music', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }] });
    return r.canceled ? null : r.filePaths[0];
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  sourceFrame: (pid: string, t: number) => sourceFrame(pid, t),
  cancel: (jobId?: string) => {
    if (jobId) jobs.get(jobId)?.abort(); // a queued job that has not started yet is cancelled too
    else abort?.abort();
    return true;
  },

  // Several "make clips" jobs can be queued; they run one after another (running them at the same time would just make each one slower).
  makeClips: (input: any, params: any, jobId = 'make') => {
    const ctl = new AbortController();
    jobs.set(jobId, ctl);
    return queue(async () => {
      const rep = progress(jobId);
      try {
        if (ctl.signal.aborted) throw new FriendlyError('Cancelled.');
        const p = await createProject(input, params, rep, ctl.signal);
        const todo = p.clips;
        for (let i = 0; i < todo.length; i++) {
          rep('preview', (i / todo.length) * 100, `Building preview ${i + 1} of ${todo.length}…`);
          await renderPreview(p.id, todo[i].id, (x) => rep('preview', ((i + x / 100) / todo.length) * 100, `Building preview ${i + 1} of ${todo.length}… ${Math.round(x)}%`), ctl.signal).catch((e) => {
            if (e instanceof FriendlyError && /Cancelled/.test(e.friendly)) throw e;
          });
        }
        return { ok: true, project: loadProject(p.id) };
      } catch (e) {
        return { ok: false, error: friendly(e) };
      } finally {
        jobs.delete(jobId);
      }
    });
  },

  recordStart: async (url: string) => {
    try {
      if (live || starting) return { ok: false, error: { message: 'Already recording.' } };
      starting = true;
      const s = getSettings();
      setCookiesBrowser(s.cookiesBrowser);
      await ensureTools(s.whisperModel, progress('setup'), true);
      const info = await linkInfo(url);
      live = recordLive(url, info.title, path.join(s.outputDir, '_sources'), 120, (sec, bytes) => send('live', { sec, bytes }));
      return { ok: true, title: info.title, isLive: info.isLive };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    } finally {
      starting = false;
    }
  },
  recordStop: async (title: string) => {
    if (!live) return { ok: false, error: { message: 'Nothing is recording.' } };
    const l = live;
    live = null;
    try {
      const file = await l.stop();
      return { ok: true, file, title };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  },

  renderClip: (pid: string, cid: string) =>
    queue(async () => {
      abort = new AbortController();
      try {
        await renderPreview(pid, cid, (x) => send('progress', { jobId: 'clip:' + cid, stage: 'preview', pct: x, message: `Updating preview… ${Math.round(x)}%` }), abort.signal);
        return { ok: true, project: loadProject(pid) };
      } catch (e) {
        return { ok: false, error: friendly(e), project: loadProject(pid) };
      }
    }),
  exportClip: (pid: string, cid: string) =>
    queue(async () => {
      abort = new AbortController();
      try {
        await exportClip(pid, cid, (s, p, m) => send('progress', { jobId: 'export:' + cid, stage: s, pct: p, message: m }), abort.signal);
        return { ok: true, project: loadProject(pid) };
      } catch (e) {
        return { ok: false, error: friendly(e), project: loadProject(pid) };
      }
    }),
  updateClip: (pid: string, cid: string, patch: any) => {
    try {
      return { ok: true, project: updateClip(pid, cid, patch) };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  },
  /** Default caption text for a clip with the current cut settings. */
  captionText: (pid: string, cid: string) => {
    const p = loadProject(pid);
    const c = p?.clips.find((x) => x.id === cid);
    if (!p || !c) return '';
    const s: ClipSettings = c.settings;
    return planCuts(wordsOf(pid).words, s.start, s.end, { silence: s.removeSilence, fillers: s.removeFillers }).words.map((w) => w.t).join(' ');
  },
};

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'Clypper',
    backgroundColor: '#0f1115',
    icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  // serve local media (previews, covers, source videos) to the player
  protocol.handle('clypper', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
    const ok = /\.(mp4|mkv|mov|webm|jpg|jpeg|png|m4v|ts)$/i.test(p) && path.isAbsolute(p) && fs.existsSync(p);
    if (!ok) return new Response('not found', { status: 404 });
    // The video player needs byte-range answers (HTTP 206) to jump around the timeline; plain file fetches do not give them.
    const size = fs.statSync(p).size;
    const mime = /\.(jpe?g)$/i.test(p) ? 'image/jpeg' : /\.png$/i.test(p) ? 'image/png' : /\.webm$/i.test(p) ? 'video/webm' : /\.mkv$/i.test(p) ? 'video/x-matroska' : /\.ts$/i.test(p) ? 'video/mp2t' : 'video/mp4';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    let start = 0;
    let end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      } else {
        start = Math.max(0, size - Number(m[2])); // "last N bytes"
      }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const body = size === 0 ? null : (Readable.toWeb(fs.createReadStream(p, { start, end })) as unknown as ReadableStream);
    const headers: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(size === 0 ? 0 : end - start + 1), 'Cache-Control': 'no-store' };
    if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: m ? 206 : 200, headers });
  });
  for (const [name, fn] of Object.entries(api)) ipcMain.handle('api:' + name, (_e, ...a) => fn(...a));
  fs.mkdirSync(dataDir(), { recursive: true });
  createWindow();
});

app.on('window-all-closed', () => {
  abort?.abort();
  jobs.forEach((j) => j.abort());
  live?.stop().catch(() => undefined); // do not leave a recorder running in the background
  app.quit();
});
if (!app.requestSingleInstanceLock()) app.quit();
