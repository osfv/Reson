//! Autoplay: when the queue runs out (with repeat off), playback continues with songs from the
//! library that resemble what was queued. Same artists score highest, then the same genres and
//! era, with a nudge for liked and often-played songs and some randomness so it isn't the same
//! list every time.

use std::collections::{HashMap, HashSet};

/// Songs added per top-up.
pub const BATCH: usize = 10;
const MAX_PER_ARTIST: usize = 3;
const MAX_PER_ALBUM: usize = 2;
/// Weight of the random part of the score; an artist match is worth 3, a genre match 2.
const JITTER: f64 = 2.0;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: i64,
    pub artist: String,
    pub album_artist: String,
    pub album_id: i64,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub plays: i64,
    pub liked: bool,
}

struct Profile {
    artists: HashSet<String>,
    genres: HashSet<String>,
    year: Option<i32>,
}

fn key(s: &str) -> String {
    s.trim().to_lowercase()
}

fn profile(seeds: &[&Candidate]) -> Profile {
    let mut artists = HashSet::new();
    let mut genres = HashSet::new();
    let mut years = Vec::new();
    for s in seeds {
        artists.insert(key(&s.artist));
        artists.insert(key(&s.album_artist));
        if let Some(g) = s.genre.as_deref().map(key).filter(|g| !g.is_empty()) {
            genres.insert(g);
        }
        years.extend(s.year);
    }
    artists.remove("");
    years.sort_unstable();
    Profile { artists, genres, year: years.get(years.len() / 2).copied() }
}

fn score(c: &Candidate, p: &Profile) -> f64 {
    let mut s = 0.0;
    if p.artists.contains(&key(&c.artist)) || p.artists.contains(&key(&c.album_artist)) {
        s += 3.0;
    }
    if c.genre.as_deref().map(key).is_some_and(|g| p.genres.contains(&g)) {
        s += 2.0;
    }
    if let (Some(a), Some(b)) = (c.year, p.year) {
        match (a - b).abs() {
            0..=3 => s += 1.0,
            4..=8 => s += 0.5,
            _ => {}
        }
    }
    if c.liked {
        s += 1.0;
    }
    s + ((c.plays as f64).ln_1p() * 0.4).min(1.2)
}

