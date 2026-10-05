use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{History, Library, Playlist, YearStats};
use crate::lyrics::{self, Candidate, Lyrics};
use crate::output::DeviceInfo;
use crate::player::{Cmd, Repeat, Snapshot};
use crate::updater::{self, UpdateInfo};
use crate::library;
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
    state.discord.enabled.store(prefs.discord, Ordering::Relaxed);
    state.discord.covers.store(prefs.discord_covers, Ordering::Relaxed);
    if let Ok(mut id) = state.discord.app_id.lock() {
        *id = prefs.discord_app_id.clone();
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

#[tauri::command]
pub fn set_liked(state: State<AppState>, track_id: i64, liked: bool) -> Res<()> {
    state.db.set_liked(track_id, liked).map_err(err)
}

#[tauri::command]
pub async fn audio_devices() -> Vec<DeviceInfo> {
    tauri::async_runtime::spawn_blocking(crate::output::devices).await.unwrap_or_default()
}

#[tauri::command]
pub fn year_stats(state: State<AppState>, year: i32) -> Res<YearStats> {
    state.db.year_stats(year).map_err(err)
}

/// Raw cover bytes, for drawing covers onto a canvas (the asset protocol would taint it).
#[tauri::command]
pub fn cover_bytes(state: State<AppState>, album_id: i64) -> Res<Response> {
    let cover = state.db.album_cover(album_id).ok_or("No cover")?;
    std::fs::read(cover).map(Response::new).map_err(err)
}

/// Asks where to save, then writes the PNG sent as the raw request body.
/// The suggested file name comes in the `x-file-name` header.
#[tauri::command]
pub async fn save_image(app: AppHandle, request: Request<'_>) -> Res<bool> {
    let InvokeBody::Raw(data) = request.body() else { return Err("Expected image bytes".into()) };
    let data = data.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .filter(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || "-_ .".contains(c)))
        .unwrap_or("Reson.png")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().add_filter("PNG image", &["png"]).set_file_name(&name).blocking_save_file() else {
            return Ok(false);
        };
        let path = path.into_path().map_err(err)?;
        std::fs::write(path, data).map_err(err)?;
        Ok(true)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn open_link(url: String) -> Res<()> {
    crate::open_url(&url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastFmStatus {
    /// The user has entered their API key and secret.
    configured: bool,
    /// Last four characters of the key in use.
    key_hint: Option<String>,
    user: Option<String>,
}

#[tauri::command]
pub fn lastfm_status(state: State<AppState>) -> LastFmStatus {
    let l = &state.lastfm;
    LastFmStatus { configured: l.configured(), key_hint: l.key_hint(), user: l.user() }
}

/// Validates the user's own API key and secret with Last.fm and stores them.
#[tauri::command]
pub async fn lastfm_set_keys(app: AppHandle, state: State<'_, AppState>, key: String, secret: String) -> Res<()> {
    let lfm = state.lastfm.clone();
    tauri::async_runtime::spawn_blocking(move || lfm.set_keys(&key, &secret)).await.map_err(err)??;
    let _ = app.emit("lastfm:changed", ());
    Ok(())
}

#[tauri::command]
pub fn lastfm_clear_keys(app: AppHandle, state: State<AppState>) {
    state.lastfm.clear_keys();
    let _ = app.emit("lastfm:changed", ());
}

/// Checks a Discord Application ID against the running Discord app. Returns the Discord user name.
#[tauri::command]
pub async fn discord_test(app_id: String) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || crate::discord::test(app_id.trim())).await.map_err(err)?
}

/// Opens Last.fm's approval page and waits (up to 3 minutes) for the user to allow Reson.
#[tauri::command]
pub async fn lastfm_connect(app: AppHandle, state: State<'_, AppState>) -> Res<Option<String>> {
    let lfm = state.lastfm.clone();
    let user = tauri::async_runtime::spawn_blocking(move || -> Res<Option<String>> {
        let (token, url) = lfm.begin_auth()?;
        crate::open_url(&url)?;
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_secs(2));
            if let Some(name) = lfm.finish_auth(&token)? {
                return Ok(Some(name));
            }
        }
        Ok(None)
    })
    .await
    .map_err(err)??;
    let _ = app.emit("lastfm:changed", ());
    Ok(user)
}

#[tauri::command]
pub fn lastfm_disconnect(app: AppHandle, state: State<AppState>) {
    state.lastfm.disconnect();
    let _ = app.emit("lastfm:changed", ());
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>) -> Res<Option<UpdateInfo>> {
    let current = app.package_info().version.to_string();
    let found = tauri::async_runtime::spawn_blocking(move || updater::check(&current)).await.map_err(err)??;
    if let Ok(mut slot) = state.update.lock() {
        *slot = found.clone();
    }
    Ok(found)
}

/// Downloads and runs the installer for the update found by the last check. Reson quits.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    let update = state.update.lock().ok().and_then(|u| u.clone()).ok_or("No update to install. Check again.")?;
    tauri::async_runtime::spawn_blocking(move || updater::install(&app, &update)).await.map_err(err)?
}
