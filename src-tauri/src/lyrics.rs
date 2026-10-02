//! Lyrics lookup. Sources, in order: a `.lrc` file next to the track, lyrics embedded in the tags,
//! then LRCLIB (https://lrclib.net). LRCLIB results, including "not found", are cached in SQLite.
//! Users can also pick a different LRCLIB match, sync lyrics themselves, and publish to LRCLIB.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{now, Db};

const LRCLIB: &str = "https://lrclib.net/api";
const USER_AGENT: &str = concat!("Reson/", env!("CARGO_PKG_VERSION"), " (desktop music player)");
/// Re-ask LRCLIB about songs it didn't have after this long; the catalog grows constantly.
const RETRY_MISSING_AFTER: i64 = 3 * 24 * 3600;
/// Search results must be this close to the local file's length to count as the same recording.
const DURATION_TOLERANCE: f64 = 4.0;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// LRC text with `[mm:ss.xx]` line stamps; may contain `<mm:ss.xx>` word stamps (karaoke).
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub instrumental: bool,
    /// "file", "embedded", "lrclib", "user" or "none".
    pub source: String,
    /// User timing correction, added to playback time when matching lines.
    pub offset_ms: i64,
}

impl Lyrics {
    fn none() -> Self {
        Self { synced: None, plain: None, instrumental: false, source: "none".into(), offset_ms: 0 }
    }

    fn from_text(text: String, source: &str) -> Option<Self> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return None;
        }
        let synced = looks_synced(&text);
        Some(Self {
            plain: (!synced).then(|| text.clone()),
            synced: synced.then_some(text),
            instrumental: false,
            source: source.into(),
            offset_ms: 0,
        })
    }
}

pub struct LyricsQuery {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: i64,
    track_name: Option<String>,
    artist_name: Option<String>,
    album_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
    has_word_sync: Option<bool>,
    lyricsfile: Option<String>,
}

/// A search hit offered to the user when picking lyrics by hand.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: i64,
    track_name: String,
    artist_name: String,
    album_name: String,
    duration: f64,
    synced: bool,
    plain: bool,
    instrumental: bool,
    word_sync: bool,
    /// First couple of lines, so the user can recognize the right one.
    preview: String,
}

#[derive(Deserialize)]
struct LfDoc {
    #[serde(default)]
    lines: Vec<LfLine>,
}

#[derive(Deserialize)]
struct LfLine {
    text: Option<String>,
    start_ms: Option<i64>,
    #[serde(default)]
    words: Vec<LfWord>,
}

#[derive(Deserialize)]
struct LfWord {
    text: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
}

fn stamp(ms: i64) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}.{:02}", ms / 60_000, (ms / 1000) % 60, (ms % 1000) / 10)
}

/// Converts an LRCLIB Lyricsfile with word timings into enhanced LRC (`[line]<word>text ...`).
fn lyricsfile_to_enhanced_lrc(yaml: &str) -> Option<String> {
    let doc: LfDoc = serde_norway::from_str(yaml).ok()?;
    let mut out = String::new();
    let mut any_words = false;
    for line in doc.lines {
        let Some(start) = line.start_ms else { continue };
        out.push('[');
        out.push_str(&stamp(start));
        out.push(']');
        if line.words.iter().any(|w| w.start_ms.is_some()) {
            any_words = true;
            let mut last_end = None;
            for w in &line.words {
                if let Some(ws) = w.start_ms {
                    out.push_str(&format!("<{}>", stamp(ws)));
                }
                out.push_str(w.text.as_deref().unwrap_or(""));
                last_end = w.end_ms.or(last_end);
            }
            if let Some(end) = last_end {
                out.push_str(&format!("<{}>", stamp(end)));
            }
        } else {
            out.push_str(line.text.as_deref().unwrap_or(""));
        }
        out.push('\n');
    }
    any_words.then_some(out)
}

