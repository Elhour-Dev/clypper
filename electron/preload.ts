import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('clypper', {
  pathFor: (f: File) => webUtils.getPathForFile(f),
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke('api:' + name, ...args),
  on: (channel: string, cb: (payload: any) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
