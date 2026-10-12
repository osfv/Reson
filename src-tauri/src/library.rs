use std::collections::HashSet;
use std::fs::{self, File};
use std::io::BufReader;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use lofty::config::ParseOptions;
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::mp4::{Mp4Codec, Mp4File};
use lofty::picture::PictureType;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::db::{AudioInfo, Db, TrackMeta};
use crate::{palette, AppState};

pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "ape", "wv"];
const COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "albumart"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub active: bool,
    /// Files that couldn't be read (still downloading, damaged, unsupported codec).
    pub failed: usize,
    /// Names of the first few failed files, for the import summary.
    pub failed_names: Vec<String>,
    /// Still walking the folders: `total` is the number of songs found so far.
    pub listing: bool,
}

impl ScanProgress {
    fn start() -> Self {
        Self { done: 0, total: 0, added: 0, active: true, failed: 0, failed_names: Vec::new(), listing: true }
    }

    fn record(&mut self, file: &Path, import: impl FnOnce() -> bool) {
        // A panic in a tag or image decoder must cost one file, not end the import unannounced.
        match panic::catch_unwind(AssertUnwindSafe(import)) {
            Ok(true) => self.added += 1,
            // Never skip silently: the user should know which files didn't make it in.
            _ => {
                self.failed += 1;
                if self.failed_names.len() < 5 {
                    self.failed_names.push(file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                }
            }
        }
    }
}

/// One canonical spelling per file: `C:/a//b.flac` and `C:\a\b.flac` must be the same library row.
fn normalize(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    abs.components().collect()
}

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Lists the audio files under `paths`. `found` hears the running count, since walking a large
/// network share can take minutes.
fn collect(paths: &[PathBuf], mut found: impl FnMut(usize)) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths.iter().map(|p| normalize(p)) {
        let p = &p;
        if p.is_dir() {
            for entry in WalkDir::new(p).follow_links(true) {
                if let Ok(e) = entry {
                    if e.file_type().is_file() && has_ext(e.path(), AUDIO_EXTS) {
                        out.push(e.into_path());
                    }
                }
                found(out.len());
            }
        } else if p.is_file() && has_ext(p, AUDIO_EXTS) {
            out.push(p.clone());
        }
        found(out.len());
    }
    out.sort();
    out.dedup();
    out
}

fn mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn clean(s: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Parses a file, identifying its container from the bytes rather than trusting the extension.
fn probe(path: &Path) -> Option<TaggedFile> {
    Probe::open(path)
        .ok()
        .and_then(|p| p.guess_file_type().ok())
        .and_then(|p| p.read().ok())
        .or_else(|| lofty::read_from_path(path).ok())
}

/// MP4 is a container, so the codec inside (AAC vs Apple Lossless) needs a closer look.
fn mp4_codec(path: &Path) -> Option<&'static str> {
    let mut reader = BufReader::new(File::open(path).ok()?);
    let mp4 = Mp4File::read_from(&mut reader, ParseOptions::new()).ok()?;
    Some(match mp4.properties().codec()? {
        Mp4Codec::ALAC => "ALAC",
        Mp4Codec::FLAC => "FLAC",
        Mp4Codec::MP3 => "MP3",
        _ => "AAC",
    })
}

fn audio_info(path: &Path, tagged: &TaggedFile) -> AudioInfo {
    let props = tagged.properties();
    let format = match tagged.file_type() {
        FileType::Flac => "FLAC",
        FileType::Mpeg => "MP3",
        FileType::Mp4 => mp4_codec(path).unwrap_or("AAC"),
        FileType::Aac => "AAC",
        FileType::Vorbis => "OGG",
        FileType::Opus => "Opus",
        FileType::Wav => "WAV",
        FileType::Aiff => "AIFF",
        FileType::Ape => "APE",
        FileType::WavPack => "WavPack",
        FileType::Mpc => "MPC",
        FileType::Speex => "Speex",
        _ => "Unknown",
    };
    AudioInfo {
        format: Some(format.into()),
        sample_rate: props.sample_rate(),
        bit_depth: props.bit_depth(),
        bitrate: props.audio_bitrate().or(props.overall_bitrate()).filter(|b| *b > 0),
        channels: props.channels(),
        size: fs::metadata(path).ok().map(|m| m.len() as i64),
    }
}