impl Record {
    fn into_lyrics(self) -> Lyrics {
        let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let word_synced = self
            .has_word_sync
            .unwrap_or(false)
            .then(|| self.lyricsfile.as_deref().and_then(lyricsfile_to_enhanced_lrc))
            .flatten();
        Lyrics {
            synced: word_synced.or_else(|| clean(self.synced_lyrics)),
            plain: clean(self.plain_lyrics),
            instrumental: self.instrumental.unwrap_or(false),
            source: "lrclib".into(),
            offset_ms: 0,
        }
    }

    fn into_candidate(self) -> Candidate {
        let preview_src = self.plain_lyrics.clone().unwrap_or_default();
        Candidate {
            id: self.id,
            track_name: self.track_name.unwrap_or_default(),
            artist_name: self.artist_name.unwrap_or_default(),
            album_name: self.album_name.unwrap_or_default(),
            duration: self.duration.unwrap_or(0.0),
            synced: self.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()),
            plain: self.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()),
            instrumental: self.instrumental.unwrap_or(false),
            word_sync: self.has_word_sync.unwrap_or(false),
            preview: preview_src.lines().filter(|l| !l.trim().is_empty()).take(2).collect::<Vec<_>>().join(" / "),
        }
    }
}

fn looks_synced(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_start();
        let Some(rest) = l.strip_prefix('[') else { return false };
        let (mins, rest) = rest.split_once(':').unwrap_or(("", ""));
        !mins.is_empty() && mins.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(|c: char| c.is_ascii_digit())
    })
}

fn sidecar(path: &Path) -> Option<Lyrics> {
    let bytes = fs::read(path.with_extension("lrc")).ok()?;
    Lyrics::from_text(String::from_utf8_lossy(&bytes).into_owned(), "file")
}

fn embedded(path: &Path) -> Option<Lyrics> {
    let tagged = lofty::read_from_path(path).ok()?;
    let text = tagged.tags().iter().find_map(|t| t.get_string(ItemKey::Lyrics).map(str::to_string))?;
    Lyrics::from_text(text, "embedded")
}

/// Drops "(feat. ...)", "[Remastered]" and similar decorations that often differ between sources.
fn simplify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut depth = 0;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split(" - ").next().unwrap_or(&out).trim().to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn net(e: ureq::Error) -> String {
    format!("Couldn't reach LRCLIB: {e}")
}

fn lrclib(q: &LyricsQuery) -> Result<Option<Lyrics>, String> {
    let agent = agent();

    // 1. Exact signature match.
    let mut res = agent
        .get(&format!("{LRCLIB}/get"))
        .query("track_name", &q.title)
        .query("artist_name", &q.artist)
        .query("album_name", &q.album)
        .query("duration", (q.duration.round() as i64).to_string())
        .call()
        .map_err(net)?;
    match res.status().as_u16() {
        200 => return Ok(Some(res.body_mut().read_json::<Record>().map_err(net)?.into_lyrics())),
        404 => {}
        code => return Err(format!("LRCLIB returned HTTP {code}")),
    }

    // 2. Search by title + artist (then a simplified title), keeping only recordings of the same length.
    let simple = simplify(&q.title);
    let titles = if simple != q.title && !simple.is_empty() { vec![q.title.clone(), simple] } else { vec![q.title.clone()] };
    for title in titles {
        let mut res = agent
            .get(&format!("{LRCLIB}/search"))
            .query("track_name", &title)
            .query("artist_name", &q.artist)
            .call()
            .map_err(net)?;
        if res.status().as_u16() != 200 {
            continue;
        }
        let records: Vec<Record> = res.body_mut().read_json().map_err(net)?;
        let diff = |r: &Record| r.duration.map(|d| (d - q.duration).abs()).unwrap_or(f64::MAX);
        let best = records
            .into_iter()
            .filter(|r| q.duration <= 0.0 || diff(r) <= DURATION_TOLERANCE)
            .filter(|r| r.synced_lyrics.is_some() || r.plain_lyrics.is_some() || r.instrumental == Some(true))
            .min_by(|a, b| {
                (a.synced_lyrics.is_none(), diff(a)).partial_cmp(&(b.synced_lyrics.is_none(), diff(b))).unwrap()
            });
        if let Some(r) = best {
            return Ok(Some(r.into_lyrics()));
        }
    }
    Ok(None)
}

