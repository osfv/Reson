mod analysis;
mod background;
mod commands;
mod db;
mod dsp;
mod library;
mod lyrics;
mod media;
mod palette;
mod player;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PREFS_KEY: &str = "prefs";

/// User preferences that the backend needs. UI-only preferences live in the webview's storage.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub crossfade: f32,
    pub normalize: bool,
    pub watch_folders: Vec<String>,
    pub close_to_tray: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { crossfade: 0.0, normalize: true, watch_folders: Vec::new(), close_to_tray: false }
    }
}

impl Prefs {
    pub fn playback(&self) -> player::PlaybackPrefs {
        player::PlaybackPrefs { crossfade: self.crossfade.clamp(0.0, 12.0), normalize: self.normalize }
    }
}

pub struct AppState {
    pub db: Arc<db::Db>,
    pub player: player::PlayerHandle,
    pub covers_dir: PathBuf,
    pub scan_lock: Mutex<()>,
    pub prefs: Mutex<Prefs>,
    pub analyzer: analysis::Analyzer,
    pub loudness: background::Loudness,
    pub watch: background::Watch,
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Opens or closes the compact always-on-top player. The main window hides while it's open.
pub fn set_mini_player(app: &AppHandle, open: bool) -> tauri::Result<()> {
    if open {
        if app.get_webview_window("mini").is_none() {
            WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html".into()))
                .title("Reson")
                .inner_size(380.0, 108.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .always_on_top(true)
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(20, 20, 22, 255))
                .build()?;
        } else if let Some(m) = app.get_webview_window("mini") {
            m.show()?;
            m.set_focus()?;
        }
        if let Some(w) = app.get_webview_window("main") {
            w.hide()?;
        }
    } else {
        if let Some(m) = app.get_webview_window("mini") {
            m.close()?;
        }
        show_main(app);
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Reson", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "Mini player", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &next, &prev, &sep1, &show, &mini, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main").tooltip("Reson").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            match event.id.as_ref() {
                "toggle" => state.player.send(player::Cmd::Toggle),
                "next" => state.player.send(player::Cmd::Next),
                "prev" => state.player.send(player::Cmd::Prev),
                "show" => {
                    let _ = set_mini_player(app, false);
                }
                "mini" => {
                    let _ = set_mini_player(app, true);
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = set_mini_player(tray.app_handle(), false);
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The mini player has a fixed size and should always open in its default spot.
                .with_denylist(&["mini"])
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let covers_dir = data_dir.join("covers");
            std::fs::create_dir_all(&covers_dir)?;
            let db = Arc::new(db::Db::open(&data_dir.join("library.db"))?);
            let prefs: Prefs = db.setting(PREFS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();

            // Startup maintenance: hide tracks whose files were moved or deleted since the last run
            // (kept in the database so they relink when found again), and refresh cached palettes
            // if the extraction algorithm changed.
            let handle = app.handle().clone();
            let bg_db = db.clone();
            std::thread::spawn(move || {
                let mut changed = bg_db.mark_missing().unwrap_or(false);
                changed |= bg_db.merge_moved().unwrap_or(0) > 0;
                changed |= library::refresh_palettes(&bg_db);
                changed |= library::backfill_audio_info(&bg_db);
                if changed {
                    let _ = handle.emit("library:changed", ());
                }
            });

            #[cfg(windows)]
            let hwnd = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
            #[cfg(not(windows))]
            let hwnd = None;
            let tap = dsp::Tap::new();
            let analyzer = analysis::spawn(app.handle().clone(), tap.clone());
            let player = player::spawn(app.handle().clone(), db.clone(), hwnd, tap, prefs.playback());
            let loudness = background::spawn_loudness(db.clone(), player.sender());
            let watch = background::spawn_watch(app.handle().clone());
            watch.set_folders(&prefs.watch_folders);

            // Pick up anything added to watched folders while Reson was closed.
            if !prefs.watch_folders.is_empty() {
                let handle = app.handle().clone();
                let folders: Vec<PathBuf> = prefs.watch_folders.iter().map(PathBuf::from).collect();
                std::thread::spawn(move || {
                    let state = handle.state::<AppState>();
                    let _guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
                    library::import(&handle, &state.db, &state.covers_dir, folders, true);
                });
            }

            app.manage(AppState {
                db,
                player,
                covers_dir,
                scan_lock: Mutex::new(()),
                prefs: Mutex::new(prefs),
                analyzer,
                loudness,
                watch,
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                match window.label() {
                    "main" => {
                        let to_tray = app.state::<AppState>().prefs.lock().map(|p| p.close_to_tray).unwrap_or(false);
                        if to_tray {
                            api.prevent_close();
                            let _ = window.hide();
                        } else {
                            app.exit(0);
                        }
                    }
                    "mini" => show_main(app),
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library,
            commands::import_paths,
            commands::remove_tracks,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_delete,
            commands::playlist_set_tracks,
            commands::playlist_add_tracks,
            commands::lyrics_get,
            commands::lyrics_search,
            commands::lyrics_choose,
            commands::lyrics_set_offset,
            commands::lyrics_save_user,
            commands::lyrics_publish,
            commands::history_get,
            commands::prefs_get,
            commands::prefs_set,
            commands::visualizer_enable,
            commands::mini_player,
            commands::player_state,
            commands::player_play,
            commands::player_enqueue,
            commands::player_insert,
            commands::player_move,
            commands::player_toggle,
            commands::player_next,
            commands::player_prev,
            commands::player_seek,
            commands::player_set_volume,
            commands::player_set_shuffle,
            commands::player_set_repeat,
            commands::player_jump,
            commands::player_remove,
            commands::player_clear_upcoming,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reson");
}

pub fn save_prefs(db: &db::Db, prefs: &Prefs) {
    if let Ok(json) = serde_json::to_string(prefs) {
        let _ = db.set_setting(PREFS_KEY, &json);
    }
}
