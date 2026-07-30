//! Cross-platform microphone capture and streaming speaker playback.
//!
//! miniaudio owns platform device discovery, format conversion, channel mixing,
//! and resampling. The N-API classes expose one stable mono `f32` contract to
//! TypeScript while the internal playback stream is shared with native WebRTC.

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU32, Ordering},
};

use flume::TryRecvError;
use maudio::{
	audio::{performance::PerformanceProfile, sample_rate::SampleRate},
	backend::Backend,
	device::{
		Device,
		device_builder::{DeviceBuilder, DeviceBuilderOps},
	},
};
use napi::{
	bindgen_prelude::{Float32Array, Result},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::sync::Notify;

const AUDIO_CHANNELS: u32 = 1;
// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
// miniaudio's PulseAudio backend reserves three periods. Android's OpenSL ES
// source emits 125 ms fragments, so Linux capture needs at least 150 ms queued.
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
// PulseAudio can retain its default three periods after the producer closes.
// Wait for all of them before stopping the device so the tail reaches the sink.
#[cfg(target_os = "linux")]
const PLAYBACK_DRAIN_CALLBACKS: usize = 3;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_DRAIN_CALLBACKS: usize = 2;

#[cfg(target_os = "macos")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::CoreAudio];
#[cfg(target_os = "windows")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Wasapi];
#[cfg(target_os = "linux")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::PulseAudio, Backend::Alsa, Backend::Jack];
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Sndio, Backend::Audio4, Backend::Oss];

type CaptureCallback = ThreadsafeFunction<Float32Array, UnknownReturnValue>;
type NativeResult<T> = std::result::Result<T, String>;

struct PlaybackState {
	gain_bits: AtomicU32,
	drained:   AtomicBool,
	stopped:   AtomicBool,
	notify:    Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits: AtomicU32::new(1.0f32.to_bits()),
			drained:   AtomicBool::new(false),
			stopped:   AtomicBool::new(false),
			notify:    Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}
}