pub fn get(db: &Db, track_id: i64, refresh: bool) -> Result<Lyrics, String> {
    let q = db.lyrics_query(track_id).map_err(|e| e.to_string())?.ok_or("Track not found")?;
    let path = Path::new(&q.path);
    let offset_ms = db.lyrics_offset(track_id);

    // Local files win and are never cached, so editing a .lrc shows up immediately.
    if let Some(l) = sidecar(path) {
        return Ok(Lyrics { offset_ms, ..l });
    }
    if !refresh {
        if let Some((cached, at)) = db.cached_lyrics(track_id) {
            if cached.source != "none" || now() - at < RETRY_MISSING_AFTER {
                return Ok(cached);
            }
        }
    }
    let found = match embedded(path) {
        Some(l) => l,
        None => lrclib(&q)?.unwrap_or_else(Lyrics::none),
    };
    let _ = db.save_lyrics(track_id, &found);
    Ok(Lyrics { offset_ms, ..found })
}

/// Free-text LRCLIB search for the manual picker.
pub fn search(query: &str) -> Result<Vec<Candidate>, String> {
    let mut res = agent().get(&format!("{LRCLIB}/search")).query("q", query).call().map_err(net)?;
    if res.status().as_u16() != 200 {
        return Err(format!("LRCLIB returned HTTP {}", res.status().as_u16()));
    }
    let records: Vec<Record> = res.body_mut().read_json().map_err(net)?;
    Ok(records.into_iter().take(25).map(Record::into_candidate).collect())
}

/// Uses a specific LRCLIB record for this track from now on.
pub fn choose(db: &Db, track_id: i64, lrclib_id: i64) -> Result<Lyrics, String> {
    let mut res = agent().get(&format!("{LRCLIB}/get/{lrclib_id}")).call().map_err(net)?;
    if res.status().as_u16() != 200 {
        return Err(format!("LRCLIB returned HTTP {}", res.status().as_u16()));
    }
    let lyrics = res.body_mut().read_json::<Record>().map_err(net)?.into_lyrics();
    db.save_lyrics(track_id, &lyrics).map_err(|e| e.to_string())?;
    Ok(Lyrics { offset_ms: db.lyrics_offset(track_id), ..lyrics })
}

/// Saves lyrics the user synced (or typed) in the app; optionally also as a `.lrc` next to the song.
pub fn save_user(db: &Db, track_id: i64, synced: Option<String>, plain: Option<String>, write_file: bool) -> Result<Lyrics, String> {
    let lyrics = Lyrics { synced, plain, instrumental: false, source: "user".into(), offset_ms: 0 };
    db.save_lyrics(track_id, &lyrics).map_err(|e| e.to_string())?;
    if write_file {
        if let (Some(text), Ok(Some(q))) = (&lyrics.synced, db.lyrics_query(track_id)) {
            fs::write(Path::new(&q.path).with_extension("lrc"), text).map_err(|e| format!("Couldn't write .lrc file: {e}"))?;
        }
    }
    Ok(Lyrics { offset_ms: db.lyrics_offset(track_id), ..lyrics })
}

#[derive(Deserialize)]
struct Challenge {
    prefix: String,
    target: String,
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok())).collect()
}

/// Finds a nonce such that sha256(prefix + nonce) <= target, using every core.
fn solve(prefix: &str, target: &[u8], progress: &(dyn Fn(u64) + Sync)) -> Option<u64> {
    let threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u64;
    let found = Arc::new(AtomicBool::new(false));
    let answer = Arc::new(AtomicU64::new(0));
    let tried = Arc::new(AtomicU64::new(0));
    thread::scope(|s| {
        for t in 0..threads {
            let (found, answer, tried) = (found.clone(), answer.clone(), tried.clone());
            s.spawn(move || {
                let base = Sha256::new_with_prefix(prefix.as_bytes());
                let mut nonce = t;
                let mut buf = itoa_buf();
                while !found.load(Ordering::Relaxed) {
                    for _ in 0..4096 {
                        let mut h = base.clone();
                        h.update(write_u64(&mut buf, nonce));
                        if h.finalize().as_slice() <= target {
                            found.store(true, Ordering::Relaxed);
                            answer.store(nonce, Ordering::Relaxed);
                            return;
                        }
                        nonce += threads;
                    }
                    tried.fetch_add(4096, Ordering::Relaxed);
                }
            });
        }
        while !found.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(250));
            progress(tried.load(Ordering::Relaxed));
        }
    });
    Some(answer.load(Ordering::Relaxed))
}

