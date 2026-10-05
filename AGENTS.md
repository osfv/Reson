# Reson

Desktop music player. Tauri 2 shell, Rust backend (`src-tauri/`), React + Vite + Tailwind v4 frontend (`src/`).

## Commands

- `npm run tauri dev`: run the app with hot reload (Rust changes rebuild and restart the app)
- `npm run tauri build`: release build + installer
- `npm run typecheck`: TypeScript check
- `npx vite build`: frontend production build only
- `cargo test` (in `src-tauri/`): Rust tests (palette, DSP/EQ, loudness, spectral check, updater signatures, db)
- `cargo check` (in `src-tauri/`): fast Rust compile check

Verify changes with `npm run typecheck` and `cargo check` at minimum; run `cargo test` when touching `palette.rs`.

## Architecture

- `src-tauri/src/player.rs`: audio engine on a dedicated thread (rodio + symphonia). Owns the queue,
  shuffle/repeat, and persists state to the `settings` table. Talks to the UI via `Cmd` messages in and
  `player:state` / `player:progress` / `player:error` events out.
- `src-tauri/src/library.rs`: folder/file import (lofty tags, embedded or folder cover art), emits
  `library:scan` and `library:changed`. Audio format is detected from file contents (`Probe::guess_file_type`,
  plus the MP4 codec to tell AAC from ALAC), not the extension. Tracks with `format IS NULL` are backfilled on
  startup; new `tracks` columns are added in `Db::open` via `AUDIO_COLUMNS`.
  Never auto-delete tracks whose files vanish: `mark_missing` hides them (`tracks.missing = 1`) and
  `upsert_track` / `merge_moved` relink a moved file to its old row by title + artist + album + duration, so
  lyrics offsets, play history and playlist entries survive. Only explicit "Remove from library" deletes.
- `src-tauri/src/lyrics.rs`: lyrics lookup via the async `lyrics_get` command. Order: sidecar `.lrc` (never
  cached) > embedded tag > LRCLIB `/api/get` (exact signature) > `/api/search` (only results within ±4 s of the
  track length). Results, including misses, are cached in the `lyrics` table; misses are retried after 3 days.
  Network requests only happen when the user opens the Lyrics view. Frontend parsing lives in `src/lib/lrc.ts`.
- `src-tauri/src/media.rs`: Windows media overlay / hardware media keys via `souvlaki`, owned by the audio
  thread (needs the main window HWND, passed from `setup`). OS events become `Cmd`s. The engine's `announce()`
  also sets the window title to the current song. Window size/position persist via `tauri-plugin-window-state`.
- Neutral (low-chroma) album accents are swapped for off-white in `paletteOf` (`src/lib/theme.ts`); toggle
  buttons show an accent dot when active so state never depends on color alone.
- ALAC playback relies on the direct `symphonia` dependency enabling the `alac` feature (rodio 0.22 doesn't
  expose it).
- `src-tauri/src/palette.rs`: k-means palette extraction from cover art. Bump `palette::VERSION` when
  changing the algorithm so cached palettes are recomputed on next launch.
- `src-tauri/src/db.rs`: SQLite (rusqlite, bundled). Data lives in the app data dir
  (`%APPDATA%/dev.reson.player/` on Windows): `library.db` and `covers/<album_id>.jpg`.
- Frontend theming: album palettes are applied as CSS custom properties (`--bg`, `--surface`, `--accent`,
  `--on-accent`) registered with `@property` in `src/index.css`, so the UI blends between albums.
  Album/artist pages scope their own palette by overriding these variables locally.
- `src-tauri/src/decode.rs`: every source the engine plays comes from `decode::open(path, format)`. rodio covers
  FLAC/MP3/AAC/ALAC/Vorbis/WAV; Opus (`opus-decoder` + Symphonia's Ogg demuxer), APE (`ape-decoder`) and WavPack
  (`wavicle`, whole-file decode, tags after the `wvpk` blocks stripped) are pure-Rust adapters. `opus-decoder`
  relies on C-style u8 shift truncation, so its dev-profile `overflow-checks`/`debug-assertions` are off in
  Cargo.toml, and each packet is decoded under `catch_unwind`. Opus decoding costs noticeably more CPU than FLAC.
- `src-tauri/src/dsp.rs` also holds the equalizer (`EqSettings`: 10 graphic bands + optional AutoEQ parametric
  profile, RBJ biquads, auto headroom for boosts). A disabled or flat EQ plans zero filters so it costs nothing and
  stays bit-perfect. The TS mirror for the response curve is `src/lib/eq.ts`; keep the formulas in sync.
- `src-tauri/src/output.rs`: shared output (rodio/cpal, any device by endpoint id) or WASAPI exclusive (`wasapi`
  0.19, which shares `windows` 0.61 with Tauri). Exclusive reopens the device whenever a track's rate/channels
  differ, so gapless preload is skipped across format changes. If the stream dies, the engine falls back to shared.
  `OutputStatus.bit_perfect` needs exclusive + volume 1.0 + no EQ + normalization gain 1.0.
- `src-tauri/src/spectral.rs`: fake-lossless check. `library::analyze` decodes once for loudness and/or the
  spectral cutoff; the background worker fills `tracks.cutoff_hz` (NULL unchecked, -1 unknown, 0 full band) and
  emits `library:analysis`. Verdict wording lives in `src/lib/quality.ts`.
- `src-tauri/src/presence.rs`: `PlayerEvent`s the engine sends to listeners: `discord.rs` and `lastfm.rs`.
- Discord and Last.fm use the user's own credentials, entered through the setup dialogs in
  `src/components/setup/` (never ship an app id or API key in the repo). Discord: `prefs.discord_app_id`; nothing
  connects until it's set; `discord_test` checks an id against the running Discord app (handshake READY returns the
  user name). Covers: iTunes Search, else the local cover uploaded to uguu.se (3 h) or Litterbox (72 h), cached in
  `albums.art_url` / `art_checked` and re-uploaded before expiry; misses retry after 15 min.
