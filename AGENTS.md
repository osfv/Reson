# Reson

Desktop music player. Tauri 2 shell, Rust backend (`src-tauri/`), React + Vite + Tailwind v4 frontend (`src/`).

## Commands

- `npm run tauri dev`: run the app with hot reload (Rust changes rebuild and restart the app)
- `npm run tauri build`: release build + installer
- `npm run typecheck`: TypeScript check
- `npx vite build`: frontend production build only
- `cargo test` (in `src-tauri/`): Rust tests (palette contrast / neutrality)
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

## Dev tips

- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev` exposes the
  WebView over the Chrome DevTools Protocol for screenshots and console logs.
- The repo lives under OneDrive; `src-tauri/target` gets large. Consider excluding it from sync or setting
  `CARGO_TARGET_DIR` outside OneDrive.
