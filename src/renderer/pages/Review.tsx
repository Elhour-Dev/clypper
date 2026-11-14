import { useEffect, useMemo, useState } from 'react';
import type { Clip, ClipSettings, PlatformKit, Project } from '../../shared/types';
import { api, mediaUrl, onProgress } from '../api';
import type { Ctx } from '../App';
import { Chips, CopyBtn, CopyRow, Toggle, fmt } from '../ui';

const STYLES = [
  { id: 'pop', label: 'Pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'boxed', label: 'Boxed' },
  { id: 'kinetic', label: 'Kinetic' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'comic', label: 'Comic' },
] as const;

export function Review({ ctx }: { ctx: Ctx }) {
  const p = ctx.project;
  const [sel, setSel] = useState<string>('');
  const [busy, setBusy] = useState<{ id: string; pct: number; msg: string } | null>(null);

  useEffect(() => {
    if (p && !p.clips.some((c) => c.id === sel && !c.deleted)) setSel(p.clips.find((c) => !c.deleted)?.id || '');
  }, [p?.id, p?.clips.length]);
  useEffect(() => onProgress((x) => (x.jobId.startsWith('clip:') || x.jobId.startsWith('export:') ? setBusy({ id: x.jobId.split(':')[1], pct: x.pct, msg: x.message }) : undefined)), []);

  if (!p) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 50 }}>
        <h2>No clips yet</h2>
        <p className="muted">Make clips from a video first, or open one from My projects.</p>
        <button className="btn primary" onClick={() => ctx.go('home')}>
          Make clips
        </button>
      </div>
    );
  }

  const clips = p.clips.filter((c) => !c.deleted);
  const clip = clips.find((c) => c.id === sel);
  const apply = (r: Awaited<ReturnType<typeof api.renderClip>>) => {
    setBusy(null);
    if (r.project) ctx.setProject(r.project);
    if (!r.ok) ctx.fail(r.error);
  };

  async function exportAll() {
    for (const c of clips.filter((x) => !x.exportPath || !x.approved)) {
      setSel(c.id);
      const r = await api.exportClip(p!.id, c.id);
      apply(r);
      if (!r.ok) break; // stop on cancel or error instead of silently continuing
    }
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row">
        <div className="grow">
          <h1>{p.name}</h1>
          <span className="muted">
            {clips.length} clips · source {fmt(p.duration)}
          </span>
        </div>
        <button className="btn primary" disabled={!clips.length || !!busy} onClick={exportAll}>
          ⬇ Export all clips
        </button>
        {clips[0]?.kit?.folder && (
          <button className="btn" onClick={() => api.openPath(clips[0].kit!.folder!.replace(/[\\/][^\\/]+$/, ''))}>
            📂 Open output folder
          </button>
        )}
      </div>

      <div className="review">
        <div className="col" style={{ gap: 10 }}>
          {clips.map((c) => (
            <button key={c.id} className={'clipcard' + (c.id === sel ? ' on' : '')} onClick={() => setSel(c.id)}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <strong>
                  #{c.n} {c.settings.hookTitle || c.candidate.hook}
                </strong>
                <span className={'score' + (c.candidate.score >= 70 ? ' hi' : '')} title="Viral score">
                  {c.candidate.score}
                </span>
              </div>
              <div className="muted small" style={{ margin: '6px 0' }}>
                {c.candidate.reason}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className="badge">{fmt(c.settings.end - c.settings.start)}</span>
                {c.status === 'rendering' && <span className="badge">Building…</span>}
                {c.status === 'error' && <span className="badge err">Problem</span>}
                {c.exportPath && <span className="badge ok">Exported</span>}
                {c.kit && c.posted.youtube && c.posted.tiktok && <span className="badge ok">Posted ✓</span>}
              </div>
            </button>
          ))}
        </div>
        {clip ? <Editor key={clip.id} ctx={ctx} project={p} clip={clip} busy={busy?.id === clip.id ? busy : null} apply={apply} setBusy={setBusy} /> : <div className="card muted">Select a clip.</div>}
      </div>
    </div>
  );
}

