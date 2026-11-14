# Clypper

Windows desktop app that turns long videos, links and live-stream recordings into viral 9:16 shorts, and prepares everything you need to post them yourself on YouTube Shorts and TikTok. **No uploading and no account connection.**

## Install
Download `Clypper-Setup-x.y.z.exe` from [Releases](https://github.com/Elhour-Dev/clypper/releases), run it, press **Make clips**.
The app is not code-signed, so Windows SmartScreen may warn: choose *More info → Run anyway*.
First run downloads free tools once (FFmpeg, whisper.cpp + speech model, yt-dlp, about 400 MB).

## What it does
1. Transcribes locally with word timing (whisper.cpp).
2. Finds the best moments (hooks, emotion words, audio peaks, scene changes) and shows a viral score and reason. Optional free Gemini key improves ratings and titles (only transcript text is sent).
3. Auto-edits: cuts silences and "um/uh", 9:16 with face/speaker tracking or blurred fit, zoom punch-ins on key words, six animated caption styles (incl. kinetic), sound effects, optional music with ducking, loudness normalisation to -14 LUFS, hook title, progress bar.
4. Review screen: play, trim, edit captions/style/effects, presets, approve or delete.
5. Exports 1080x1920 MP4 + `cover.jpg` + `kit.txt` in one folder per clip.
6. Posting kit per platform: 3 titles, description, hashtags, caption, best time, copy buttons, "posted" checklist.

## Develop
```bash
npm ci
npm test          # unit tests
npm run dev       # Vite + Electron
npm run dist      # builds release/Clypper-Setup-x.y.z.exe
```
For dev, put `ffmpeg`, `whisper-cli` and a model under `tools/` or let the app download them.
Headless pipeline check: `node scripts/build-main.mjs smoke && node dist-electron/smoke.js <video>`.

## Release
Push a tag `vX.Y.Z`. GitHub Actions builds on Windows and attaches **only the installer `.exe`** to the release. The app checks the latest release on startup and offers a direct download.

## Stack
Electron + React/Vite + TypeScript. FFmpeg (libass captions), whisper.cpp, yt-dlp, UltraFace ONNX (face tracking), Gemini free tier (optional).
Fonts: Poppins, Anton, Bebas Neue, Bangers (SIL OFL). Sound effects and the music pad are synthesised by FFmpeg (no copyright).

MIT licence.
