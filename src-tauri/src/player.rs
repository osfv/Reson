//! Audio engine. Runs on its own thread, owns the output device and the play queue, and talks to
//! the UI through commands (in) and `player:*` events (out).
//!
//! Playback model: the current track lives in a [`Deck`] (one rodio `Player`). Near the end of a
//! track the next one is appended to the same `Player` so it starts sample-accurately (gapless).
//! With crossfade enabled, the next track instead gets its own deck that fades in while the old
//! one fades out. Pause, resume, seek and manual skips use short gain ramps so they never click.

use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use rodio::mixer::Mixer;
use rodio::{Player, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::autoplay;
use crate::db::{now, Db, QueueSource};
use crate::decode::{self, BoxSource};
use crate::dsp::{normalization_gain, EqCtl, EqSettings, Master, Processed, Tap, TrackCtl};
use crate::media::MediaSession;
use crate::output::{self, Output};
use crate::presence::{PlayerEvent, PresenceTrack};

const SETTINGS_KEY: &str = "player";
const TICK: Duration = Duration::from_millis(100);
/// "Previous" restarts the current track instead of going back once this far in.
const RESTART_THRESHOLD: f64 = 3.0;
/// Gapless: append the next track to the output queue this long before the current one ends.
const PRELOAD_BEFORE: f64 = 5.0;
/// Loudness target for normalization (the common streaming reference).
const TARGET_LUFS: f64 = -14.0;
const DECLICK_MS: u32 = 30;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

/// Playback preferences owned by the engine.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaybackPrefs {
    /// Seconds; 0 = gapless, no crossfade.
    pub crossfade: f32,
    pub normalize: bool,
    pub eq: EqSettings,
    /// Endpoint id; None = follow the Windows default device.
    pub output_device: Option<String>,
    /// WASAPI exclusive mode (bit-perfect when nothing else changes the signal).
    pub exclusive: bool,
    /// When the queue runs out (repeat off), keep playing similar songs from the library.
    pub autoplay: bool,
}

impl Default for PlaybackPrefs {
    fn default() -> Self {
        Self { crossfade: 0.0, normalize: true, eq: EqSettings::default(), output_device: None, exclusive: false, autoplay: true }
    }
}

/// What the output is doing, for the status line under Now Playing.
#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    pub exclusive: bool,
    pub rate: u32,
    pub bits: u16,
    /// Exclusive, 100% volume, no EQ or normalization gain, and the device is at least as deep
    /// as the file: the samples reach the DAC unchanged.
    pub bit_perfect: bool,
}

pub enum Cmd {
    Load { sources: Vec<QueueSource>, index: usize },
    Toggle,
    Play,
    Pause,
    Next,
    Prev,
    Seek(f64),
    SeekBy(f64),
    ClearUpcoming,
    Volume(f32),
    Shuffle(bool),
    Repeat(Repeat),
    Enqueue { sources: Vec<QueueSource>, next: bool },
    Insert { sources: Vec<QueueSource>, at: usize },
    Move { uid: u64, to: usize },
    Jump(u64),
    Remove(u64),
    Prefs(PlaybackPrefs),
    Loudness { id: i64, lufs: f64, peak: f64 },
}

#[derive(Clone)]
struct Item {
    uid: u64,
    src: QueueSource,
    /// Added by autoplay rather than by the user.
    auto: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    uid: u64,
    id: i64,
    auto: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    queue: Vec<QueueEntry>,
    index: Option<usize>,
    playing: bool,
    volume: f32,
    shuffle: bool,
    repeat: Repeat,
    position: f64,
    duration: f64,
    output: Option<OutputStatus>,
}

#[derive(Serialize, Clone)]
struct Progress {
    position: f64,
    duration: f64,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    ids: Vec<i64>,
    /// Pre-shuffle order as indices into `ids`.
    original: Option<Vec<usize>>,
    index: Option<usize>,
    position: f64,
    volume: f32,
    shuffle: bool,
    repeat: Repeat,
    /// Indices into `ids` that autoplay added.
    #[serde(default)]
    auto: Vec<usize>,
}

pub struct PlayerHandle {
    tx: Sender<Cmd>,
    pub snapshot: Arc<Mutex<Snapshot>>,
}

impl PlayerHandle {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }
    pub fn sender(&self) -> Sender<Cmd> {
        self.tx.clone()
    }
}

