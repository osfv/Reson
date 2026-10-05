//! Opens any supported file as a rodio [`Source`].
//!
//! rodio (via Symphonia) covers FLAC, MP3, AAC, ALAC, Vorbis and WAV. Opus, Monkey's Audio (APE)
//! and WavPack have no Symphonia 0.5 decoder, so they get small adapters around pure-Rust
//! decoders here. Every adapter produces interleaved f32 and supports seeking.

use std::fs::File;
use std::io::BufReader;
use std::num::NonZero;
use std::path::Path;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

pub type BoxSource = Box<dyn Source + Send>;

/// `format` is the detected format stored in the library ("Opus", "APE", ...). When unknown, the
/// extension decides, and anything else goes to rodio.
pub fn open(path: &Path, format: Option<&str>) -> Result<BoxSource, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = match format {
        Some(f) => f.to_string(),
        None => match ext.as_str() {
            "opus" => "Opus".into(),
            "ape" => "APE".into(),
            "wv" => "WavPack".into(),
            _ => String::new(),
        },
    };
    let pcm: Box<dyn Pcm> = match kind.as_str() {
        "Opus" => Box::new(OpusPcm::open(path)?),
        "APE" => Box::new(ApePcm::open(path)?),
        "WavPack" => Box::new(WavPackPcm::open(path)?),
        _ => {
            let file = File::open(path).map_err(|e| e.to_string())?;
            return Ok(Box::new(rodio::Decoder::try_from(file).map_err(|e| e.to_string())?));
        }
    };
    Ok(Box::new(PcmSource::new(pcm)))
}

/// A decoder that hands out blocks of interleaved samples.
trait Pcm: Send {
    fn channels(&self) -> u16;
    fn rate(&self) -> u32;
    fn duration(&self) -> Option<Duration>;
    /// Appends the next block to `out`. Returns false at the end of the stream.
    fn next_block(&mut self, out: &mut Vec<f32>) -> bool;
    fn seek(&mut self, to: Duration) -> Result<(), String>;
}

struct PcmSource {
    pcm: Box<dyn Pcm>,
    buf: Vec<f32>,
    pos: usize,
    channels: ChannelCount,
    rate: SampleRate,
}

impl PcmSource {
    fn new(pcm: Box<dyn Pcm>) -> Self {
        let channels = NonZero::new(pcm.channels().max(1)).unwrap();
        let rate = NonZero::new(pcm.rate().max(1)).unwrap();
        Self { pcm, buf: Vec::with_capacity(16_384), pos: 0, channels, rate }
    }
}

impl Iterator for PcmSource {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        while self.pos >= self.buf.len() {
            self.buf.clear();
            self.pos = 0;
            if !self.pcm.next_block(&mut self.buf) {
                return None;
            }
        }
        let s = self.buf[self.pos];
        self.pos += 1;
        Some(s)
    }
}

impl Source for PcmSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.pcm.duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.buf.clear();
        self.pos = 0;
        self.pcm.seek(pos).map_err(|e| SeekError::Other(std::sync::Arc::new(std::io::Error::other(e))))
    }
}

/// Little-endian PCM bytes (8-bit unsigned, 16/24/32-bit signed) to f32.
fn push_le(bytes: &[u8], bits: u16, out: &mut Vec<f32>) {
    match bits {
        8 => out.extend(bytes.iter().map(|&b| (b as f32 - 128.0) / 128.0)),
        16 => out.extend(bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32_768.0)),
        24 => out.extend(bytes.chunks_exact(3).map(|c| {
            let v = i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8;
            v as f32 / 8_388_608.0
        })),
        _ => out.extend(bytes.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0)),
    }
}

// ---------------------------------------------------------------------------------------------
// Opus: Symphonia's Ogg demuxer for packets, `opus-decoder` (pure Rust) for audio.

struct OpusPcm {
    reader: Box<dyn symphonia::core::formats::FormatReader>,
    track: u32,
    decoder: opus_decoder::OpusDecoder,
    channels: u16,
    frames: Option<u64>,
    /// Samples (per channel, 48 kHz) still to drop: the encoder pre-skip, or seek pre-roll.
    skip: usize,
    scratch: Vec<f32>,
}

const OPUS_RATE: u32 = 48_000;

impl OpusPcm {
    fn open(path: &Path) -> Result<Self, String> {
        use symphonia::core::codecs::CODEC_TYPE_OPUS;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;

        let file = File::open(path).map_err(|e| e.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        hint.with_extension("ogg");
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Not an Ogg Opus file: {e}"))?;
        let reader = probed.format;
        let track = reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec == CODEC_TYPE_OPUS)
            .ok_or("No Opus stream in this file")?;
        let channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
        if channels > 2 {
            return Err("Surround Opus files aren't supported yet".into());
        }
        let decoder = opus_decoder::OpusDecoder::new(OPUS_RATE, channels as usize).map_err(|e| e.to_string())?;
        let delay = track.codec_params.delay.unwrap_or(0) as usize;
        let frames = track.codec_params.n_frames.map(|n| n.saturating_sub(delay as u64));
        let id = track.id;
        Ok(Self {
            reader,
            track: id,
            decoder,
            channels,
            frames,
            skip: delay,
            scratch: vec![0.0; opus_decoder::OpusDecoder::MAX_FRAME_SIZE_48K * channels as usize],
        })
    }
}