- `src-tauri/src/lastfm.rs`: key + secret live in the `lastfm_keys` setting; `lastfm_set_keys` validates them with a
  signed `auth.getToken` (error 10 = bad key, 13 = bad secret). Listens queue in `scrobbles` and flush in batches
  of 50.
- `src-tauri/src/taskbar.rs`: thumbnail toolbar (prev/play-pause/next) via `ITaskbarList3` + window subclass, all
  on the main thread; the engine calls `taskbar::update` which hops over with `run_on_main_thread`.
- `src-tauri/src/updater.rs`: own updater on `ureq` (keeps the installer small). Reads
  `releases/latest/download/latest.json` (Tauri's manifest format), verifies the installer with `minisign-verify`
  against `PUBLIC_KEY`, runs it with `/P /UPDATE /R`, and exits. `tests/fixtures/updater-fixture.txt(.sig)` proves
  the compiled key matches the release key.
- `src-tauri/src/smart.rs`: smart playlists store only their rules (JSON in `smart_playlists.rules`); `Rules::compile`
  turns them into one parameterized query re-run on every library read (and after each play via `history:changed`).
  Random sort is shuffled in Rust (`Rules::finish`, SplitMix64 per seed) because SQL arithmetic hashes only rotate
  one fixed order. Date values are the local start of the chosen day; "after" begins on the next day.
- Likes live in the `likes` table (`Library.liked`, most recent first); Statistics (the `year` route) come from `plays` via
  `Db::year_stats` (local-time years). The share card is drawn on a canvas in `src/lib/shareCard.ts`; covers come
  in through `cover_bytes` because asset-protocol images would taint the canvas.

## Conventions

- Dependencies are pinned to versions published at least 7 days before adding them. Tauri is held on
  2.11.x, and `Cargo.lock` pins its internal crates (tauri-runtime 2.11.3, tauri-runtime-wry 2.11.4,
  tauri-utils 2.9.3, tauri-macros/codegen/plugin 2.6.3) because they must move together with `tauri`.
  `@tauri-apps/api` must stay on the same minor as the `tauri` crate.
- Icons: Phosphor only. Font: Geist / Geist Mono via @fontsource.
- No em-dashes in UI copy.
- Tauri commands that create or close windows must be `async`: sync commands run on the main thread and
  deadlock WebView2 window creation on Windows (this froze all IPC once).
- The root layout grid needs an explicit `grid-cols-[minmax(0,1fr)]`. An implicit `auto` column sizes to the
  player bar's max-content (fr tracks use max-content under min-content sizing), so long unwrapped text such as
  a lyric line pushed the whole app wider than the window.
- Album cover morphs use `layoutId` only for `ui.morphAlbum` (the album being entered/left). Giving every card a
  layoutId makes all covers fly between grids on unrelated navigations. Cards inside horizontally scrolling
  rows (`AlbumRow`) pass `morph={false}`: the row clips overflow, so a cover morphing back into it disappears.
- Effects must not implicitly return values (WebView2's `scrollTo` returns a Promise, which React treats
  as a cleanup function and crashes on unmount). Always use block bodies in `useEffect`.

## Website

`website/` is the standalone marketing site (own `package.json`; Vite + React + Tailwind v4 + Motion, same pinned
versions as the app). Run `npm install` and `npm run dev` (port 4321) or `npm run build` inside `website/`. The build
uses a relative `base`, so `website/dist` can be hosted from any path (e.g. GitHub Pages under `/Reson/`). It reuses
the app's palette mechanism (`@property` CSS variables) for the cover theming demo; screenshots live in
`website/public/shots/`. The hero video lives in `website/public/video/` as AV1 WebM + H.264 MP4 + poster (title bar
cropped, 1600px wide, no audio), encoded with ffmpeg from the raw OBS clip. Scrub personal info (usernames in folder paths) from any new screenshot.

## Dev tips

- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev` exposes the
  WebView over the Chrome DevTools Protocol for screenshots and console logs.
- The repo lives under OneDrive; `src-tauri/target` gets large. Consider excluding it from sync or setting
  `CARGO_TARGET_DIR` outside OneDrive.
- Releases: bump `version` in `tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, run
  `npm run tauri build` (~10 min; NSIS + MSI land in `src-tauri/target/release/bundle/`), smoke-test
  `target/release/reson.exe`, then sign the NSIS installer with
  `npx tauri signer sign -f ~/.tauri/reson.key -p "" <setup.exe>` (the private key lives only in
  `C:\Users\fearl\.tauri\`, never in the repo), write `latest.json` (`version`, `notes`, `pub_date`,
  `platforms.windows-x86_64.{signature: contents of the .sig, url: release asset URL}`), tag `vX.Y.Z`, and
  `gh release create` with both installers, `latest.json` and the SHA-256s. Losing the key means existing installs
  can't auto-update anymore.
- `tauri-plugin-single-instance` is keyed by the app identifier, so the dev build, a release exe and an installed
  copy can't run at the same time: a second launch just focuses the first. Quit one before testing another.
  WebView2 instances sharing the user data folder also share browser args, so a CDP port only works on the
  first instance started.