/// Parses ReplayGain values like "-6.54 dB" or "0.988".
fn replaygain(v: Option<&str>) -> Option<f64> {
    v?.trim().trim_end_matches(|c: char| c.is_alphabetic() || c.is_whitespace()).trim().parse().ok()
}

/// Decodes a file once and measures what's asked for: integrated loudness as (LUFS, peak), and
/// the spectral cutoff used to spot lossless files made from lossy ones.
pub fn analyze(path: &Path, format: Option<&str>, loudness: bool, cutoff: bool) -> (Option<(f64, f64)>, Option<i32>) {
    use rodio::Source;
    let Ok(source) = crate::decode::open(path, format) else { return (None, None) };
    let channels = source.channels().get() as usize;
    let rate = source.sample_rate().get();
    let mut meter = loudness.then(|| crate::dsp::LoudnessMeter::new(channels, rate));
    let mut spectrum = cutoff.then(|| crate::spectral::SpectrumAcc::new(rate));
    let (mut mono, mut ch) = (0.0f32, 0usize);
    for s in source {
        if let Some(m) = &mut meter {
            m.push(s);
        }
        if let Some(sp) = &mut spectrum {
            mono += s;
            ch += 1;
            if ch == channels {
                sp.push(mono / channels as f32);
                (mono, ch) = (0.0, 0);
            }
        }
    }
    (meter.and_then(|m| m.finish()), spectrum.and_then(|s| s.finish()))
}

/// Reads tags and returns metadata plus the embedded front cover bytes, if any.
fn read(path: &Path) -> Option<(TrackMeta, Option<Vec<u8>>)> {
    let tagged = probe(path)?;
    let duration = tagged.properties().duration().as_secs_f64();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = tag.and_then(|t| clean(t.title())).unwrap_or(stem);
    let artist = tag.and_then(|t| clean(t.artist())).unwrap_or_else(|| "Unknown Artist".into());
    let album = tag.and_then(|t| clean(t.album())).unwrap_or_else(|| "Unknown Album".into());
    let album_artist = tag
        .and_then(|t| t.get_string(ItemKey::AlbumArtist))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| artist.clone());

    let cover = tag.and_then(|t| {
        let pics = t.pictures();
        pics.iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .or_else(|| pics.first())
            .map(|p| p.data().to_vec())
    });

    let meta = TrackMeta {
        path: path.to_string_lossy().into_owned(),
        title,
        artist,
        album,
        album_artist,
        track_no: tag.and_then(|t| t.track()),
        disc_no: tag.and_then(|t| t.disk()),
        year: tag.and_then(|t| t.date()).map(|d| d.year as u32),
        duration,
        genre: tag.and_then(|t| clean(t.genre())),
        mtime: mtime(path),
        audio: audio_info(path, &tagged),
        loudness: tag.and_then(|t| replaygain(t.get_string(ItemKey::ReplayGainTrackGain))).map(|gain| -18.0 - gain),
        peak: tag.and_then(|t| replaygain(t.get_string(ItemKey::ReplayGainTrackPeak))),
    };
    Some((meta, cover))
}

fn folder_cover(track: &Path) -> Option<Vec<u8>> {
    let dir = track.parent()?;
    fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| has_ext(p, COVER_EXTS))
        .find(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| COVER_NAMES.iter().any(|n| s.to_ascii_lowercase().starts_with(n)))
        })
        .and_then(|p| fs::read(p).ok())
}

fn save_cover(db: &Db, covers_dir: &Path, album_id: i64, bytes: &[u8]) -> Option<()> {
    let img = image::load_from_memory(bytes).ok()?;
    let palette = palette::extract(&img);
    let out = covers_dir.join(format!("{album_id}.jpg"));
    img.thumbnail(640, 640).to_rgb8().save_with_format(&out, image::ImageFormat::Jpeg).ok()?;
    db.set_album_cover(album_id, &out.to_string_lossy(), &palette).ok()
}

