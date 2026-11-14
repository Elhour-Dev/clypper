import { spawn, ChildProcess } from 'node:child_process';

export interface RunOpts {
  cwd?: string;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
  collect?: boolean;
}

export class FriendlyError extends Error {
  constructor(public friendly: string, public detail = '') {
    super(friendly);
  }
}

/** Run a program, stream lines, resolve with collected output. Rejects on non-zero exit. */
export function run(exe: string, args: string[], o: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd: o.cwd, windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    const feed = (buf: Buffer, which: 'o' | 'e') => {
      const s = buf.toString('utf8');
      if (which === 'o') {
        if (o.collect !== false) out += s;
        if (o.onStdout) s.split(/\r?\n|\r/).forEach((l) => l && o.onStdout!(l));
      } else {
        if (o.collect !== false) err += s;
        if (o.onStderr) s.split(/\r?\n|\r/).forEach((l) => l && o.onStderr!(l));
      }
      if (out.length > 4e6) out = out.slice(-2e6);
      if (err.length > 4e6) err = err.slice(-2e6);
    };
    child.stdout?.on('data', (b) => feed(b, 'o'));
    child.stderr?.on('data', (b) => feed(b, 'e'));
    child.on('error', (e) => reject(e));
    child.on('close', (code, sig) => {
      if (o.signal?.aborted) return reject(new FriendlyError('Cancelled.'));
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new FriendlyError(`A tool stopped with an error (${exe.split(/[\\/]/).pop()}).`, (err || out).slice(-1500) + ` [code ${code ?? sig}]`));
    });
    o.signal?.addEventListener('abort', () => child.kill());
  });
}
