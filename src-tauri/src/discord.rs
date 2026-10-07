//! "Listening to" status on Discord, over the Discord desktop app's local IPC pipe. Does nothing
//! when Discord isn't running and reconnects when it starts.
//!
//! Each user connects their own Discord application (its name is what Discord shows after
//! "Listening to"), set up in Settings; nothing happens until they do.
//!
//! Discord can only show images from public URLs, and Reson's covers are local files. So the cover
//! is looked up on Apple's public iTunes Search API (album, then song; only names are sent). Music
//! that isn't on iTunes gets its own cover uploaded to a temporary anonymous host (uguu.se, 3 h,
//! falling back to Litterbox, 72 h); the link is reused until shortly before it expires.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};

use crate::db::Db;
use crate::presence::{PlayerEvent, PresenceTrack};

const REPO: &str = "https://github.com/osfv/Reson";
const LOGO: &str = "https://raw.githubusercontent.com/osfv/Reson/main/src-tauri/icons/128x128@2x.png";
const RECONNECT_EVERY: Duration = Duration::from_secs(15);
/// Albums whose cover couldn't be found or uploaded are tried again after this long.
const MISS_RETRY: i64 = 15 * 60;

pub struct DiscordCtl {
    pub enabled: AtomicBool,
    /// Look up album covers so Discord can show them.
    pub covers: AtomicBool,
    /// The user's own Discord application id.
    pub app_id: Mutex<Option<String>>,
}

impl DiscordCtl {
    fn app_id(&self) -> Option<String> {
        self.app_id.lock().ok().and_then(|id| id.clone()).filter(|id| !id.is_empty())
    }
}

#[derive(Clone, PartialEq)]
struct Shown {
    track: PresenceTrack,
    /// When the song started, in unix ms; moves on seek.
    start_ms: i64,
}

