//! Smart playlists: rule-based playlists compiled to SQL, so they are re-evaluated from the library
//! on every read and stay current as songs are added, played or removed.

use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Upper bound for a playlist's limit, so a typo can't ask for millions of rows.
pub const MAX_LIMIT: u32 = 10_000;
const DAY: i64 = 24 * 3600;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Match {
    All,
    Any,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Title,
    Artist,
    Album,
    AlbumArtist,
    Genre,
    Year,
    Plays,
    LastPlayed,
    AddedAt,
    Duration,
    Format,
    BitDepth,
    SampleRate,
    Bitrate,
    /// Sort only: a stable shuffle (see `Sort::seed`).
    Random,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Text,
    Number,
    Date,
}

impl Field {
    fn kind(self) -> Option<Kind> {
        use Field::*;
        Some(match self {
            Title | Artist | Album | AlbumArtist | Genre | Format => Kind::Text,
            Year | Plays | Duration | BitDepth | SampleRate | Bitrate => Kind::Number,
            LastPlayed | AddedAt => Kind::Date,
            Random => return None,
        })
    }

    /// SQL expression over `t` (tracks), `a` (albums) and `p` (play stats).
    fn column(self) -> &'static str {
        use Field::*;
        match self {
            Title => "t.title",
            Artist => "t.artist",
            Album => "a.title",
            AlbumArtist => "a.artist",
            Genre => "COALESCE(t.genre, '')",
            Format => "COALESCE(t.format, '')",
            Year => "a.year",
            Plays => "COALESCE(p.plays, 0)",
            Duration => "t.duration",
            BitDepth => "t.bit_depth",
            SampleRate => "t.sample_rate",
            Bitrate => "t.bitrate",
            LastPlayed => "p.last_played",
            AddedAt => "t.added_at",
            Random => "t.id",
        }
    }

    fn needs_plays(self) -> bool {
        matches!(self, Field::Plays | Field::LastPlayed)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    // Text and number
    Is,
    IsNot,
    // Text
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    // Number
    Gt,
    Lt,
    Between,
    // Date: value is a number of days
    InLast,
    NotInLast,
    // Date: value is a unix timestamp in seconds
    Before,
    After,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rule {
    pub field: Field,
    pub op: Op,
    #[serde(default)]
    pub value: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub field: Field,
    #[serde(default)]
    pub desc: bool,
    /// Random order is seeded so the list doesn't reshuffle every time the library refreshes.
    #[serde(default)]
    pub seed: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    #[serde(rename = "match")]
    pub mode: Match,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub sort: Option<Sort>,
}

fn text(rule: &Rule) -> Result<String, String> {
    match &rule.value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(format!("{:?} needs some text to compare with", rule.field)),
    }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn num(rule: &Rule) -> Result<f64, String> {
    number(&rule.value).ok_or_else(|| format!("{:?} needs a number", rule.field))
}

fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// One rule as a SQL condition plus its parameters.
fn condition(rule: &Rule, now: i64) -> Result<(String, Vec<SqlValue>), String> {
    let col = rule.field.column();
    let kind = rule.field.kind().ok_or("Random can only be used for sorting")?;
    let bad = || Err(format!("{:?} can't be used with {:?}", rule.op, rule.field));
    let like = |pattern: String, negate: bool| {
        let not = if negate { "NOT " } else { "" };
        (format!("{col} {not}LIKE ? ESCAPE '\\'"), vec![SqlValue::Text(pattern)])
    };
    Ok(match kind {
        Kind::Text => {
            let v = text(rule)?;
            match rule.op {
                Op::Is => (format!("{col} = ? COLLATE NOCASE"), vec![SqlValue::Text(v)]),
                Op::IsNot => (format!("{col} <> ? COLLATE NOCASE"), vec![SqlValue::Text(v)]),
                Op::Contains => like(format!("%{}%", like_escape(&v)), false),
                Op::NotContains => like(format!("%{}%", like_escape(&v)), true),
                Op::StartsWith => like(format!("{}%", like_escape(&v)), false),
                Op::EndsWith => like(format!("%{}", like_escape(&v)), false),
                _ => return bad(),
            }
        }
        Kind::Number => match rule.op {
            Op::Is => (format!("{col} = ?"), vec![SqlValue::Real(num(rule)?)]),
            Op::IsNot => (format!("({col} IS NULL OR {col} <> ?)"), vec![SqlValue::Real(num(rule)?)]),
            Op::Gt => (format!("{col} > ?"), vec![SqlValue::Real(num(rule)?)]),
            Op::Lt => (format!("{col} < ?"), vec![SqlValue::Real(num(rule)?)]),
            Op::Between => {
                let pair = rule.value.as_array().filter(|a| a.len() == 2);
                let (lo, hi) = pair
                    .and_then(|a| Some((number(&a[0])?, number(&a[1])?)))
                    .ok_or_else(|| format!("{:?} between needs two numbers", rule.field))?;
                let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                (format!("{col} BETWEEN ? AND ?"), vec![SqlValue::Real(lo), SqlValue::Real(hi)])
            }
            _ => return bad(),
        },
        Kind::Date => match rule.op {
            Op::InLast | Op::NotInLast => {
                let days = num(rule)?;
                if days < 0.0 {
                    return Err("The number of days can't be negative".into());
                }
                let since = now - (days * DAY as f64) as i64;
                if rule.op == Op::InLast {
                    (format!("{col} >= ?"), vec![SqlValue::Integer(since)])
                } else {
                    // Never played counts as "not in the last N days".
                    (format!("({col} IS NULL OR {col} < ?)"), vec![SqlValue::Integer(since)])
                }
            }
            Op::Before => (format!("{col} < ?"), vec![SqlValue::Integer(num(rule)? as i64)]),
            // The value is the start of the chosen day; "after" begins on the next one.
            Op::After => (format!("{col} >= ?"), vec![SqlValue::Integer(num(rule)? as i64 + DAY)]),
            _ => return bad(),
        },
    })
}

impl Rules {
    pub fn validate(&self) -> Result<(), String> {
        self.compile(0).map(|_| ())
    }

    /// Builds a query selecting matching, present track ids in playlist order.
    pub fn compile(&self, now: i64) -> Result<(String, Vec<SqlValue>), String> {
        let mut conds = Vec::with_capacity(self.rules.len());
        let mut params = Vec::new();
        for rule in &self.rules {
            let (sql, p) = condition(rule, now)?;
            conds.push(sql);
            params.extend(p);
        }
        let sort = self.sort.as_ref();
        let needs_plays =
            self.rules.iter().any(|r| r.field.needs_plays()) || sort.is_some_and(|s| s.field.needs_plays());

        let mut sql = String::from("SELECT t.id FROM tracks t JOIN albums a ON a.id = t.album_id");
        if needs_plays {
            sql.push_str(
                " LEFT JOIN (SELECT track_id, COUNT(*) AS plays, MAX(played_at) AS last_played
                   FROM plays GROUP BY track_id) p ON p.track_id = t.id",
            );
        }
        sql.push_str(" WHERE t.missing = 0");
        if !conds.is_empty() {
            let joiner = if self.mode == Match::All { " AND " } else { " OR " };
            sql.push_str(&format!(" AND ({})", conds.join(joiner)));
        }
        match sort {
            // Shuffled in `finish`, which also applies the limit.
            Some(Sort { field: Field::Random, .. }) => sql.push_str(" ORDER BY t.id"),
            Some(s) => {
                let dir = if s.desc { "DESC" } else { "ASC" };
                let col = s.field.column();
                let collate = if s.field.kind() == Some(Kind::Text) { " COLLATE NOCASE" } else { "" };
                // Missing values (no year, never played) go last either way.
                sql.push_str(&format!(" ORDER BY {col} IS NULL, {col}{collate} {dir}, t.id"));
            }
            None => sql.push_str(
                " ORDER BY t.artist COLLATE NOCASE, t.album_id, t.disc_no, t.track_no, t.title COLLATE NOCASE",
            ),
        }
        if let Some(limit) = self.limit {
            if limit == 0 {
                return Err("The limit must be at least 1".into());
            }
            if self.seed().is_none() {
                sql.push_str(" LIMIT ?");
                params.push(SqlValue::Integer(limit.min(MAX_LIMIT) as i64));
            }
        }
        Ok((sql, params))
    }

    fn seed(&self) -> Option<u32> {
        self.sort.as_ref().filter(|s| s.field == Field::Random).map(|s| s.seed)
    }

    /// Puts the ids from the compiled query in their final order: a random sort is shuffled here
    /// (a stable order per seed), then limited.
    pub fn finish(&self, mut ids: Vec<i64>) -> Vec<i64> {
        if let Some(seed) = self.seed() {
            ids.sort_by_key(|&id| mix(((seed as u64) << 32) ^ id as u64));
            if let Some(limit) = self.limit {
                ids.truncate(limit.min(MAX_LIMIT) as usize);
            }
        }
        ids
    }
}

