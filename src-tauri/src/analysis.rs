//! Visualizer analysis. Reads the primary track's [`Tap`], runs an FFT ~40 times a second and emits
//! log-spaced band levels plus a bass envelope and beat flag as `player:spectrum` events. Only runs
//! while the UI has asked for it, so it costs nothing when Now Playing is closed.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dsp::{Tap, RING_LEN};

const N: usize = 2048;
pub const BANDS: usize = 48;
const FRAME: Duration = Duration::from_millis(25);
const MIN_HZ: f32 = 35.0;
const MAX_HZ: f32 = 16_000.0;

#[derive(Serialize, Clone)]
struct Spectrum {
    /// 0..=255 per band, low to high frequency.
    bands: Vec<u8>,
    /// Smoothed low-frequency energy, 0..1.
    bass: f32,
    /// True on frames where a kick/onset was detected.
    beat: bool,
}

pub struct Analyzer {
    pub enabled: Arc<AtomicBool>,
    /// The tap currently feeding the analyzer; swapped by the engine on track changes.
    pub tap: Arc<Mutex<Arc<Tap>>>,
}

struct Fft {
    cos: Vec<f32>,
    sin: Vec<f32>,
    rev: Vec<usize>,
    window: Vec<f32>,
}

impl Fft {
    fn new() -> Self {
        let bits = N.trailing_zeros();
        Self {
            cos: (0..N / 2).map(|i| (2.0 * PI * i as f32 / N as f32).cos()).collect(),
            sin: (0..N / 2).map(|i| -(2.0 * PI * i as f32 / N as f32).sin()).collect(),
            rev: (0..N).map(|i| i.reverse_bits() >> (usize::BITS - bits)).collect(),
            window: (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (N - 1) as f32).cos()).collect(),
        }
    }

    /// Magnitudes of the first N/2 bins.
    fn magnitudes(&self, input: &[f32]) -> Vec<f32> {
        let mut re: Vec<f32> = (0..N).map(|i| input[self.rev[i]] * self.window[self.rev[i]]).collect();
        let mut im = vec![0.0f32; N];
        let mut size = 2;
        while size <= N {
            let half = size / 2;
            let step = N / size;
            for start in (0..N).step_by(size) {
                for k in 0..half {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * c - im[b] * s;
                    let ti = re[b] * s + im[b] * c;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            size *= 2;
        }
        (0..N / 2).map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt() / (N as f32 / 4.0)).collect()
    }
}

/// FFT bins covering `lo..hi` Hz, kept inside the spectrum. Bands above Nyquist (files sampled
/// below ~32 kHz) collapse onto the top bin instead of indexing past the end.
fn band_bins(lo: f32, hi: f32, bin_hz: f32) -> std::ops::Range<usize> {
    let i0 = ((lo / bin_hz) as usize).clamp(1, N / 2 - 1);
    let i1 = ((hi / bin_hz).ceil() as usize).clamp(i0 + 1, N / 2);
    i0..i1
}

pub fn spawn(app: AppHandle, initial: Arc<Tap>) -> Analyzer {
    let enabled = Arc::new(AtomicBool::new(false));
    let tap = Arc::new(Mutex::new(initial));
    let (en, tp) = (enabled.clone(), tap.clone());
    thread::Builder::new()
        .name("reson-analysis".into())
        .spawn(move || run(app, en, tp))
        .expect("spawn analysis thread");
    Analyzer { enabled, tap }
}

