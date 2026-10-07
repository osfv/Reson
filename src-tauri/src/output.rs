//! Audio outputs: the shared system mixer (rodio/cpal) on any device, or WASAPI exclusive mode.
//!
//! In exclusive mode Reson owns the device: no Windows mixer, no resampling, and the device runs
//! at each song's own sample rate, so with volume at 100% and the EQ and normalization off the
//! samples reach the DAC unchanged (bit-perfect). Both outputs expose a rodio [`Mixer`] that the
//! engine's players connect to, so the rest of the engine doesn't care which one is active.

use std::num::NonZero;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use rodio::mixer::Mixer;
use rodio::{DeviceSinkBuilder, DeviceTrait, MixerDeviceSink};
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// The Windows endpoint id; stable across reboots.
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// Output devices, default first.
pub fn devices() -> Vec<DeviceInfo> {
    use rodio::cpal::traits::HostTrait;
    let host = rodio::cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.id().ok()).map(|id| id.1);
    let mut out: Vec<DeviceInfo> = host
        .output_devices()
        .map(|it| {
            it.filter_map(|d| {
                let id = d.id().ok()?.1;
                let name = d.description().ok()?.name().to_string();
                Some(DeviceInfo { default: Some(&id) == default.as_ref(), id, name })
            })
            .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|d| !d.default);
    out
}

pub enum Output {
    Shared(MixerDeviceSink),
    #[cfg(windows)]
    Exclusive(Exclusive),
}

impl Output {
    pub fn mixer(&self) -> &Mixer {
        match self {
            Output::Shared(s) => s.mixer(),
            #[cfg(windows)]
            Output::Exclusive(e) => &e.mixer,
        }
    }

    /// (sample rate, channels) for exclusive mode, which only plays matching sources.
    pub fn exclusive_format(&self) -> Option<(u32, u16)> {
        match self {
            Output::Shared(_) => None,
            #[cfg(windows)]
            Output::Exclusive(e) => Some((e.rate, e.channels)),
        }
    }

    /// False once an exclusive stream has died (device unplugged or taken over).
    pub fn alive(&self) -> bool {
        match self {
            Output::Shared(_) => true,
            #[cfg(windows)]
            Output::Exclusive(e) => e.alive.load(Ordering::Relaxed),
        }
    }

    /// Bit depth of the exclusive stream, for the status line.
    pub fn exclusive_bits(&self) -> Option<u16> {
        match self {
            Output::Shared(_) => None,
            #[cfg(windows)]
            Output::Exclusive(e) => Some(e.bits),
        }
    }
}

/// Opens the shared output on `device_id`, falling back to the default device if it's gone.
pub fn open_shared(device_id: Option<&str>) -> Result<Output, String> {
    use rodio::cpal::traits::HostTrait;
    let found = device_id.and_then(|want| {
        rodio::cpal::default_host()
            .output_devices()
            .ok()?
            .find(|d| d.id().ok().is_some_and(|id| id.1 == want))
    });
    let mut sink = match found {
        Some(d) => DeviceSinkBuilder::from_device(d).and_then(|b| b.open_stream()),
        None => DeviceSinkBuilder::open_default_sink(),
    }
    .map_err(|e| e.to_string())?;
    sink.log_on_drop(false);
    Ok(Output::Shared(sink))
}

#[cfg(windows)]
pub struct Exclusive {
    mixer: Mixer,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub rate: u32,
    pub channels: u16,
    pub bits: u16,
}

