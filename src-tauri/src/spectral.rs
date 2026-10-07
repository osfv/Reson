//! Fake-lossless detection. Lossy encoders throw away everything above a cutoff (about 16 kHz for
//! a 128 kbps MP3, 19 to 20 kHz at 320 kbps), and converting the result to FLAC can't bring it
//! back. So a "lossless" file whose spectrum falls off a cliff well below the Nyquist frequency was
//! very likely made from a lossy one. Same idea finds "hi-res" files upsampled from CD audio.

use crate::analysis::Fft;

const N: usize = 8192;
/// Analyze one window, then skip this many, to keep a full-track scan quick.
const SKIP_WINDOWS: u32 = 3;
const BAND_HZ: f32 = 200.0;
/// Windows quieter than this (RMS) are skipped: silence has no spectrum worth reading.
const MIN_RMS: f32 = 0.001;

/// Accumulates the average power spectrum of a mono signal fed one sample at a time.
pub struct SpectrumAcc {
    fft: Fft,
    rate: u32,
    buf: Vec<f32>,
    skip: u32,
    power: Vec<f64>,
    windows: u32,
}

impl SpectrumAcc {
    pub fn new(rate: u32) -> Self {
        Self { fft: Fft::new(N), rate, buf: Vec::with_capacity(N), skip: 0, power: vec![0.0; N / 2], windows: 0 }
    }

    pub fn push(&mut self, s: f32) {
        self.buf.push(s);
        if self.buf.len() < N {
            return;
        }
        if self.skip == 0 {
            let rms = (self.buf.iter().map(|x| x * x).sum::<f32>() / N as f32).sqrt();
            if rms >= MIN_RMS {
                for (p, m) in self.power.iter_mut().zip(self.fft.magnitudes(&self.buf)) {
                    *p += (m as f64) * (m as f64);
                }
                self.windows += 1;
            }
            self.skip = SKIP_WINDOWS;
        } else {
            self.skip -= 1;
        }
        self.buf.clear();
    }

    /// The detected cutoff in Hz, 0 if the spectrum reaches the top of the band, or None if
    /// there wasn't enough audio to judge.
    pub fn finish(&self) -> Option<i32> {
        if self.windows < 4 {
            return None;
        }
        let bin_hz = self.rate as f32 / N as f32;
        let per_band = ((BAND_HZ / bin_hz).round() as usize).max(1);
        let bands: Vec<f32> = self
            .power
            .chunks(per_band)
            .map(|c| (10.0 * (c.iter().sum::<f64>() / c.len() as f64 / self.windows as f64 + 1e-20).log10()) as f32)
            .collect();
        Some(find_cutoff(&bands, per_band as f32 * bin_hz))
    }
}

/// Finds a brick-wall drop in a band spectrum (dB per `band_hz` slice, low to high). Returns the
/// frequency where the drop starts, or 0 if there is none.
pub fn find_cutoff(bands: &[f32], band_hz: f32) -> i32 {
    let nyquist = bands.len() as f32 * band_hz;
    let at = |f: f32| ((f / band_hz) as usize).min(bands.len().saturating_sub(1));
    let reference = bands[at(500.0)..=at(6_000.0)].iter().cloned().fold(f32::MIN, f32::max);
    // Ignore the last ~600 Hz: every converter's anti-alias filter rolls off there.
    let top = at(nyquist - 600.0);
    let mean = |r: std::ops::Range<usize>| bands[r.clone()].iter().sum::<f32>() / r.len().max(1) as f32;

    let mut best: Option<(usize, f32)> = None;
    for j in at(10_000.0).max(5)..top.saturating_sub(3) {
        let below = mean(j - 5..j);
        let above = mean(j..j + 3);
        let tail = bands[j..top].iter().cloned().fold(f32::MIN, f32::max);
        let cliff = below - above;
        // A real cutoff: a steep drop, nothing coming back above it, and music below it.
        if cliff >= 20.0 && tail <= below - 15.0 && below >= reference - 70.0 && best.is_none_or(|(_, c)| cliff > c) {
            best = Some((j, cliff));
        }
    }
    best.map(|(j, _)| (j as f32 * band_hz) as i32).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(seed: &mut u64) -> f32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed as f64 / u64::MAX as f64 * 2.0 - 1.0) as f32
    }

    /// White noise through a sharp windowed-sinc low-pass (about 0.5 kHz wide, -70 dB stopband)
    /// stands in for a lossy encoder's brick wall.
    fn run(rate: u32, lowpass: Option<f32>) -> Option<i32> {
        use std::f32::consts::PI;
        const TAPS: usize = 511;
        let mut acc = SpectrumAcc::new(rate);
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let fir: Option<Vec<f32>> = lowpass.map(|f| {
            let fc = f / rate as f32;
            let m = (TAPS - 1) as f32;
            (0..TAPS)
                .map(|i| {
                    let x = i as f32 - m / 2.0;
                    let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * PI * fc * x).sin() / (PI * x) };
                    let blackman = 0.42 - 0.5 * (2.0 * PI * i as f32 / m).cos() + 0.08 * (4.0 * PI * i as f32 / m).cos();
                    sinc * blackman
                })
                .collect()
        });
        let mut history = vec![0f32; TAPS];
        for n in 0..rate as usize * 6 {
            let x = noise(&mut seed) * 0.3;
            let y = match &fir {
                Some(h) => {
                    history[n % TAPS] = x;
                    h.iter().enumerate().map(|(k, c)| c * history[(n + TAPS - k) % TAPS]).sum()
                }
                None => x,
            };
            acc.push(y);
        }
        acc.finish()
    }

    #[test]
    fn full_band_noise_has_no_cutoff() {
        assert_eq!(run(44_100, None), Some(0));
    }

    #[test]
    fn finds_a_16k_brick_wall() {
        let c = run(44_100, Some(16_000.0)).unwrap();
        assert!((15_000..=16_600).contains(&c), "{c}");
    }

    #[test]
    fn finds_cd_band_limit_in_hi_res() {
        let c = run(96_000, Some(21_500.0)).unwrap();
        assert!((20_500..=22_200).contains(&c), "{c}");
    }

    #[test]
    fn silence_is_unknown() {
        let mut acc = SpectrumAcc::new(44_100);
        for _ in 0..44_100 * 10 {
            acc.push(0.0);
        }
        assert_eq!(acc.finish(), None);
    }
}