fn run(app: AppHandle, enabled: Arc<AtomicBool>, tap: Arc<Mutex<Arc<Tap>>>) {
    let fft = Fft::new();
    let mut levels = [0f32; BANDS];
    let mut ceiling = -20f32;
    let mut bass = 0f32;
    let mut bass_avg = 0f32;
    let mut last_beat = Instant::now();
    let mut last_written = 0u64;
    let mut idle_frames = 0u32;
    let mut buf = vec![0f32; N];

    loop {
        let started = Instant::now();
        if !enabled.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(120));
            continue;
        }
        let current = tap.lock().map(|t| t.clone()).ok();
        let (rate, fresh) = match current.as_ref().and_then(|t| t.ring.lock().ok()) {
            Some(ring) => {
                let fresh = ring.written != last_written;
                last_written = ring.written;
                for (i, slot) in buf.iter_mut().enumerate() {
                    *slot = ring.data[(ring.write + RING_LEN - N + i) % RING_LEN];
                }
                (ring.sample_rate as f32, fresh)
            }
            None => (44_100.0, false),
        };

        idle_frames = if fresh { 0 } else { idle_frames + 1 };
        // Paused or stopped: let the bars fall for a moment, then go quiet.
        if idle_frames > 40 {
            thread::sleep(FRAME);
            continue;
        }

        let mags = if fresh { fft.magnitudes(&buf) } else { vec![0.0; N / 2] };
        let bin_hz = rate / N as f32;
        let mut dbs = [0f32; BANDS];
        for (b, db) in dbs.iter_mut().enumerate() {
            let lo = MIN_HZ * (MAX_HZ / MIN_HZ).powf(b as f32 / BANDS as f32);
            let hi = MIN_HZ * (MAX_HZ / MIN_HZ).powf((b + 1) as f32 / BANDS as f32);
            let peak = mags[band_bins(lo, hi, bin_hz)].iter().cloned().fold(0.0, f32::max);
            // Music falls off ~3-4.5 dB per octave; compensate so the highs aren't flat on the floor.
            let center = (lo * hi).sqrt();
            let tilt_db = (4.5 * (center / 1000.0).log2()).clamp(-6.0, 12.0);
            *db = 20.0 * (peak + 1e-7).log10() + tilt_db;
        }
        // Auto-range to this song: loud masters would otherwise peg every band near the top.
        let frame_max = dbs.iter().cloned().fold(f32::MIN, f32::max);
        ceiling = if frame_max > ceiling { frame_max } else { ceiling - 0.08 }.max(-30.0);
        let floor = ceiling - 42.0;
        let mut out = Vec::with_capacity(BANDS);
        for (level, db) in levels.iter_mut().zip(dbs) {
            let target = if fresh { ((db - floor) / (ceiling - floor)).clamp(0.0, 1.0).powf(1.6) } else { 0.0 };
            // Fast attack, slower release.
            *level = if target > *level { *level + (target - *level) * 0.6 } else { *level + (target - *level) * 0.18 };
            out.push((*level * 255.0) as u8);
        }

        let low_end = ((150.0 / bin_hz) as usize).max(2);
        let energy = mags[1..low_end].iter().map(|m| m * m).sum::<f32>().sqrt();
        bass_avg = bass_avg * 0.96 + energy * 0.04;
        let beat = fresh && energy > bass_avg * 1.45 && energy > 0.02 && last_beat.elapsed() > Duration::from_millis(220);
        if beat {
            last_beat = Instant::now();
        }
        let norm = (energy / (bass_avg * 2.2 + 1e-4)).clamp(0.0, 1.0);
        bass = if norm > bass { bass + (norm - bass) * 0.55 } else { bass + (norm - bass) * 0.12 };

        let _ = app.emit("player:spectrum", Spectrum { bands: out, bass, beat });
        if let Some(rest) = FRAME.checked_sub(started.elapsed()) {
            thread::sleep(rest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_bins_stay_in_range_for_low_sample_rates() {
        for rate in [8_000.0, 11_025.0, 16_000.0, 22_050.0, 44_100.0, 192_000.0] {
            let bin_hz = rate / N as f32;
            for b in 0..BANDS {
                let lo = MIN_HZ * (MAX_HZ / MIN_HZ).powf(b as f32 / BANDS as f32);
                let hi = MIN_HZ * (MAX_HZ / MIN_HZ).powf((b + 1) as f32 / BANDS as f32);
                let r = band_bins(lo, hi, bin_hz);
                assert!(r.start < r.end && r.end <= N / 2, "rate {rate} band {b}: {r:?}");
            }
        }
    }

    #[test]
    fn fft_finds_a_tone() {
        let fft = Fft::new();
        let rate = 48_000.0;
        let hz = 1_000.0;
        let input: Vec<f32> = (0..N).map(|i| (2.0 * PI * hz * i as f32 / rate).sin()).collect();
        let mags = fft.magnitudes(&input);
        let peak_bin = mags.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        let expected = (hz / (rate / N as f32)).round() as usize;
        assert!(peak_bin.abs_diff(expected) <= 1, "{peak_bin} vs {expected}");
    }
}