#[cfg(windows)]
impl Drop for Exclusive {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Takes over `device_id` (or the default device) at exactly `rate` / `channels`.
#[cfg(windows)]
pub fn open_exclusive(device_id: Option<&str>, rate: u32, channels: u16) -> Result<Output, String> {
    let (mixer, source) = rodio::mixer::mixer(
        NonZero::new(channels.max(1)).unwrap(),
        NonZero::new(rate.max(1)).unwrap(),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let alive = Arc::new(AtomicBool::new(true));
    let (ready_tx, ready_rx) = mpsc::channel();
    let device_id = device_id.map(str::to_string);
    let (st, al) = (stop.clone(), alive.clone());
    let thread = thread::Builder::new()
        .name("reson-exclusive".into())
        .spawn(move || {
            let result = wasapi_exclusive::run(device_id.as_deref(), rate, channels, source, &st, &ready_tx);
            al.store(false, Ordering::Relaxed);
            if let Err(e) = result {
                let _ = ready_tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv() {
        Ok(Ok(bits)) => Ok(Output::Exclusive(Exclusive { mixer, stop, alive, thread: Some(thread), rate, channels, bits })),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("The exclusive audio thread stopped".into()),
    }
}

#[cfg(windows)]
mod wasapi_exclusive {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;

    use rodio::mixer::MixerSource;
    use wasapi::{
        calculate_period_100ns, get_default_device, initialize_mta, DeviceCollection, Direction, SampleType,
        StreamMode, WasapiError, WaveFormat,
    };
    use windows::Win32::Media::Audio::{AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED};

    /// Container / valid bits to try, best first. 24-in-32 is what most DACs want.
    const FORMATS: &[(usize, usize)] = &[(32, 24), (32, 32), (24, 24), (16, 16)];

    fn explain(e: WasapiError) -> String {
        if let WasapiError::Windows(w) = &e {
            let code = w.code();
            if code == AUDCLNT_E_DEVICE_IN_USE {
                return "another app is using this device in exclusive mode".into();
            }
            if code == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
                return "exclusive mode is turned off for this device in Windows sound settings".into();
            }
        }
        e.to_string()
    }

    pub fn run(
        device_id: Option<&str>,
        rate: u32,
        channels: u16,
        mut source: MixerSource,
        stop: &AtomicBool,
        ready: &Sender<Result<u16, String>>,
    ) -> Result<(), String> {
        let _ = initialize_mta();
        let device = match device_id {
            Some(id) => {
                let all = DeviceCollection::new(&Direction::Render).map_err(explain)?;
                (&all).into_iter().filter_map(Result::ok).find(|d| d.get_id().ok().as_deref() == Some(id))
            }
            None => None,
        }
        .map(Ok)
        .unwrap_or_else(|| get_default_device(&Direction::Render))
        .map_err(explain)?;

        let mut client = device.get_iaudioclient().map_err(explain)?;
        let format = FORMATS
            .iter()
            .find_map(|&(store, valid)| {
                let f = WaveFormat::new(store, valid, &SampleType::Int, rate as usize, channels as usize, None);
                client.is_supported_exclusive_with_quirks(&f).ok()
            })
            .ok_or_else(|| format!("the device can't play {} kHz in exclusive mode", rate as f64 / 1000.0))?;
        let (store, valid) = (format.get_bitspersample() as usize, format.get_validbitspersample() as usize);
        let block = format.get_blockalign() as usize;

        let (default_period, _) = client.get_device_period().map_err(explain)?;
        let period = client.calculate_aligned_period_near(default_period, Some(128), &format).map_err(explain)?;
        let mode = StreamMode::EventsExclusive { period_hns: period };
        if let Err(e) = client.initialize_client(&format, &Direction::Render, &mode) {
            // Some drivers want a specific buffer size; Microsoft's documented recovery.
            let unaligned = matches!(&e, WasapiError::Windows(w) if w.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED);
            if !unaligned {
                return Err(explain(e));
            }
            let frames = client.get_buffer_size().map_err(explain)?;
            let aligned = calculate_period_100ns(frames as i64, rate as i64);
            client = device.get_iaudioclient().map_err(explain)?;
            client
                .initialize_client(&format, &Direction::Render, &StreamMode::EventsExclusive { period_hns: aligned })
                .map_err(explain)?;
        }
        let event = client.set_get_eventhandle().map_err(explain)?;
        let render = client.get_audiorenderclient().map_err(explain)?;

        let scale = (1u64 << (valid - 1)) as f64;
        let shift = store - valid;
        let mut fill = |frames: usize, data: &mut Vec<u8>| {
            data.clear();
            for _ in 0..frames * channels as usize {
                let s = source.next().unwrap_or(0.0) as f64;
                let v = (s * scale).round().clamp(-scale, scale - 1.0) as i64;
                match store {
                    16 => data.extend_from_slice(&(v as i16).to_le_bytes()),
                    24 => data.extend_from_slice(&(v as i32).to_le_bytes()[..3]),
                    _ => data.extend_from_slice(&((v << shift) as i32).to_le_bytes()),
                }
            }
        };

        let mut data = Vec::with_capacity(block * 4096);
        // Event-driven exclusive streams need a full buffer queued before they start.
        let first = client.get_available_space_in_frames().map_err(explain)? as usize;
        fill(first, &mut data);
        render.write_to_device(first, &data, None).map_err(explain)?;
        client.start_stream().map_err(explain)?;
        let _ = ready.send(Ok(valid as u16));

        while !stop.load(Ordering::Relaxed) {
            if event.wait_for_event(1000).is_err() {
                break;
            }
            let Ok(frames) = client.get_available_space_in_frames() else { break };
            fill(frames as usize, &mut data);
            if render.write_to_device(frames as usize, &data, None).is_err() {
                break;
            }
        }
        let _ = client.stop_stream();
        Ok(())
    }
}