/// Producer endpoint for one native playback device.
#[derive(Clone)]
pub(crate) struct PlaybackWriter {
	tx:    flume::Sender<Vec<f32>>,
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue mono floating-point samples without blocking the caller.
	pub(crate) fn write(&self, samples: &[f32]) -> NativeResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		self
			.tx
			.send(samples.to_vec())
			.map_err(|_| "Native audio playback is closed".to_owned())
	}
}

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub(crate) struct PlaybackStream {
	device: Option<Device<f32>>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub(crate) fn start(sample_rate: u32) -> NativeResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		let callback_state = Arc::clone(&state);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut builder = DeviceBuilder::playback().f32();
		builder
			.sample_rate(sample_rate)
			.playback_channels(AUDIO_CHANNELS)
			.period_size_millis(PLAYBACK_PERIOD_MS)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS);
		let mut device = builder
			.with_callback(move |_device, output| {
				fill_playback(
					&rx,
					&mut current,
					&mut cursor,
					output,
					&callback_state,
					&mut empty_callbacks,
				);
			})
			.map_err(|error| format!("Failed to open the default speaker: {error}"))?;
		device
			.device_start()
			.map_err(|error| format!("Failed to start speaker playback: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { tx, state: Arc::clone(&state) }),
			state,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub(crate) fn writer(&self) -> NativeResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	fn finish_input(&mut self) {
		self.writer.take();
	}

	fn set_gain(&self, gain: f32) -> NativeResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub(crate) fn stop(&mut self) -> NativeResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device
			.device_stop()
			.map_err(|error| format!("Failed to stop speaker playback: {error}"))
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

fn audio_sample_rate(sample_rate: u32) -> NativeResult<SampleRate> {
	SampleRate::try_from(sample_rate)
		.map_err(|error| format!("Unsupported audio sample rate {sample_rate}: {error}"))
}

fn fill_playback(
	rx: &flume::Receiver<Vec<f32>>,
	current: &mut Vec<f32>,
	cursor: &mut usize,
	output: &mut [f32],
	state: &PlaybackState,
	empty_callbacks: &mut usize,
) {
	output.fill(0.0);
	if state.stopped.load(Ordering::Acquire) {
		return;
	}

	let gain = state.gain();
	let mut output_offset = 0;
	while output_offset < output.len() {
		if *cursor == current.len() {
			match rx.try_recv() {
				Ok(next) => {
					*current = next;
					*cursor = 0;
					*empty_callbacks = 0;
				},
				Err(TryRecvError::Empty) => {
					*empty_callbacks = 0;
					break;
				},
				Err(TryRecvError::Disconnected) => {
					*empty_callbacks += 1;
					if *empty_callbacks >= PLAYBACK_DRAIN_CALLBACKS {
						state.mark_drained();
					}
					break;
				},
			}
		}

		let count = (current.len() - *cursor).min(output.len() - output_offset);
		let source = &current[*cursor..*cursor + count];
		let destination = &mut output[output_offset..output_offset + count];
		if gain == 1.0 {
			destination.copy_from_slice(source);
		} else {
			for (destination, source) in destination.iter_mut().zip(source) {
				*destination = *source * gain;
			}
		}
		*cursor += count;
		output_offset += count;
	}
}

fn start_capture_device<C>(sample_rate: u32, mut on_audio: C) -> NativeResult<Device<f32>>
where
	C: FnMut(&[f32]) + Send + 'static,
{
	let sample_rate = audio_sample_rate(sample_rate)?;
	let mut builder = DeviceBuilder::capture().f32();
	builder
		.sample_rate(sample_rate)
		.capture_channels(AUDIO_CHANNELS)
		.period_size_millis(CAPTURE_PERIOD_MS)
		.performance_profile(PerformanceProfile::LowLatency)
		.backends(AUDIO_BACKENDS);
	let mut device = builder
		.with_callback(move |_device, samples| {
			if !samples.is_empty() {
				on_audio(samples);
			}
		})
		.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
	device
		.device_start()
		.map_err(|error| format!("Failed to start microphone capture: {error}"))?;
	Ok(device)
}

/// Default-microphone capture converted to mono `f32` at the requested sample
/// rate.
#[napi]
pub struct AudioCapture {
	device: Mutex<Option<Device<f32>>>,
}

#[napi]
impl AudioCapture {
	/// Open the default microphone and deliver low-latency mono PCM chunks.
	#[napi(constructor)]
	pub fn new(
		sample_rate: u32,
		#[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
		on_audio: CaptureCallback,
	) -> Result<Self> {
		let device = start_capture_device(sample_rate, move |samples| {
			on_audio
				.call(Ok(Float32Array::new(samples.to_vec())), ThreadsafeFunctionCallMode::NonBlocking);
		})
		.map_err(napi::Error::from_reason)?;
		Ok(Self { device: Mutex::new(Some(device)) })
	}

	/// Stop capture immediately and release the microphone.
	#[napi]
	pub fn stop(&self) -> Result<()> {
		let device = self.device.lock().take();
		let Some(mut device) = device else {
			return Ok(());
		};
		device.device_stop().map_err(|error| {
			napi::Error::from_reason(format!("Failed to stop microphone capture: {error}"))
		})
	}
}

impl Drop for AudioCapture {
	fn drop(&mut self) {
		if let Some(mut device) = self.device.get_mut().take() {
			let _ = device.device_stop();
		}
	}
}

/// Gapless mono `f32` playback through the default speaker.
#[napi]
pub struct AudioPlayback {
	stream: Mutex<Option<PlaybackStream>>,
	state:  Arc<PlaybackState>,
}

#[napi]
impl AudioPlayback {
	/// Open the default speaker at the requested logical sample rate.
	#[napi(constructor)]
	pub fn new(sample_rate: u32) -> Result<Self> {
		let stream = PlaybackStream::start(sample_rate).map_err(napi::Error::from_reason)?;
		let state = stream.state();
		Ok(Self { stream: Mutex::new(Some(stream)), state })
	}

	/// Queue mono floating-point PCM in playback order.
	#[napi]
	pub fn write(&self, samples: Float32Array) -> Result<()> {
		let stream = self.stream.lock();
		let stream = stream
			.as_ref()
			.ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
		stream
			.writer()
			.and_then(|writer| writer.write(&samples))
			.map_err(napi::Error::from_reason)
	}

	/// Scale audio at render time so gain changes affect already queued samples.
	#[napi]
	pub fn set_gain(&self, gain: f64) -> Result<()> {
		let stream = self.stream.lock();
		let stream = stream
			.as_ref()
			.ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
		stream
			.set_gain(gain as f32)
			.map_err(napi::Error::from_reason)
	}

	/// Close input, wait until queued samples reach the speaker, then release
	/// it.
	#[napi]
	pub async fn end(&self) -> Result<()> {
		{
			let mut stream = self.stream.lock();
			let Some(stream) = stream.as_mut() else {
				return Ok(());
			};
			stream.finish_input();
		}
		self.state.wait_for_drain().await;
		let stream = self.stream.lock().take();
		if let Some(mut stream) = stream {
			stream.stop().map_err(napi::Error::from_reason)?;
		}
		Ok(())
	}

	/// Stop immediately and discard all queued samples.
	#[napi]
	pub fn stop(&self) -> Result<()> {
		let stream = self.stream.lock().take();
		if let Some(mut stream) = stream {
			stream.stop().map_err(napi::Error::from_reason)?;
		}
		Ok(())
	}
}

impl Drop for AudioPlayback {
	fn drop(&mut self) {
		if let Some(mut stream) = self.stream.get_mut().take() {
			let _ = stream.stop();
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		mem::forget,
		sync::atomic::AtomicUsize,
		thread::sleep,
		time::{Duration, Instant},
	};

	use super::*;

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = PlaybackState::new();
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		tx.send(vec![1.0, -1.0]).expect("receiver is live");
		tx.send(vec![0.5, -0.5]).expect("receiver is live");
		drop(tx);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [9.0; 5];

		fill_playback(&rx, &mut current, &mut cursor, &mut output, &state, &mut empty_callbacks);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while empty_callbacks < PLAYBACK_DRAIN_CALLBACKS {
			silence.fill(1.0);
			fill_playback(&rx, &mut current, &mut cursor, &mut silence, &state, &mut empty_callbacks);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				state.drained.load(Ordering::Acquire),
				empty_callbacks >= PLAYBACK_DRAIN_CALLBACKS
			);
		}
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut device = start_capture_device(16_000, move |_samples| {
			callback_count.fetch_add(1, Ordering::Relaxed);
		})
		.expect("default capture device starts");

		let deadline = Instant::now() + Duration::from_secs(5);
		while callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
			sleep(Duration::from_millis(20));
		}
		if callbacks.load(Ordering::Relaxed) == 0 {
			forget(device);
			panic!("capture device started but delivered no frames within five seconds");
		}
		device.device_stop().expect("capture device stops");
	}
}
