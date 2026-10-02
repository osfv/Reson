//! Per-track signal processing that sits between the decoder and rodio's mixer.
//!
//! Every track is wrapped in [`Processed`], which applies three gains:
//! - `fade`: driven by the engine for click-free pause/seek and for crossfades, ramped over a
//!   duration chosen per change;
//! - `norm`: loudness normalization for this track;
//! - `volume`: the engine-wide volume, shared by all tracks so it also affects a fading-out deck.
//!
//! `norm * volume` is always smoothed over a short fixed ramp so slider moves never zipper.
//! The primary track also feeds a mono copy of its signal into a [`Tap`] for the visualizer.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

/// f32 stored in an AtomicU32.
#[derive(Default)]
pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed)
    }
}

/// Engine-wide controls shared by every track.
pub struct Master {
    pub volume: AtomicF32,
}

/// Per-track controls, written by the engine thread and read by the audio thread.
pub struct TrackCtl {
    fade_target: AtomicF32,
    fade_ms: AtomicU32,
    /// Bumped on every fade change so the audio thread knows to re-plan the ramp.
    fade_version: AtomicU32,
    pub norm: AtomicF32,
    pub tap: AtomicBool,
}

impl TrackCtl {
    pub fn new(fade: f32, norm: f32) -> Arc<Self> {
        Arc::new(Self {
            fade_target: AtomicF32::new(fade),
            fade_ms: AtomicU32::new(0),
            fade_version: AtomicU32::new(0),
            norm: AtomicF32::new(norm),
            tap: AtomicBool::new(false),
        })
    }

    /// Ramp the fade gain to `target` over `ms` milliseconds (0 = jump).
    pub fn fade_to(&self, target: f32, ms: u32) {
        self.fade_target.set(target);
        self.fade_ms.store(ms, Ordering::Relaxed);
        self.fade_version.fetch_add(1, Ordering::Release);
    }
}

/// Ring buffer of recent mono samples for spectrum analysis.
pub struct Tap {
    pub ring: Mutex<Ring>,
}

pub struct Ring {
    pub data: Vec<f32>,
    pub write: usize,
    pub sample_rate: u32,
    /// Total samples ever written; lets the reader tell whether anything new arrived.
    pub written: u64,
}

pub const RING_LEN: usize = 4096;

impl Tap {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { ring: Mutex::new(Ring { data: vec![0.0; RING_LEN], write: 0, sample_rate: 44_100, written: 0 }) })
    }
}

struct Smooth {
    cur: f32,
    target: f32,
    step: f32,
}

impl Smooth {
    fn new(v: f32) -> Self {
        Self { cur: v, target: v, step: 0.0 }
    }
    fn plan(&mut self, target: f32, frames: f32) {
        self.target = target;
        if frames <= 1.0 {
            self.cur = target;
            self.step = 0.0;
        } else {
            self.step = (target - self.cur) / frames;
        }
    }
    fn tick(&mut self) -> f32 {
        if self.cur != self.target {
            self.cur += self.step;
            if (self.step >= 0.0 && self.cur >= self.target) || (self.step < 0.0 && self.cur <= self.target) {
                self.cur = self.target;
            }
        }
        self.cur
    }
}

/// How often (in frames) the audio thread re-reads the shared controls.
const CONTROL_EVERY: u32 = 64;
const LEVEL_RAMP_MS: f32 = 40.0;
const TAP_CHUNK: usize = 256;

pub struct Processed<S: Source> {
    inner: S,
    master: Arc<Master>,
    ctl: Arc<TrackCtl>,
    tap: Arc<Tap>,
    channels: u16,
    rate: f32,
    channel: u16,
    frame_counter: u32,
    seen_version: u32,
    fade: Smooth,
    level: Smooth,
    gain: f32,
    mono_acc: f32,
    pending: Vec<f32>,
}

