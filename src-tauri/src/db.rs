use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::lyrics::{Lyrics, LyricsQuery};
use crate::media::NowPlayingInfo;
use crate::palette::Palette;
use crate::smart::{self, Rules};

pub struct Db(Mutex<Connection>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album_id: i64,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub duration: f64,
    pub genre: Option<String>,
    pub added_at: i64,
    #[serde(flatten)]
    pub audio: AudioInfo,
    /// Spectral check of lossless files: None = not checked yet, -1 = couldn't tell, 0 = full
    /// bandwidth, otherwise the frequency (Hz) where the audio stops.
    pub cutoff_hz: Option<i32>,
}

/// What the file actually contains, detected from its bytes rather than its extension.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub format: Option<String>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    /// kbps
    pub bitrate: Option<u32>,
    pub channels: Option<u8>,
    /// bytes
    pub size: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub year: Option<u32>,
    pub cover: Option<String>,
    pub palette: Option<Palette>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub track_ids: Vec<i64>,
}

/// A rule-based playlist. `track_ids` is evaluated from the rules on every read.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartPlaylist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub rules: Rules,
    pub track_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub playlists: Vec<Playlist>,
    /// Liked track ids, most recently liked first.
    pub liked: Vec<i64>,
    pub smart_playlists: Vec<SmartPlaylist>,
}

/// Fields read from a file's tags, ready to be written to the library.
pub struct TrackMeta {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: Option<u32>,
    pub duration: f64,
    pub genre: Option<String>,
    pub mtime: i64,
    pub audio: AudioInfo,
    /// From ReplayGain tags when present (converted to LUFS); otherwise measured later.
    pub loudness: Option<f64>,
    pub peak: Option<f64>,
}

/// Columns added after the first release; created on open if missing.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("tracks", "format", "TEXT"),
    ("tracks", "sample_rate", "INTEGER"),
    ("tracks", "bit_depth", "INTEGER"),
    ("tracks", "bitrate", "INTEGER"),
    ("tracks", "channels", "INTEGER"),
    ("tracks", "size", "INTEGER"),
    ("tracks", "loudness", "REAL"),
    ("tracks", "peak", "REAL"),
    ("lyrics", "offset_ms", "INTEGER NOT NULL DEFAULT 0"),
    // Files that vanished (moved, deleted, drive unplugged). Hidden, never deleted automatically,
    // so lyrics offsets, history and playlists survive until the file is found again.
    ("tracks", "missing", "INTEGER NOT NULL DEFAULT 0"),
    ("tracks", "cutoff_hz", "INTEGER"),
    // Public artwork URL for the Discord status (looked up once per album).
    ("albums", "art_url", "TEXT"),
    ("albums", "art_checked", "INTEGER"),
];

/// Formats whose spectrum is worth checking for signs of a lossy source.
const LOSSLESS_SQL: &str = "('FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack')";

#[derive(Serialize, Deserialize, Clone)]
pub struct QueueSource {
    pub id: i64,
    pub path: String,
    pub duration: f64,
    #[serde(default)]
    pub loudness: Option<f64>,
    #[serde(default)]
    pub peak: Option<f64>,
    /// Detected format; picks the decoder.
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub bit_depth: Option<u8>,
}

