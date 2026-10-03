use std::path::PathBuf;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{History, Library, Playlist, SmartPlaylist};
use crate::library;
use crate::lyrics::{self, Candidate, Lyrics};
use crate::player::{Cmd, Repeat, Snapshot};
use crate::smart::Rules;
use crate::{AppState, Prefs};

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn get_library(state: State<AppState>) -> Res<Library> {
    state.db.library().map_err(err)
}

#[tauri::command]
pub fn import_paths(app: AppHandle, paths: Vec<String>) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let _guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
        let paths = paths.into_iter().map(PathBuf::from).collect();
        library::import(&app, &state.db, &state.covers_dir, paths, false);
    });
}

#[tauri::command]
pub fn remove_tracks(app: AppHandle, state: State<AppState>, ids: Vec<i64>) -> Res<()> {
    let covers = state.db.remove_tracks(&ids).map_err(err)?;
    library::remove_files(&covers);
    let _ = app.emit("library:changed", ());
    Ok(())
}

#[tauri::command]
pub fn playlist_create(state: State<AppState>, name: String) -> Res<Playlist> {
    state.db.playlist_create(name.trim()).map_err(err)
}

#[tauri::command]
pub fn playlist_rename(state: State<AppState>, id: i64, name: String) -> Res<()> {
    state.db.playlist_rename(id, name.trim()).map_err(err)
}

#[tauri::command]
pub fn playlist_delete(state: State<AppState>, id: i64) -> Res<()> {
    state.db.playlist_delete(id).map_err(err)
}

#[tauri::command]
pub fn playlist_set_tracks(state: State<AppState>, id: i64, track_ids: Vec<i64>) -> Res<()> {
    state.db.playlist_set_tracks(id, &track_ids).map_err(err)
}

#[tauri::command]
pub fn playlist_add_tracks(state: State<AppState>, id: i64, track_ids: Vec<i64>) -> Res<()> {
    state.db.playlist_add_tracks(id, &track_ids).map_err(err)
}

#[tauri::command]
pub fn smart_playlists_get(state: State<AppState>) -> Res<Vec<SmartPlaylist>> {
    state.db.smart_playlists().map_err(err)
}

/// Live match list for the rule editor.
#[tauri::command]
pub fn smart_preview(state: State<AppState>, rules: Rules) -> Res<Vec<i64>> {
    state.db.smart_tracks(&rules)
}

#[tauri::command]
pub fn smart_create(state: State<AppState>, name: String, rules: Rules) -> Res<SmartPlaylist> {
    state.db.smart_create(name.trim(), &rules)
}

#[tauri::command]
pub fn smart_update(state: State<AppState>, id: i64, name: String, rules: Rules) -> Res<()> {
    state.db.smart_update(id, name.trim(), &rules)
}

#[tauri::command]
pub fn smart_delete(state: State<AppState>, id: i64) -> Res<()> {
    state.db.smart_delete(id).map_err(err)
}

/// Opt-in suggestions; returns the full, re-evaluated list.
#[tauri::command]
pub fn smart_add_defaults(state: State<AppState>) -> Res<Vec<SmartPlaylist>> {
    state.db.smart_add_defaults()?;
    state.db.smart_playlists().map_err(err)
}

/// Network-bound, so it runs off the main thread.
#[tauri::command]
pub async fn lyrics_get(state: State<'_, AppState>, track_id: i64, refresh: bool) -> Res<Lyrics> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || lyrics::get(&db, track_id, refresh))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn lyrics_search(query: String) -> Res<Vec<Candidate>> {
    tauri::async_runtime::spawn_blocking(move || lyrics::search(&query)).await.map_err(err)?
}

#[tauri::command]
pub async fn lyrics_choose(state: State<'_, AppState>, track_id: i64, lrclib_id: i64) -> Res<Lyrics> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || lyrics::choose(&db, track_id, lrclib_id)).await.map_err(err)?
}

#[tauri::command]
pub fn lyrics_set_offset(state: State<AppState>, track_id: i64, offset_ms: i64) -> Res<()> {
    state.db.set_lyrics_offset(track_id, offset_ms.clamp(-30_000, 30_000)).map_err(err)
}

#[tauri::command]
pub fn lyrics_save_user(
    state: State<AppState>,
    track_id: i64,
    synced: Option<String>,
    plain: Option<String>,
    write_file: bool,
) -> Res<Lyrics> {
    lyrics::save_user(&state.db, track_id, synced, plain, write_file)
}

