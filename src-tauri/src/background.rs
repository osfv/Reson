//! Background workers: loudness measurement for normalization, and watched-folder sync.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::library;
use crate::player::Cmd;
use crate::AppState;

/// Stored for files that can't be measured so they aren't retried (gain works out to 1.0).
const UNMEASURABLE: (f64, f64) = (-14.0, 1.0);

pub struct Loudness {
    tx: Sender<i64>,
}

impl Loudness {
    /// Measure these tracks before anything else (e.g. the queue that just started playing).
    pub fn prioritize(&self, ids: &[i64]) {
        for &id in ids.iter().take(8) {
            let _ = self.tx.send(id);
        }
    }
}

pub fn spawn_loudness(db: Arc<Db>, player: Sender<Cmd>) -> Loudness {
    let (tx, rx) = mpsc::channel::<i64>();
    thread::Builder::new()
        .name("reson-loudness".into())
        .spawn(move || loop {
            let mut batch: Vec<i64> = rx.try_iter().collect();
            if batch.is_empty() {
                batch = db.tracks_missing_loudness(20).unwrap_or_default().into_iter().map(|(id, _)| id).collect();
            }
            if batch.is_empty() {
                match rx.recv_timeout(Duration::from_secs(60)) {
                    Ok(id) => batch.push(id),
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            for id in batch {
                let Some((path, done)) = db.track_path(id) else { continue };
                if done {
                    continue;
                }
                let (lufs, peak) = library::measure_loudness(Path::new(&path)).unwrap_or(UNMEASURABLE);
                if db.set_loudness(id, lufs, peak).is_ok() {
                    let _ = player.send(Cmd::Loudness { id, lufs, peak });
                }
                // Stay out of the way of playback and the UI.
                thread::sleep(Duration::from_millis(30));
            }
        })
        .expect("spawn loudness thread");
    Loudness { tx }
}

/// Watches the user's music folders and imports changes after they settle.
pub struct Watch {
    watcher: Mutex<Option<RecommendedWatcher>>,
    tx: Sender<PathBuf>,
}

impl Watch {
    pub fn set_folders(&self, folders: &[String]) {
        let tx = self.tx.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if !event.kind.is_access() {
                    for p in event.paths {
                        let _ = tx.send(p);
                    }
                }
            }
        });
        let mut slot = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
        if let Ok(mut w) = watcher {
            for f in folders {
                let _ = w.watch(Path::new(f), RecursiveMode::Recursive);
            }
            *slot = Some(w);
        }
    }
}

/// How long the filesystem must be quiet before a sync runs (downloads write in bursts).
const SETTLE: Duration = Duration::from_secs(3);

pub fn spawn_watch(app: AppHandle) -> Watch {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    thread::Builder::new()
        .name("reson-watch".into())
        .spawn(move || {
            let mut pending: HashSet<PathBuf> = HashSet::new();
            let mut last = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(p) => {
                        pending.insert(p);
                        last = Instant::now();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                if pending.is_empty() || last.elapsed() < SETTLE {
                    continue;
                }
                let changed: Vec<PathBuf> = pending.drain().collect();
                let state = app.state::<AppState>();
                let _guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
                let existing: Vec<PathBuf> = changed.iter().filter(|p| p.exists()).cloned().collect();
                if !existing.is_empty() {
                    library::import(&app, &state.db, &state.covers_dir, existing, true);
                }
                if changed.iter().any(|p| !p.exists()) && state.db.mark_missing().unwrap_or(false) {
                    let _ = app.emit("library:changed", ());
                }
            }
        })
        .expect("spawn watch thread");
    Watch { watcher: Mutex::new(None), tx }
}