/// Up to `n` song ids like `seeds`, never from `exclude`, best first. `random` returns 0..1.
pub fn pick(seeds: &[i64], candidates: &[Candidate], exclude: &HashSet<i64>, n: usize, mut random: impl FnMut() -> f64) -> Vec<i64> {
    let by_id: HashMap<i64, &Candidate> = candidates.iter().map(|c| (c.id, c)).collect();
    let seed_rows: Vec<&Candidate> = seeds.iter().filter_map(|id| by_id.get(id).copied()).collect();
    let p = profile(&seed_rows);
    let mut ranked: Vec<(f64, &Candidate)> = candidates
        .iter()
        .filter(|c| !exclude.contains(&c.id))
        .map(|c| (score(c, &p) + random() * JITTER, c))
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));

    // Spread the batch over artists and albums; a small library may need a second, uncapped pass.
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut per_album: HashMap<i64, usize> = HashMap::new();
    let mut out: Vec<i64> = Vec::with_capacity(n);
    for (_, c) in &ranked {
        if out.len() == n {
            break;
        }
        let artist = per_artist.entry(key(&c.artist)).or_default();
        let album = per_album.entry(c.album_id).or_default();
        if *artist < MAX_PER_ARTIST && *album < MAX_PER_ALBUM {
            *artist += 1;
            *album += 1;
            out.push(c.id);
        }
    }
    for (_, c) in &ranked {
        if out.len() == n {
            break;
        }
        if !out.contains(&c.id) {
            out.push(c.id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: i64, artist: &str, album_id: i64, genre: Option<&str>, year: Option<i32>) -> Candidate {
        Candidate {
            id,
            artist: artist.into(),
            album_artist: artist.into(),
            album_id,
            genre: genre.map(Into::into),
            year,
            plays: 0,
            liked: false,
        }
    }

    /// Ken Carson (seed album 1, more on albums 2-3), other rap, and unrelated jazz.
    fn library() -> Vec<Candidate> {
        vec![
            song(1, "Ken Carson", 1, Some("Rap"), Some(2023)),
            song(2, "Ken Carson", 2, Some("Rap"), Some(2022)),
            song(3, "ken carson ", 2, Some("rap"), Some(2022)),
            song(4, "Ken Carson", 3, Some("Rap"), Some(2021)),
            song(5, "Ken Carson", 3, Some("Rap"), Some(2021)),
            song(6, "Destroy Lonely", 4, Some("Rap"), Some(2024)),
            song(7, "Homixide Gang", 5, Some("Rap"), Some(2023)),
            song(8, "Bill Evans", 6, Some("Jazz"), Some(1961)),
            song(9, "Bill Evans", 6, Some("Jazz"), Some(1961)),
            song(10, "Chet Baker", 7, Some("Jazz"), Some(1954)),
        ]
    }

    #[test]
    fn same_artist_first_then_genre_then_the_rest() {
        let picks = pick(&[1], &library(), &HashSet::from([1]), 10, || 0.0);
        // Three Ken Carson songs (the artist cap), other rap, then jazz; ids 1 is excluded.
        let first: HashSet<i64> = picks[..3].iter().copied().collect();
        assert!(first.is_subset(&HashSet::from([2, 3, 4, 5])), "{picks:?}");
        assert_eq!(HashSet::from([picks[3], picks[4]]), HashSet::from([6, 7]), "{picks:?}");
        assert!(!picks.contains(&1));
        assert_eq!(picks.len(), 9);
    }

    #[test]
    fn spreads_over_albums_and_artists() {
        let picks = pick(&[1], &library(), &HashSet::from([1]), 5, || 0.0);
        let carson = picks.iter().filter(|id| (2..=5).contains(*id)).count();
        assert_eq!(carson, 3);
        // At most two from any one album.
        for album in [2, 3] {
            let on_album = picks.iter().filter(|id| library().iter().any(|c| c.id == **id && c.album_id == album)).count();
            assert!(on_album <= 2, "{picks:?}");
        }
    }

    #[test]
    fn small_libraries_still_fill_the_batch() {
        // One artist, one album: the caps would stop at two, the second pass fills the rest.
        let lib: Vec<Candidate> = (1..=6).map(|id| song(id, "Solo", 1, None, None)).collect();
        let picks = pick(&[1], &lib, &HashSet::from([1]), 10, || 0.0);
        assert_eq!(picks.len(), 5);
    }

    #[test]
    fn liked_and_played_songs_come_first_among_equals() {
        let mut lib = library();
        lib[7].liked = true; // Bill Evans 8
        lib[9].plays = 20; // Chet Baker 10
        let picks = pick(&[1], &lib, &HashSet::from([1, 2, 3, 4, 5, 6, 7]), 3, || 0.0);
        assert_eq!(HashSet::from([picks[0], picks[1]]), HashSet::from([8, 10]));
        assert_eq!(picks[2], 9);
    }

    #[test]
    fn reads_candidates_and_recent_plays_from_the_library() {
        use crate::db::{AudioInfo, Db, TrackMeta};
        let dir = std::env::temp_dir().join(format!("reson-autoplay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        for (path, artist, genre) in [("a.flac", "Ken Carson", Some("Rap")), ("b.flac", "Ken Carson", None), ("c.flac", "Chet Baker", Some("Jazz"))] {
            db.upsert_track(&TrackMeta {
                path: path.into(),
                title: path.into(),
                artist: artist.into(),
                album: "Album".into(),
                album_artist: artist.into(),
                track_no: None,
                disc_no: None,
                year: Some(2023),
                duration: 120.0,
                genre: genre.map(Into::into),
                mtime: 1,
                audio: AudioInfo::default(),
                loudness: None,
                peak: None,
            })
            .unwrap();
        }
        db.set_liked(3, true).unwrap();
        db.exec_for_test(
            "INSERT INTO plays (track_id, played_at) VALUES (1, 100), (1, 200), (2, 300);
             UPDATE tracks SET missing = 1 WHERE path = 'b.flac';",
        );
        let mut c = db.autoplay_candidates().unwrap();
        c.sort_by_key(|c| c.id);
        // The missing file isn't a candidate.
        assert_eq!(c.iter().map(|c| c.id).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!((c[0].plays, c[0].liked, c[0].genre.as_deref(), c[0].year), (2, false, Some("Rap"), Some(2023)));
        assert_eq!((c[1].plays, c[1].liked), (0, true));
        assert_eq!(db.recent_plays(10).unwrap(), vec![2, 1]);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn randomness_changes_the_order_but_not_the_rules() {
        let mut state = 7u64;
        let mut rng = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let exclude = HashSet::from([1, 8, 9]);
        for _ in 0..20 {
            let picks = pick(&[1], &library(), &exclude, 4, &mut rng);
            assert_eq!(picks.len(), 4);
            assert!(picks.iter().all(|id| !exclude.contains(id)));
        }
    }
}
