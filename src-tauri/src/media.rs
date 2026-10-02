//! OS media integration: the Windows media overlay and hardware media keys (MPRIS on Linux).
//! Owned by the audio thread; OS events are forwarded back into the engine as `Cmd`s.

use std::ffi::c_void;
use std::sync::mpsc::Sender;
use std::time::Duration;

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};

use crate::player::Cmd;

/// How far the overlay's skip-forward/back buttons jump when the OS doesn't say.
const SEEK_STEP: f64 = 10.0;

pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover: Option<String>,
    pub duration: f64,
}

pub struct MediaSession {
    controls: MediaControls,
}

impl MediaSession {
    pub fn new(hwnd: Option<isize>, tx: Sender<Cmd>) -> Option<Self> {
        // souvlaki panics (taking the audio thread down with it) instead of erroring without a window.
        if cfg!(windows) && hwnd.is_none() {
            return None;
        }
        let config = PlatformConfig {
            display_name: "Reson",
            dbus_name: "reson",
            hwnd: hwnd.map(|h| h as *mut c_void),
        };
        let mut controls = MediaControls::new(config).ok()?;
        controls
            .attach(move |event| {
                let sign = |d: SeekDirection| if matches!(d, SeekDirection::Forward) { 1.0 } else { -1.0 };
                let cmd = match event {
                    MediaControlEvent::Play => Cmd::Play,
                    MediaControlEvent::Pause | MediaControlEvent::Stop => Cmd::Pause,
                    MediaControlEvent::Toggle => Cmd::Toggle,
                    MediaControlEvent::Next => Cmd::Next,
                    MediaControlEvent::Previous => Cmd::Prev,
                    MediaControlEvent::SetPosition(MediaPosition(d)) => Cmd::Seek(d.as_secs_f64()),
                    MediaControlEvent::SeekBy(dir, d) => Cmd::SeekBy(sign(dir) * d.as_secs_f64()),
                    MediaControlEvent::Seek(dir) => Cmd::SeekBy(sign(dir) * SEEK_STEP),
                    _ => return,
                };
                let _ = tx.send(cmd);
            })
            .ok()?;
        Some(Self { controls })
    }

    pub fn set_track(&mut self, info: Option<&NowPlayingInfo>) {
        let cover = info.and_then(|i| i.cover.as_ref()).map(|c| format!("file://{c}"));
        let _ = self.controls.set_metadata(match info {
            Some(i) => MediaMetadata {
                title: Some(&i.title),
                artist: Some(&i.artist),
                album: Some(&i.album),
                cover_url: cover.as_deref(),
                duration: Some(Duration::from_secs_f64(i.duration.max(0.0))),
            },
            None => MediaMetadata::default(),
        });
    }

    pub fn set_state(&mut self, has_track: bool, playing: bool, position: f64) {
        let progress = Some(MediaPosition(Duration::from_secs_f64(position.max(0.0))));
        let _ = self.controls.set_playback(match (has_track, playing) {
            (false, _) => MediaPlayback::Stopped,
            (true, true) => MediaPlayback::Playing { progress },
            (true, false) => MediaPlayback::Paused { progress },
        });
    }
}
