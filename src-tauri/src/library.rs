use std::collections::HashSet;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use lofty::config::ParseOptions;
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::mp4::{Mp4Codec, Mp4File};
use lofty::picture::PictureType;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::db::{AudioInfo, Db, TrackMeta};
use crate::palette;

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

fn collect(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths.iter().map(|p| normalize(p)) {
        let p = &p;
        if p.is_dir() {
            out.extend(
                WalkDir::new(p)
                    .follow_links(true)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_file() && has_ext(e.path(), AUDIO_EXTS))
                    .map(|e| e.into_path()),
            );
        } else if p.is_file() && has_ext(p, AUDIO_EXTS) {
            out.push(p.clone());
        }
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

/// Imports files and folders. `quiet` imports (watched-folder syncs) don't show progress and only
/// announce themselves when something was actually added.
pub fn import(app: &AppHandle, db: &Db, covers_dir: &Path, paths: Vec<PathBuf>, quiet: bool) -> usize {
    let files = collect(&paths);
    let total = files.len();
    let mut progress = ScanProgress { done: 0, total, added: 0, active: true, failed: 0, failed_names: Vec::new() };
    if !quiet {
        let _ = app.emit("library:scan", progress.clone());
    }

    let mut folder_tried: HashSet<i64> = HashSet::new();
    let mut last_emit = Instant::now();

    for file in &files {
        progress.done += 1;
        let path_str = file.to_string_lossy();
        let unchanged = db.track_mtime(&path_str).ok().flatten() == Some(mtime(file));
        if !unchanged {
            match read(file).map(|(meta, embedded)| (db.upsert_track(&meta), embedded)) {
                Some((Ok((album_id, has_cover)), embedded)) => {
                    progress.added += 1;
                    if !has_cover {
                        let bytes = embedded
                            .or_else(|| folder_tried.insert(album_id).then(|| folder_cover(file)).flatten());
                        if let Some(b) = bytes {
                            save_cover(db, covers_dir, album_id, &b);
                        }
                    }
                }
                // Never skip silently: the user should know which files didn't make it in.
                _ => {
                    progress.failed += 1;
                    if progress.failed_names.len() < 5 {
                        progress.failed_names.push(file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                    }
                }
            }
        }
        if !quiet && last_emit.elapsed() > Duration::from_millis(80) {
            let _ = app.emit("library:scan", progress.clone());
            last_emit = Instant::now();
        }
    }

    // Files moved into the imported folder: hide the old paths and fold them into the new copies.
    let _ = db.mark_missing();
    let _ = db.merge_moved();
    if let Ok(stale) = db.cleanup_albums() {
        remove_files(&stale);
    }
    progress.active = false;
    let added = progress.added;
    if !quiet || added > 0 || progress.failed > 0 {
        let _ = app.emit("library:scan", progress);
        let _ = app.emit("library:changed", ());
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