#[derive(Serialize, Clone)]
struct PublishProgress {
    stage: String,
    hashes: u64,
}

/// Solving LRCLIB's proof-of-work can take a while; progress arrives as `lyrics:publish` events.
#[tauri::command]
pub async fn lyrics_publish(app: AppHandle, state: State<'_, AppState>, track_id: i64, synced: String, plain: String) -> Res<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lyrics::publish(&db, track_id, &synced, &plain, &|stage, hashes| {
            let _ = app.emit("lyrics:publish", PublishProgress { stage: stage.into(), hashes });
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn history_get(state: State<AppState>) -> Res<History> {
    state.db.history().map_err(err)
}

#[tauri::command]
pub fn prefs_get(state: State<AppState>) -> Prefs {
    state.prefs.lock().map(|p| p.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn prefs_set(state: State<AppState>, prefs: Prefs) {
    let folders_changed = state.prefs.lock().map(|p| p.watch_folders != prefs.watch_folders).unwrap_or(true);
    if folders_changed {
        state.watch.set_folders(&prefs.watch_folders);
    }
    state.player.send(Cmd::Prefs(prefs.playback()));
    crate::save_prefs(&state.db, &prefs);
    if let Ok(mut p) = state.prefs.lock() {
        *p = prefs;
    }
}

#[tauri::command]
pub fn visualizer_enable(state: State<AppState>, on: bool) {
    state.analyzer.enabled.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Must be async: creating a window from a synchronous command deadlocks on Windows, because
/// sync commands run on the main thread that the new webview also needs.
#[tauri::command]
pub async fn mini_player(app: AppHandle, open: bool) -> Res<()> {
    crate::set_mini_player(&app, open).map_err(err)
}

#[tauri::command]
pub fn player_state(state: State<AppState>) -> Snapshot {
    state.player.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn player_play(state: State<AppState>, track_ids: Vec<i64>, index: usize) -> Res<()> {
    let sources = state.db.queue_sources(&track_ids).map_err(err)?;
    let start = index.min(track_ids.len().saturating_sub(1));
    state.loudness.prioritize(&track_ids[start..]);
    state.player.send(Cmd::Load { sources, index });
    Ok(())
}

#[tauri::command]
pub fn player_enqueue(state: State<AppState>, track_ids: Vec<i64>, next: bool) -> Res<()> {
    let sources = state.db.queue_sources(&track_ids).map_err(err)?;
    state.loudness.prioritize(&track_ids);
    state.player.send(Cmd::Enqueue { sources, next });
    Ok(())
}

#[tauri::command]
pub fn player_insert(state: State<AppState>, track_ids: Vec<i64>, at: usize) -> Res<()> {
    let sources = state.db.queue_sources(&track_ids).map_err(err)?;
    state.loudness.prioritize(&track_ids);
    state.player.send(Cmd::Insert { sources, at });
    Ok(())
}

#[tauri::command]
pub fn player_move(state: State<AppState>, uid: u64, to: usize) {
    state.player.send(Cmd::Move { uid, to });
}

#[tauri::command]
pub fn player_toggle(state: State<AppState>) {
    state.player.send(Cmd::Toggle);
}

#[tauri::command]
pub fn player_next(state: State<AppState>) {
    state.player.send(Cmd::Next);
}

#[tauri::command]
pub fn player_prev(state: State<AppState>) {
    state.player.send(Cmd::Prev);
}

#[tauri::command]
pub fn player_seek(state: State<AppState>, position: f64) {
    state.player.send(Cmd::Seek(position));
}

#[tauri::command]
pub fn player_set_volume(state: State<AppState>, volume: f32) {
    state.player.send(Cmd::Volume(volume));
}

#[tauri::command]
pub fn player_set_shuffle(state: State<AppState>, on: bool) {
    state.player.send(Cmd::Shuffle(on));
}

#[tauri::command]
pub fn player_set_repeat(state: State<AppState>, mode: Repeat) {
    state.player.send(Cmd::Repeat(mode));
}

#[tauri::command]
pub fn player_jump(state: State<AppState>, uid: u64) {
    state.player.send(Cmd::Jump(uid));
}

#[tauri::command]
pub fn player_remove(state: State<AppState>, uid: u64) {
    state.player.send(Cmd::Remove(uid));
}

#[tauri::command]
pub fn player_clear_upcoming(state: State<AppState>) {
    state.player.send(Cmd::ClearUpcoming);
}