impl Pcm for OpusPcm {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn rate(&self) -> u32 {
        OPUS_RATE
    }
    fn duration(&self) -> Option<Duration> {
        self.frames.map(|f| Duration::from_secs_f64(f as f64 / OPUS_RATE as f64))
    }
    fn next_block(&mut self, out: &mut Vec<f32>) -> bool {
        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(_) => return false,
            };
            if packet.track_id() != self.track {
                continue;
            }
            // The decoder is young; a bug on one packet must not take the audio thread down.
            let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.decoder.decode_float(&packet.data, &mut self.scratch, false)
            }));
            let n = match decoded {
                Ok(Ok(n)) => n,
                Ok(Err(_)) => continue,
                Err(_) => {
                    self.decoder.reset();
                    continue;
                }
            };
            let ch = self.channels as usize;
            let drop = self.skip.min(n);
            self.skip -= drop;
            if n > drop {
                out.extend_from_slice(&self.scratch[drop * ch..n * ch]);
                return true;
            }
        }
    }
    fn seek(&mut self, to: Duration) -> Result<(), String> {
        use symphonia::core::formats::{SeekMode, SeekTo};
        // Opus needs ~80 ms of pre-roll after a seek for the decoder state to settle.
        let preroll = 0.08;
        let target = to.as_secs_f64();
        let start = (target - preroll).max(0.0);
        let seeked = self
            .reader
            .seek(SeekMode::Accurate, SeekTo::Time { time: start.into(), track_id: Some(self.track) })
            .map_err(|e| e.to_string())?;
        self.decoder.reset();
        let landed = seeked.actual_ts as f64 / OPUS_RATE as f64;
        self.skip = (((target - landed).max(0.0)) * OPUS_RATE as f64) as usize;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Monkey's Audio: `ape-decoder` decodes frame by frame with sample-accurate seeking.

struct ApePcm {
    decoder: ape_decoder::ApeDecoder<BufReader<File>>,
    frame: u32,
    skip: usize,
    channels: u16,
    bits: u16,
    rate: u32,
    total: u64,
}

impl ApePcm {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let decoder = ape_decoder::ApeDecoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let info = decoder.info();
        Ok(Self {
            channels: info.channels,
            bits: info.bits_per_sample,
            rate: info.sample_rate,
            total: info.total_samples,
            decoder,
            frame: 0,
            skip: 0,
        })
    }
}

impl Pcm for ApePcm {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(self.total as f64 / self.rate.max(1) as f64))
    }
    fn next_block(&mut self, out: &mut Vec<f32>) -> bool {
        if self.frame >= self.decoder.total_frames() {
            return false;
        }
        let Ok(bytes) = self.decoder.decode_frame(self.frame) else { return false };
        self.frame += 1;
        let frame_bytes = self.channels as usize * (self.bits as usize / 8).max(1);
        let skip = (self.skip * frame_bytes).min(bytes.len());
        self.skip = 0;
        push_le(&bytes[skip..], self.bits, out);
        true
    }
    fn seek(&mut self, to: Duration) -> Result<(), String> {
        let sample = ((to.as_secs_f64() * self.rate as f64) as u64).min(self.total.saturating_sub(1));
        let r = self.decoder.seek(sample).map_err(|e| e.to_string())?;
        self.frame = r.frame_index;
        self.skip = r.skip_samples as usize;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// WavPack: `wavicle` decodes a whole stream at once, so the file is decoded up front.

struct WavPackPcm {
    samples: Vec<i32>,
    pos: usize,
    channels: u16,
    rate: u32,
    scale: f32,
    float: bool,
}

const WAVPACK_BLOCK: usize = 8192;

/// The run of `wvpk` blocks at the start of a file, without the APEv2 / ID3v1 tag that taggers
/// append after the audio (the decoder rejects anything that isn't a block).
fn audio_blocks(bytes: &[u8]) -> &[u8] {
    let mut end = 0;
    while bytes.len() >= end + 8 && &bytes[end..end + 4] == b"wvpk" {
        let size = u32::from_le_bytes([bytes[end + 4], bytes[end + 5], bytes[end + 6], bytes[end + 7]]) as usize;
        let next = end + 8 + size;
        if next > bytes.len() {
            break;
        }
        end = next;
    }
    &bytes[..end]
}

impl WavPackPcm {
    fn open(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let d = wavicle::decode_stream(audio_blocks(&bytes)).map_err(|e| format!("Couldn't decode WavPack: {e}"))?;
        Ok(Self {
            channels: d.channels as u16,
            rate: d.sample_rate,
            scale: 1.0 / (1u64 << (d.bits_per_sample.clamp(1, 32) - 1)) as f32,
            float: d.is_float,
            samples: d.samples,
            pos: 0,
        })
    }
}

impl Pcm for WavPackPcm {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn duration(&self) -> Option<Duration> {
        let frames = self.samples.len() / self.channels.max(1) as usize;
        Some(Duration::from_secs_f64(frames as f64 / self.rate.max(1) as f64))
    }
    fn next_block(&mut self, out: &mut Vec<f32>) -> bool {
        if self.pos >= self.samples.len() {
            return false;
        }
        let end = (self.pos + WAVPACK_BLOCK * self.channels as usize).min(self.samples.len());
        let chunk = &self.samples[self.pos..end];
        if self.float {
            out.extend(chunk.iter().map(|&s| f32::from_bits(s as u32)));
        } else {
            out.extend(chunk.iter().map(|&s| s as f32 * self.scale));
        }
        self.pos = end;
        true
    }
    fn seek(&mut self, to: Duration) -> Result<(), String> {
        let ch = self.channels.max(1) as usize;
        let frame = (to.as_secs_f64() * self.rate as f64) as usize;
        self.pos = (frame * ch).min(self.samples.len());
        Ok(())
    }
}
