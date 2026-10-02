# Reson

A desktop music player for the files you own. Rust plays the audio, React draws the interface, and the whole UI takes its colors from the album art of whatever you're listening to.

No account, no server, no streaming. Point Reson at a folder and it builds your library.

## Features

**Playback**
- Gapless playback, optional crossfade, and declicked pause, resume and seek
- Loudness normalization from ReplayGain tags, or measured on import when a file has none
- Queue with drag-to-reorder, shuffle, repeat, and play history
- Windows media overlay and hardware media keys
- Mini player that stays on top, plus a tray icon

**Library**
- Import folders or files, or drop them on the window
- Watched folders pick up new downloads on their own
- Real format detection: Reson reads the file's contents, so an AAC file named `.mp3` shows up as AAC. Song info lists bit depth, sample rate, bitrate and channels.
- Embedded or folder cover art (`cover.jpg`, `folder.jpg`)
- Move your files and Reson relinks them, keeping history, playlists and lyric timing
- Albums, artists, songs, playlists, search, and a Home screen with recent and most-played music

**Lyrics**
- Synced lyrics from a `.lrc` file next to the song, the file's own tags, or [LRCLIB](https://lrclib.net)
- Word-by-word karaoke highlighting, with depth blur on lines away from the current one
- Click a line to jump to it; nudge the timing per song if it runs early or late
- Search LRCLIB by hand when the automatic match misses
- Tap-to-sync editor for songs with plain lyrics, with optional publishing back to LRCLIB

**Look and feel**
- Album-art theming with contrast checks, so text stays readable on any cover
- Now Playing backdrop built from the cover's palette, with an optional beat pulse and spectrum bars
- Cover morph animation between the album grid and the album page
- Respects your system's reduced-motion setting

Supported formats: FLAC, ALAC, MP3, AAC/M4A, OGG Vorbis and WAV.

## Privacy

Reson only talks to the network to fetch lyrics, and only when you open the lyrics view. It sends LRCLIB the song's title, artist, album and length. Publishing lyrics is opt-in and public.

## Building from source

You need [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 20 or newer, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. Windows 10 and 11 already ship WebView2.

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # release build and installer
```

Checks:

```sh
npm run typecheck
cd src-tauri && cargo test
```

Reson is developed and tested on Windows. Tauri runs on macOS and Linux too, but nobody has tried Reson there yet.

## Stack

[Tauri 2](https://tauri.app), [rodio](https://github.com/RustAudio/rodio) and [Symphonia](https://github.com/pdeljanov/Symphonia) for decoding, [lofty](https://github.com/Serial-ATA/lofty-rs) for tags, SQLite via [rusqlite](https://github.com/rusqlite/rusqlite), and React 19, Tailwind CSS 4 and [Motion](https://motion.dev) on the front end.

## License

[MIT](LICENSE)
