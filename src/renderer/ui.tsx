import { useState } from 'react';
import { api } from './api';

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} tabIndex={0} onClick={() => onChange(!on)} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange(!on))}>
      <span>
        {label}
        {hint && <span className="muted small" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <span className="sw" />
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="chips" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={'chip' + (value === o.id ? ' on' : '')} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const t = document.createElement('textarea');
          t.value = text;
          document.body.appendChild(t);
          t.select();
          document.execCommand('copy');
          t.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

export function CopyRow({ text, label }: { text: string; label?: string }) {
  return (
    <div className="copyrow">
      <span>{text}</span>
      <CopyBtn text={text} label={label} />
    </div>
  );
}

export function ErrorToast({ err, onClose }: { err: { message: string; detail?: string } | null; onClose: () => void }) {
  if (!err) return null;
  return (
    <div className="toast" role="alert">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <strong>{err.message}</strong>
        <button className="btn sm ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {err.detail && (
        <details>
          <summary>Technical details</summary>
          <pre>{err.detail}</pre>
          <CopyBtn text={err.detail} label="Copy details" />
        </details>
      )}
    </div>
  );
}

export const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, '0')}`;
};

export const openUrl = (u: string) => api.openExternal(u);
