import { useEffect, useState } from 'react';
import type { Project } from '../../shared/types';
import { api } from '../api';
import type { Ctx } from '../App';
import { Chips, Toggle, fmt } from '../ui';

export function Library({ ctx }: { ctx: Ctx }) {
  const [list, setList] = useState<Project[] | null>(null);
  const load = () => api.listProjects().then(setList);
  useEffect(() => void load(), []);
  return (
    <div className="col">
      <h1>My projects</h1>
      {list && !list.length && <div className="card muted">Nothing here yet. Your finished projects will show up here.</div>}
      {list?.map((p) => {
        const live = p.clips.filter((c) => !c.deleted);
        return (
          <div key={p.id} className="card row">
            <div className="grow">
              <strong>{p.name}</strong>
              <div className="muted small">
                {new Date(p.createdAt).toLocaleString()} · {live.length} clips · {fmt(p.duration)} · {live.filter((c) => c.exportPath).length} exported
              </div>
            </div>
            <button
              className="btn primary"
              onClick={async () => {
                ctx.setProject(await api.getProject(p.id));
                ctx.go('review');
              }}
            >
              Open
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (confirm(`Remove "${p.name}" from Clypper? Exported clips stay in your folder.`)) {
                  await api.deleteProject(p.id);
                  load();
                }
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Settings({ ctx }: { ctx: Ctx }) {
  const { settings: s, setSettings } = ctx;
  const [key, setKey] = useState(s.geminiKey);
  const [keyState, setKeyState] = useState<'' | 'testing' | 'ok' | 'bad'>('');
  const [keyMsg, setKeyMsg] = useState('');
  return (
    <div className="col" style={{ maxWidth: 720 }}>
      <h1>Settings</h1>
      <div className="card col">
        <h3>Look</h3>
        <Chips value={s.theme} options={[{ id: 'system', label: 'Match Windows' }, { id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }]} onChange={(v) => setSettings({ theme: v })} />
      </div>
      <div className="card col">
        <h3>Where clips are saved</h3>
        <div className="row">
          <input type="text" readOnly value={s.outputDir} style={{ flex: 1 }} />
          <button className="btn" onClick={async () => { const f = await api.pickFolder(); if (f) setSettings({ outputDir: f }); }}>Change…</button>
          <button className="btn" onClick={() => api.openPath(s.outputDir)}>Open</button>
        </div>
      </div>
      <div className="card col">
        <h3>AI help (free Gemini key)</h3>
        <p className="muted small">Optional. Gives smarter clip ratings and better titles. Get a free key at aistudio.google.com/apikey. Only transcript text is sent, never video or audio.</p>
        <div className="row">
          <input type="password" style={{ flex: 1 }} placeholder="Paste your key" value={key} onChange={(e) => { setKey(e.target.value); setKeyState(''); }} />
          <button
            className="btn"
            onClick={async () => {
              setKeyState('testing');
              setKeyMsg('');
              try {
                const r = key.trim() ? await api.testKey(key.trim()) : { ok: true };
                setKeyMsg((r as any).message || '');
                setKeyState(r.ok ? 'ok' : 'bad');
                if (r.ok) await setSettings({ geminiKey: key.trim() });
              } catch {
                setKeyMsg('Something went wrong. Try again.');
                setKeyState('bad');
              }
            }}
          >
            Test & save
          </button>
        </div>
        {keyState === 'ok' && <span style={{ color: 'var(--good)' }}>{keyMsg || (key ? 'Key works and is saved ✓' : 'Key removed')}</span>}
        {keyState === 'bad' && <span style={{ color: 'var(--bad)' }}>{keyMsg || 'That key did not work. Check it and try again.'}</span>}
        {keyState === 'testing' && <span className="muted">Testing…</span>}
      </div>
      <div className="card col">
        <h3>Blocked YouTube videos</h3>
        <p className="muted small">If YouTube says a video needs sign-in or a robot check, Clypper can borrow your browser's login just for downloading. Nothing is stored or sent anywhere else. Firefox works best.</p>
        <Chips value={s.cookiesBrowser} options={[{ id: 'none', label: 'Off' }, { id: 'firefox', label: 'Firefox' }, { id: 'chrome', label: 'Chrome' }, { id: 'edge', label: 'Edge' }]} onChange={(v) => setSettings({ cookiesBrowser: v })} />
      </div>
      <div className="card col">
        <h3>Speech accuracy vs speed</h3>
        <Chips
          value={s.whisperModel}
          options={[
            { id: 'base.en', label: 'Fast (English)' },
            { id: 'small.en', label: 'Accurate (English, slower)' },
            { id: 'base', label: 'Fast (any language)' },
            { id: 'small', label: 'Accurate (any language)' },
          ]}
          onChange={(v) => setSettings({ whisperModel: v })}
        />
        <p className="muted small">A new model downloads the first time you use it (about 150–500 MB).</p>
        <Toggle on={s.encoder === 'auto'} onChange={(v) => setSettings({ encoder: v ? 'auto' : 'cpu' })} label="Use Intel graphics to export faster" hint="Turn off if exports ever fail." />
      </div>
    </div>
  );
}

export function Help() {
  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <h1>Help</h1>
      <div className="card">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Pick a video</strong> (a file, a link, or record a live stream) and press <strong>Make clips</strong>.
          </li>
          <li>
            Clypper listens, finds the best moments and shows a <strong>viral score</strong> and reason for each.
          </li>
          <li>
            In <strong>Review</strong>, watch each clip. Change the length, captions or effects, then press <strong>Update preview</strong>.
          </li>
          <li>
            Press <strong>Approve & export</strong>. You get a 1080×1920 video, a cover image and a text file in one folder per clip.
          </li>
          <li>
            Use the <strong>Posting kit</strong> (titles, description, hashtags, best time) and upload the clip yourself on YouTube Shorts and TikTok. Tick “Posted” when done.
          </li>
        </ol>
      </div>
      <div className="card">
        <h2>Good to know</h2>
        <ul>
          <li>
            <strong>First run</strong> downloads a few free tools (about 400 MB). This happens once.
          </li>
          <li>
            Everything runs on your PC. Nothing is uploaded. Clypper never connects to your accounts.
          </li>
          <li>Long videos take longer. A 30-minute video can take 10 to 20 minutes on a laptop.</li>
          <li>
            <strong>Live streams:</strong> use the Live tab, press Start, then Stop. Finished streams work with the Link tab.
          </li>
          <li>
            <strong>“Follow the speaker”</strong> keeps the face in frame. If no face is found, Clypper uses a blurred fit.
          </li>
          <li>Windows may warn about an unknown app the first time. Choose “More info”, then “Run anyway”.</li>
        </ul>
      </div>
      <div className="card">
        <h2>If something goes wrong</h2>
        <p className="muted">Messages show what to do. Press “Technical details” and copy them if you ask for help.</p>
      </div>
    </div>
  );
}