/// A listen waiting to be sent to Last.fm.
pub struct PendingScrobble {
    pub id: i64,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub album_artist: String,
    pub duration: f64,
    pub played_at: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YearStats {
    pub year: i32,
    /// Years with any listening, newest first.
    pub years: Vec<i32>,
    pub plays: i64,
    pub minutes: f64,
    pub songs: i64,
    pub artists: i64,
    pub albums: i64,
    /// (track id, plays, minutes)
    pub top_tracks: Vec<(i64, i64, f64)>,
    /// (album id, plays, minutes)
    pub top_albums: Vec<(i64, i64, f64)>,
    /// (album artist, plays, minutes)
    pub top_artists: Vec<(String, i64, f64)>,
    pub top_genres: Vec<(String, i64)>,
    /// Minutes listened in each month, January first.
    pub months: Vec<f64>,
    /// ("2026-03-14", minutes)
    pub top_day: Option<(String, f64)>,
    pub longest_streak: i64,
    /// (track id, "2026-01-01")
    pub first_track: Option<(i64, String)>,
    pub liked: i64,
    pub new_songs: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// Album ids, most recently played first.
    pub recent_albums: Vec<i64>,
    /// Track ids, most recently played first (deduplicated).
    pub recent_tracks: Vec<i64>,
    /// (track id, play count) over the last 90 days, most played first.
    pub top_tracks: Vec<(i64, i64)>,
}

/// Days since 1970-01-01 for a "YYYY-MM-DD" date (proleptic Gregorian).
fn day_number(date: &str) -> Option<i64> {
    let mut it = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Longest run of consecutive days in a sorted list of dates.
fn longest_streak<'a>(dates: impl Iterator<Item = &'a str>) -> i64 {
    let (mut best, mut run, mut prev) = (0, 0, None::<i64>);
    for day in dates.filter_map(day_number) {
        run = if prev == Some(day - 1) { run + 1 } else { 1 };
        best = best.max(run);
        prev = Some(day);
    }
    best
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SCHEMA: &str = "
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  year INTEGER,
  cover TEXT,
  palette TEXT,
  UNIQUE (title, artist)
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_id INTEGER NOT NULL REFERENCES albums(id),
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL NOT NULL,
  genre TEXT,
  mtime INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_tracks_pl ON playlist_tracks(playlist_id, position);
CREATE TABLE IF NOT EXISTS lyrics (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  synced TEXT,
  plain TEXT,
  instrumental INTEGER NOT NULL,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_time ON plays(played_at);
CREATE TABLE IF NOT EXISTS likes (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  liked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scrobbles (
  id INTEGER PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  duration REAL NOT NULL,
  played_at INTEGER NOT NULL
);
-- Smart playlists store their definition (smart::Rules as JSON), never their tracks.
CREATE TABLE IF NOT EXISTS smart_playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rules TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch(SCHEMA)?;
        for (table, col, ty) in ADDED_COLUMNS {
            let exists: bool = conn.query_row(
                &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = ?"),
                [col],
                |r| r.get(0),
            )?;
            if !exists {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {ty}"))?;
            }
        }
        Ok(Self(Mutex::new(conn)))
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn library(&self) -> rusqlite::Result<Library> {
        let conn = self.conn();
        let tracks = conn
            .prepare(
                "SELECT id, path, title, artist, album_id, track_no, disc_no, duration, genre, added_at,
                   format, sample_rate, bit_depth, bitrate, channels, size, cutoff_hz
                 FROM tracks WHERE missing = 0
                 ORDER BY artist COLLATE NOCASE, album_id, disc_no, track_no, title COLLATE NOCASE",
            )?
            .query_map([], |r| {
                Ok(Track {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    title: r.get(2)?,
                    artist: r.get(3)?,
                    album_id: r.get(4)?,
                    track_no: r.get(5)?,
                    disc_no: r.get(6)?,
                    duration: r.get(7)?,
                    genre: r.get(8)?,
                    added_at: r.get(9)?,
                    audio: AudioInfo {
                        format: r.get(10)?,
                        sample_rate: r.get(11)?,
                        bit_depth: r.get(12)?,
                        bitrate: r.get(13)?,
                        channels: r.get(14)?,
                        size: r.get(15)?,
                    },
                    cutoff_hz: r.get(16)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let albums = conn
            .prepare(
                "SELECT id, title, artist, year, cover, palette FROM albums
                 WHERE id IN (SELECT album_id FROM tracks WHERE missing = 0) ORDER BY title COLLATE NOCASE",
            )?
            .query_map([], |r| {
                let palette: Option<String> = r.get(5)?;
                Ok(Album {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artist: r.get(2)?,
                    year: r.get(3)?,
                    cover: r.get(4)?,
                    palette: palette.and_then(|p| serde_json::from_str(&p).ok()),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let liked = conn
            .prepare("SELECT track_id FROM likes ORDER BY liked_at DESC, rowid DESC")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(conn);
        Ok(Library { tracks, albums, playlists: self.playlists()?, liked, smart_playlists: self.smart_playlists()? })
    }

    pub fn set_liked(&self, track_id: i64, liked: bool) -> rusqlite::Result<()> {
        let conn = self.conn();
        if liked {
            conn.execute("INSERT OR IGNORE INTO likes (track_id, liked_at) VALUES (?1, ?2)", params![track_id, now()])?;
        } else {
            conn.execute("DELETE FROM likes WHERE track_id = ?", [track_id])?;
        }
        Ok(())
    }

    /// Lossless tracks whose spectrum hasn't been checked yet, newest first.
    pub fn tracks_missing_cutoff(&self, limit: usize) -> rusqlite::Result<Vec<i64>> {
        self.conn()
            .prepare(&format!(
                "SELECT id FROM tracks WHERE cutoff_hz IS NULL AND missing = 0 AND format IN {LOSSLESS_SQL}
                 ORDER BY added_at DESC LIMIT ?"
            ))?
            .query_map([limit as i64], |r| r.get(0))?
            .collect()
    }

    /// (path, format, needs loudness, needs a spectral check)
    pub fn analysis_job(&self, id: i64) -> Option<(String, Option<String>, bool, bool)> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT path, format, loudness IS NULL, cutoff_hz IS NULL AND format IN {LOSSLESS_SQL}
                     FROM tracks WHERE id = ?"
                ),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_cutoff(&self, id: i64, cutoff_hz: i32) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE tracks SET cutoff_hz = ?1 WHERE id = ?2", params![cutoff_hz, id])?;
        Ok(())
    }

    pub fn album_cover(&self, album_id: i64) -> Option<String> {
        self.conn().query_row("SELECT cover FROM albums WHERE id = ?", [album_id], |r| r.get(0)).ok().flatten()
    }

    /// The cached public artwork URL for an album, and when it was looked up (None = never).
    pub fn album_art_url(&self, album_id: i64) -> (Option<String>, Option<i64>) {
        self.conn()
            .query_row("SELECT art_url, art_checked FROM albums WHERE id = ?", [album_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((None, None))
    }

    pub fn set_album_art_url(&self, album_id: i64, url: Option<&str>) -> rusqlite::Result<()> {
        self.conn()
            .execute("UPDATE albums SET art_url = ?1, art_checked = ?2 WHERE id = ?3", params![url, now(), album_id])?;
        Ok(())
    }

    pub fn queue_scrobble(&self, s: &PendingScrobble) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO scrobbles (artist, title, album, album_artist, duration, played_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.artist, s.title, s.album, s.album_artist, s.duration, s.played_at],
        )?;
        Ok(())
    }

    /// Oldest first; Last.fm takes up to 50 per request.
    pub fn pending_scrobbles(&self, limit: usize) -> rusqlite::Result<Vec<PendingScrobble>> {
        self.conn()
            .prepare("SELECT id, artist, title, album, album_artist, duration, played_at FROM scrobbles ORDER BY played_at LIMIT ?")?
            .query_map([limit as i64], |r| {
                Ok(PendingScrobble {
                    id: r.get(0)?,
                    artist: r.get(1)?,
                    title: r.get(2)?,
                    album: r.get(3)?,
                    album_artist: r.get(4)?,
                    duration: r.get(5)?,
                    played_at: r.get(6)?,
                })
            })?
            .collect()
    }

    pub fn remove_scrobbles(&self, ids: &[i64]) -> rusqlite::Result<()> {
        let conn = self.conn();
        let mut stmt = conn.prepare("DELETE FROM scrobbles WHERE id = ?")?;
        for id in ids {
            stmt.execute([id])?;
        }
        Ok(())
    }

    /// Listening stats for one calendar year (local time).
    pub fn year_stats(&self, year: i32) -> rusqlite::Result<YearStats> {
        let conn = self.conn();
        let y = year.to_string();
        // Every play joined with what was played, limited to the year.
        let base = "FROM plays p JOIN tracks t ON t.id = p.track_id JOIN albums a ON a.id = t.album_id
                    WHERE strftime('%Y', p.played_at, 'unixepoch', 'localtime') = ?1";
        let years = conn
            .prepare(
                "SELECT DISTINCT CAST(strftime('%Y', played_at, 'unixepoch', 'localtime') AS INTEGER) AS y
                 FROM plays ORDER BY y DESC",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<i32>>>()?;
        let (plays, minutes, songs, artists, albums): (i64, f64, i64, i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(t.duration), 0) / 60.0, COUNT(DISTINCT t.id),
                   COUNT(DISTINCT a.artist), COUNT(DISTINCT a.id) {base}"
            ),
            [&y],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let top_tracks = conn
            .prepare(&format!(
                "SELECT t.id, COUNT(*) AS n, SUM(t.duration) / 60.0 {base} GROUP BY t.id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT 10"
            ))?
            .query_map([&y], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let top_albums = conn
            .prepare(&format!(
                "SELECT a.id, COUNT(*) AS n, SUM(t.duration) / 60.0 AS m {base} GROUP BY a.id ORDER BY m DESC LIMIT 6"
            ))?
            .query_map([&y], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let top_artists = conn
            .prepare(&format!(
                "SELECT a.artist, COUNT(*) AS n, SUM(t.duration) / 60.0 AS m {base} GROUP BY a.artist ORDER BY m DESC LIMIT 6"
            ))?
            .query_map([&y], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let top_genres = conn
            .prepare(&format!(
                "SELECT t.genre, COUNT(*) AS n {base} AND t.genre IS NOT NULL AND t.genre != '' GROUP BY t.genre COLLATE NOCASE
                 ORDER BY n DESC LIMIT 5"
            ))?
            .query_map([&y], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut months = vec![0.0; 12];
        let mut stmt = conn.prepare(&format!(
            "SELECT CAST(strftime('%m', p.played_at, 'unixepoch', 'localtime') AS INTEGER), SUM(t.duration) / 60.0 {base} GROUP BY 1"
        ))?;
        for row in stmt.query_map([&y], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)))? {
            let (m, mins) = row?;
            if (1..=12).contains(&m) {
                months[m as usize - 1] = mins;
            }
        }
        let days: Vec<(String, f64)> = conn
            .prepare(&format!(
                "SELECT date(p.played_at, 'unixepoch', 'localtime') AS d, SUM(t.duration) / 60.0 {base} GROUP BY d ORDER BY d"
            ))?
            .query_map([&y], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let top_day = days.iter().cloned().max_by(|a, b| a.1.total_cmp(&b.1));
        let longest_streak = longest_streak(days.iter().map(|(d, _)| d.as_str()));
        let first_track = conn
            .query_row(
                &format!("SELECT t.id, date(p.played_at, 'unixepoch', 'localtime') {base} ORDER BY p.played_at LIMIT 1"),
                [&y],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let liked = conn.query_row(
            "SELECT COUNT(*) FROM likes WHERE strftime('%Y', liked_at, 'unixepoch', 'localtime') = ?1",
            [&y],
            |r| r.get(0),
        )?;
        let new_songs = conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE missing = 0 AND strftime('%Y', added_at, 'unixepoch', 'localtime') = ?1",
            [&y],
            |r| r.get(0),
        )?;
        Ok(YearStats {
            year,
            years,
            plays,
            minutes,
            songs,
            artists,
            albums,
            top_tracks,
            top_albums,
            top_artists,
            top_genres,
            months,
            top_day,
            longest_streak,
            first_track,
            liked,
            new_songs,
        })
    }

    pub fn playlists(&self) -> rusqlite::Result<Vec<Playlist>> {
        let conn = self.conn();
        let mut playlists = conn
            .prepare("SELECT id, name, created_at FROM playlists ORDER BY created_at, id")?
            .query_map([], |r| {
                Ok(Playlist { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, track_ids: vec![] })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = conn.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position")?;
        for p in &mut playlists {
            p.track_ids = stmt.query_map([p.id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        }
        Ok(playlists)
    }

    /// Track ids matching `rules`, in playlist order.
    pub fn smart_tracks(&self, rules: &Rules) -> Result<Vec<i64>, String> {
        let (sql, params) = rules.compile(now())?;
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(rusqlite::params_from_iter(params), |r| r.get(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<_>>())
            .map_err(|e| e.to_string())?;
        Ok(rules.finish(ids))
    }

    /// All smart playlists with their current tracks. Definitions this version can't read (e.g. written
    /// by a newer Reson) are skipped rather than failing the whole library.
    pub fn smart_playlists(&self) -> rusqlite::Result<Vec<SmartPlaylist>> {
        let rows: Vec<(i64, String, String, i64)> = self
            .conn()
            .prepare("SELECT id, name, rules, created_at FROM smart_playlists ORDER BY created_at, id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, name, json, created_at)| {
                let rules: Rules = serde_json::from_str(&json).ok()?;
                let track_ids = self.smart_tracks(&rules).unwrap_or_default();
                Some(SmartPlaylist { id, name, created_at, rules, track_ids })
            })
            .collect())
    }

    pub fn smart_create(&self, name: &str, rules: &Rules) -> Result<SmartPlaylist, String> {
        rules.validate()?;
        let json = serde_json::to_string(rules).map_err(|e| e.to_string())?;
        let created_at = now();
        let id = {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO smart_playlists (name, rules, created_at) VALUES (?1, ?2, ?3)",
                params![name, json, created_at],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        };
        let track_ids = self.smart_tracks(rules)?;
        Ok(SmartPlaylist { id, name: name.into(), created_at, rules: rules.clone(), track_ids })
    }

    pub fn smart_update(&self, id: i64, name: &str, rules: &Rules) -> Result<(), String> {
        rules.validate()?;
        let json = serde_json::to_string(rules).map_err(|e| e.to_string())?;
        self.conn()
            .execute("UPDATE smart_playlists SET name = ?1, rules = ?2 WHERE id = ?3", params![name, json, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn smart_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM smart_playlists WHERE id = ?", [id])?;
        Ok(())
    }

    /// Adds the suggested smart playlists the user doesn't already have (matched by name).
    pub fn smart_add_defaults(&self) -> Result<usize, String> {
        let existing: Vec<String> = self
            .conn()
            .prepare("SELECT name FROM smart_playlists")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())?;
        let mut added = 0;
        for (name, rules) in smart::defaults() {
            if !existing.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                self.smart_create(name, &rules)?;
                added += 1;
            }
        }
        Ok(added)
    }

    /// Returns the stored mtime for a fully-scanned path, used to skip unchanged files on re-import.
    pub fn track_mtime(&self, path: &str) -> rusqlite::Result<Option<i64>> {
        self.conn()
            .query_row("SELECT mtime FROM tracks WHERE path = ? AND format IS NOT NULL", [path], |r| r.get(0))
            .optional()
    }

    /// Tracks imported before format detection existed.
    pub fn tracks_missing_audio_info(&self) -> rusqlite::Result<Vec<(i64, String)>> {
        self.conn()
            .prepare("SELECT id, path FROM tracks WHERE format IS NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }

    pub fn set_audio_info(&self, id: i64, a: &AudioInfo) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE tracks SET format = ?1, sample_rate = ?2, bit_depth = ?3, bitrate = ?4, channels = ?5, size = ?6
             WHERE id = ?7",
            params![a.format, a.sample_rate, a.bit_depth, a.bitrate, a.channels, a.size, id],
        )?;
        Ok(())
    }

    /// Inserts or updates a track and its album. Returns (album_id, album_has_cover).
    pub fn upsert_track(&self, m: &TrackMeta) -> rusqlite::Result<(i64, bool)> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO albums (title, artist, year) VALUES (?1, ?2, ?3)",
            params![m.album, m.album_artist, m.year],
        )?;
        let (album_id, cover): (i64, Option<String>) = tx.query_row(
            "SELECT id, cover FROM albums WHERE title = ?1 AND artist = ?2",
            params![m.album, m.album_artist],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if m.year.is_some() {
            tx.execute("UPDATE albums SET year = ?1 WHERE id = ?2 AND year IS NULL", params![m.year, album_id])?;
        }
        // A file we've never seen at this path may be a missing track that was moved. Re-point the
        // old row instead of adding a new one, so its lyrics offset, history and playlists carry over.
        let known: bool = tx.query_row("SELECT COUNT(*) > 0 FROM tracks WHERE path = ?", [&m.path], |r| r.get(0))?;
        if !known {
            let moved: Option<i64> = tx
                .query_row(
                    "SELECT id FROM tracks WHERE missing = 1 AND title = ?1 AND artist = ?2 AND album_id = ?3
                       AND abs(duration - ?4) < 1.5 LIMIT 1",
                    params![m.title, m.artist, album_id, m.duration],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = moved {
                tx.execute("UPDATE tracks SET path = ?1, missing = 0 WHERE id = ?2", params![m.path, id])?;
            }
        }
        tx.execute(
            "INSERT INTO tracks (path, title, artist, album_id, track_no, disc_no, duration, genre, mtime, added_at,
               format, sample_rate, bit_depth, bitrate, channels, size, loudness, peak)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(path) DO UPDATE SET title = excluded.title, artist = excluded.artist,
               album_id = excluded.album_id, track_no = excluded.track_no, disc_no = excluded.disc_no,
               duration = excluded.duration, genre = excluded.genre, mtime = excluded.mtime,
               format = excluded.format, sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth,
               bitrate = excluded.bitrate, channels = excluded.channels, size = excluded.size,
               loudness = excluded.loudness, peak = excluded.peak, missing = 0",
            params![
                m.path, m.title, m.artist, album_id, m.track_no, m.disc_no, m.duration, m.genre, m.mtime,
                now(), m.audio.format, m.audio.sample_rate, m.audio.bit_depth, m.audio.bitrate,
                m.audio.channels, m.audio.size, m.loudness, m.peak
            ],
        )?;
        tx.commit()?;
        Ok((album_id, cover.is_some()))
    }

    pub fn album_covers(&self) -> rusqlite::Result<Vec<(i64, String)>> {
        self.conn()
            .prepare("SELECT id, cover FROM albums WHERE cover IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }

    pub fn set_album_cover(&self, album_id: i64, cover: &str, palette: &Palette) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE albums SET cover = ?1, palette = ?2 WHERE id = ?3",
            params![cover, serde_json::to_string(palette).ok(), album_id],
        )?;
        Ok(())
    }

    /// Removes tracks and any albums left empty. Returns cover files that are no longer referenced.
    pub fn remove_tracks(&self, ids: &[i64]) -> rusqlite::Result<Vec<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM tracks WHERE id = ?")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        let covers = cleanup_albums(&tx)?;
        tx.commit()?;
        Ok(covers)
    }

    /// Deletes albums with no tracks left (e.g. after re-tagging). Returns their cover files.
    pub fn cleanup_albums(&self) -> rusqlite::Result<Vec<String>> {
        self.remove_tracks(&[])
    }

    /// Flags tracks whose files are gone (and un-flags ones that are back). Never deletes: a moved
    /// or temporarily unavailable file must not cost the user their lyrics offsets, history or
    /// playlists. Returns true if anything changed.
    pub fn mark_missing(&self) -> rusqlite::Result<bool> {
        let rows: Vec<(i64, String, bool)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id, path, missing FROM tracks")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let changes: Vec<(i64, bool)> = rows
            .into_iter()
            .filter_map(|(id, path, was_missing)| {
                let now_missing = !Path::new(&path).exists();
                (now_missing != was_missing).then_some((id, now_missing))
            })
            .collect();
        if changes.is_empty() {
            return Ok(false);
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE tracks SET missing = ?1 WHERE id = ?2")?;
            for (id, missing) in &changes {
                stmt.execute(params![missing, id])?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    /// Folds missing tracks into an identical song that is present elsewhere (the file was moved and
    /// re-imported before the old copy was flagged), carrying over history, playlist entries,
    /// lyrics and the lyrics offset. Returns how many were merged.
    pub fn merge_moved(&self) -> rusqlite::Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let pairs: Vec<(i64, i64)> = tx
            .prepare(
                "SELECT m.id, (SELECT v.id FROM tracks v WHERE v.missing = 0 AND v.title = m.title
                   AND v.artist = m.artist AND v.album_id = m.album_id AND abs(v.duration - m.duration) < 1.5
                   ORDER BY v.id LIMIT 1) AS target
                 FROM tracks m WHERE m.missing = 1 AND target IS NOT NULL",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (old, new) in &pairs {
            tx.execute("UPDATE plays SET track_id = ?1 WHERE track_id = ?2", params![new, old])?;
            tx.execute("UPDATE playlist_tracks SET track_id = ?1 WHERE track_id = ?2", params![new, old])?;
            tx.execute("UPDATE OR IGNORE likes SET track_id = ?1 WHERE track_id = ?2", params![new, old])?;
            tx.execute(
                "INSERT OR IGNORE INTO lyrics (track_id, synced, plain, instrumental, source, fetched_at, offset_ms)
                 SELECT ?1, synced, plain, instrumental, source, fetched_at, offset_ms FROM lyrics WHERE track_id = ?2",
                params![new, old],
            )?;
            tx.execute(
                "UPDATE lyrics SET offset_ms = (SELECT offset_ms FROM lyrics WHERE track_id = ?2)
                 WHERE track_id = ?1 AND offset_ms = 0 AND EXISTS (SELECT 1 FROM lyrics WHERE track_id = ?2)",
                params![new, old],
            )?;
            tx.execute("DELETE FROM tracks WHERE id = ?", [old])?;
        }
        tx.commit()?;
        Ok(pairs.len())
    }

    pub fn queue_sources(&self, ids: &[i64]) -> rusqlite::Result<Vec<QueueSource>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare_cached("SELECT path, duration, loudness, peak, format, bit_depth FROM tracks WHERE id = ?")?;
        let mut out = Vec::with_capacity(ids.len());
        for &id in ids {
            if let Some(src) = stmt
                .query_row([id], |r| {
                    Ok(QueueSource {
                        id,
                        path: r.get(0)?,
                        duration: r.get(1)?,
                        loudness: r.get(2)?,
                        peak: r.get(3)?,
                        format: r.get(4)?,
                        bit_depth: r.get(5)?,
                    })
                })
                .optional()?
            {
                out.push(src);
            }
        }
        Ok(out)
    }

    /// Every playable song with what autoplay scores it on.
    pub fn autoplay_candidates(&self) -> rusqlite::Result<Vec<crate::autoplay::Candidate>> {
        self.conn()
            .prepare(
                "SELECT t.id, t.artist, a.artist, t.album_id, t.genre, a.year, COALESCE(p.n, 0), l.track_id IS NOT NULL
                 FROM tracks t JOIN albums a ON a.id = t.album_id
                 LEFT JOIN (SELECT track_id, COUNT(*) AS n FROM plays GROUP BY track_id) p ON p.track_id = t.id
                 LEFT JOIN likes l ON l.track_id = t.id
                 WHERE t.missing = 0",
            )?
            .query_map([], |r| {
                Ok(crate::autoplay::Candidate {
                    id: r.get(0)?,
                    artist: r.get(1)?,
                    album_artist: r.get(2)?,
                    album_id: r.get(3)?,
                    genre: r.get(4)?,
                    year: r.get(5)?,
                    plays: r.get(6)?,
                    liked: r.get(7)?,
                })
            })?
            .collect()
    }

    /// The `limit` most recently played distinct songs.
    pub fn recent_plays(&self, limit: usize) -> rusqlite::Result<Vec<i64>> {
        self.conn()
            .prepare("SELECT track_id FROM plays GROUP BY track_id ORDER BY MAX(played_at) DESC LIMIT ?")?
            .query_map([limit as i64], |r| r.get(0))?
            .collect()
    }

    /// Tracks still needing a loudness measurement, in the order given (queue first), then the rest.
    pub fn tracks_missing_loudness(&self, limit: usize) -> rusqlite::Result<Vec<(i64, String)>> {
        self.conn()
            .prepare("SELECT id, path FROM tracks WHERE loudness IS NULL AND missing = 0 ORDER BY added_at DESC LIMIT ?")?
            .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }

    pub fn track_path(&self, id: i64) -> Option<(String, bool)> {
        self.conn()
            .query_row("SELECT path, loudness IS NOT NULL FROM tracks WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten()
    }

    /// Stores a measurement. Silent/undecodable files get a sentinel so they aren't retried forever.
    pub fn set_loudness(&self, id: i64, lufs: f64, peak: f64) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE tracks SET loudness = ?1, peak = ?2 WHERE id = ?3", params![lufs, peak, id])?;
        Ok(())
    }

    pub fn record_play(&self, track_id: i64) -> rusqlite::Result<()> {
        self.conn().execute("INSERT INTO plays (track_id, played_at) VALUES (?1, ?2)", params![track_id, now()])?;
        Ok(())
    }

    pub fn history(&self) -> rusqlite::Result<History> {
        let conn = self.conn();
        let recent_albums = conn
            .prepare(
                "SELECT t.album_id FROM plays p JOIN tracks t ON t.id = p.track_id WHERE t.missing = 0
                 GROUP BY t.album_id ORDER BY MAX(p.played_at) DESC LIMIT 12",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let recent_tracks = conn
            .prepare(
                "SELECT p.track_id FROM plays p JOIN tracks t ON t.id = p.track_id WHERE t.missing = 0
                 GROUP BY p.track_id ORDER BY MAX(p.played_at) DESC LIMIT 20",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let top_tracks = conn
            .prepare(
                "SELECT p.track_id, COUNT(*) AS n FROM plays p JOIN tracks t ON t.id = p.track_id
                 WHERE p.played_at > ? AND t.missing = 0
                 GROUP BY p.track_id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT 10",
            )?
            .query_map([now() - 90 * 24 * 3600], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(History { recent_albums, recent_tracks, top_tracks })
    }

    pub fn playlist_create(&self, name: &str) -> rusqlite::Result<Playlist> {
        let conn = self.conn();
        let created_at = now();
        conn.execute("INSERT INTO playlists (name, created_at) VALUES (?1, ?2)", params![name, created_at])?;
        Ok(Playlist { id: conn.last_insert_rowid(), name: name.into(), created_at, track_ids: vec![] })
    }

    pub fn playlist_rename(&self, id: i64, name: &str) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE playlists SET name = ?1 WHERE id = ?2", params![name, id])?;
        Ok(())
    }

    pub fn playlist_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM playlists WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn playlist_set_tracks(&self, id: i64, track_ids: &[i64]) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", [id])?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)")?;
            for (pos, tid) in track_ids.iter().enumerate() {
                stmt.execute(params![id, tid, pos as i64])?;
            }
        }
        tx.commit()
    }

    pub fn playlist_add_tracks(&self, id: i64, track_ids: &[i64]) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let start: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_tracks WHERE playlist_id = ?",
            [id],
            |r| r.get(0),
        )?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)")?;
            for (i, tid) in track_ids.iter().enumerate() {
                stmt.execute(params![id, tid, start + i as i64])?;
            }
        }
        tx.commit()
    }

    pub fn now_playing_info(&self, id: i64) -> rusqlite::Result<Option<NowPlayingInfo>> {
        self.conn()
            .query_row(
                "SELECT t.title, t.artist, a.title, a.cover, t.duration, a.id, a.artist
                 FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?",
                [id],
                |r| {
                    Ok(NowPlayingInfo {
                        title: r.get(0)?,
                        artist: r.get(1)?,
                        album: r.get(2)?,
                        cover: r.get(3)?,
                        duration: r.get(4)?,
                        album_id: r.get(5)?,
                        album_artist: r.get(6)?,
                    })
                },
            )
            .optional()
    }

    pub fn lyrics_query(&self, id: i64) -> rusqlite::Result<Option<LyricsQuery>> {
        self.conn()
            .query_row(
                "SELECT t.path, t.title, t.artist, a.title, t.duration
                 FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?",
                [id],
                |r| {
                    Ok(LyricsQuery {
                        path: r.get(0)?,
                        title: r.get(1)?,
                        artist: r.get(2)?,
                        album: r.get(3)?,
                        duration: r.get(4)?,
                    })
                },
            )
            .optional()
    }

    /// Cached lyrics and when they were fetched.
    pub fn cached_lyrics(&self, id: i64) -> Option<(Lyrics, i64)> {
        self.conn()
            .query_row(
                "SELECT synced, plain, instrumental, source, fetched_at, offset_ms FROM lyrics WHERE track_id = ?",
                [id],
                |r| {
                    Ok((
                        Lyrics {
                            synced: r.get(0)?,
                            plain: r.get(1)?,
                            instrumental: r.get(2)?,
                            source: r.get(3)?,
                            offset_ms: r.get(5)?,
                        },
                        r.get(4)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn save_lyrics(&self, id: i64, l: &Lyrics) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO lyrics (track_id, synced, plain, instrumental, source, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(track_id) DO UPDATE SET synced = excluded.synced, plain = excluded.plain,
               instrumental = excluded.instrumental, source = excluded.source, fetched_at = excluded.fetched_at",
            params![id, l.synced, l.plain, l.instrumental, l.source, now()],
        )?;
        Ok(())
    }

    /// Per-track lyric timing correction. Creates a placeholder row for local `.lrc` lyrics.
    pub fn set_lyrics_offset(&self, id: i64, offset_ms: i64) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO lyrics (track_id, instrumental, source, fetched_at, offset_ms) VALUES (?1, 0, 'none', 0, ?2)
             ON CONFLICT(track_id) DO UPDATE SET offset_ms = excluded.offset_ms",
            params![id, offset_ms],
        )?;
        Ok(())
    }

    pub fn lyrics_offset(&self, id: i64) -> i64 {
        self.conn()
            .query_row("SELECT offset_ms FROM lyrics WHERE track_id = ?", [id], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        self.conn()
            .query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    #[cfg(test)]
    pub fn exec_for_test(&self, sql: &str) {
        self.conn().execute_batch(sql).unwrap();
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

fn cleanup_albums(tx: &rusqlite::Transaction) -> rusqlite::Result<Vec<String>> {
    let covers = tx
        .prepare("SELECT cover FROM albums WHERE cover IS NOT NULL AND id NOT IN (SELECT album_id FROM tracks)")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    tx.execute("DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM tracks)", [])?;
    Ok(covers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(path: &str) -> TrackMeta {
        TrackMeta {
            path: path.into(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            album_artist: "Artist".into(),
            track_no: Some(1),
            disc_no: None,
            year: None,
            duration: 180.0,
            genre: None,
            mtime: 1,
            audio: AudioInfo::default(),
            loudness: None,
            peak: None,
        }
    }

    #[test]
    fn streaks_count_consecutive_days() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2000-03-01"), Some(11_017));
        let days = ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-05", "2026-03-06"];
        assert_eq!(longest_streak(days.into_iter()), 3);
        assert_eq!(longest_streak(std::iter::empty()), 0);
    }

    #[test]
    fn opening_an_older_database_adds_smart_playlists_and_keeps_data() {
        let dir = std::env::temp_dir().join(format!("reson-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        {
            // The v0.1.0 layout: no smart_playlists table and none of the later track columns.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE albums (id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, year INTEGER,
                   cover TEXT, palette TEXT, UNIQUE (title, artist));
                 CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
                   artist TEXT NOT NULL, album_id INTEGER NOT NULL REFERENCES albums(id), track_no INTEGER,
                   disc_no INTEGER, duration REAL NOT NULL, genre TEXT, mtime INTEGER NOT NULL, added_at INTEGER NOT NULL);
                 CREATE TABLE playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE TABLE playlist_tracks (playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, position INTEGER NOT NULL);
                 CREATE TABLE plays (track_id INTEGER NOT NULL, played_at INTEGER NOT NULL);
                 INSERT INTO albums (id, title, artist, year) VALUES (1, 'Album', 'Artist', 2001);
                 INSERT INTO tracks VALUES (1, 'x.flac', 'Song', 'Artist', 1, 1, 1, 180, NULL, 1, 1);
                 INSERT INTO playlists VALUES (1, 'Mine', 1);
                 INSERT INTO playlist_tracks VALUES (1, 1, 0);
                 INSERT INTO plays VALUES (1, 5), (1, 6);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let lib = db.library().unwrap();
        assert_eq!(lib.tracks.len(), 1);
        assert_eq!(lib.playlists[0].track_ids, vec![1]);
        assert!(lib.smart_playlists.is_empty());

        let rules: Rules = serde_json::from_str(
            r#"{"match":"all","rules":[{"field":"plays","op":"gt","value":1},{"field":"year","op":"is","value":2001}]}"#,
        )
        .unwrap();
        let created = db.smart_create("Played", &rules).unwrap();
        assert_eq!(created.track_ids, vec![1]);
        drop(db);

        // Reopening is a no-op migration and the definition survives.
        let db = Db::open(&path).unwrap();
        let smart = db.smart_playlists().unwrap();
        assert_eq!(smart.len(), 1);
        assert_eq!(smart[0].rules, rules);
        assert_eq!(smart[0].track_ids, vec![1]);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn moved_files_keep_their_row_and_offset() {
        let dir = std::env::temp_dir().join(format!("reson-dbtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.flac");
        std::fs::write(&old, b"x").unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();

        db.upsert_track(&meta(&old.to_string_lossy())).unwrap();
        let id = db.library().unwrap().tracks[0].id;
        db.set_lyrics_offset(id, 750).unwrap();

        // The file moves away: hidden, not deleted.
        std::fs::remove_file(&old).unwrap();
        assert!(db.mark_missing().unwrap());
        assert!(db.library().unwrap().tracks.is_empty());
        assert_eq!(db.lyrics_offset(id), 750);

        // It shows up somewhere else: the same row comes back with its offset.
        let new = dir.join("new.flac");
        std::fs::write(&new, b"x").unwrap();
        db.upsert_track(&meta(&new.to_string_lossy())).unwrap();
        let lib = db.library().unwrap();
        assert_eq!(lib.tracks.len(), 1);
        assert_eq!(lib.tracks[0].id, id);
        assert_eq!(lib.tracks[0].path, new.to_string_lossy());
        assert_eq!(db.lyrics_offset(id), 750);
        assert!(!db.mark_missing().unwrap());

        // Re-imported from a new folder while the old file was still flagged present: merged later.
        let third = dir.join("third.flac");
        std::fs::write(&third, b"x").unwrap();
        db.upsert_track(&meta(&third.to_string_lossy())).unwrap();
        assert_eq!(db.library().unwrap().tracks.len(), 2);
        db.record_play(id).unwrap();
        std::fs::remove_file(&new).unwrap();
        db.mark_missing().unwrap();
        assert_eq!(db.merge_moved().unwrap(), 1);
        let lib = db.library().unwrap();
        assert_eq!(lib.tracks.len(), 1);
        let survivor = lib.tracks[0].id;
        assert_eq!(db.lyrics_offset(survivor), 750);
        assert_eq!(db.history().unwrap().recent_tracks, vec![survivor]);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