impl<S: Source> Processed<S> {
    pub fn new(inner: S, master: Arc<Master>, ctl: Arc<TrackCtl>, tap: Arc<Tap>) -> Self {
        let channels = inner.channels().get();
        let rate = inner.sample_rate().get() as f32;
        let fade = ctl.fade_target.get();
        let level = ctl.norm.get() * master.volume.get();
        Self {
            inner,
            master,
            seen_version: ctl.fade_version.load(Ordering::Acquire),
            ctl,
            tap,
            channels,
            rate,
            channel: 0,
            frame_counter: 0,
            fade: Smooth::new(fade),
            level: Smooth::new(level),
            gain: fade * level,
            mono_acc: 0.0,
            pending: Vec::with_capacity(TAP_CHUNK),
        }
    }

    fn refresh_controls(&mut self) {
        let v = self.ctl.fade_version.load(Ordering::Acquire);
        if v != self.seen_version {
            self.seen_version = v;
            let ms = self.ctl.fade_ms.load(Ordering::Relaxed) as f32;
            self.fade.plan(self.ctl.fade_target.get(), ms / 1000.0 * self.rate);
        }
        let level = self.ctl.norm.get() * self.master.volume.get();
        if level != self.level.target {
            self.level.plan(level, LEVEL_RAMP_MS / 1000.0 * self.rate);
        }
    }

    fn flush_tap(&mut self) {
        if let Ok(mut ring) = self.tap.ring.try_lock() {
            ring.sample_rate = self.rate as u32;
            for &s in &self.pending {
                let w = ring.write;
                ring.data[w] = s;
                ring.write = (w + 1) % RING_LEN;
            }
            ring.written += self.pending.len() as u64;
        }
        self.pending.clear();
    }
}

impl<S: Source> Iterator for Processed<S> {
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        let s = self.inner.next()?;
        if self.channel == 0 {
            if self.frame_counter == 0 {
                self.refresh_controls();
            }
            self.frame_counter = (self.frame_counter + 1) % CONTROL_EVERY;
            self.gain = self.fade.tick() * self.level.tick();
        }
        self.mono_acc += s;
        self.channel += 1;
        if self.channel >= self.channels {
            self.channel = 0;
            if self.ctl.tap.load(Ordering::Relaxed) {
                // Pre-volume, post-fade: visuals shouldn't shrink when you turn the volume down.
                self.pending.push(self.mono_acc / self.channels as f32 * self.fade.cur);
                if self.pending.len() >= TAP_CHUNK {
                    self.flush_tap();
                }
            }
            self.mono_acc = 0.0;
        }
        Some(s * self.gain)
    }
}

impl<S: Source> Source for Processed<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.channel = 0;
        self.mono_acc = 0.0;
        self.inner.try_seek(pos)
    }
}

/// Converts a loudness measurement into a linear normalization gain targeting `target_lufs`,
/// limited so the track's peak never exceeds full scale.
pub fn normalization_gain(loudness: Option<f64>, peak: Option<f64>, target_lufs: f64) -> f32 {
    let Some(l) = loudness else { return 1.0 };
    let mut db = (target_lufs - l).clamp(-24.0, 6.0);
    if let Some(p) = peak.filter(|p| *p > 0.0) {
        db = db.min(-20.0 * p.log10());
    }
    10f64.powf(db / 20.0) as f32
}

/// Integrated loudness (ITU-R BS.1770 / EBU R128, gated) and sample peak of decoded audio.
pub struct LoudnessMeter {
    channels: usize,
    rate: f64,
    filters: Vec<[Biquad; 2]>,
    block_sum: f64,
    block_frames: usize,
    /// Mean-square energy of each 100 ms step; 400 ms blocks are built from 4 consecutive steps.
    steps: Vec<f64>,
    peak: f32,
    channel: usize,
    frame_energy: f64,
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// K-weighting filters from BS.1770, derived for an arbitrary sample rate.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    use std::f64::consts::PI;
    // Stage 1: high shelf.
    let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (PI * f0 / rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        z1: 0.0,
        z2: 0.0,
    };
    // Stage 2: high pass.
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (PI * f0 / rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        z1: 0.0,
        z2: 0.0,
    };
    [shelf, hp]
}