/// `hwnd` is the main window handle, needed on Windows to register with the system media overlay.
/// `listeners` get track changes and scrobbles (Discord, Last.fm).
pub fn spawn(
    app: AppHandle,
    db: Arc<Db>,
    hwnd: Option<isize>,
    tap: Arc<Tap>,
    prefs: PlaybackPrefs,
    listeners: Vec<Sender<PlayerEvent>>,
) -> PlayerHandle {
    let (tx, rx) = mpsc::channel();
    let snapshot = Arc::new(Mutex::new(Snapshot { volume: 0.8, ..Default::default() }));
    let shared = snapshot.clone();
    let media_tx = tx.clone();
    thread::Builder::new()
        .name("reson-audio".into())
        .spawn(move || {
            let mut engine = Engine::new(app, db, shared, tap, prefs);
            engine.listeners = listeners;
            engine.media = MediaSession::new(hwnd, media_tx);
            engine.restore();
            engine.publish();
            loop {
                match rx.recv_timeout(TICK) {
                    Ok(cmd) => {
                        engine.handle(cmd);
                        // Drain bursts (e.g. volume drags) before publishing once.
                        while let Ok(cmd) = rx.try_recv() {
                            engine.handle(cmd);
                        }
                        engine.publish();
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                engine.tick();
            }
            engine.save();
        })
        .expect("spawn audio thread");
    PlayerHandle { tx, snapshot }
}

struct Preloaded {
    uid: u64,
    ctl: Arc<TrackCtl>,
}

struct Deck {
    player: Player,
    ctl: Arc<TrackCtl>,
    uid: u64,
    /// Number of sources we've appended that haven't finished yet (1, or 2 with a preload).
    queued: usize,
    preloaded: Option<Preloaded>,
    /// Set when the next track couldn't be queued gaplessly (exclusive mode, different format).
    preload_tried: bool,
    /// Whether this play has been counted in the listening history yet.
    counted: bool,
    /// Unix time this track started, and whether it has been scrobbled.
    started_at: i64,
    scrobbled: bool,
}

struct Engine {
    app: AppHandle,
    db: Arc<Db>,
    shared: Arc<Mutex<Snapshot>>,
    device: Option<Output>,
    /// Exclusive mode failed for the current settings; stay on the shared mixer until they change.
    exclusive_failed: bool,
    master: Arc<Master>,
    eq: Arc<EqCtl>,
    tap: Arc<Tap>,
    listeners: Vec<Sender<PlayerEvent>>,
    /// (has a track, playing) last sent to the taskbar buttons.
    taskbar: Option<(bool, bool)>,
    /// The current track as told to Discord / Last.fm.
    presence: Option<PresenceTrack>,
    deck: Option<Deck>,
    /// Decks that are fading out (crossfade or manual skip), dropped after their deadline.
    fading: Vec<(Player, Instant)>,
    queue: Vec<Item>,
    original: Option<Vec<Item>>,
    index: Option<usize>,
    playing: bool,
    volume: f32,
    shuffle: bool,
    repeat: Repeat,
    prefs: PlaybackPrefs,
    /// Seek target for a track that is loaded but paused; applied when playback starts.
    pending_seek: Option<f64>,
    next_uid: u64,
    dirty: bool,
    last_save: Instant,
    last_progress: Instant,
    media: Option<MediaSession>,
    /// Track id whose metadata was last pushed to the OS overlay and window title.
    announced: Option<i64>,
    /// Queue item autoplay last tried to extend the queue after, so it asks the library once.
    autoplay_tried: Option<u64>,
}

impl Engine {
    fn new(app: AppHandle, db: Arc<Db>, shared: Arc<Mutex<Snapshot>>, tap: Arc<Tap>, prefs: PlaybackPrefs) -> Self {
        Self {
            app,
            db,
            shared,
            device: None,
            exclusive_failed: false,
            master: Arc::new(Master { volume: crate::dsp::AtomicF32::new(0.64) }),
            eq: EqCtl::new(prefs.eq.clone()),
            tap,
            listeners: Vec::new(),
            taskbar: None,
            presence: None,
            deck: None,
            fading: Vec::new(),
            queue: vec![],
            original: None,
            index: None,
            playing: false,
            volume: 0.8,
            shuffle: false,
            repeat: Repeat::Off,
            prefs,
            pending_seek: None,
            next_uid: 1,
            dirty: false,
            last_save: Instant::now(),
            last_progress: Instant::now(),
            media: None,
            announced: None,
            autoplay_tried: None,
        }
    }

    fn items(&mut self, sources: Vec<QueueSource>) -> Vec<Item> {
        sources
            .into_iter()
            .map(|src| {
                self.next_uid += 1;
                Item { uid: self.next_uid, src, auto: false }
            })
            .collect()
    }

    fn error(&self, msg: impl Into<String>) {
        let _ = self.app.emit("player:error", msg.into());
    }

    fn wants_exclusive(&self) -> bool {
        cfg!(windows) && self.prefs.exclusive && !self.exclusive_failed
    }

    /// The mixer to play a `rate` / `channels` source on, (re)opening the output if needed.
    /// Exclusive mode reopens the device whenever the format changes, so nothing is resampled.
    fn mixer_for(&mut self, rate: u32, channels: u16) -> Option<Mixer> {
        let exclusive = self.wants_exclusive();
        let fits = self.device.as_ref().is_some_and(|d| match d.exclusive_format() {
            Some(f) => exclusive && f == (rate, channels),
            None => !exclusive,
        });
        if !fits {
            // Anything still fading out belongs to the old output.
            self.fading.clear();
            self.device = None;
            #[cfg(windows)]
            if exclusive {
                match output::open_exclusive(self.prefs.output_device.as_deref(), rate, channels) {
                    Ok(o) => self.device = Some(o),
                    Err(e) => {
                        self.exclusive_failed = true;
                        self.error(format!("Exclusive mode isn't available: {e}. Playing through the Windows mixer instead."));
                    }
                }
            }
            if self.device.is_none() {
                match output::open_shared(self.prefs.output_device.as_deref()) {
                    Ok(o) => self.device = Some(o),
                    Err(e) => self.error(format!("No audio output available: {e}")),
                }
            }
        }
        self.device.as_ref().map(|d| d.mixer().clone())
    }

    /// Closes the output and picks up where playback was, e.g. after switching devices.
    fn reopen_output(&mut self) {
        let (pos, playing) = (self.position(), self.playing);
        self.retire_deck(0);
        self.fading.clear();
        self.device = None;
        if let Some(idx) = self.index {
            if playing {
                self.load(idx, true, pos, 40);
            } else if self.load(idx, false, 0.0, 0) {
                self.pending_seek = Some(pos);
            }
        }
    }

    fn set_volume(&mut self, v: f32) {
        self.volume = v.clamp(0.0, 1.0);
        // Perceptual curve so the slider feels linear to the ear.
        self.master.volume.set(self.volume * self.volume);
    }

    fn norm_for(&self, src: &QueueSource) -> f32 {
        if self.prefs.normalize {
            normalization_gain(src.loudness, src.peak, TARGET_LUFS)
        } else {
            1.0
        }
    }

    /// Decodes a queue item into a processed source with its own control block.
    fn open(&self, item: &Item, fade: f32) -> Result<(Processed<BoxSource>, Arc<TrackCtl>), String> {
        let decoder = decode::open(Path::new(&item.src.path), item.src.format.as_deref())?;
        let ctl = TrackCtl::new(fade, self.norm_for(&item.src));
        Ok((Processed::new(decoder, self.master.clone(), ctl.clone(), self.tap.clone(), self.eq.clone()), ctl))
    }

    /// Fades the current deck out quickly (or over `ms`) and parks it until it's silent.
    fn retire_deck(&mut self, ms: u32) {
        if let Some(deck) = self.deck.take() {
            deck.ctl.tap.store(false, std::sync::atomic::Ordering::Relaxed);
            if let Some(p) = &deck.preloaded {
                p.ctl.fade_to(0.0, ms);
            }
            if deck.player.is_paused() || ms == 0 {
                return; // dropping stops it; it's already silent
            }
            deck.ctl.fade_to(0.0, ms);
            self.fading.push((deck.player, Instant::now() + Duration::from_millis(ms as u64 + 60)));
        }
    }

    /// Opens queue[idx] onto a fresh deck. Returns false if the file can't be decoded.
    fn load(&mut self, idx: usize, play: bool, start: f64, fade_in_ms: u32) -> bool {
        self.retire_deck(DECLICK_MS);
        self.pending_seek = None;
        let item = self.queue[idx].clone();
        // Always start silent; playing tracks ramp up below, paused ones on resume.
        let (source, ctl) = match self.open(&item, 0.0) {
            Ok(s) => s,
            Err(e) => {
                self.error(format!("Couldn't play {}: {e}", item.src.path));
                return false;
            }
        };
        let Some(mixer) = self.mixer_for(source.sample_rate().get(), source.channels().get()) else { return false };
        let player = Player::connect_new(&mixer);
        if !play {
            player.pause();
        }
        player.append(source);
        if start > 0.0 {
            if play {
                let _ = player.try_seek(Duration::from_secs_f64(start));
            } else {
                self.pending_seek = Some(start);
            }
        }
        ctl.tap.store(true, std::sync::atomic::Ordering::Relaxed);
        if play {
            ctl.fade_to(1.0, fade_in_ms.max(8));
        }
        self.deck = Some(Deck {
            player,
            ctl,
            uid: item.uid,
            queued: 1,
            preloaded: None,
            preload_tried: false,
            counted: false,
            started_at: now(),
            scrobbled: false,
        });
        self.index = Some(idx);
        self.playing = play;
        true
    }

    /// Loads the track at `idx`, skipping forward past files that fail to decode.
    fn start_at(&mut self, idx: usize, play: bool) {
        let len = self.queue.len();
        for step in 0..len {
            if self.load((idx + step) % len, play, 0.0, 0) {
                return;
            }
        }
        self.stop();
    }

    fn stop(&mut self) {
        self.retire_deck(DECLICK_MS);
        self.playing = false;
        self.pending_seek = None;
        if self.queue.is_empty() {
            self.index = None;
        }
    }

    fn position(&self) -> f64 {
        self.pending_seek
            .or_else(|| self.deck.as_ref().map(|d| d.player.get_pos().as_secs_f64()))
            .unwrap_or(0.0)
    }

    fn duration(&self) -> f64 {
        self.index.and_then(|i| self.queue.get(i)).map(|i| i.src.duration).unwrap_or(0.0)
    }

    fn resume(&mut self) {
        let Some(idx) = self.index else {
            if !self.queue.is_empty() {
                self.start_at(0, true);
            }
            return;
        };
        if self.deck.is_none() {
            let start = self.pending_seek.unwrap_or(0.0);
            if !self.load(idx, true, start, 60) {
                self.start_at(idx + 1, true);
            }
            return;
        }
        if let Some(d) = &self.deck {
            d.player.play();
            if let Some(t) = self.pending_seek.take() {
                let _ = d.player.try_seek(Duration::from_secs_f64(t));
            }
            d.ctl.fade_to(1.0, 60);
        }
        self.playing = true;
    }

    fn pause(&mut self) {
        if let Some(d) = &self.deck {
            d.ctl.fade_to(0.0, DECLICK_MS);
            thread::sleep(Duration::from_millis(DECLICK_MS as u64 + 8));
            d.player.pause();
        }
        self.playing = false;
    }

    /// Where playback goes after the current track, and whether it keeps playing.
    fn next_index(&self, manual: bool) -> Option<(usize, bool)> {
        let idx = self.index?;
        let len = self.queue.len();
        if len == 0 {
            return None;
        }
        Some(if !manual && self.repeat == Repeat::One {
            (idx, true)
        } else if idx + 1 < len {
            (idx + 1, true)
        } else if self.repeat == Repeat::All {
            (0, true)
        } else {
            // End of the queue: park on the first track, paused.
            (0, false)
        })
    }

    fn advance(&mut self, manual: bool) {
        // Skipping past the last song asks again even if the library had nothing earlier.
        self.autoplay(manual);
        if let Some((idx, play)) = self.next_index(manual) {
            self.start_at(idx, play);
        }
    }

    fn previous(&mut self) {
        let Some(idx) = self.index else { return };
        if self.position() > RESTART_THRESHOLD || (idx == 0 && self.repeat != Repeat::All) {
            self.seek(0.0);
        } else {
            let prev = if idx == 0 { self.queue.len() - 1 } else { idx - 1 };
            self.start_at(prev, true);
        }
    }

    fn seek(&mut self, t: f64) {
        let t = t.clamp(0.0, self.duration().max(0.0));
        if self.deck.is_none() || !self.playing {
            self.pending_seek = Some(t);
            return;
        }
        // A seek invalidates any gapless preload, which is tied to the old end-of-track.
        if self.deck.as_ref().is_some_and(|d| d.preloaded.is_some()) {
            let idx = self.index.unwrap_or(0);
            self.load(idx, true, t, 40);
            return;
        }
        let result = self.deck.as_ref().map(|d| {
            d.ctl.fade_to(0.0, 12);
            thread::sleep(Duration::from_millis(15));
            let r = d.player.try_seek(Duration::from_secs_f64(t));
            d.ctl.fade_to(1.0, 40);
            r
        });
        if let Some(Err(e)) = result {
            self.error(format!("Seek failed: {e}"));
        }
    }

    fn set_shuffle(&mut self, on: bool) {
        if on == self.shuffle {
            return;
        }
        self.shuffle = on;
        if on {
            self.original = Some(self.queue.clone());
            let current = self.index.map(|i| self.queue.remove(i));
            fastrand::shuffle(&mut self.queue);
            if let Some(c) = current {
                self.queue.insert(0, c);
                self.index = Some(0);
            }
        } else if let Some(orig) = self.original.take() {
            let uid = self.index.map(|i| self.queue[i].uid);
            self.queue = orig;
            self.index = uid.and_then(|u| self.queue.iter().position(|i| i.uid == u));
        }
    }

    fn insert(&mut self, sources: Vec<QueueSource>, at: usize) {
        let items = self.items(sources);
        if items.is_empty() {
            return;
        }
        let was_empty = self.index.is_none();
        let at = at.min(self.queue.len());
        let current_uid = self.index.map(|i| self.queue[i].uid);
        self.queue.splice(at..at, items.clone());
        if let (Some(i), true) = (self.index, at <= self.index.unwrap_or(usize::MAX)) {
            self.index = Some(i + items.len());
        }
        if let Some(orig) = &mut self.original {
            let pos = current_uid
                .and_then(|u| orig.iter().position(|i| i.uid == u))
                .map(|p| p + 1)
                .unwrap_or(orig.len());
            orig.splice(pos..pos, items);
        }
        if was_empty {
            self.start_at(at, false);
        }
    }

    fn enqueue(&mut self, sources: Vec<QueueSource>, next: bool) {
        let after = self.index.map(|i| i + 1).unwrap_or(0);
        // "Add to queue" goes before any autoplay songs, which only fill in after what the user picked.
        let first_auto = self.queue.iter().skip(after).position(|i| i.auto).map(|p| after + p);
        let at = if next { after } else { first_auto.unwrap_or(self.queue.len()) };
        self.insert(sources, at);
    }

    /// Autoplay: while the last song plays (repeat off), adds a batch of similar songs from the
    /// library so playback carries on, gaplessly or crossfaded like any other next song.
    fn autoplay(&mut self, force: bool) {
        let Some(idx) = self.index.filter(|i| i + 1 == self.queue.len()) else { return };
        let uid = Some(self.queue[idx].uid);
        if !self.prefs.autoplay || self.repeat != Repeat::Off || (!force && self.autoplay_tried == uid) {
            return;
        }
        self.autoplay_tried = uid;
        // What the user chose steers it; once only autoplay songs are left, they do.
        let chosen: Vec<i64> = self.queue.iter().rev().filter(|i| !i.auto).take(25).map(|i| i.src.id).collect();
        let seeds = if chosen.is_empty() { self.queue.iter().rev().take(10).map(|i| i.src.id).collect() } else { chosen };
        let Ok(candidates) = self.db.autoplay_candidates() else { return };
        let mut exclude: HashSet<i64> = self.queue.iter().map(|i| i.src.id).collect();
        exclude.extend(self.db.recent_plays(50).unwrap_or_default());
        let mut ids = autoplay::pick(&seeds, &candidates, &exclude, autoplay::BATCH, fastrand::f64);
        if ids.is_empty() {
            // Everything has been played lately: allow repeats, just not the last few songs.
            let recent: HashSet<i64> = self.queue.iter().rev().take(10).map(|i| i.src.id).collect();
            ids = autoplay::pick(&seeds, &candidates, &recent, autoplay::BATCH, fastrand::f64);
        }
        let sources = self.db.queue_sources(&ids).unwrap_or_default();
        if sources.is_empty() {
            return;
        }
        let items: Vec<Item> = self.items(sources).into_iter().map(|i| Item { auto: true, ..i }).collect();
        if let Some(orig) = &mut self.original {
            orig.extend(items.iter().cloned());
        }
        self.queue.extend(items);
        self.publish();
    }

    fn move_item(&mut self, uid: u64, to: usize) {
        let Some(from) = self.queue.iter().position(|i| i.uid == uid) else { return };
        let current = self.index.map(|i| self.queue[i].uid);
        let item = self.queue.remove(from);
        // `to` is the index of the row it was dropped on (land before it), measured before removal.
        let to = if from < to { to - 1 } else { to }.min(self.queue.len());
        self.queue.insert(to, item);
        self.index = current.and_then(|u| self.queue.iter().position(|i| i.uid == u));
    }

    fn remove(&mut self, uid: u64) {
        if let Some(orig) = &mut self.original {
            orig.retain(|i| i.uid != uid);
        }
        let Some(pos) = self.queue.iter().position(|i| i.uid == uid) else { return };
        self.queue.remove(pos);
        match self.index {
            Some(cur) if cur == pos => {
                if self.queue.is_empty() {
                    self.stop();
                } else {
                    let play = self.playing;
                    self.start_at(pos.min(self.queue.len() - 1), play);
                }
            }
            Some(cur) if cur > pos => self.index = Some(cur - 1),
            _ => {}
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Load { sources, index } => {
                self.queue = self.items(sources);
                self.original = None;
                if self.queue.is_empty() {
                    self.stop();
                    return;
                }
                let index = index.min(self.queue.len() - 1);
                self.index = Some(index);
                if self.shuffle {
                    self.shuffle = false;
                    self.set_shuffle(true);
                }
                let idx = self.index.unwrap_or(0);
                self.start_at(idx, true);
            }
            Cmd::Toggle => {
                if self.playing {
                    self.pause()
                } else {
                    self.resume()
                }
            }
            Cmd::Play if !self.playing => self.resume(),
            Cmd::Pause if self.playing => self.pause(),
            Cmd::Play | Cmd::Pause => {}
            Cmd::Next => self.advance(true),
            Cmd::Prev => self.previous(),
            Cmd::Seek(t) => self.seek(t),
            Cmd::SeekBy(delta) => {
                let t = self.position() + delta;
                self.seek(t);
            }
            Cmd::ClearUpcoming => {
                let keep = self.index.map(|i| i + 1).unwrap_or(0);
                self.queue.truncate(keep);
                let kept: Vec<u64> = self.queue.iter().map(|i| i.uid).collect();
                if let Some(orig) = &mut self.original {
                    orig.retain(|i| kept.contains(&i.uid));
                }
            }
            Cmd::Volume(v) => self.set_volume(v),
            Cmd::Shuffle(on) => self.set_shuffle(on),
            Cmd::Repeat(r) => self.repeat = r,
            Cmd::Enqueue { sources, next } => self.enqueue(sources, next),
            Cmd::Insert { sources, at } => self.insert(sources, at),
            Cmd::Move { uid, to } => self.move_item(uid, to),
            Cmd::Jump(uid) => {
                if let Some(pos) = self.queue.iter().position(|i| i.uid == uid) {
                    self.start_at(pos, true);
                }
            }
            Cmd::Remove(uid) => self.remove(uid),
            Cmd::Prefs(p) => {
                let output_changed = p.output_device != self.prefs.output_device || p.exclusive != self.prefs.exclusive;
                if p.eq != self.prefs.eq {
                    self.eq.set(p.eq.clone());
                }
                self.prefs = p;
                if output_changed {
                    self.exclusive_failed = false;
                    self.reopen_output();
                }
                let current = self.index.and_then(|i| self.queue.get(i)).map(|i| i.src.clone());
                if let (Some(d), Some(src)) = (&self.deck, current) {
                    d.ctl.norm.set(self.norm_for(&src));
                }
            }
            Cmd::Loudness { id, lufs, peak } => {
                for item in self.queue.iter_mut().chain(self.original.iter_mut().flatten()) {
                    if item.src.id == id {
                        item.src.loudness = Some(lufs);
                        item.src.peak = Some(peak);
                    }
                }
            }
        }
    }

    /// Gapless: append the next track to the current player shortly before the end.
    fn maybe_preload(&mut self) {
        if self.prefs.crossfade > 0.0 || !self.playing {
            return;
        }
        let remaining = self.duration() - self.position();
        let Some(deck) = &self.deck else { return };
        if deck.preloaded.is_some() || deck.preload_tried || remaining > PRELOAD_BEFORE || self.duration() <= 0.0 {
            return;
        }
        self.autoplay(false);
        let Some((idx, true)) = self.next_index(false) else { return };
        let item = self.queue[idx].clone();
        let format = self.device.as_ref().and_then(|d| d.exclusive_format());
        if let Some(deck) = self.deck.as_mut() {
            deck.preload_tried = true;
        }
        if let Ok((source, ctl)) = self.open(&item, 1.0) {
            // Exclusive mode can't change sample rate mid-stream; that track starts fresh instead.
            if format.is_some_and(|f| f != (source.sample_rate().get(), source.channels().get())) {
                return;
            }
            let deck = self.deck.as_mut().unwrap();
            deck.player.append(source);
            deck.queued = 2;
            deck.preloaded = Some(Preloaded { uid: item.uid, ctl });
        }
    }

    /// Crossfade: start the next track on a new deck while the current one fades out.
    fn maybe_crossfade(&mut self) -> bool {
        let cf = self.prefs.crossfade as f64;
        if cf <= 0.0 || !self.playing || self.deck.is_none() {
            return false;
        }
        let (dur, pos) = (self.duration(), self.position());
        if dur < cf * 2.0 + 1.0 || dur - pos > cf || dur - pos < 0.2 {
            return false;
        }
        self.autoplay(false);
        let Some((idx, true)) = self.next_index(false) else { return false };
        let ms = (cf * 1000.0) as u32;
        if let Some(deck) = self.deck.take() {
            deck.ctl.tap.store(false, std::sync::atomic::Ordering::Relaxed);
            deck.ctl.fade_to(0.0, ms);
            self.fading.push((deck.player, Instant::now() + Duration::from_millis(ms as u64 + 500)));
        }
        if !self.load(idx, true, 0.0, ms) {
            self.advance(false);
        }
        true
    }

    fn on_source_finished(&mut self) {
        let pre = match self.deck.as_mut() {
            Some(deck) => {
                deck.queued = deck.queued.saturating_sub(1);
                if deck.queued >= 1 { deck.preloaded.take() } else { None }
            }
            None => return,
        };
        match pre {
            Some(pre) => {
                let expected = self.next_index(false).map(|(i, _)| self.queue[i].uid);
                if let Some(deck) = self.deck.as_mut() {
                    pre.ctl.tap.store(true, std::sync::atomic::Ordering::Relaxed);
                    deck.ctl = pre.ctl;
                    deck.uid = pre.uid;
                    deck.counted = false;
                    deck.preload_tried = false;
                    deck.started_at = now();
                    deck.scrobbled = false;
                }
                match self.queue.iter().position(|i| i.uid == pre.uid) {
                    // The queue still agrees with what we preloaded: seamless.
                    Some(pos) if expected == Some(pre.uid) => self.index = Some(pos),
                    // The queue changed after preloading (or the item was removed); follow it.
                    _ => self.advance(false),
                }
            }
            None => self.advance(false),
        }
        self.publish();
    }

    fn tick(&mut self) {
        let now = Instant::now();
        self.fading.retain(|(_, until)| *until > now);

        if self.device.as_ref().is_some_and(|d| !d.alive()) {
            self.exclusive_failed = true;
            self.error("Lost exclusive access to the audio device. Switched to the Windows mixer.");
            self.reopen_output();
            self.publish();
        }

        if self.playing {
            if let Some(deck) = &self.deck {
                if deck.player.len() < deck.queued {
                    self.on_source_finished();
                }
            }
            if !self.maybe_crossfade() {
                self.maybe_preload();
            } else {
                self.publish();
            }
            self.count_play();
        }
        if self.playing && self.last_progress.elapsed() >= Duration::from_millis(200) {
            let _ = self.app.emit("player:progress", Progress { position: self.position(), duration: self.duration() });
            self.last_progress = Instant::now();
        }
        let since = self.last_save.elapsed();
        if (self.dirty && since > Duration::from_secs(1)) || (self.playing && since > Duration::from_secs(5)) {
            self.save();
        }
    }

    /// Records a play once a track has been heard for 30 s or half its length, and scrobbles it
    /// by Last.fm's rule (longer than 30 s, played for half its length or 4 minutes).
    fn count_play(&mut self) {
        let duration = self.duration();
        let threshold = (duration * 0.5).min(30.0).max(1.0);
        let pos = self.position();
        let id = self.index.and_then(|i| self.queue.get(i)).map(|i| i.src.id);
        let Some(id) = id else { return };
        let mut scrobble = None;
        if let Some(deck) = &mut self.deck {
            if !deck.counted && pos >= threshold {
                deck.counted = true;
                let _ = self.db.record_play(id);
                let _ = self.app.emit("history:changed", ());
            }
            if !deck.scrobbled && duration > 30.0 && pos >= (duration * 0.5).min(240.0) {
                deck.scrobbled = true;
                scrobble = Some(deck.started_at);
            }
        }
        if let Some(started_at) = scrobble {
            if let Some(track) = self.presence_track(id) {
                self.send(PlayerEvent::Scrobble { track, started_at });
            }
        }
    }

    fn presence_track(&self, id: i64) -> Option<PresenceTrack> {
        self.db.now_playing_info(id).ok().flatten().map(|i| PresenceTrack {
            id,
            album_id: i.album_id,
            title: i.title,
            artist: i.artist,
            album: i.album,
            album_artist: i.album_artist,
            duration: i.duration,
        })
    }

    fn send(&mut self, event: PlayerEvent) {
        self.listeners.retain(|l| l.send(event.clone()).is_ok());
    }

    fn output_status(&self) -> Option<OutputStatus> {
        let d = self.device.as_ref()?;
        let (rate, _) = d.exclusive_format()?;
        let bits = d.exclusive_bits().unwrap_or(0);
        let src_bits = self.index.and_then(|i| self.queue.get(i)).and_then(|i| i.src.bit_depth).unwrap_or(16) as u16;
        let norm = self.deck.as_ref().map(|d| d.ctl.norm.get()).unwrap_or(1.0);
        let bit_perfect = self.volume >= 1.0 && norm == 1.0 && !self.eq.is_active() && bits >= src_bits;
        Some(OutputStatus { exclusive: true, rate, bits, bit_perfect })
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            queue: self.queue.iter().map(|i| QueueEntry { uid: i.uid, id: i.src.id, auto: i.auto }).collect(),
            index: self.index,
            playing: self.playing,
            volume: self.volume,
            shuffle: self.shuffle,
            repeat: self.repeat,
            position: self.position(),
            duration: self.duration(),
            output: self.output_status(),
        }
    }

    fn publish(&mut self) {
        let snap = self.snapshot();
        if let Ok(mut s) = self.shared.lock() {
            *s = snap.clone();
        }
        self.announce(&snap);
        let _ = self.app.emit("player:state", snap);
        self.dirty = true;
    }

    /// Mirrors playback into the OS media overlay, the tray tooltip and the window title.
    fn announce(&mut self, snap: &Snapshot) {
        let current = self.index.and_then(|i| self.queue.get(i)).map(|i| i.src.id);
        if current != self.announced {
            self.announced = current;
            let info = current.and_then(|id| self.db.now_playing_info(id).ok().flatten());
            if let Some(m) = &mut self.media {
                m.set_track(info.as_ref());
            }
            self.presence = current.and_then(|id| self.presence_track(id));
            let title = info.map(|i| format!("{} - {}", i.title, i.artist)).unwrap_or_else(|| "Reson".into());
            if let Some(w) = self.app.get_webview_window("main") {
                let _ = w.set_title(&title);
            }
            if let Some(tray) = self.app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(&title));
            }
        }
        if let Some(m) = &mut self.media {
            m.set_state(current.is_some(), snap.playing, snap.position);
        }
        let buttons = (current.is_some(), snap.playing);
        if self.taskbar != Some(buttons) {
            self.taskbar = Some(buttons);
            crate::taskbar::update(&self.app, buttons.0, buttons.1);
        }
        let track = self.presence.clone();
        self.send(PlayerEvent::State { track, playing: snap.playing, position: snap.position });
    }

    fn save(&mut self) {
        let original = self.original.as_ref().map(|orig| {
            orig.iter().filter_map(|o| self.queue.iter().position(|q| q.uid == o.uid)).collect()
        });
        let saved = Saved {
            ids: self.queue.iter().map(|i| i.src.id).collect(),
            original,
            index: self.index,
            position: self.position(),
            volume: self.volume,
            shuffle: self.shuffle,
            repeat: self.repeat,
            auto: self.queue.iter().enumerate().filter(|(_, i)| i.auto).map(|(p, _)| p).collect(),
        };
        if let Ok(json) = serde_json::to_string(&saved) {
            let _ = self.db.set_setting(SETTINGS_KEY, &json);
        }
        self.dirty = false;
        self.last_save = Instant::now();
    }

    fn restore(&mut self) {
        let Some(saved) = self.db.setting(SETTINGS_KEY).and_then(|s| serde_json::from_str::<Saved>(&s).ok())
        else {
            return;
        };
        self.set_volume(saved.volume);
        self.repeat = saved.repeat;
        self.shuffle = saved.shuffle;
        let sources = self.db.queue_sources(&saved.ids).unwrap_or_default();
        let complete = sources.len() == saved.ids.len();
        self.queue = self.items(sources);
        if complete {
            for &p in &saved.auto {
                if let Some(item) = self.queue.get_mut(p) {
                    item.auto = true;
                }
            }
        }
        if complete {
            self.original = saved
                .original
                .filter(|o| o.len() == self.queue.len())
                .map(|o| o.iter().filter_map(|&i| self.queue.get(i).cloned()).collect());
        }
        if self.shuffle && self.original.is_none() {
            self.original = Some(self.queue.clone());
        }
        if let Some(idx) = saved.index.filter(|&i| complete && i < self.queue.len()) {
            if self.load(idx, false, 0.0, 0) {
                self.pending_seek = Some(saved.position);
            }
        } else if !self.queue.is_empty() {
            self.start_at(0, false);
        }
    }
}
