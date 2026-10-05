//! What the audio engine tells outside listeners (Discord status, Last.fm) about playback.

#[derive(Clone, Debug, PartialEq)]
pub struct PresenceTrack {
    pub id: i64,
    pub album_id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub duration: f64,
}

#[derive(Clone, Debug)]
pub enum PlayerEvent {
    /// Sent whenever playback state is published (track change, play/pause, seek).
    State { track: Option<PresenceTrack>, playing: bool, position: f64 },
    /// The current track has been played long enough to count as a listen.
    Scrobble { track: PresenceTrack, started_at: i64 },
}
