<div align="center">

# Reson

**A desktop music player for the files you own.**

Rust plays the audio, React draws the interface, and the whole app recolors itself
from the album art of whatever you're listening to.

[![License: MIT](https://img.shields.io/badge/license-MIT-white?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)
![Rust](https://img.shields.io/badge/Rust-backend-dea584?style=flat-square&logo=rust&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white)

<img src="docs/screenshots/lyrics.png" alt="Now Playing with synced lyrics" width="860">

</div>

No account, no server, no streaming. Point Reson at a folder of FLACs or MP3s and it builds your library: covers, colors, lyrics and all.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/home.png" alt="Home screen with recent albums and most played songs"></td>
    <td width="50%"><img src="docs/screenshots/now-playing.png" alt="Now Playing themed from a pale purple cover"></td>
  </tr>
  <tr>
    <td align="center"><sub>Home: jump back in, on repeat, recently added</sub></td>
    <td align="center"><sub>Now Playing takes its colors from the cover</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/lyrics-theme.png" alt="Synced lyrics with depth blur on a purple theme"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub>Synced lyrics from LRCLIB, with karaoke fill on the current line and depth blur on the rest</sub></td>
  </tr>
</table>

## Why Reson

- **It looks like your music.** Reson pulls a palette from each cover and fades the whole interface to it, with contrast checks so text stays readable on any artwork.
- **Lyrics that keep time.** Synced lyrics arrive on their own, the current word fills as it's sung, and you can click any line to jump there.
- **It tells you what your files really are.** Reson reads the audio inside the file, so an AAC renamed to `.mp3` shows up as AAC, and a 24-bit/96 kHz FLAC says so.
- **It sounds right.** Gapless playback, optional crossfade, loudness normalization, and no clicks when you pause or seek.

## Features

<details open>
<summary><b>Playback</b></summary>

- Gapless playback and optional crossfade (0 to 12 seconds)
- Loudness normalization from ReplayGain tags, or measured in the background when a file has none
- Short fades on pause, resume and seek, so you never hear a pop
- Queue with drag-to-reorder, shuffle, repeat one or all, and play history
- Windows media overlay and hardware media keys
- Mini player that stays on top, plus a tray icon
</details>

<details open>
<summary><b>Lyrics</b></summary>

- Sources in order: a `.lrc` file next to the song, lyrics in the file's tags, then [LRCLIB](https://lrclib.net)
- Duration matching, so a remix or live version doesn't get the wrong lyrics
- Word-by-word karaoke fill and Apple-style depth blur
- Scroll freely; a "Sync lyrics" button takes you back to the current line
- Per-song timing offset when lyrics run early or late
- Manual LRCLIB search when the automatic match misses
- Tap-to-sync editor for songs with plain lyrics, with optional publishing back to LRCLIB
- Current line in the player bar while you browse
</details>

<details open>
<summary><b>Library</b></summary>

- Import folders or files, or drop them on the window
- Watched folders pick up new downloads
- Content-based format detection with bit depth, sample rate, bitrate and channels in Song info
- Embedded cover art, or `cover.jpg` / `folder.jpg` next to the files
- Move your files and Reson relinks them, keeping history, playlists and lyric timing
- Albums, artists, songs, playlists, search (`Ctrl+K`) and a Home screen
</details>

<details open>
<summary><b>Look and feel</b></summary>

- Now Playing backdrop built from the cover's palette, with an optional beat pulse and spectrum bars
- Cover morph between the album grid and the album page
- Smooth per-frame progress, so the seek bar and lyrics never step
- Respects your system's reduced-motion setting
</details>

**Formats:** FLAC, ALAC, MP3, AAC/M4A, OGG Vorbis and WAV.

## Getting started

Reson doesn't have a prebuilt installer yet, so for now you build it yourself. You need:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20 or newer
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (Windows 10 and 11 already ship WebView2)

```sh
git clone https://github.com/osfv/Reson.git
cd Reson
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # release build and installer in src-tauri/target/release/bundle
```

Then click **Add music** in the sidebar, or drag a folder onto the window.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `Ctrl` `←` / `→` | Previous / next track |
| `Alt` `←` / `→` | Back / forward |
| `Ctrl` `K` | Search |
| `L` | Toggle lyrics in Now Playing |
| `Esc` | Close Now Playing, menus and dialogs |

## Privacy

Reson only uses the network to fetch lyrics, and only for songs you open the lyrics view on (or play, if the player bar lyric is on). It sends LRCLIB the song's title, artist, album and length. Publishing lyrics is opt-in and public. Your library stays in a local SQLite database.

## Platform support

Reson is developed and tested on Windows. Tauri also runs on macOS and Linux, but nobody has tried Reson there yet. Reports and fixes are welcome.

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```sh
npm run typecheck
cd src-tauri && cargo test
```

[`AGENTS.md`](AGENTS.md) explains how the app fits together: the audio engine, library import, lyrics lookup and theming.

## Built with

[Tauri 2](https://tauri.app) · [rodio](https://github.com/RustAudio/rodio) and [Symphonia](https://github.com/pdeljanov/Symphonia) · [lofty](https://github.com/Serial-ATA/lofty-rs) · [rusqlite](https://github.com/rusqlite/rusqlite) · React 19 · Tailwind CSS 4 · [Motion](https://motion.dev) · [Phosphor Icons](https://phosphoricons.com) · lyrics from [LRCLIB](https://lrclib.net)

## License

[MIT](LICENSE)
