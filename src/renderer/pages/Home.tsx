import { useEffect, useRef, useState } from 'react';
import { api, onLive, onProgress } from '../api';
import type { Progress } from '../../shared/types';
import type { Ctx } from '../App';
import { fmt } from '../ui';

type Mode = 'file' | 'link' | 'live';

const STEPS: [string, string][] = [
  ['setup', 'Getting tools ready (first time only)'],
  ['download', 'Getting the video'],
  ['audio', 'Preparing the sound'],
  ['transcribe', 'Listening to the speech'],
  ['analyze', 'Finding the best moments'],
  ['preview', 'Editing your clips'],
];

export function Home({ ctx }: { ctx: Ctx }) {
  const { settings } = ctx;
  const [mode, setMode] = useState<Mode>('file');
  const [file, setFile] = useState('');
  const [url, setUrl] = useState('');
  const [liveUrl, setLiveUrl] = useState('');
  const [count, setCount] = useState(settings.clipCount);
  const [minLen, setMin] = useState(settings.minLen);
  const [maxLen, setMax] = useState(settings.maxLen);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [over, setOver] = useState(false);
  const [rec, setRec] = useState<{ title: string; sec: number; bytes: number } | null>(null);
  const recRef = useRef<{ title: string } | null>(null);

  useEffect(() => onProgress((p) => p.jobId === 'make' || p.jobId === 'setup' ? setProg(p) : undefined), []);
  useEffect(() => onLive((l) => setRec((r) => (r ? { ...r, ...l } : r))), []);
  useEffect(() => {
    if (minLen > maxLen) setMax(minLen);
  }, [minLen]);

  const ready = mode === 'file' ? !!file : mode === 'link' ? /^https?:\/\//.test(url.trim()) : false;

  async function run(input: any) {
    setBusy(true);
    setProg({ jobId: 'make', stage: 'setup', pct: -1, message: 'Starting…' });
    await ctx.setSettings({ clipCount: count, minLen, maxLen });
    const r = await api.makeClips(input, { count, minLen, maxLen });
    setBusy(false);
    setProg(null);
    if (r.ok) {
      ctx.setProject(r.project);
      ctx.go('review');
    } else if (!/Cancelled/.test(r.error.message)) ctx.fail(r.error);
  }

  const make = () => run(mode === 'file' ? { kind: 'file', path: file } : { kind: 'url', url: url.trim() });

  async function startRec() {
    const r = await api.recordStart(liveUrl.trim());
    if (!r.ok) return ctx.fail(r.error);
    recRef.current = { title: r.title };
    setRec({ title: r.title, sec: 0, bytes: 0 });
  }
  async function stopRec() {
    const title = recRef.current?.title || 'live';
    setBusy(true);
    const r = await api.recordStop(title);
    setBusy(false);
    setRec(null);
    if (!r.ok) return ctx.fail(r.error);
    await run({ kind: 'recorded', path: r.file, title });
  }

  if (busy && prog) return <Working prog={prog} />;

  return (
    <div className="col" style={{ gap: 22 }}>
      <div>
        <h1>Turn a long video into viral shorts</h1>
        <p className="muted">Pick a video, a link or a live stream. Clypper finds the best moments, edits them, and gives you everything to post.</p>
      </div>

      <div className="card col">
        <div className="tabs" role="tablist">
          {(
            [
              ['file', '🎞️ Video file'],
              ['link', '🔗 Link'],
              ['live', '🔴 Live stream'],
            ] as [Mode, string][]
          ).map(([id, l]) => (
            <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? 'on' : ''} onClick={() => setMode(id)}>
              {l}
            </button>
          ))}
        </div>

        {mode === 'file' && (
          <div
            className={'drop' + (over ? ' over' : '')}
            role="button"
            tabIndex={0}
            onClick={async () => setFile((await api.pickVideo()) || file)}
            onKeyDown={async (e) => e.key === 'Enter' && setFile((await api.pickVideo()) || file)}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              const p = f && window.clypper?.pathFor?.(f);
              if (p) setFile(p);
            }}
          >
            {file ? (
              <>
                <strong>{file.split(/[\\/]/).pop()}</strong>
                <div className="muted small">{file}</div>
                <div className="muted small">Click to choose another</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 30 }}>📂</div>
                <strong>Drop a video here</strong>
                <div className="muted">or click to browse (MP4, MOV, MKV…)</div>
              </>
            )}
          </div>
        )}

        {mode === 'link' && (
          <label className="field">
            Video link (YouTube, Twitch or Kick video, or a finished stream replay)
            <input type="text" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        )}

        {mode === 'live' && (
          <div className="col">
            <p className="muted small" style={{ margin: 0 }}>
              Paste a live stream link and record it. Press Stop when you have enough, then Clypper makes clips from the recording. Already finished? Use the Link tab with the replay link.
            </p>
            {!rec ? (
              <div className="row">
                <input type="text" style={{ flex: 1, minWidth: 260 }} placeholder="https://www.twitch.tv/channel  or  https://kick.com/channel" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} />
                <button className="btn primary" disabled={!/^https?:\/\//.test(liveUrl.trim())} onClick={startRec}>
                  ● Start recording
                </button>
              </div>
            ) : (
              <div className="row">
                <span style={{ color: 'var(--bad)', fontWeight: 700 }}>● Recording</span>
                <strong>{rec.title}</strong>
                <span className="muted">
                  {fmt(rec.sec)} · {(rec.bytes / 1e6).toFixed(0)} MB
                </span>
                <span className="grow" />
                <button className="btn primary" disabled={rec.sec < 25} onClick={stopRec} title={rec.sec < 25 ? 'Record at least 25 seconds' : ''}>
                  ■ Stop & make clips
                </button>
              </div>
            )}
          </div>
        )}

        <hr className="sep" />
        <div className="row" style={{ alignItems: 'flex-end', gap: 26 }}>
          <label className="field">
            How many clips
            <input type="number" min={1} max={12} value={count} onChange={(e) => setCount(Math.max(1, Math.min(12, +e.target.value || 1)))} />
          </label>
          <label className="field">
            Shortest (seconds)
            <input type="number" min={15} max={60} value={minLen} onChange={(e) => setMin(Math.max(15, Math.min(60, +e.target.value || 15)))} />
          </label>
          <label className="field">
            Longest (seconds)
            <input type="number" min={15} max={60} value={maxLen} onChange={(e) => setMax(Math.max(minLen, Math.min(60, +e.target.value || 60)))} />
          </label>
          <span className="grow" />
          {mode !== 'live' && (
            <button className="btn primary big" disabled={!ready} onClick={make}>
              ✨ Make clips
            </button>
          )}
        </div>
      </div>

      {!settings.geminiKey && (
        <div className="card row" style={{ gap: 16 }}>
          <span style={{ fontSize: 22 }}>💡</span>
          <div className="grow">
            <strong>Better titles and moment picking (free)</strong>
            <div className="muted small">Add a free Gemini key in Settings. Without it, Clypper still works using built-in rules. Only the spoken text is sent, never your video.</div>
          </div>
          <button className="btn" onClick={() => ctx.go('settings')}>
            Add key
          </button>
        </div>
      )}
    </div>
  );
}

export function Working({ prog }: { prog: Progress }) {
  const idx = Math.max(0, STEPS.findIndex(([k]) => k === prog.stage));
  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }} role="status" aria-live="polite">
      <h1>Working on it…</h1>
      <p className="muted">You can keep this window open. Longer videos take longer.</p>
      <div className="steps">
        {STEPS.map(([k, l], i) => (
          <div key={k} className={'step' + (i < idx ? ' done' : i === idx ? ' now' : '')}>
            <span className="dot">{i < idx ? '✓' : ''}</span>
            {l}
          </div>
        ))}
      </div>
      <div className={'bar' + (prog.pct < 0 ? ' ind' : '')}>
        <i style={{ width: `${Math.max(2, prog.pct)}%` }} />
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        {prog.message}
      </p>
      <button className="btn danger" onClick={() => api.cancel()}>
        Cancel
      </button>
    </div>
  );
}