/// SplitMix64's finalizer: a bijection, so every seed gives an unrelated order with no ties.
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Suggested playlists, added only when the user asks for them.
pub fn defaults() -> Vec<(&'static str, Rules)> {
    let rule = |field, op, value: Value| Rule { field, op, value };
    let sort = |field, desc| Some(Sort { field, desc, seed: 0 });
    let all = |rules, limit, sort| Rules { mode: Match::All, rules, limit, sort };
    vec![
        ("Most played", all(vec![rule(Field::Plays, Op::Gt, 0.into())], Some(25), sort(Field::Plays, true))),
        (
            "Recently added",
            all(vec![rule(Field::AddedAt, Op::InLast, 30.into())], Some(100), sort(Field::AddedAt, true)),
        ),
        ("Never played", all(vec![rule(Field::Plays, Op::Is, 0.into())], None, None)),
        (
            "Forgotten favorites",
            all(
                vec![rule(Field::Plays, Op::Gt, 4.into()), rule(Field::LastPlayed, Op::NotInLast, 90.into())],
                Some(50),
                sort(Field::Plays, true),
            ),
        ),
        (
            "Hi-res",
            Rules {
                mode: Match::Any,
                rules: vec![rule(Field::BitDepth, Op::Gt, 16.into()), rule(Field::SampleRate, Op::Gt, 48000.into())],
                limit: None,
                sort: None,
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{AudioInfo, Db, TrackMeta};
    use serde_json::json;

    struct Fixture {
        db: Db,
        dir: std::path::PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn track(path: &str, title: &str, artist: &str, album: &str, year: Option<u32>, genre: Option<&str>) -> TrackMeta {
        TrackMeta {
            path: path.into(),
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            album_artist: artist.into(),
            track_no: None,
            disc_no: None,
            year,
            duration: 200.0,
            genre: genre.map(Into::into),
            mtime: 1,
            audio: AudioInfo { format: Some("FLAC".into()), bit_depth: Some(16), sample_rate: Some(44100), ..Default::default() },
            loudness: None,
            peak: None,
        }
    }

    /// Four songs: ids 1..=4 in insertion order.
    fn fixture(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("reson-smart-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        db.upsert_track(&track("a.flac", "Alpha 50%", "Boards", "Geogaddi", Some(2002), Some("Electronic"))).unwrap();
        db.upsert_track(&track("b.flac", "Bravo", "Boards", "Geogaddi", Some(2002), Some("Electronic"))).unwrap();
        db.upsert_track(&track("c.mp3", "Charlie", "Cocteau", "Heaven", Some(1990), Some("Dream Pop"))).unwrap();
        db.upsert_track(&track("d.flac", "Delta", "Drexciya", "Neptune", None, None)).unwrap();
        db.exec_for_test(
            "UPDATE tracks SET format = 'MP3', bit_depth = NULL, duration = 95 WHERE path = 'c.mp3';
             UPDATE tracks SET bit_depth = 24, sample_rate = 96000 WHERE path = 'd.flac';
             UPDATE tracks SET added_at = 1000 WHERE path = 'a.flac';",
        );
        Fixture { db, dir }
    }

    fn rules(mode: Match, rules: Vec<Rule>) -> Rules {
        Rules { mode, rules, limit: None, sort: None }
    }

    fn rule(field: Field, op: Op, value: Value) -> Rule {
        Rule { field, op, value }
    }

    fn eval(f: &Fixture, r: &Rules) -> Vec<i64> {
        f.db.smart_tracks(r).unwrap()
    }

    fn sorted(mut v: Vec<i64>) -> Vec<i64> {
        v.sort();
        v
    }

    #[test]
    fn text_rules_are_case_insensitive_and_escape_wildcards() {
        let f = fixture("text");
        let r = |op, v: &str| rules(Match::All, vec![rule(Field::Artist, op, json!(v))]);
        assert_eq!(sorted(eval(&f, &r(Op::Is, "boards"))), vec![1, 2]);
        assert_eq!(sorted(eval(&f, &r(Op::IsNot, "BOARDS"))), vec![3, 4]);
        assert_eq!(sorted(eval(&f, &r(Op::Contains, "oc"))), vec![3]);
        assert_eq!(sorted(eval(&f, &r(Op::StartsWith, "d"))), vec![4]);
        assert_eq!(sorted(eval(&f, &r(Op::EndsWith, "ARDS"))), vec![1, 2]);
        assert_eq!(sorted(eval(&f, &r(Op::NotContains, "o"))), vec![4]);
        // "%" is literal, not a wildcard.
        let pct = rules(Match::All, vec![rule(Field::Title, Op::Contains, json!("50%"))]);
        assert_eq!(eval(&f, &pct), vec![1]);
        let pct = rules(Match::All, vec![rule(Field::Title, Op::Contains, json!("%"))]);
        assert_eq!(eval(&f, &pct), vec![1]);
        // Album and genre come from the album row / nullable column.
        let g = rules(Match::All, vec![rule(Field::Genre, Op::Is, json!(""))]);
        assert_eq!(eval(&f, &g), vec![4]);
        let a = rules(Match::All, vec![rule(Field::Album, Op::Is, json!("heaven"))]);
        assert_eq!(eval(&f, &a), vec![3]);
    }

    #[test]
    fn number_rules_and_any_all() {
        let f = fixture("number");
        let year = |op, v| rule(Field::Year, op, v);
        assert_eq!(sorted(eval(&f, &rules(Match::All, vec![year(Op::Gt, json!(1995))]))), vec![1, 2]);
        assert_eq!(sorted(eval(&f, &rules(Match::All, vec![year(Op::Lt, json!("1995"))]))), vec![3]);
        assert_eq!(sorted(eval(&f, &rules(Match::All, vec![year(Op::Between, json!([2005, 1980]))]))), vec![1, 2, 3]);
        // A song with no year is "not 2002".
        assert_eq!(sorted(eval(&f, &rules(Match::All, vec![year(Op::IsNot, json!(2002))]))), vec![3, 4]);

        let lossless = rule(Field::Format, Op::Is, json!("flac"));
        let hires = rule(Field::BitDepth, Op::Gt, json!(16));
        let short = rule(Field::Duration, Op::Lt, json!(120));
        assert_eq!(eval(&f, &rules(Match::All, vec![lossless.clone(), hires.clone()])), vec![4]);
        assert_eq!(sorted(eval(&f, &rules(Match::Any, vec![hires, short]))), vec![3, 4]);
        assert_eq!(eval(&f, &rules(Match::All, vec![rule(Field::SampleRate, Op::Is, json!(96000))])), vec![4]);
        // No rules: everything.
        assert_eq!(eval(&f, &rules(Match::Any, vec![])).len(), 4);
    }

    #[test]
    fn play_stats_dates_sort_and_limit() {
        let f = fixture("plays");
        let now = crate::db::now();
        f.db.exec_for_test(&format!(
            "INSERT INTO plays (track_id, played_at) VALUES (3, {r}), (3, {r}), (3, {r}), (2, {old}), (2, {old}), (1, {r});",
            r = now - 3600,
            old = now - 200 * DAY,
        ));
        let most_played = Rules {
            mode: Match::All,
            rules: vec![rule(Field::Plays, Op::Gt, json!(0))],
            limit: Some(2),
            sort: Some(Sort { field: Field::Plays, desc: true, seed: 0 }),
        };
        assert_eq!(eval(&f, &most_played), vec![3, 2]);

        let never = rules(Match::All, vec![rule(Field::Plays, Op::Is, json!(0))]);
        assert_eq!(eval(&f, &never), vec![4]);
        let recent = rules(Match::All, vec![rule(Field::LastPlayed, Op::InLast, json!(7))]);
        assert_eq!(sorted(eval(&f, &recent)), vec![1, 3]);
        // Never-played songs count as "not played in the last 30 days".
        let stale = rules(Match::All, vec![rule(Field::LastPlayed, Op::NotInLast, json!(30))]);
        assert_eq!(sorted(eval(&f, &stale)), vec![2, 4]);
        let old_add = rules(Match::All, vec![rule(Field::AddedAt, Op::Before, json!(5000))]);
        assert_eq!(eval(&f, &old_add), vec![1]);
        let new_add = rules(Match::All, vec![rule(Field::AddedAt, Op::After, json!(5000))]);
        assert_eq!(sorted(eval(&f, &new_add)), vec![2, 3, 4]);

        // Missing years sort last in both directions.
        let by_year = |desc| Rules { sort: Some(Sort { field: Field::Year, desc, seed: 0 }), ..rules(Match::All, vec![]) };
        assert_eq!(eval(&f, &by_year(false)), vec![3, 1, 2, 4]);
        assert_eq!(eval(&f, &by_year(true)), vec![1, 2, 3, 4]);

        // Random order is stable for a seed and still respects the limit.
        let shuffled = |seed| Rules {
            limit: Some(3),
            sort: Some(Sort { field: Field::Random, desc: false, seed }),
            ..rules(Match::All, vec![])
        };
        assert_eq!(eval(&f, &shuffled(7)), eval(&f, &shuffled(7)));
        assert_eq!(eval(&f, &shuffled(7)).len(), 3);
    }

    #[test]
    fn random_order_is_a_real_shuffle() {
        let f = fixture("shuffle");
        for i in 0..36 {
            f.db.upsert_track(&track(&format!("s{i}.flac"), &format!("Song {i}"), "Many", "Lots", None, None)).unwrap();
        }
        let random = |seed, limit| Rules {
            limit,
            sort: Some(Sort { field: Field::Random, desc: false, seed }),
            ..rules(Match::All, vec![])
        };
        let (a, b) = (eval(&f, &random(1, None)), eval(&f, &random(2, None)));
        assert_eq!(sorted(a.clone()), sorted(b.clone()));
        // A new seed is a new order, not the same order started from another song.
        let start = b.iter().position(|id| *id == a[0]).unwrap();
        let rotated: Vec<i64> = b[start..].iter().chain(&b[..start]).copied().collect();
        assert_ne!(rotated, a);
        // Neighbours aren't a fixed number of import positions apart.
        let gaps: std::collections::HashSet<i64> = a.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
        assert!(gaps.len() > 5, "{gaps:?}");
        // The limit takes a stable sample of the whole shuffled list.
        assert_eq!(eval(&f, &random(1, Some(10))), a[..10]);
    }

    #[test]
    fn after_a_date_starts_the_next_day() {
        let f = fixture("after");
        // a.flac was added 1000 s into day 0, so it's on that day, not after it.
        let after = rules(Match::All, vec![rule(Field::AddedAt, Op::After, json!(0))]);
        assert_eq!(sorted(eval(&f, &after)), vec![2, 3, 4]);
        let before = rules(Match::All, vec![rule(Field::AddedAt, Op::Before, json!(DAY))]);
        assert_eq!(eval(&f, &before), vec![1]);
    }

    #[test]
    fn updates_live_with_the_library() {
        let f = fixture("live");
        let flac = rules(Match::All, vec![rule(Field::Format, Op::Is, json!("FLAC"))]);
        let pl = f.db.smart_create("Lossless", &flac).unwrap();
        assert_eq!(pl.track_ids.len(), 3);
        f.db.upsert_track(&track("e.flac", "Echo", "Eno", "Ambient 1", Some(1978), None)).unwrap();
        f.db.exec_for_test("UPDATE tracks SET missing = 1 WHERE path = 'a.flac'");
        let lists = f.db.smart_playlists().unwrap();
        assert_eq!(sorted(lists[0].track_ids.clone()), vec![2, 4, 5]);

        f.db.smart_update(pl.id, "Lossless only", &rules(Match::All, vec![])).unwrap();
        let lists = f.db.smart_playlists().unwrap();
        assert_eq!(lists[0].name, "Lossless only");
        assert_eq!(lists[0].track_ids.len(), 4);
        f.db.smart_delete(pl.id).unwrap();
        assert!(f.db.library().unwrap().smart_playlists.is_empty());
    }

    #[test]
    fn invalid_rules_are_rejected() {
        let bad = [
            rules(Match::All, vec![rule(Field::Year, Op::Contains, json!("19"))]),
            rules(Match::All, vec![rule(Field::Title, Op::Gt, json!(3))]),
            rules(Match::All, vec![rule(Field::Plays, Op::Gt, json!("lots"))]),
            rules(Match::All, vec![rule(Field::Year, Op::Between, json!([1990]))]),
            rules(Match::All, vec![rule(Field::AddedAt, Op::InLast, json!(-1))]),
            rules(Match::All, vec![rule(Field::Random, Op::Is, json!(1))]),
            rules(Match::All, vec![rule(Field::Title, Op::Is, Value::Null)]),
            Rules { limit: Some(0), ..rules(Match::All, vec![]) },
        ];
        for r in &bad {
            assert!(r.validate().is_err(), "{r:?}");
        }
        let f = fixture("invalid");
        assert!(f.db.smart_create("Bad", &bad[0]).is_err());
        assert!(f.db.smart_playlists().unwrap().is_empty());
    }

    #[test]
    fn rules_round_trip_as_json() {
        let json = r#"{"match":"any","rules":[{"field":"lastPlayed","op":"notInLast","value":30},
            {"field":"albumArtist","op":"startsWith","value":"The"}],"limit":25,
            "sort":{"field":"plays","desc":true}}"#;
        let r: Rules = serde_json::from_str(json).unwrap();
        assert_eq!(r.mode, Match::Any);
        assert_eq!(r.rules[1].field, Field::AlbumArtist);
        assert_eq!(r.sort.as_ref().unwrap().seed, 0);
        assert_eq!(serde_json::from_str::<Rules>(&serde_json::to_string(&r).unwrap()).unwrap(), r);
        for (_, d) in defaults() {
            d.validate().unwrap();
        }
    }

    #[test]
    fn defaults_are_opt_in_and_not_duplicated() {
        let f = fixture("defaults");
        assert!(f.db.smart_playlists().unwrap().is_empty());
        assert_eq!(f.db.smart_add_defaults().unwrap(), defaults().len());
        assert_eq!(f.db.smart_add_defaults().unwrap(), 0);
        let lists = f.db.smart_playlists().unwrap();
        assert_eq!(lists.len(), defaults().len());
        let hires = lists.iter().find(|p| p.name == "Hi-res").unwrap();
        assert_eq!(hires.track_ids, vec![4]);
    }
}
