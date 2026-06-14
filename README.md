# My SFX Panel

A Premiere Composer-style **sound-effects browser panel for Adobe Premiere Pro**.
Browse your own SFX library with waveform thumbnails, preview with pitch / reverb /
treble / reverse, and drop clips onto the timeline at the playhead — on whichever
audio track you've targeted. Self-updating.

![Premiere Pro 2022+](https://img.shields.io/badge/Premiere%20Pro-2022%E2%80%932026%2B-9999ff)

## Download & install

**[⬇ Download the installer](https://github.com/Slasher1v/SFX-Panel/releases/latest/download/SFX-Panel-Installer.zip)** — then:

- **macOS:** unzip → double-click `Install SFX Panel (Mac).command`
  (if blocked, right-click → Open → Open).
- **Windows:** unzip → double-click `Install SFX Panel (Windows).bat`.

Then fully quit and reopen Premiere Pro → **Window → Extensions → My SFX Panel**.

The installer copies the panel into Premiere's extensions folder and enables
unsigned extensions automatically.

## Features

- **Folder library** — point it at any folder of sound effects (`+ Add folder`); nested subfolders become a browsable tree.
- **Waveform thumbnails** for WAV / MP3 / M4A / AIFF / FLAC / OGG, virtualized so 2,000+ file folders stay fast.
- **Preview player** — stereo waveform, scrub, volume, and bake-in **Pitch**, **Reverb** (with a real tail), **Treble** (EQ), and **Reverse**.
- **Add to timeline** at the playhead on the **targeted** audio track.
- **Color tags** (macOS-style) — right-click a sound to tag it, click a tag to filter your whole library.
- **Self-updating** — a banner appears when a new version ships; your tags, favorites, and folders are preserved.

## Updates

The panel checks [`update.json`](update.json) on launch and offers a one-click update
when a newer version is published. Nothing to reinstall.

## For maintainers — cutting a release

1. Make changes in this folder.
2. Bump `version` in **`package.json`** and **`update.json`**; set `notes`.
   (If you added/removed a file, update the `files` list in `update.json`.)
3. `git push`.
4. Build the installer zip and attach it to a new GitHub Release (see below).

> A working copy containing a `.dev` marker file never auto-updates, so your dev folder is safe.

## License

Personal project — share freely.