function Editor({ ctx, project, clip, busy, apply, setBusy }: { ctx: Ctx; project: Project; clip: Clip; busy: { pct: number; msg: string } | null; apply: (r: any) => void; setBusy: (b: any) => void }) {
  const [s, setS] = useState<ClipSettings>(clip.settings);
  const [capText, setCapText] = useState(clip.settings.captionText ?? '');
  const [presetName, setPresetName] = useState('');
  const dirty = JSON.stringify(s) !== JSON.stringify(clip.settings) || clip.status === 'pending' || clip.status === 'error';
  const set = <K extends keyof ClipSettings>(k: K, v: ClipSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const src = clip.previewPath ? mediaUrl(clip.previewPath) : '';

  const [orig, setOrig] = useState<string | null>(null); // caption text the cuts produce by default
  useEffect(() => {
    api.captionText(project.id, clip.id).then((t) => {
      setOrig(t);
      setCapText((c) => c || t);
    });
  }, []);

  // only keep a caption override when the user really changed the words
  const save = () => api.updateClip(project.id, clip.id, { settings: { ...s, captionText: orig !== null && capText.trim() && capText.trim() !== orig.trim() ? capText.trim() : undefined } });

  async function update() {
    setBusy({ id: clip.id, pct: 0, msg: 'Updating preview…' });
    const u = await save();
    if (!u.ok) return apply(u);
    ctx.setProject(u.project);
    apply(await api.renderClip(project.id, clip.id));
  }
  async function doExport() {
    setBusy({ id: clip.id, pct: 0, msg: 'Exporting…' });
    const u = await save();
    if (!u.ok) return apply(u);
    apply(await api.exportClip(project.id, clip.id));
  }
  const mark = async (patch: Parameters<typeof api.updateClip>[2]) => {
    const r = await api.updateClip(project.id, clip.id, patch);
    if (r.ok) ctx.setProject(r.project);
  };
  const applyPreset = (name: string) => {
    const pr = ctx.presets.find((x) => x.name === name);
    if (pr) setS((x) => ({ ...x, ...pr.settings, start: x.start, end: x.end, hookTitle: x.hookTitle }));
  };
  const nudge = (k: 'start' | 'end', d: number) => set(k, Math.max(0, Math.min(project.duration, +(s[k] + d).toFixed(1))));
  const len = s.end - s.start;

  return (
    <>
      <div className="col" style={{ gap: 10 }}>
        <div className="phone">
          {src ? <video key={src} src={src} controls loop playsInline /> : <div className="ph">{busy ? busy.msg : clip.status === 'error' ? clip.error : 'Preview not built yet'}</div>}
          {busy && src && <div className="ph" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', color: '#fff' }}>{busy.msg}</div>}
        </div>
        {busy && (
          <div className="bar">
            <i style={{ width: `${Math.max(3, busy.pct)}%` }} />
          </div>
        )}
        <div className="row">
          <button className={'btn primary' + (dirty && !busy ? ' pulse' : '')} disabled={!!busy} onClick={update}>
            ↻ {dirty ? 'Update preview' : 'Rebuild'}
          </button>
          <button className="btn" disabled={!!busy} onClick={doExport}>
            ✓ Approve & export
          </button>
        </div>
        <div className="row">
          <button className="btn danger sm" onClick={() => mark({ deleted: true })}>
            🗑 Delete clip
          </button>
          <span className="muted small">Preview is small and quick. Export is 1080×1920.</span>
        </div>
        {clip.status === 'error' && <div className="muted small" style={{ color: 'var(--bad)' }}>{clip.error}</div>}
      </div>

      <div className="col" style={{ gap: 14 }}>
        <div className="card">
          <h3>Why this clip</h3>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className={'score' + (clip.candidate.score >= 70 ? ' hi' : '')} style={{ fontSize: 18, height: 34, minWidth: 54 }}>
              {clip.candidate.score}
            </span>
            <span>{clip.candidate.reason}</span>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Words {clip.candidate.signals.text} · Sound {clip.candidate.signals.audio} · Visual {clip.candidate.signals.scene}
          </div>
        </div>

        <div className="card">
          <h3>Length</h3>
          <div className="row" style={{ gap: 20 }}>
            {(['start', 'end'] as const).map((k) => (
              <div key={k} className="row" style={{ gap: 6 }}>
                <span className="muted">{k === 'start' ? 'Start' : 'End'}</span>
                <button className="btn sm" aria-label={`${k} earlier`} onClick={() => nudge(k, -0.5)}>−</button>
                <strong style={{ minWidth: 56, textAlign: 'center' }}>{fmt(s[k])}.{Math.round((s[k] % 1) * 10)}</strong>
                <button className="btn sm" aria-label={`${k} later`} onClick={() => nudge(k, 0.5)}>+</button>
              </div>
            ))}
            <span className={len < 15 || len > 60 ? 'badge err' : 'badge'}>{len.toFixed(1)} s{len < 15 ? ' (short)' : len > 60 ? ' (long)' : ''}</span>
          </div>
        </div>

        <div className="card">
          <h3>Captions</h3>
          <Toggle on={s.captions} onChange={(v) => set('captions', v)} label="Show word-by-word captions" />
          {s.captions && (
            <div className="col">
              <Chips value={s.captionStyle} options={STYLES as any} onChange={(v) => set('captionStyle', v)} />
              <div className="row">
                <span className="muted small">Position</span>
                <Chips value={s.captionPos} options={[{ id: 'top', label: 'Top' }, { id: 'middle', label: 'Middle' }, { id: 'bottom', label: 'Bottom' }]} onChange={(v) => set('captionPos', v)} />
              </div>
              <label className="field">
                Fix caption words (same word order keeps the timing)
                <textarea value={capText} onChange={(e) => setCapText(e.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Picture & effects</h3>
          <div className="col" style={{ gap: 6 }}>
            <Chips value={s.reframe} options={[{ id: 'track', label: 'Follow the speaker' }, { id: 'blur', label: 'Blurred fit' }, { id: 'center', label: 'Centre crop' }]} onChange={(v) => set('reframe', v)} />
            <div className="kv">
              <Toggle on={s.removeSilence} onChange={(v) => set('removeSilence', v)} label="Cut silences" />
              <Toggle on={s.removeFillers} onChange={(v) => set('removeFillers', v)} label="Cut “um / uh”" />
              <Toggle on={s.zoom} onChange={(v) => set('zoom', v)} label="Zoom on key words" />
              <Toggle on={s.sfx} onChange={(v) => set('sfx', v)} label="Sound effects" />
              <Toggle on={s.progressBar} onChange={(v) => set('progressBar', v)} label="Progress bar" />
              <Toggle on={s.showHook} onChange={(v) => set('showHook', v)} label="Hook title at start" />
            </div>
            {s.showHook && (
              <label className="field">
                Hook title
                <input type="text" value={s.hookTitle} maxLength={60} onChange={(e) => set('hookTitle', e.target.value)} />
              </label>
            )}
            <div className="row">
              <span className="muted small">Music</span>
              <Chips value={s.music === 'none' ? 'none' : s.music === 'builtin' ? 'builtin' : 'file'} options={[{ id: 'none', label: 'None' }, { id: 'builtin', label: 'Built-in calm' }, { id: 'file', label: s.music !== 'none' && s.music !== 'builtin' ? s.music.split(/[\\/]/).pop()! : 'My file…' }]} onChange={async (v) => {
                if (v === 'file') {
                  const f = await api.pickMusic();
                  if (f) set('music', f);
                } else set('music', v);
              }} />
            </div>
            {s.music !== 'none' && (
              <label className="field">
                Music volume (it lowers itself when someone talks)
                <input type="range" min={0.05} max={0.6} step={0.01} value={s.musicVolume} onChange={(e) => set('musicVolume', +e.target.value)} />
              </label>
            )}
          </div>
          <hr className="sep" />
          <div className="row">
            <select style={{ width: 180 }} defaultValue="" onChange={(e) => applyPreset(e.target.value)} aria-label="Apply a saved preset">
              <option value="" disabled>
                Apply preset…
              </option>
              {ctx.presets.map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
            </select>
            <input type="text" style={{ width: 160 }} placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
            <button
              className="btn sm"
              disabled={!presetName.trim()}
              onClick={async () => {
                const { start, end, hookTitle, captionText, ...rest } = s;
                await api.savePreset({ name: presetName.trim(), settings: rest });
                await ctx.reloadPresets();
                setPresetName('');
              }}
            >
              Save as preset
            </button>
          </div>
        </div>

        {clip.kit && <KitPanel clip={clip} onPosted={(posted) => mark({ posted })} />}
      </div>
    </>
  );
}

function KitPanel({ clip, onPosted }: { clip: Clip; onPosted: (p: Partial<Clip['posted']>) => void }) {
  const [tab, setTab] = useState<'youtube' | 'tiktok'>('youtube');
  const kit = clip.kit!;
  const k: PlatformKit = kit[tab];
  const cover = useMemo(() => mediaUrl(kit.folder ? kit.folder + '\\cover.jpg' : ''), [kit.folder]);
  return (
    <div className="card">
      <h2>📦 Posting kit</h2>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        {cover && <img className="cover" src={cover} alt="Best cover frame" />}
        <div className="col grow" style={{ minWidth: 280 }}>
          <div className="row">
            <div className="tabs">
              <button className={tab === 'youtube' ? 'on' : ''} onClick={() => setTab('youtube')}>YouTube Shorts</button>
              <button className={tab === 'tiktok' ? 'on' : ''} onClick={() => setTab('tiktok')}>TikTok</button>
            </div>
            <span className="grow" />
            <button className="btn sm" onClick={() => api.openPath(kit.folder!)}>📂 Open folder</button>
          </div>
          <h3>3 title options</h3>
          {k.titles.map((t, i) => (
            <CopyRow key={i} text={t} />
          ))}
          <h3>Description</h3>
          <CopyRow text={k.description} />
          <h3>Hashtags</h3>
          <CopyRow text={k.hashtags.join(' ')} />
          <h3>Caption</h3>
          <CopyRow text={k.caption} />
          <div className="row">
            <span>
              🕒 Best time: <strong>{k.postTime}</strong>
            </span>
          </div>
          <div className="row">
            <CopyBtn label="Copy cover path" text={kit.folder + '\\cover.jpg'} />
            <CopyBtn label="Copy everything" text={[...k.titles.slice(0, 1), k.description, k.hashtags.join(' ')].join('\n\n')} />
          </div>
          <hr className="sep" />
          <h3>Posted?</h3>
          <Toggle on={clip.posted.youtube} onChange={(v) => onPosted({ youtube: v })} label="Posted on YouTube Shorts" />
          <Toggle on={clip.posted.tiktok} onChange={(v) => onPosted({ tiktok: v })} label="Posted on TikTok" />
        </div>
      </div>
    </div>
  );
}
