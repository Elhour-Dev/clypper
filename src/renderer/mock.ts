// Browser-only fake backend so the UI can be developed and screenshot-tested without Electron.
import type { AppSettings, Project } from '../shared/types';

const defaults: AppSettings['defaults'] = {
  start: 0, end: 30, captions: true, captionStyle: 'pop', captionPos: 'middle', reframe: 'track', removeSilence: true, removeFillers: true,
  zoom: true, sfx: true, music: 'none', musicVolume: 0.18, hookTitle: '', showHook: true, progressBar: true,
};
let settings: AppSettings = { theme: 'system', outputDir: 'C:\\Users\\you\\Videos\\Clypper', geminiKey: '', whisperModel: 'base.en', clipCount: 5, minLen: 20, maxLen: 45, defaults, encoder: 'auto' };

const kit = (n: number) => ({
  youtube: { titles: [`The Money Mistake Nobody Warns You About #${n}`, 'Why Saving Alone Will Not Make You Rich', 'Start Small: The 100 Dollar Rule'], description: 'Most people save too little and never invest. Here is the simple fix.\n\nFollow for more short clips like this.', hashtags: ['#shorts', '#money', '#investing', '#savings', '#viral'], caption: 'The biggest money mistake', postTime: 'Monday, Nov 17, 12:00 PM (your local time)' },
  tiktok: { titles: ['The biggest money mistake', 'Money hits different', 'Wait for the end'], description: 'The biggest money mistake 👀 Follow for more', hashtags: ['#fyp', '#foryou', '#money', '#viral'], caption: 'The biggest money mistake', postTime: 'Monday, Nov 17, 7:00 PM (your local time)' },
  folder: 'C:\\Users\\you\\Videos\\Clypper\\Demo\\01 - The biggest mistake',
});

const project: Project = {
  id: 'demo', name: 'Demo podcast episode', sourceLabel: 'demo.mp4', videoPath: '', duration: 1800, width: 1920, height: 1080, createdAt: Date.now(),
  params: { count: 4, minLen: 20, maxLen: 45 },
  clips: [1, 2, 3, 4].map((n) => ({
    id: `demo-${n}`, n, status: n === 3 ? 'pending' : 'ready', approved: n === 1, deleted: false, posted: { youtube: false, tiktok: false },
    candidate: { start: 60 * n, end: 60 * n + 32, score: 92 - n * 7, reason: ['Opens with a question; emotional words (crazy, money); loud, energetic delivery.', 'Strong hook phrase at the start; excited delivery.', 'Opens with a number; lots of visual changes.', 'Steady, clear talking with a complete thought.'][n - 1], hook: ['Why does this work', 'Nobody tells you this', '3 things I wish I knew', 'Start small and stay consistent'][n - 1], signals: { text: 80, audio: 70, scene: 30 } },
    settings: { ...defaults, start: 60 * n, end: 60 * n + 32, hookTitle: ['Why does this work', 'Nobody tells you this', '3 things I wish I knew', 'Start small and stay consistent'][n - 1] },
    kit: n === 1 ? kit(1) : undefined,
  })),
};

export const mock = {
  version: async () => '0.1.0',
  getSettings: async () => settings,
  setSettings: async (p: Partial<AppSettings>) => (settings = { ...settings, ...p }),
  getPresets: async () => [{ name: 'Fast & punchy', settings: {} }, { name: 'Kinetic words', settings: { captionStyle: 'kinetic' } }],
  savePreset: async () => mock.getPresets(),
  deletePreset: async () => mock.getPresets(),
  listProjects: async () => [project],
  getProject: async () => project,
  deleteProject: async () => undefined,
  toolStatus: async () => ({ ffmpeg: true, whisper: true, model: true, ytdlp: true }),
  checkUpdate: async () => ({ available: true, current: '0.1.0', latest: '0.2.0', url: 'https://example.com' }),
  testKey: async () => true,
  pickVideo: async () => 'C:\\Videos\\demo.mp4',
  pickMusic: async () => null,
  pickFolder: async () => null,
  makeClips: async () => ({ ok: true, project }),
  renderClip: async () => ({ ok: true, project }),
  exportClip: async () => ({ ok: true, project }),
  updateClip: async () => ({ ok: true, project }),
  captionText: async () => 'Why does this work? Because compound growth is insane',
  cancel: async () => true,
};