/// Application ids are Discord snowflakes: 17 to 20 digits.
pub fn valid_app_id(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// Connects with `app_id` and returns the Discord user name it reaches, so setup can confirm it.
pub fn test(app_id: &str) -> Result<String, String> {
    if !valid_app_id(app_id) {
        return Err("That doesn't look like an Application ID. It's a long number, 17 to 20 digits.".into());
    }
    let mut c = DiscordIpcClient::new(app_id);
    c.connect_ipc().map_err(|_| "Couldn't reach Discord. Make sure the Discord app is open on this PC.".to_string())?;
    c.send(serde_json::json!({ "v": 1, "client_id": app_id }), 0).map_err(|e| e.to_string())?;
    let (op, data) = c.recv().map_err(|e| format!("Discord didn't answer: {e}"))?;
    let _ = c.close();
    if op == 1 && data["evt"] == "READY" {
        let user = &data["data"]["user"];
        let name = user["global_name"].as_str().or(user["username"].as_str()).unwrap_or("you");
        return Ok(name.to_string());
    }
    let reason = data["message"].as_str().unwrap_or("it was rejected");
    Err(format!("Discord didn't accept that Application ID ({reason}). Copy it again from the General Information page."))
}

pub fn spawn(db: Arc<Db>, ctl: Arc<DiscordCtl>) -> Sender<PlayerEvent> {
    let (tx, rx) = mpsc::channel::<PlayerEvent>();
    thread::Builder::new()
        .name("reson-discord".into())
        .spawn(move || {
            let mut client: Option<(DiscordIpcClient, String)> = None;
            let mut last_attempt: Option<Instant> = None;
            let mut wanted: Option<Shown> = None;
            let mut shown: Option<Option<Shown>> = None;
            loop {
                match rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(PlayerEvent::State { track, playing, position }) => {
                        wanted = track.filter(|_| playing).map(|track| Shown {
                            start_ms: now_ms() - (position * 1000.0) as i64,
                            track,
                        });
                        // Small seek jitter shouldn't count as a change.
                        if let (Some(Some(s)), Some(w)) = (&shown, &wanted) {
                            if s.track == w.track && (s.start_ms - w.start_ms).abs() < 1500 {
                                wanted = Some(s.clone());
                            }
                        }
                        // Let bursts (skipping through tracks) settle before talking to Discord.
                        while let Ok(PlayerEvent::State { track, playing, position }) = rx.recv_timeout(Duration::from_millis(400)) {
                            wanted = track.filter(|_| playing).map(|track| Shown { start_ms: now_ms() - (position * 1000.0) as i64, track });
                        }
                    }
                    Ok(PlayerEvent::Scrobble { .. }) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }

                // Off, not set up yet, or switched to a different app: drop the connection.
                let app_id = ctl.app_id().filter(|_| ctl.enabled.load(Ordering::Relaxed));
                if client.as_ref().is_some_and(|(_, id)| Some(id) != app_id.as_ref()) {
                    if let Some((mut c, _)) = client.take() {
                        let _ = c.clear_activity();
                        let _ = c.close();
                    }
                    shown = None;
                    last_attempt = None;
                }
                let Some(app_id) = app_id else { continue };
                if client.is_none() {
                    if last_attempt.is_some_and(|t| t.elapsed() < RECONNECT_EVERY) {
                        continue;
                    }
                    last_attempt = Some(Instant::now());
                    let mut c = DiscordIpcClient::new(&app_id);
                    if c.connect().is_err() {
                        continue;
                    }
                    client = Some((c, app_id));
                    shown = None;
                }
                if shown.as_ref() == Some(&wanted) {
                    continue;
                }
                let cover = match &wanted {
                    Some(s) if ctl.covers.load(Ordering::Relaxed) => cover_url(&db, &s.track),
                    _ => None,
                };
                let (c, _) = client.as_mut().unwrap();
                let result = match &wanted {
                    Some(s) => c.set_activity(activity(s, cover.as_deref())),
                    None => c.clear_activity(),
                };
                if result.is_ok() {
                    shown = Some(wanted.clone());
                } else {
                    // Discord closed; reconnect on a later pass.
                    client = None;
                }
            }
            if let Some((mut c, _)) = client {
                let _ = c.clear_activity();
                let _ = c.close();
            }
        })
        .expect("spawn discord thread");
    tx
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn activity<'a>(s: &'a Shown, cover: Option<&'a str>) -> Activity<'a> {
    let end = s.start_ms + (s.track.duration * 1000.0) as i64;
    let mut assets = Assets::new().large_image(cover.unwrap_or(LOGO));
    // The album shows as a third line; a placeholder name is better left out.
    if !s.track.album.is_empty() && s.track.album != "Unknown Album" {
        assets = assets.large_text(s.track.album.as_str());
    }
    if cover.is_some() {
        assets = assets.small_image(LOGO).small_text("Reson");
    }
    Activity::new()
        .activity_type(ActivityType::Listening)
        .status_display_type(StatusDisplayType::Details)
        .details(s.track.title.as_str())
        .state(s.track.artist.as_str())
        .assets(assets)
        .timestamps(Timestamps::new().start(s.start_ms).end(end))
        .buttons(vec![Button::new("Try Reson today", REPO)])
}

/// Temporary hosts, best first: (upload endpoint, link domain, seconds to reuse a link).
/// uguu spreads files over subdomains (h., n., d.uguu.se), so links match on the domain.
const HOSTS: &[(&str, &str, i64)] = &[
    ("https://uguu.se/upload", "uguu.se", 150 * 60),
    ("https://litterbox.catbox.moe/resources/internals/api.php", "litter.catbox.moe", 70 * 3600),
];

/// Whether `url` is an https link on `domain` or one of its subdomains.
fn on_domain(url: &str, domain: &str) -> bool {
    let host = url.strip_prefix("https://").and_then(|rest| rest.split('/').next()).unwrap_or("");
    host == domain || host.strip_suffix(domain).is_some_and(|sub| sub.ends_with('.'))
}

/// How long a cached link stays usable: uploads expire, iTunes links don't.
fn ttl(url: &str) -> Option<i64> {
    HOSTS.iter().find(|(_, domain, _)| on_domain(url, domain)).map(|(_, _, ttl)| *ttl)
}

/// A public cover URL for the album, cached in the library.
fn cover_url(db: &Db, t: &PresenceTrack) -> Option<String> {
    let (cached, checked) = db.album_art_url(t.album_id);
    if let Some(at) = checked {
        let age = crate::db::now() - at;
        match &cached {
            Some(url) if ttl(url).is_none_or(|ttl| age < ttl) => return cached,
            None if age < MISS_RETRY => return None,
            _ => {}
        }
    }
    let found = itunes_cover(&t.album_artist, &t.album, "album", "collectionName")
        .or_else(|| itunes_cover(&t.artist, &t.title, "song", "trackName"))
        .or_else(|| upload_cover(db, t.album_id));
    let _ = db.set_album_art_url(t.album_id, found.as_deref());
    found
}

fn multipart(boundary: &str, fields: &[(&str, &str)], file_field: &str, image: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(image.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"cover.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(image);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Uploads the album's own cover (the 640 px copy Reson keeps), trying each host in turn.
fn upload_cover(db: &Db, album_id: i64) -> Option<String> {
    let image = std::fs::read(db.album_cover(album_id)?).ok()?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(12)))
        .http_status_as_error(false)
        .user_agent(concat!("Reson/", env!("CARGO_PKG_VERSION"), " (desktop music player)"))
        .build()
        .into();
    HOSTS.iter().find_map(|(endpoint, domain, _)| {
        let boundary = format!("reson-{:016x}", fastrand::u64(..));
        let body = if domain.contains("catbox") {
            multipart(&boundary, &[("reqtype", "fileupload"), ("time", "72h")], "fileToUpload", &image)
        } else {
            multipart(&boundary, &[], "files[]", &image)
        };
        let text = agent
            .post(*endpoint)
            .header("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
            .send(&body[..])
            .ok()?
            .body_mut()
            .read_to_string()
            .ok()?;
        // Litterbox answers with the bare link; uguu with JSON (`\/` escapes included).
        let url = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(json) => json["files"][0]["url"].as_str()?.to_string(),
            Err(_) => text.trim().to_string(),
        };
        on_domain(&url, domain).then_some(url)
    })
}

/// Searches iTunes for `artist` + `name` (an album or a song) and returns the artwork of the
/// first result whose artist and `name_field` match.
fn itunes_cover(artist: &str, name: &str, entity: &str, name_field: &str) -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .user_agent(concat!("Reson/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let body: serde_json::Value = agent
        .get("https://itunes.apple.com/search")
        .query("term", &format!("{artist} {name}"))
        .query("entity", entity)
        .query("limit", "10")
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()?;
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let (want_name, want_artist) = (norm(name), norm(artist));
    if want_name.is_empty() || want_artist.is_empty() {
        return None;
    }
    let pick = body["results"].as_array()?.iter().find(|r| {
        let n = norm(r[name_field].as_str().unwrap_or(""));
        let a = norm(r["artistName"].as_str().unwrap_or(""));
        // "A Great Chaos (Deluxe)" locally vs "A Great Chaos" on iTunes, and the other way round.
        let name_ok = !n.is_empty() && (n.starts_with(&want_name) || want_name.starts_with(&n));
        name_ok && !a.is_empty() && (a.contains(&want_artist) || want_artist.contains(&a))
    })?;
    // The API returns 100 px art; the same URL scheme serves larger sizes.
    Some(pick["artworkUrl100"].as_str()?.replace("100x100bb", "512x512bb"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ids_are_snowflakes() {
        assert!(valid_app_id("1234567890123456789"));
        assert!(!valid_app_id("123"));
        assert!(!valid_app_id("15563403366479996a9"));
    }

    #[test]
    fn uploads_expire_itunes_links_dont() {
        assert_eq!(ttl("https://litter.catbox.moe/abc.jpg"), Some(70 * 3600));
        assert!(ttl("https://h.uguu.se/abc.jpg").is_some());
        assert!(ttl("https://d.uguu.se/abc.jpg").is_some());
        assert_eq!(ttl("https://uguu.se.evil.example/abc.jpg"), None);
        assert_eq!(ttl("https://notuguu.se/abc.jpg"), None);
        assert_eq!(ttl("https://is1-ssl.mzstatic.com/image/x/512x512bb.jpg"), None);
    }
}
