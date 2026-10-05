//! Last.fm scrobbling: "now playing" updates and listens, queued in the library so nothing is
//! lost while offline. Uses Last.fm's desktop auth flow: the user approves Reson in the browser,
//! then Reson trades the approved token for a session key, stored locally.
//!
//! Every user brings their own API account (key + shared secret, created on last.fm and entered
//! in Settings), stored in the local library database.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::{Db, PendingScrobble};
use crate::presence::{PlayerEvent, PresenceTrack};

const API: &str = "https://ws.audioscrobbler.com/2.0/";
const SESSION_KEY: &str = "lastfm_session";
const KEYS_KEY: &str = "lastfm_keys";
const FLUSH_EVERY: Duration = Duration::from_secs(300);

/// The user's own Last.fm API account.
#[derive(Serialize, Deserialize, Clone)]
pub struct Keys {
    pub key: String,
    pub secret: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    pub key: String,
    pub name: String,
}

pub struct LastFm {
    db: Arc<Db>,
    pub session: Mutex<Option<Session>>,
    keys: Mutex<Option<Keys>>,
}

#[derive(Debug)]
enum LfmError {
    Net(String),
    Api(i64, String),
}

impl std::fmt::Display for LfmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LfmError::Net(e) => write!(f, "Couldn't reach Last.fm: {e}"),
            LfmError::Api(_, m) => write!(f, "Last.fm: {m}"),
        }
    }
}

