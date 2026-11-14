export interface Word {
  t: string;
  s: number; // seconds in source
  e: number;
}

export interface Transcript {
  words: Word[];
  language: string;
  duration: number;
}

export interface Signals {
  text: number; // 0-100
  audio: number;
  scene: number;
}

export interface Candidate {
  start: number;
  end: number;
  score: number; // 0-100 viral score
  reason: string;
  hook: string; // short title text
  signals: Signals;
}

export type CaptionStyleId = 'hormozi' | 'mrbeast' | 'pop' | 'karaoke' | 'boxed' | 'kinetic' | 'minimal' | 'comic';
export type ReframeMode = 'track' | 'blur' | 'center' | 'split';
/** A rectangle on the source video, as fractions (0..1) of its width and height. */
export interface Cam {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClipSettings {
  start: number;
  end: number;
  captions: boolean;
  captionStyle: CaptionStyleId;
  captionPos: 'bottom' | 'lower' | 'middle' | 'top';
  captionText?: string; // user-edited caption words (space separated)
  skipDonations?: boolean; // no captions for donation / alert messages (default on)
  reframe: ReframeMode;
  cam?: Cam | null; // webcam box for the split layout (webcam on top, gameplay below)
  removeSilence: boolean;
  removeFillers: boolean;
  zoom: boolean;
  sfx: boolean;
  music: 'none' | 'builtin' | string; // or path to a file
  musicVolume: number; // 0-1
  hookTitle: string;
  showHook: boolean;
  progressBar: boolean;
}

export interface PlatformKit {
  titles: string[];
  description: string;
  hashtags: string[];
  caption: string;
  postTime: string;
}

export interface Kit {
  youtube: PlatformKit;
  tiktok: PlatformKit;
  instagram?: PlatformKit; // older projects may not have it
  folder?: string;
}

export interface Clip {
  id: string;
  n: number;
  candidate: Candidate;
  settings: ClipSettings;
  status: 'pending' | 'rendering' | 'ready' | 'error';
  previewPath?: string;
  previewKey?: string; // settings snapshot the preview was made with
  exportPath?: string;
  approved: boolean;
  deleted: boolean;
  kit?: Kit;
  posted: { youtube: boolean; tiktok: boolean; instagram?: boolean };
  error?: string;
}

export interface Project {
  id: string;
  name: string;
  sourceLabel: string;
  videoPath: string;
  duration: number;
  width: number;
  height: number;
  createdAt: number;
  params: { count: number; minLen: number; maxLen: number };
  clips: Clip[];
  cam?: Cam | null; // webcam found in the source (streams): clips default to the split layout
  live?: boolean;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  outputDir: string;
  geminiKey: string;
  whisperModel: 'base.en' | 'small.en' | 'base' | 'small';
  accurateCaptions: boolean; // re-listen to the chosen clips with a bigger model
  clipCount: number;
  minLen: number;
  maxLen: number;
  defaults: ClipSettings;
  encoder: 'auto' | 'cpu';
  cookiesBrowser: 'none' | 'firefox' | 'chrome' | 'edge';
}

export interface Preset {
  name: string;
  settings: Partial<ClipSettings>;
}

export interface Progress {
  jobId: string;
  stage: string;
  pct: number; // 0-100, -1 = unknown
  message: string;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest?: string;
  url?: string;
  notes?: string;
}
