import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, Preset, Project, UpdateInfo } from '../shared/types';
import { api, ApiError } from './api';
import { ErrorToast, openUrl } from './ui';
import { Home } from './pages/Home';
import { Review } from './pages/Review';
import { Library, Settings, Help } from './pages/Other';

export type View = 'home' | 'review' | 'library' | 'settings' | 'help';

export interface Ctx {
  settings: AppSettings;
  setSettings: (p: Partial<AppSettings>) => Promise<void>;
  presets: Preset[];
  reloadPresets: () => Promise<void>;
  project: Project | null;
  setProject: (p: Project | null) => void;
  go: (v: View) => void;
  fail: (e: ApiError | null) => void;
}

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'home', label: 'Make clips', icon: '✨' },
  { id: 'review', label: 'Review & export', icon: '🎬' },
  { id: 'library', label: 'My projects', icon: '📁' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'help', label: 'Help', icon: '❓' },
];

export function App() {
  const [view, setView] = useState<View>('home');
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    api.getSettings().then(setSettingsState);
    api.getPresets().then(setPresets);
    api.version().then(setVersion);
    api.checkUpdate().then((u) => u.available && setUpdate(u));
  }, []);

  useEffect(() => {
    if (view !== 'review') document.querySelectorAll('video').forEach((v) => v.pause());
  }, [view]);

  // theme: light / dark / follow Windows
  useEffect(() => {
    if (!settings) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.theme]);

  const setSettings = useCallback(async (p: Partial<AppSettings>) => setSettingsState(await api.setSettings(p)), []);
  const reloadPresets = useCallback(async () => setPresets(await api.getPresets()), []);

  if (!settings) return null;
  const ctx: Ctx = { settings, setSettings, presets, reloadPresets, project, setProject, go: setView, fail: setErr };

  return (
    <div className="app">
      <nav className="side" aria-label="Main">
        <div className="brand">
          <span className="logo">C</span> Clypper
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={'nav' + (view === n.id ? ' on' : '')} onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined}>
            <span aria-hidden>{n.icon}</span> {n.label}
          </button>
        ))}
        <div className="grow" />
        <div className="muted small" style={{ padding: '0 12px' }}>
          Version {version}
        </div>
      </nav>
      <main className="main">
        <div className="wrap">
          {update && (
            <div className="banner" role="status">
              <span>
                🎉 <strong>Clypper {update.latest}</strong> is ready.
              </span>
              <span className="grow" />
              <button className="btn primary sm" onClick={() => openUrl(update.url!)}>
                Download now
              </button>
              <button className="btn sm ghost" onClick={() => setUpdate(null)}>
                Later
              </button>
            </div>
          )}
          {/* Home and Review stay mounted (just hidden) so running jobs and their progress survive tab changes */}
          <div style={{ display: view === 'home' ? 'contents' : 'none' }}>
            <Home ctx={ctx} />
          </div>
          <div style={{ display: view === 'review' ? 'contents' : 'none' }}>
            <Review ctx={ctx} />
          </div>
          {view === 'library' && <Library ctx={ctx} />}
          {view === 'settings' && <Settings ctx={ctx} />}
          {view === 'help' && <Help />}
        </div>
      </main>
      <ErrorToast err={err} onClose={() => setErr(null)} />
    </div>
  );
}