/// Last.fm's request signature: md5 of the sorted key/value pairs followed by the secret.
fn signature(params: &[(String, String)], secret: &str) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().filter(|(k, _)| k != "format" && k != "callback").collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut text: String = sorted.iter().map(|(k, v)| format!("{k}{v}")).collect();
    text.push_str(secret);
    Md5::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn call(keys: &Keys, method: &str, mut params: Vec<(String, String)>, post: bool) -> Result<serde_json::Value, LfmError> {
    params.push(("method".into(), method.into()));
    params.push(("api_key".into(), keys.key.clone()));
    let sig = signature(&params, &keys.secret);
    params.push(("api_sig".into(), sig));
    params.push(("format".into(), "json".into()));

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .user_agent(concat!("Reson/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let pairs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut res = if post {
        agent.post(API).send_form(pairs)
    } else {
        agent.get(API).query_pairs(pairs).call()
    }
    .map_err(|e| LfmError::Net(e.to_string()))?;
    let body: serde_json::Value = res.body_mut().read_json().map_err(|e| LfmError::Net(e.to_string()))?;
    if let Some(code) = body["error"].as_i64() {
        return Err(LfmError::Api(code, body["message"].as_str().unwrap_or("request failed").to_string()));
    }
    Ok(body)
}

fn track_params(t: &PresenceTrack) -> Vec<(String, String)> {
    let mut p = vec![
        ("artist".into(), t.artist.clone()),
        ("track".into(), t.title.clone()),
        ("album".into(), t.album.clone()),
        ("duration".into(), (t.duration.round() as i64).to_string()),
    ];
    if t.album_artist != t.artist {
        p.push(("albumArtist".into(), t.album_artist.clone()));
    }
    p
}

impl LastFm {
    pub fn new(db: Arc<Db>) -> Arc<Self> {
        let session = db.setting(SESSION_KEY).and_then(|s| serde_json::from_str(&s).ok());
        let keys = db.setting(KEYS_KEY).and_then(|s| serde_json::from_str(&s).ok());
        Arc::new(Self { db, session: Mutex::new(session), keys: Mutex::new(keys) })
    }

    fn session(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|s| s.clone())
    }

    fn keys(&self) -> Result<Keys, String> {
        self.keys.lock().ok().and_then(|k| k.clone()).ok_or_else(|| "Set up Last.fm in Settings first".to_string())
    }

    /// Last four characters of the API key, to show which one is in use.
    pub fn key_hint(&self) -> Option<String> {
        let keys = self.keys.lock().ok()?.clone()?;
        Some(keys.key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect())
    }

    /// Checks the key and secret with Last.fm (a signed request fails if either is wrong), then
    /// saves them. Changing keys signs out the old session.
    pub fn set_keys(&self, key: &str, secret: &str) -> Result<(), String> {
        let keys = Keys { key: key.trim().to_string(), secret: secret.trim().to_string() };
        if keys.key.len() != 32 || keys.secret.len() != 32 || !(keys.key.chars().chain(keys.secret.chars())).all(|c| c.is_ascii_hexdigit()) {
            return Err("Both the API key and the shared secret are 32 letters and numbers. Copy them again from your API account page.".into());
        }
        match call(&keys, "auth.getToken", vec![], false) {
            Ok(_) => {}
            Err(LfmError::Api(10, _)) => return Err("Last.fm doesn't know that API key.".into()),
            Err(LfmError::Api(13, _)) => return Err("The API key is right, but the shared secret doesn't match it.".into()),
            Err(LfmError::Api(26, _)) => return Err("Last.fm has suspended that API key.".into()),
            Err(e) => return Err(e.to_string()),
        }
        let changed = self.keys.lock().ok().and_then(|k| k.clone()).is_none_or(|old| old.key != keys.key);
        let _ = self.db.set_setting(KEYS_KEY, &serde_json::to_string(&keys).unwrap_or_default());
        if let Ok(mut slot) = self.keys.lock() {
            *slot = Some(keys);
        }
        if changed {
            self.disconnect();
        }
        Ok(())
    }

    pub fn configured(&self) -> bool {
        self.keys.lock().map(|k| k.is_some()).unwrap_or(false)
    }

    /// Forgets the keys and the session.
    pub fn clear_keys(&self) {
        self.disconnect();
        if let Ok(mut k) = self.keys.lock() {
            *k = None;
        }
        let _ = self.db.set_setting(KEYS_KEY, "null");
    }

    pub fn user(&self) -> Option<String> {
        self.session().map(|s| s.name)
    }

    pub fn disconnect(&self) {
        if let Ok(mut s) = self.session.lock() {
            *s = None;
        }
        let _ = self.db.set_setting(SESSION_KEY, "null");
    }

    /// Starts sign-in. Returns the token and the page where the user approves Reson.
    pub fn begin_auth(&self) -> Result<(String, String), String> {
        let keys = self.keys()?;
        let body = call(&keys, "auth.getToken", vec![], false).map_err(|e| e.to_string())?;
        let token = body["token"].as_str().ok_or("Last.fm didn't return a token")?.to_string();
        let url = format!("https://www.last.fm/api/auth/?api_key={}&token={token}", keys.key);
        Ok((token, url))
    }

    /// Ok(None) until the user has approved the token in the browser.
    pub fn finish_auth(&self, token: &str) -> Result<Option<String>, String> {
        match call(&self.keys()?, "auth.getSession", vec![("token".into(), token.into())], false) {
            Ok(body) => {
                let s = &body["session"];
                let session = Session {
                    key: s["key"].as_str().ok_or("Last.fm didn't return a session")?.into(),
                    name: s["name"].as_str().unwrap_or("").into(),
                };
                let _ = self.db.set_setting(SESSION_KEY, &serde_json::to_string(&session).unwrap_or_default());
                let name = session.name.clone();
                if let Ok(mut slot) = self.session.lock() {
                    *slot = Some(session);
                }
                Ok(Some(name))
            }
            // 14: not authorized yet; 4/15: token unknown or expired.
            Err(LfmError::Api(14, _)) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn now_playing(&self, app: &AppHandle, t: &PresenceTrack) {
        let (Some(s), Ok(keys)) = (self.session(), self.keys()) else { return };
        let mut p = track_params(t);
        p.push(("sk".into(), s.key));
        self.handle_auth_error(app, call(&keys, "track.updateNowPlaying", p, true).err());
    }

    /// Sends queued listens, 50 at a time. Network failures leave them queued for later.
    fn flush(&self, app: &AppHandle) {
        let (Some(s), Ok(keys)) = (self.session(), self.keys()) else { return };
        loop {
            let batch: Vec<PendingScrobble> = self.db.pending_scrobbles(50).unwrap_or_default();
            if batch.is_empty() {
                return;
            }
            let mut p: Vec<(String, String)> = vec![("sk".into(), s.key.clone())];
            for (i, sc) in batch.iter().enumerate() {
                p.push((format!("artist[{i}]"), sc.artist.clone()));
                p.push((format!("track[{i}]"), sc.title.clone()));
                p.push((format!("album[{i}]"), sc.album.clone()));
                p.push((format!("timestamp[{i}]"), sc.played_at.to_string()));
                p.push((format!("duration[{i}]"), (sc.duration.round() as i64).to_string()));
                if sc.album_artist != sc.artist {
                    p.push((format!("albumArtist[{i}]"), sc.album_artist.clone()));
                }
            }
            match call(&keys, "track.scrobble", p, true) {
                Ok(_) => {
                    let _ = self.db.remove_scrobbles(&batch.iter().map(|s| s.id).collect::<Vec<_>>());
                }
                // Rejected outright (bad data): drop them rather than retrying forever.
                Err(LfmError::Api(code, _)) if code != 9 && code != 11 && code != 16 && code != 29 => {
                    let _ = self.db.remove_scrobbles(&batch.iter().map(|s| s.id).collect::<Vec<_>>());
                }
                Err(e) => {
                    self.handle_auth_error(app, Some(e));
                    return;
                }
            }
        }
    }

    /// Error 9 means the user revoked Reson's access on Last.fm.
    fn handle_auth_error(&self, app: &AppHandle, err: Option<LfmError>) {
        if let Some(LfmError::Api(9, _)) = err {
            self.disconnect();
            let _ = app.emit("lastfm:changed", ());
            let _ = app.emit("player:error", "Last.fm signed Reson out. Connect again in Settings to keep scrobbling.");
        }
    }
}

pub fn spawn(app: AppHandle, lastfm: Arc<LastFm>) -> Sender<PlayerEvent> {
    let (tx, rx) = mpsc::channel::<PlayerEvent>();
    thread::Builder::new()
        .name("reson-lastfm".into())
        .spawn(move || {
            let mut last_announced: Option<i64> = None;
            let mut last_flush = Instant::now() - FLUSH_EVERY;
            loop {
                match rx.recv_timeout(Duration::from_secs(30)) {
                    Ok(PlayerEvent::State { track, playing, .. }) => {
                        let id = track.as_ref().filter(|_| playing).map(|t| t.id);
                        if id.is_some() && id != last_announced {
                            if let Some(t) = &track {
                                lastfm.now_playing(&app, t);
                            }
                        }
                        if id.is_some() {
                            last_announced = id;
                        }
                    }
                    Ok(PlayerEvent::Scrobble { track, started_at }) => {
                        if lastfm.session().is_some() {
                            let _ = lastfm.db.queue_scrobble(&PendingScrobble {
                                id: 0,
                                artist: track.artist,
                                title: track.title,
                                album: track.album,
                                album_artist: track.album_artist,
                                duration: track.duration,
                                played_at: started_at,
                            });
                            last_flush = Instant::now() - FLUSH_EVERY;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if last_flush.elapsed() >= FLUSH_EVERY {
                    last_flush = Instant::now();
                    lastfm.flush(&app);
                }
            }
        })
        .expect("spawn last.fm thread");
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_lastfm_rules() {
        // md5("api_keyxxxxmethodauth.getTokenmysecret"); format is never signed.
        let params = vec![
            ("method".to_string(), "auth.getToken".to_string()),
            ("api_key".to_string(), "xxxx".to_string()),
            ("format".to_string(), "json".to_string()),
        ];
        let expected: String = Md5::digest(b"api_keyxxxxmethodauth.getTokenmysecret").iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(signature(&params, "mysecret"), expected);
    }
}