impl LoudnessMeter {
    pub fn new(channels: usize, rate: u32) -> Self {
        let rate = rate as f64;
        Self {
            channels: channels.max(1),
            rate,
            filters: (0..channels.max(1)).map(|_| k_weighting(rate)).collect(),
            block_sum: 0.0,
            block_frames: 0,
            steps: Vec::new(),
            peak: 0.0,
            channel: 0,
            frame_energy: 0.0,
        }
    }

    pub fn push(&mut self, s: f32) {
        self.peak = self.peak.max(s.abs());
        let [a, b] = &mut self.filters[self.channel];
        let y = b.process(a.process(s as f64));
        // Channel weights are 1.0 for L/R/C; surround channels are rare in music libraries.
        self.frame_energy += y * y;
        self.channel += 1;
        if self.channel == self.channels {
            self.channel = 0;
            self.block_sum += self.frame_energy;
            self.frame_energy = 0.0;
            self.block_frames += 1;
            if self.block_frames as f64 >= self.rate * 0.1 {
                self.steps.push(self.block_sum / self.block_frames as f64);
                self.block_sum = 0.0;
                self.block_frames = 0;
            }
        }
    }

    /// Returns (integrated LUFS, sample peak), or None for silence / very short input.
    pub fn finish(&self) -> Option<(f64, f64)> {
        let blocks: Vec<f64> = self.steps.windows(4).map(|w| w.iter().sum::<f64>() / 4.0).collect();
        let lufs = |ms: f64| -0.691 + 10.0 * ms.log10();
        let abs_gated: Vec<f64> = blocks.into_iter().filter(|&b| b > 0.0 && lufs(b) > -70.0).collect();
        if abs_gated.is_empty() {
            return None;
        }
        let mean = abs_gated.iter().sum::<f64>() / abs_gated.len() as f64;
        let rel_threshold = lufs(mean) - 10.0;
        let gated: Vec<f64> = abs_gated.into_iter().filter(|&b| lufs(b) > rel_threshold).collect();
        if gated.is_empty() {
            return None;
        }
        Some((lufs(gated.iter().sum::<f64>() / gated.len() as f64), self.peak as f64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loudness_of_full_scale_sine_is_near_reference() {
        // A 997 Hz sine at -20 dBFS, stereo, should read about -20 LUFS... plus the +3 dB stereo sum.
        let rate = 48_000;
        let mut m = LoudnessMeter::new(2, rate);
        let amp = 10f32.powf(-20.0 / 20.0);
        for i in 0..rate * 5 {
            let s = amp * (2.0 * std::f32::consts::PI * 997.0 * i as f32 / rate as f32).sin();
            m.push(s);
            m.push(s);
        }
        let (lufs, peak) = m.finish().unwrap();
        assert!((lufs - (-20.0)).abs() < 0.6, "{lufs}");
        assert!((peak - amp as f64).abs() < 1e-3);
    }

    #[test]
    fn normalization_respects_peak() {
        assert!((normalization_gain(Some(-14.0), None, -14.0) - 1.0).abs() < 1e-6);
        // Quiet track wants +6 dB, but its peak at 0.9 only allows ~+0.9 dB.
        let g = normalization_gain(Some(-20.0), Some(0.9), -14.0);
        assert!(g * 0.9 <= 1.0001);
        assert_eq!(normalization_gain(None, None, -14.0), 1.0);
    }

    #[test]
    fn smooth_reaches_target() {
        let mut s = Smooth::new(0.0);
        s.plan(1.0, 10.0);
        for _ in 0..12 {
            s.tick();
        }
        assert_eq!(s.cur, 1.0);
        s.plan(0.25, 0.0);
        assert_eq!(s.tick(), 0.25);
    }
}