/// Reads one file into the library, plus its album cover if the album has none yet.
fn import_file(db: &Db, covers_dir: &Path, file: &Path, folder_tried: &mut HashSet<i64>) -> bool {
    let Some((meta, embedded)) = read(file) else { return false };
    let Ok((album_id, has_cover)) = db.upsert_track(&meta) else { return false };
    if !has_cover {
        let bytes = embedded.or_else(|| folder_tried.insert(album_id).then(|| folder_cover(file)).flatten());
        if let Some(b) = bytes {
            // The track is in already; art that crashes the image decoder just stays missing.
            let _ = panic::catch_unwind(AssertUnwindSafe(|| save_cover(db, covers_dir, album_id, &b)));
        }
    }
    true
}

const EMIT_EVERY: Duration = Duration::from_millis(80);
/// How often a long import shows the songs it has added so far.
const REFRESH_EVERY: Duration = Duration::from_secs(3);

/// Imports files and folders, one import at a time. `quiet` imports (watched-folder syncs) don't
/// show progress and only announce themselves when something was actually added. If the user
/// starts an import while a quiet one runs, the quiet one shows its progress, so the user's import
/// is never stuck without feedback behind a long sync of a network share.
pub fn import(app: &AppHandle, paths: Vec<PathBuf>, quiet: bool) -> usize {
    let state = app.state::<AppState>();
    if !quiet {
        state.scan_waiting.fetch_add(1, Ordering::SeqCst);
        let _ = app.emit("library:scan", ScanProgress::start());
    }
    let _guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
    if !quiet {
        state.scan_waiting.fetch_sub(1, Ordering::SeqCst);
    }
    run(&state.db, &state.covers_dir, &state.scan_waiting, &paths, quiet, |event| match event {
        ScanEvent::Progress(progress) => {
            let _ = app.emit("library:scan", progress);
        }
        ScanEvent::Changed => {
            let _ = app.emit("library:changed", ());
        }
    })
}

enum ScanEvent {
    Progress(ScanProgress),
    Changed,
}

fn run(db: &Db, covers_dir: &Path, waiting: &AtomicUsize, paths: &[PathBuf], quiet: bool, mut notify: impl FnMut(ScanEvent)) -> usize {
    let visible = || !quiet || waiting.load(Ordering::SeqCst) > 0;
    let mut progress = ScanProgress::start();
    if visible() {
        notify(ScanEvent::Progress(progress.clone()));
    }
    let mut last_emit = Instant::now();
    let files = collect(paths, |found| {
        if visible() && last_emit.elapsed() > EMIT_EVERY {
            progress.total = found;
            notify(ScanEvent::Progress(progress.clone()));
            last_emit = Instant::now();
        }
    });
    progress.total = files.len();
    progress.listing = false;
    if visible() {
        notify(ScanEvent::Progress(progress.clone()));
    }

    let mut folder_tried: HashSet<i64> = HashSet::new();
    let (mut last_refresh, mut shown) = (Instant::now(), 0);

    for file in &files {
        progress.done += 1;
        let path_str = file.to_string_lossy();
        let unchanged = db.track_mtime(&path_str).ok().flatten() == Some(mtime(file));
        if !unchanged {
            progress.record(file, || import_file(db, covers_dir, file, &mut folder_tried));
        }
        if visible() && last_emit.elapsed() > EMIT_EVERY {
            notify(ScanEvent::Progress(progress.clone()));
            last_emit = Instant::now();
        }
        if progress.added > shown && last_refresh.elapsed() > REFRESH_EVERY {
            notify(ScanEvent::Changed);
            (last_refresh, shown) = (Instant::now(), progress.added);
        }
    }

    // Files moved into the imported folder: hide the old paths and fold them into the new copies.
    let mut changed = db.mark_missing().unwrap_or(false);
    changed |= db.merge_moved().unwrap_or(0) > 0;
    if let Ok(stale) = db.cleanup_albums() {
        remove_files(&stale);
    }
    progress.active = false;
    let added = progress.added;
    // A waiting import takes over the progress display next; this sync's summary would only confuse.
    let handoff = quiet && waiting.load(Ordering::SeqCst) > 0;
    let report = !quiet || added > 0 || progress.failed > 0;
    if report && (!handoff || progress.failed > 0) {
        notify(ScanEvent::Progress(progress));
    }
    if report || changed {
        notify(ScanEvent::Changed);
    }
    if waiting.load(Ordering::SeqCst) > 0 {
        notify(ScanEvent::Progress(ScanProgress::start()));
    }
    added
}