fn itoa_buf() -> [u8; 20] {
    [0; 20]
}

fn write_u64(buf: &mut [u8; 20], mut n: u64) -> &[u8] {
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return &buf[i..];
        }
    }
}

/// Publishes lyrics for this track to LRCLIB. `progress` gets (stage, hashes tried).
pub fn publish(db: &Db, track_id: i64, synced: &str, plain: &str, progress: &(dyn Fn(&str, u64) + Sync)) -> Result<(), String> {
    let q = db.lyrics_query(track_id).map_err(|e| e.to_string())?.ok_or("Track not found")?;
    let agent = agent();
    progress("challenge", 0);
    let mut res = agent.post(&format!("{LRCLIB}/request-challenge")).send_empty().map_err(net)?;
    if res.status().as_u16() != 200 {
        return Err(format!("LRCLIB returned HTTP {} for the challenge", res.status().as_u16()));
    }
    let ch: Challenge = res.body_mut().read_json().map_err(net)?;
    let target = decode_hex(&ch.target).ok_or("LRCLIB sent an invalid challenge")?;
    let nonce = solve(&ch.prefix, &target, &|n| progress("solving", n)).ok_or("Couldn't solve the challenge")?;

    progress("uploading", 0);
    let body = serde_json::json!({
        "trackName": q.title,
        "artistName": q.artist,
        "albumName": q.album,
        "duration": q.duration,
        "plainLyrics": plain,
        "syncedLyrics": synced,
    });
    let res = agent
        .post(&format!("{LRCLIB}/publish"))
        .header("X-Publish-Token", &format!("{}:{}", ch.prefix, nonce))
        .send_json(&body)
        .map_err(net)?;
    match res.status().as_u16() {
        200 | 201 => {
            progress("done", 0);
            Ok(())
        }
        code => Err(format!("LRCLIB rejected the upload (HTTP {code})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_lrc() {
        assert!(looks_synced("[00:12.34] hello\n[00:15.00] world"));
        assert!(looks_synced("[ar:Someone]\n[01:02.3]line"));
        assert!(!looks_synced("Just some words\n[Chorus]\nmore words"));
    }

    #[test]
    fn simplifies_titles() {
        assert_eq!(simplify("overseas (feat. Destroy Lonely)"), "overseas");
        assert_eq!(simplify("Song [Remastered 2011]"), "Song");
        assert_eq!(simplify("Track - Radio Edit"), "Track");
    }

    #[test]
    fn converts_word_sync() {
        let yaml = "lines:\n  - text: Hello world\n    start_ms: 1500\n    words:\n      - text: 'Hello '\n        start_ms: 1500\n      - text: world\n        start_ms: 2100\n        end_ms: 2900\n  - text: Plain line\n    start_ms: 4000\n";
        let lrc = lyricsfile_to_enhanced_lrc(yaml).unwrap();
        assert_eq!(lrc, "[00:01.50]<00:01.50>Hello <00:02.10>world<00:02.90>\n[00:04.00]Plain line\n");
    }

    #[test]
    fn solves_easy_challenge() {
        // A target with a leading 0x0f byte needs ~16 tries on average.
        let mut target = vec![0x0f];
        target.extend([0xff; 31]);
        let nonce = solve("abc", &target, &|_| {}).unwrap();
        let hash = Sha256::digest(format!("abc{nonce}").as_bytes());
        assert!(hash.as_slice() <= target.as_slice());
    }

    #[test]
    fn formats_numbers() {
        let mut b = itoa_buf();
        assert_eq!(write_u64(&mut b, 0), b"0");
        assert_eq!(write_u64(&mut b, 28363520), b"28363520");
    }
}
