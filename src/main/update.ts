import type { UpdateInfo } from '../shared/types';

export const REPO = 'Elhour-Dev/clypper';

export const isNewer = (latest: string, current: string): boolean => {
  const a = latest.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
};

/** Asks GitHub for the newest release. Never throws: no internet just means "no update". */
export async function checkForUpdate(current: string): Promise<UpdateInfo> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Clypper', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { available: false, current };
    const j: any = await res.json();
    const latest = String(j.tag_name || '');
    const exe = (j.assets || []).find((a: any) => /\.exe$/i.test(a.name));
    if (latest && exe && isNewer(latest, current)) {
      return { available: true, current, latest: latest.replace(/^v/, ''), url: exe.browser_download_url, notes: String(j.body || '').slice(0, 400) };
    }
    return { available: false, current, latest: latest.replace(/^v/, '') };
  } catch {
    return { available: false, current };
  }
}