/// Fills in format details for tracks imported before they were recorded. Returns true if any changed.
pub fn backfill_audio_info(db: &Db) -> bool {
    let mut changed = false;
    for (id, path) in db.tracks_missing_audio_info().unwrap_or_default() {
        let p = Path::new(&path);
        if let Some(tagged) = probe(p) {
            changed |= db.set_audio_info(id, &audio_info(p, &tagged)).is_ok();
        }
    }
    changed
}

/// Recomputes cached palettes from stored covers when the extraction algorithm has changed.
/// Returns true if anything was updated.
pub fn refresh_palettes(db: &Db) -> bool {
    const KEY: &str = "palette_version";
    let current = palette::VERSION.to_string();
    if db.setting(KEY).as_deref() == Some(current.as_str()) {
        return false;
    }
    let mut changed = false;
    for (id, cover) in db.album_covers().unwrap_or_default() {
        if let Ok(img) = image::open(&cover) {
            changed |= db.set_album_cover(id, &cover, &palette::extract(&img)).is_ok();
        }
    }
    let _ = db.set_setting(KEY, &current);
    changed
}

pub fn remove_files(paths: &[String]) {
    for p in paths {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: PathBuf,
        db: Db,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("reson-import-{}-{}", std::process::id(), fastrand::u64(..)));
            fs::create_dir(&dir).unwrap();
            Self { dir, db: Db::open(Path::new(":memory:")).unwrap() }
        }

        fn wav(&self, name: &str) -> PathBuf {
            let path = self.dir.join(name);
            let mut bytes = b"RIFF".to_vec();
            bytes.extend(44u32.to_le_bytes());
            bytes.extend(b"WAVEfmt ");
            bytes.extend(16u32.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(8000u32.to_le_bytes());
            bytes.extend(8000u32.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(8u16.to_le_bytes());
            bytes.extend(b"data");
            bytes.extend(8u32.to_le_bytes());
            bytes.extend([128u8; 8]);
            fs::write(&path, bytes).unwrap();
            path
        }

        fn scan(&self, paths: &[PathBuf], quiet: bool, waiting: usize) -> (usize, Vec<ScanEvent>) {
            let mut events = Vec::new();
            let added = run(&self.db, &self.dir, &AtomicUsize::new(waiting), paths, quiet, |event| events.push(event));
            (added, events)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn collection_reports_individual_files_and_deduplicates_nested_paths() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.dir.join("nested")).unwrap();
        let song = fixture.wav("nested/song.WAV");
        fs::write(fixture.dir.join("notes.txt"), b"not audio").unwrap();
        let mut counts = Vec::new();
        let files = collect(&[song.clone()], |found| counts.push(found));
        assert_eq!(files, vec![normalize(&song)]);
        assert_eq!(counts, vec![1]);
        let files = collect(&[fixture.dir.clone(), song.clone()], |_| {});
        assert_eq!(files, vec![normalize(&song)]);
    }

    #[test]
    fn collection_reports_progress_even_without_audio_files() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.dir.join("empty")).unwrap();
        fs::write(fixture.dir.join("notes.txt"), b"not audio").unwrap();
        let mut counts = Vec::new();
        assert!(collect(&[fixture.dir.clone()], |found| counts.push(found)).is_empty());
        assert!(counts.len() >= 3);
        assert!(counts.iter().all(|count| *count == 0));
    }

    #[test]
    fn every_manual_scan_starts_with_listing_progress() {
        let fixture = Fixture::new();
        for _ in 0..2 {
            let (_, events) = fixture.scan(&[], false, 0);
            assert!(matches!(events.first(), Some(ScanEvent::Progress(p)) if p.active && p.listing));
            assert!(matches!(events.iter().rev().find(|e| matches!(e, ScanEvent::Progress(_))),
                Some(ScanEvent::Progress(p)) if !p.active));
        }
    }

    #[test]
    fn quiet_scan_reports_failures_before_handing_off() {
        let fixture = Fixture::new();
        let broken = fixture.dir.join("broken.m4a");
        fs::write(&broken, b"not an mp4 file").unwrap();
        let (_, events) = fixture.scan(&[broken], true, 1);
        assert!(events.iter().any(|event| matches!(event,
            ScanEvent::Progress(p) if !p.active && p.failed == 1 && p.failed_names == ["broken.m4a"])));
        assert!(matches!(events.last(), Some(ScanEvent::Progress(p)) if p.active && p.listing));
    }

    #[test]
    fn manual_scan_keeps_progress_visible_for_waiting_imports() {
        let fixture = Fixture::new();
        let (_, events) = fixture.scan(&[], false, 1);
        assert!(events.iter().any(|event| matches!(event, ScanEvent::Progress(p) if !p.active)));
        assert!(matches!(events.last(), Some(ScanEvent::Progress(p)) if p.active && p.listing));
    }

    #[test]
    fn imports_good_files_despite_bad_audio_and_art_then_skips_unchanged() {
        let fixture = Fixture::new();
        let song = fixture.wav("song.wav");
        fs::write(fixture.dir.join("broken.mp3"), b"not audio").unwrap();
        fs::write(fixture.dir.join("cover.jpg"), b"not an image").unwrap();
        let (added, events) = fixture.scan(&[fixture.dir.clone()], false, 0);
        assert_eq!(added, 1);
        assert!(events.iter().any(|event| matches!(event,
            ScanEvent::Progress(p) if !p.active && p.done == 2 && p.added == 1 && p.failed == 1)));
        assert_eq!(fixture.db.library().unwrap().tracks.len(), 1);
        let (added, events) = fixture.scan(&[song], true, 0);
        assert_eq!(added, 0);
        assert!(events.is_empty());
    }

    #[test]
    fn quiet_scan_refreshes_tracks_that_return_without_metadata_changes() {
        let fixture = Fixture::new();
        let song = fixture.wav("song.wav");
        fixture.scan(&[song.clone()], false, 0);
        let parked = fixture.dir.join("parked.wav");
        fs::rename(&song, &parked).unwrap();
        assert!(fixture.db.mark_missing().unwrap());
        assert!(fixture.db.library().unwrap().tracks.is_empty());
        fs::rename(&parked, &song).unwrap();
        let (added, events) = fixture.scan(&[song], true, 0);
        assert_eq!(added, 0);
        assert_eq!(fixture.db.library().unwrap().tracks.len(), 1);
        assert!(events.iter().any(|event| matches!(event, ScanEvent::Changed)));
    }

    #[test]
    fn a_decoder_panic_counts_as_one_failure_and_does_not_stop_later_files() {
        let mut progress = ScanProgress::start();
        progress.record(Path::new("broken.m4a"), || panic!("simulated decoder failure"));
        progress.record(Path::new("song.mp3"), || true);
        assert_eq!(progress.added, 1);
        assert_eq!(progress.failed, 1);
        assert_eq!(progress.failed_names, ["broken.m4a"]);
        for _ in 0..10 {
            progress.record(Path::new("bad.mp3"), || false);
        }
        assert_eq!(progress.failed, 11);
        assert_eq!(progress.failed_names.len(), 5);
    }
}
