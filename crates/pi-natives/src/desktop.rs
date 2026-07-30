//! Native full-desktop capture and input for Codex Computer Use.
//!
//! A dedicated worker owns the platform connections for the lifetime of a
//! session. Requests cross a FIFO channel, so captures and action batches can
//! never race each other and every coordinate action is interpreted against the
//! last composite frame returned to JavaScript.

#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::{
	collections::HashSet,
	fmt,
	io::Cursor,
	sync::Arc,
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use core_graphics::{
	event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
};
#[cfg(not(target_os = "linux"))]
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage, imageops::FilterType};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
#[cfg(not(target_os = "linux"))]
use xcap::Monitor;

#[cfg(target_os = "linux")]
use crate::desktop_x11::{Axis, Button, Coordinate, Direction, Input as Enigo, Key, Monitor};
use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(1);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const WAIT_ACTION_DURATION: Duration = Duration::from_secs(2);
#[cfg(any(target_os = "macos", test))]
const MACOS_POST_INPUT_SETTLE_DURATION: Duration = Duration::from_millis(100);
const MAX_COMPOSITE_PIXELS: u64 = 268_435_456;

const PERMISSION_GRANTED: &str = "granted";
const PERMISSION_DENIED: &str = "denied";
const PERMISSION_UNKNOWN: &str = "unknown";
const PERMISSION_UNAVAILABLE: &str = "unavailable";

/// Options for a persistent native desktop session.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct DesktopSessionOptions {
	/// Backend preference. `auto` and `native` both prohibit non-native
	/// fallback.
	pub backend:    Option<String>,
	/// `all` or a monitor id returned in `DesktopDisplay.id`.
	pub display:    Option<String>,
	/// Maximum composite screenshot width in pixels.
	pub max_width:  Option<u32>,
	/// Maximum composite screenshot height in pixels.
	pub max_height: Option<u32>,
}

/// One point in a drag path, in pixels of the preceding screenshot.
#[napi(object)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopPoint {
	pub x: i32,
	pub y: i32,
}

/// One `OpenAI` GA computer action.
///
/// This is an optional-field carrier because napi-rs object generation cannot
/// emit TypeScript discriminated unions. Native validation enforces the exact
/// fields required and allowed by each `type` before any input is emitted.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct DesktopAction {
	#[napi(js_name = "type")]
	pub action_type: String,
	pub x:           Option<i32>,
	pub y:           Option<i32>,
	pub button:      Option<String>,
	pub path:        Option<Vec<DesktopPoint>>,
	pub keys:        Option<Vec<String>>,
	#[napi(js_name = "scroll_x")]
	pub scroll_x:    Option<i32>,
	#[napi(js_name = "scroll_y")]
	pub scroll_y:    Option<i32>,
	pub text:        Option<String>,
}

/// Monitor geometry in both global logical desktop coordinates and composite
/// screenshot pixels.
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct DesktopDisplay {
	pub id:           String,
	pub name:         String,
	pub x:            i32,
	pub y:            i32,
	pub width:        u32,
	pub height:       u32,
	pub scale:        f64,
	pub pixel_x:      u32,
	pub pixel_y:      u32,
	pub pixel_width:  u32,
	pub pixel_height: u32,
	pub is_primary:   bool,
}

/// Native desktop backend and permission state.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct DesktopCapabilities {
	/// Concrete selected backend: `quartz`, `x11`, `wayland`, `win32`, or
	/// `unavailable`.
	pub backend:            String,
	/// OS display-server endpoint or subsystem label.
	pub display_server:     Option<String>,
	/// Whether screen capture is currently usable.
	pub capture:            bool,
	/// Whether native input is currently usable.
	pub input:              bool,
	/// `granted`, `denied`, `unknown`, or `unavailable`.
	pub capture_permission: String,
	/// `granted`, `denied`, `unknown`, or `unavailable`.
	pub input_permission:   String,
	/// Number of selected displays observed by the most recent successful probe.
	pub display_count:      u32,
}

/// A PNG composite and the exact geometry needed to map its pixels back to the
/// global logical desktop.
#[napi(object)]
pub struct DesktopCapture {
	pub data:               Uint8Array,
	pub width:              u32,
	pub height:             u32,
	pub displays:           Vec<DesktopDisplay>,
	pub backend:            String,
	pub display_server:     Option<String>,
	pub capture_permission: String,
	pub input_permission:   String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrorCode {
	InvalidOptions,
	InvalidAction,
	BackendUnavailable,
	PermissionDenied,
	CaptureFailed,
	InputFailed,
	DeadlineExceeded,
	LayoutChanged,
	CoordinateOutOfBounds,
	SessionClosed,
	WorkerFailed,
}

impl ErrorCode {
	const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidOptions => "DESKTOP_INVALID_OPTIONS",
			Self::InvalidAction => "DESKTOP_INVALID_ACTION",
			Self::BackendUnavailable => "DESKTOP_BACKEND_UNAVAILABLE",
			Self::PermissionDenied => "DESKTOP_PERMISSION_DENIED",
			Self::CaptureFailed => "DESKTOP_CAPTURE_FAILED",
			Self::InputFailed => "DESKTOP_INPUT_FAILED",
			Self::DeadlineExceeded => "DESKTOP_DEADLINE_EXCEEDED",
			Self::LayoutChanged => "DESKTOP_LAYOUT_CHANGED",
			Self::CoordinateOutOfBounds => "DESKTOP_COORDINATE_OUT_OF_BOUNDS",
			Self::SessionClosed => "DESKTOP_SESSION_CLOSED",
			Self::WorkerFailed => "DESKTOP_WORKER_FAILED",
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DesktopError {
	code:    ErrorCode,
	message: String,
}

impl DesktopError {
	fn new(code: ErrorCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	fn permission_or(code: ErrorCode, message: impl Into<String>) -> Self {
		let message = message.into();
		let lower = message.to_ascii_lowercase();
		let code = if lower.contains("permission")
			|| lower.contains("not authorized")
			|| lower.contains("access denied")
			|| lower.contains("canceled")
			|| lower.contains("cancelled")
		{
			ErrorCode::PermissionDenied
		} else {
			code
		};
		Self::new(code, message)
	}
}

impl fmt::Display for DesktopError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}: {}", self.code.as_str(), self.message)
	}
}

impl From<DesktopError> for napi::Error {
	fn from(value: DesktopError) -> Self {
		Self::from_reason(value.to_string())
	}
}

type CoreResult<T> = std::result::Result<T, DesktopError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConcreteBackend {
	#[cfg(target_os = "macos")]
	Quartz,
	#[cfg(target_os = "linux")]
	X11,
	#[cfg(target_os = "linux")]
	Wayland,
	#[cfg(target_os = "windows")]
	Win32,
}

impl ConcreteBackend {
	const fn name(self) -> &'static str {
		match self {
			#[cfg(target_os = "macos")]
			Self::Quartz => "quartz",
			#[cfg(target_os = "linux")]
			Self::X11 => "x11",
			#[cfg(target_os = "linux")]
			Self::Wayland => "wayland",
			#[cfg(target_os = "windows")]
			Self::Win32 => "win32",
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DisplaySelection {
	All,
	Id(u32),
}

#[derive(Clone, Debug)]
struct SessionConfig {
	backend:    Option<ConcreteBackend>,
	selection:  DisplaySelection,
	max_width:  Option<u32>,
	max_height: Option<u32>,
}

impl SessionConfig {
	fn parse(options: Option<DesktopSessionOptions>) -> CoreResult<(Self, DesktopCapabilities)> {
		let options = options.unwrap_or_default();
		match options.backend.as_deref().unwrap_or("auto") {
			"auto" | "native" => {},
			other => {
				return Err(DesktopError::new(
					ErrorCode::InvalidOptions,
					format!("unsupported backend `{other}`; expected `auto` or `native`"),
				));
			},
		}
		if options.max_width == Some(0) || options.max_height == Some(0) {
			return Err(DesktopError::new(
				ErrorCode::InvalidOptions,
				"maxWidth and maxHeight must be greater than zero",
			));
		}
		let selection = match options.display.as_deref().unwrap_or("all") {
			"all" => DisplaySelection::All,
			id => DisplaySelection::Id(id.parse::<u32>().map_err(|_| {
				DesktopError::new(
					ErrorCode::InvalidOptions,
					format!("display must be `all` or a numeric monitor id, got `{id}`"),
				)
			})?),
		};
		let (backend, display_server) = detect_backend();
		let backend_name = backend
			.map_or("unavailable", ConcreteBackend::name)
			.to_string();
		let capture_permission = initial_capture_permission(backend);
		let capabilities = DesktopCapabilities {
			backend: backend_name,
			display_server,
			capture: backend.is_some() && capture_permission != PERMISSION_DENIED,
			input: false,
			capture_permission,
			input_permission: if backend.is_some() {
				PERMISSION_UNKNOWN.to_string()
			} else {
				PERMISSION_UNAVAILABLE.to_string()
			},
			display_count: 0,
		};
		Ok((
			Self { backend, selection, max_width: options.max_width, max_height: options.max_height },
			capabilities,
		))
	}
}

#[cfg(target_os = "linux")]
fn detect_backend() -> (Option<ConcreteBackend>, Option<String>) {
	let wayland = std::env::var("WAYLAND_DISPLAY")
		.ok()
		.filter(|value| !value.is_empty());
	let session_is_wayland =
		std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
	if session_is_wayland || wayland.is_some() {
		return (Some(ConcreteBackend::Wayland), wayland);
	}
	let x11 = std::env::var("DISPLAY")
		.ok()
		.filter(|value| !value.is_empty());
	if x11.is_some() {
		(Some(ConcreteBackend::X11), x11)
	} else {
		(None, None)
	}
}

#[cfg(target_os = "macos")]
fn detect_backend() -> (Option<ConcreteBackend>, Option<String>) {
	(Some(ConcreteBackend::Quartz), Some("Quartz WindowServer".to_string()))
}

#[cfg(target_os = "windows")]
fn detect_backend() -> (Option<ConcreteBackend>, Option<String>) {
	(Some(ConcreteBackend::Win32), Some("Win32 desktop".to_string()))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGPreflightScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn macos_capture_permission() -> bool {
	// SAFETY: Available on every supported macOS release (10.15+), has no
	// parameters, and performs a non-prompting TCC preflight only.
	unsafe { CGPreflightScreenCaptureAccess() }
}

fn initial_capture_permission(backend: Option<ConcreteBackend>) -> String {
	if backend.is_none() {
		return PERMISSION_UNAVAILABLE.to_string();
	}
	#[cfg(target_os = "macos")]
	{
		if macos_capture_permission() {
			PERMISSION_GRANTED.to_string()
		} else {
			PERMISSION_DENIED.to_string()
		}
	}
	#[cfg(not(target_os = "macos"))]
	{
		PERMISSION_UNKNOWN.to_string()
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ValidatedAction {
	Click {
		x:         i32,
		y:         i32,
		button:    MouseButton,
		count:     u8,
		modifiers: Vec<Key>,
	},
	Drag {
		path:      Vec<DesktopPoint>,
		modifiers: Vec<Key>,
	},
	Keypress {
		keys: Vec<String>,
	},
	Move {
		x:         i32,
		y:         i32,
		modifiers: Vec<Key>,
	},
	Screenshot,
	Scroll {
		x:         i32,
		y:         i32,
		scroll_x:  i32,
		scroll_y:  i32,
		modifiers: Vec<Key>,
	},
	Type {
		text: String,
	},
	Wait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MouseButton {
	Left,
	Right,
	Wheel,
	Back,
	Forward,
}

impl MouseButton {
	fn parse(value: String) -> CoreResult<Self> {
		match value.as_str() {
			"left" => Ok(Self::Left),
			"right" => Ok(Self::Right),
			"wheel" => Ok(Self::Wheel),
			"back" => Ok(Self::Back),
			"forward" => Ok(Self::Forward),
			_ => Err(DesktopError::new(
				ErrorCode::InvalidAction,
				format!("unsupported mouse button `{value}`"),
			)),
		}
	}
}

impl From<MouseButton> for Button {
	fn from(value: MouseButton) -> Self {
		match value {
			MouseButton::Left => Self::Left,
			MouseButton::Right => Self::Right,
			MouseButton::Wheel => Self::Middle,
			MouseButton::Back => Self::Back,
			MouseButton::Forward => Self::Forward,
		}
	}
}

impl TryFrom<DesktopAction> for ValidatedAction {
	type Error = DesktopError;

	fn try_from(action: DesktopAction) -> CoreResult<Self> {
		let DesktopAction { action_type, x, y, button, path, keys, scroll_x, scroll_y, text } =
			action;
		let unexpected = |name: &str| {
			DesktopError::new(
				ErrorCode::InvalidAction,
				format!("{action_type} action contains unexpected `{name}`"),
			)
		};
		let required = |name: &str| {
			DesktopError::new(
				ErrorCode::InvalidAction,
				format!("{action_type} action requires `{name}`"),
			)
		};
		macro_rules! reject {
			($($field:ident),* $(,)?) => {
				$(if $field.is_some() { return Err(unexpected(stringify!($field))); })*
			};
		}
		match action_type.as_str() {
			"click" => {
				reject!(path, scroll_x, scroll_y, text);
				let x = x.ok_or_else(|| required("x"))?;
				let y = y.ok_or_else(|| required("y"))?;
				validate_nonnegative_point(x, y, &action_type)?;
				let button = MouseButton::parse(button.ok_or_else(|| required("button"))?)?;
				let modifiers = parse_modifiers(keys.unwrap_or_default())?;
				Ok(Self::Click { x, y, button, count: 1, modifiers })
			},
			"double_click" => {
				reject!(button, path, scroll_x, scroll_y, text);
				let x = x.ok_or_else(|| required("x"))?;
				let y = y.ok_or_else(|| required("y"))?;
				validate_nonnegative_point(x, y, &action_type)?;
				let modifiers = parse_modifiers(keys.unwrap_or_default())?;
				Ok(Self::Click { x, y, button: MouseButton::Left, count: 2, modifiers })
			},
			"drag" => {
				reject!(x, y, button, scroll_x, scroll_y, text);
				let path = path.ok_or_else(|| required("path"))?;
				if path.len() < 2 {
					return Err(DesktopError::new(
						ErrorCode::InvalidAction,
						"drag action requires at least two path points",
					));
				}
				for point in &path {
					validate_nonnegative_point(point.x, point.y, "drag")?;
				}
				let modifiers = parse_modifiers(keys.unwrap_or_default())?;
				Ok(Self::Drag { path, modifiers })
			},
			"keypress" => {
				reject!(x, y, button, path, scroll_x, scroll_y, text);
				let keys = keys.ok_or_else(|| required("keys"))?;
				if keys.is_empty() || keys.iter().any(String::is_empty) {
					return Err(DesktopError::new(
						ErrorCode::InvalidAction,
						"keypress action requires at least one non-empty key",
					));
				}
				parse_keypress(&keys)?;
				Ok(Self::Keypress { keys })
			},
			"move" => {
				reject!(button, path, scroll_x, scroll_y, text);
				let x = x.ok_or_else(|| required("x"))?;
				let y = y.ok_or_else(|| required("y"))?;
				validate_nonnegative_point(x, y, "move")?;
				let modifiers = parse_modifiers(keys.unwrap_or_default())?;
				Ok(Self::Move { x, y, modifiers })
			},
			"screenshot" => {
				reject!(x, y, button, path, keys, scroll_x, scroll_y, text);
				Ok(Self::Screenshot)
			},
			"scroll" => {
				reject!(button, path, text);
				let x = x.ok_or_else(|| required("x"))?;
				let y = y.ok_or_else(|| required("y"))?;
				validate_nonnegative_point(x, y, "scroll")?;
				let modifiers = parse_modifiers(keys.unwrap_or_default())?;
				Ok(Self::Scroll {
					x,
					y,
					scroll_x: scroll_x.ok_or_else(|| required("scroll_x"))?,
					scroll_y: scroll_y.ok_or_else(|| required("scroll_y"))?,
					modifiers,
				})
			},
			"type" => {
				reject!(x, y, button, path, keys, scroll_x, scroll_y);
				Ok(Self::Type { text: text.ok_or_else(|| required("text"))? })
			},
			"wait" => {
				reject!(x, y, button, path, keys, scroll_x, scroll_y, text);
				Ok(Self::Wait)
			},
			_ => Err(DesktopError::new(
				ErrorCode::InvalidAction,
				format!("unsupported desktop action type `{action_type}`"),
			)),
		}
	}
}

fn validate_nonnegative_point(x: i32, y: i32, action: &str) -> CoreResult<()> {
	if x < 0 || y < 0 {
		return Err(DesktopError::new(
			ErrorCode::InvalidAction,
			format!("{action} screenshot coordinates must be non-negative, got ({x}, {y})"),
		));
	}
	Ok(())
}

#[derive(Clone, Debug, PartialEq)]
struct LayoutDisplay {
	id:         String,
	name:       String,
	x:          i32,
	y:          i32,
	width:      u32,
	height:     u32,
	scale:      f64,
	is_primary: bool,
}

#[derive(Debug)]
struct MonitorSnapshot {
	#[cfg(not(target_os = "macos"))]
	monitor: Monitor,
	display: LayoutDisplay,
}

#[cfg(target_os = "macos")]
fn capture_quartz_screenshot(display: &LayoutDisplay) -> CoreResult<RgbaImage> {
	let file = tempfile::Builder::new()
		.prefix("omp-computer-")
		.suffix(".png")
		.tempfile()
		.map_err(|error| {
			DesktopError::new(
				ErrorCode::CaptureFailed,
				format!("failed to create temporary screenshot file: {error}"),
			)
		})?;
	let rect = format!("-R{},{},{},{}", display.x, display.y, display.width, display.height);
	let mut child = Command::new("/usr/sbin/screencapture")
		.arg("-x")
		.arg(rect)
		.arg(file.path())
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|error| {
			DesktopError::new(
				ErrorCode::CaptureFailed,
				format!("failed to start macOS screen capture: {error}"),
			)
		})?;
	let deadline = Instant::now() + Duration::from_secs(5);
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) => {},
			Err(error) => {
				let _ = child.kill();
				let _ = child.wait();
				return Err(DesktopError::new(
					ErrorCode::CaptureFailed,
					format!("failed while waiting for macOS screen capture: {error}"),
				));
			},
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			return Err(DesktopError::new(
				ErrorCode::CaptureFailed,
				"macOS screen capture exceeded its five-second deadline",
			));
		}
		thread::sleep(Duration::from_millis(10));
	};
	if !status.success() {
		return Err(DesktopError::permission_or(
			ErrorCode::CaptureFailed,
			format!("macOS screen capture exited with {status}"),
		));
	}
	image::open(file.path())
		.map_err(|error| {
			DesktopError::new(
				ErrorCode::CaptureFailed,
				format!("failed to decode macOS screenshot: {error}"),
			)
		})
		.map(DynamicImage::into_rgba8)
}

fn capture_monitor_image(snapshot: &MonitorSnapshot) -> CoreResult<RgbaImage> {
	#[cfg(target_os = "macos")]
	return capture_quartz_screenshot(&snapshot.display);
	#[cfg(not(target_os = "macos"))]
	snapshot.monitor.capture_image().map_err(|source| {
		DesktopError::permission_or(
			ErrorCode::CaptureFailed,
			format!("capture of display `{}` failed: {source}", snapshot.display.id),
		)
	})
}

const fn same_display_rect(left: &LayoutDisplay, right: &LayoutDisplay) -> bool {
	left.x == right.x
		&& left.y == right.y
		&& left.width == right.width
		&& left.height == right.height
}

#[derive(Clone, Debug, PartialEq)]
struct FrameDisplay {
	display:      LayoutDisplay,
	pixel_x:      u32,
	pixel_y:      u32,
	pixel_width:  u32,
	pixel_height: u32,
}

#[derive(Clone, Debug, PartialEq)]
struct FrameGeometry {
	width:    u32,
	height:   u32,
	displays: Vec<FrameDisplay>,
}

impl FrameGeometry {
	fn map_point(&self, x: i32, y: i32) -> CoreResult<(i32, i32)> {
		let x = u32::try_from(x).map_err(|_| {
			DesktopError::new(ErrorCode::CoordinateOutOfBounds, "negative screenshot x coordinate")
		})?;
		let y = u32::try_from(y).map_err(|_| {
			DesktopError::new(ErrorCode::CoordinateOutOfBounds, "negative screenshot y coordinate")
		})?;
		if x >= self.width || y >= self.height {
			return Err(DesktopError::new(
				ErrorCode::CoordinateOutOfBounds,
				format!("screenshot coordinate ({x}, {y}) is outside {}x{}", self.width, self.height),
			));
		}
		let frame = self
			.displays
			.iter()
			.find(|frame| {
				x >= frame.pixel_x
					&& x < frame.pixel_x + frame.pixel_width
					&& y >= frame.pixel_y
					&& y < frame.pixel_y + frame.pixel_height
			})
			.ok_or_else(|| {
				DesktopError::new(
					ErrorCode::CoordinateOutOfBounds,
					format!("screenshot coordinate ({x}, {y}) falls outside every display"),
				)
			})?;
		let local_x = u64::from(x - frame.pixel_x) * u64::from(frame.display.width)
			/ u64::from(frame.pixel_width);
		let local_y = u64::from(y - frame.pixel_y) * u64::from(frame.display.height)
			/ u64::from(frame.pixel_height);
		let global_x = i64::from(frame.display.x) + local_x as i64;
		let global_y = i64::from(frame.display.y) + local_y as i64;
		Ok((
			i32::try_from(global_x).map_err(|_| {
				DesktopError::new(ErrorCode::CoordinateOutOfBounds, "mapped x coordinate overflow")
			})?,
			i32::try_from(global_y).map_err(|_| {
				DesktopError::new(ErrorCode::CoordinateOutOfBounds, "mapped y coordinate overflow")
			})?,
		))
	}
}

#[derive(Debug)]
struct CoreCapture {
	png:      Vec<u8>,
	geometry: FrameGeometry,
}

impl CoreCapture {
	fn into_napi(self, capabilities: &Arc<Mutex<DesktopCapabilities>>) -> DesktopCapture {
		let capabilities = capabilities.lock().clone();
		DesktopCapture {
			data:               Uint8Array::from(self.png),
			width:              self.geometry.width,
			height:             self.geometry.height,
			displays:           self
				.geometry
				.displays
				.into_iter()
				.map(|frame| DesktopDisplay {
					id:           frame.display.id,
					name:         frame.display.name,
					x:            frame.display.x,
					y:            frame.display.y,
					width:        frame.display.width,
					height:       frame.display.height,
					scale:        frame.display.scale,
					pixel_x:      frame.pixel_x,
					pixel_y:      frame.pixel_y,
					pixel_width:  frame.pixel_width,
					pixel_height: frame.pixel_height,
					is_primary:   frame.display.is_primary,
				})
				.collect(),
			backend:            capabilities.backend,
			display_server:     capabilities.display_server,
			capture_permission: capabilities.capture_permission,
			input_permission:   capabilities.input_permission,
		}
	}
}

fn validate_layout(displays: &[LayoutDisplay]) -> CoreResult<(i32, i32, i64, i64)> {
	if displays.is_empty() {
		return Err(DesktopError::new(
			ErrorCode::BackendUnavailable,
			"native backend reported no active displays",
		));
	}
	let mut ids = HashSet::with_capacity(displays.len());
	let mut min_x = i32::MAX;
	let mut min_y = i32::MAX;
	let mut max_x = i64::MIN;
	let mut max_y = i64::MIN;
	for (index, display) in displays.iter().enumerate() {
		if !ids.insert(&display.id) {
			return Err(DesktopError::new(
				ErrorCode::LayoutChanged,
				format!("duplicate display id `{}`", display.id),
			));
		}
		if display.width == 0
			|| display.height == 0
			|| !display.scale.is_finite()
			|| display.scale <= 0.0
		{
			return Err(DesktopError::new(
				ErrorCode::LayoutChanged,
				format!("display `{}` has invalid geometry or scale", display.id),
			));
		}
		let right = i64::from(display.x) + i64::from(display.width);
		let bottom = i64::from(display.y) + i64::from(display.height);
		min_x = min_x.min(display.x);
		min_y = min_y.min(display.y);
		max_x = max_x.max(right);
		max_y = max_y.max(bottom);
		for other in &displays[..index] {
			let other_right = i64::from(other.x) + i64::from(other.width);
			let other_bottom = i64::from(other.y) + i64::from(other.height);
			let overlap_x = i64::from(display.x) < other_right && i64::from(other.x) < right;
			let overlap_y = i64::from(display.y) < other_bottom && i64::from(other.y) < bottom;
			if overlap_x && overlap_y {
				return Err(DesktopError::new(
					ErrorCode::LayoutChanged,
					format!("displays `{}` and `{}` overlap", display.id, other.id),
				));
			}
		}
	}
	Ok((min_x, min_y, max_x, max_y))
}

fn same_layout(frame: &FrameGeometry, current: &[LayoutDisplay]) -> bool {
	if frame.displays.len() != current.len() {
		return false;
	}
	frame.displays.iter().all(|prior| {
		current.iter().any(|now| {
			now.id == prior.display.id
				&& now.x == prior.display.x
				&& now.y == prior.display.y
				&& now.width == prior.display.width
				&& now.height == prior.display.height
				&& (now.scale - prior.display.scale).abs() < 0.001
		})
	})
}
/// `XTest` `FakeInput` root coordinates are i16. Reject frame layouts the wire
/// protocol cannot address before any input is synthesized, so coordinates
/// fail closed instead of truncating.
#[cfg(any(target_os = "linux", test))]
fn validate_xtest_frame(frame: &FrameGeometry) -> CoreResult<()> {
	if frame
		.displays
		.iter()
		.any(|display| display.display.x < 0 || display.display.y < 0)
	{
		return Err(DesktopError::new(
			ErrorCode::BackendUnavailable,
			"X11/x11rb XTest absolute input cannot represent negative global desktop coordinates; \
			 select a display whose origin is non-negative",
		));
	}
	if frame.displays.iter().any(|display| {
		i64::from(display.display.x) + i64::from(display.display.width) > 32_768
			|| i64::from(display.display.y) + i64::from(display.display.height) > 32_768
	}) {
		return Err(DesktopError::new(
			ErrorCode::BackendUnavailable,
			"X11/x11rb XTest absolute input is limited to global coordinates in 0..=32767; select a \
			 smaller display layout",
		));
	}
	Ok(())
}

/// Every Linux input path (plain X11 and `XWayland` alike) synthesizes through
/// `XTest`, so the `XTest` coordinate limits apply regardless of the detected
/// backend.
#[cfg(target_os = "linux")]
fn validate_coordinate_backend(frame: &FrameGeometry) -> CoreResult<()> {
	validate_xtest_frame(frame)
}

#[cfg(not(target_os = "linux"))]
#[allow(
	clippy::unnecessary_wraps,
	clippy::missing_const_for_fn,
	reason = "signature parity with the Linux XTest validator"
)]
fn validate_coordinate_backend(_frame: &FrameGeometry) -> CoreResult<()> {
	Ok(())
}

/// The composite frame every coordinate action in one batch maps against:
/// frozen to the frame most recently returned to JavaScript before the batch
/// started, so an in-batch capture can never silently rebase later actions.
#[derive(Clone, Debug)]
struct BatchCoordinateFrame(Option<FrameGeometry>);

impl BatchCoordinateFrame {
	fn from_returned_frame(frame: Option<&FrameGeometry>) -> Self {
		Self(frame.cloned())
	}

	fn validate(&self, current: &[LayoutDisplay]) -> CoreResult<FrameGeometry> {
		let frame = self.0.clone().ok_or_else(|| {
			DesktopError::new(
				ErrorCode::InvalidAction,
				"coordinate input requires a screenshot returned by a completed prior request",
			)
		})?;
		if !same_layout(&frame, current) {
			return Err(DesktopError::new(
				ErrorCode::LayoutChanged,
				"display layout changed since the preceding screenshot; capture a new frame before \
				 input",
			));
		}
		validate_coordinate_backend(&frame)?;
		Ok(frame)
	}
}

/// Intermediate `screenshot` actions are deferred to the single capture taken
/// after the batch; every other action keeps its relative order.
fn executable_batch_actions(
	actions: Vec<ValidatedAction>,
) -> impl Iterator<Item = ValidatedAction> {
	actions
		.into_iter()
		.filter(|action| !matches!(action, ValidatedAction::Screenshot))
}

#[cfg(any(target_os = "macos", test))]
/// Whether the final segment after the last explicit wait contains input.
/// Screenshot markers are deferred and do not affect settling.
fn needs_post_input_settle(actions: &[ValidatedAction]) -> bool {
	let mut needs_settle = false;
	for action in actions {
		match action {
			ValidatedAction::Wait => needs_settle = false,
			ValidatedAction::Screenshot => {},
			ValidatedAction::Click { .. }
			| ValidatedAction::Drag { .. }
			| ValidatedAction::Keypress { .. }
			| ValidatedAction::Move { .. }
			| ValidatedAction::Scroll { .. }
			| ValidatedAction::Type { .. } => needs_settle = true,
		}
	}
	needs_settle
}

enum DesktopBatchStep {
	Action(ValidatedAction),
	#[cfg(any(target_os = "macos", test))]
	PostInputSettle,
	Capture,
}

fn desktop_batch_steps(actions: Vec<ValidatedAction>) -> impl Iterator<Item = DesktopBatchStep> {
	#[cfg(any(target_os = "macos", test))]
	let post_input_settle =
		needs_post_input_settle(&actions).then_some(DesktopBatchStep::PostInputSettle);
	#[cfg(not(any(target_os = "macos", test)))]
	let post_input_settle: Option<DesktopBatchStep> = None;

	executable_batch_actions(actions)
		.map(DesktopBatchStep::Action)
		.chain(post_input_settle)
		.chain(std::iter::once(DesktopBatchStep::Capture))
}

fn execute_desktop_batch<C, T>(
	context: &mut C,
	actions: Vec<ValidatedAction>,
	deadline: Instant,
	mut execute_action: impl FnMut(&mut C, ValidatedAction) -> CoreResult<()>,
	mut capture: impl FnMut(&mut C) -> CoreResult<T>,
) -> CoreResult<T> {
	for step in desktop_batch_steps(actions) {
		match step {
			DesktopBatchStep::Action(action) => {
				check_deadline(deadline)?;
				execute_action(context, action)?;
			},
			#[cfg(any(target_os = "macos", test))]
			DesktopBatchStep::PostInputSettle => {
				let remaining = deadline.saturating_duration_since(Instant::now());
				thread::sleep(MACOS_POST_INPUT_SETTLE_DURATION.min(remaining));
			},
			DesktopBatchStep::Capture => {
				check_deadline(deadline)?;
				return capture(context);
			},
		}
	}
	unreachable!("desktop batch always ends with capture")
}

struct DesktopWorker {
	config:         SessionConfig,
	capabilities:   Arc<Mutex<DesktopCapabilities>>,
	input:          Option<Enigo>,
	input_error:    Option<DesktopError>,
	/// Geometry of the last frame actually handed back to JavaScript; the only
	/// frame coordinate input may be interpreted against.
	returned_frame: Option<FrameGeometry>,
}

impl DesktopWorker {
	fn new(config: SessionConfig, capabilities: Arc<Mutex<DesktopCapabilities>>) -> Self {
		let input_error = if config.backend.is_none() {
			Some(DesktopError::new(
				ErrorCode::BackendUnavailable,
				"no native graphical desktop is available",
			))
		} else {
			None
		};
		let worker = Self { config, capabilities, input: None, input_error, returned_frame: None };
		// Capture probing is intentionally independent from input initialization.
		// In particular, Linux read-only sessions must not connect the XTest
		// input backend until the first mutating action.
		worker.probe_capabilities();
		worker
	}

	fn probe_capabilities(&self) {
		match self.enumerate_monitors() {
			Ok(monitors) => {
				let mut caps = self.capabilities.lock();
				caps.capture = true;
				caps.display_count = monitors.len() as u32;
			},
			Err(error) => self.record_capture_failure(&error),
		}
	}

	fn record_capture_failure(&self, error: &DesktopError) {
		let mut caps = self.capabilities.lock();
		caps.capture = false;
		caps.capture_permission = if error.code == ErrorCode::PermissionDenied {
			PERMISSION_DENIED.to_string()
		} else {
			PERMISSION_UNAVAILABLE.to_string()
		};
		caps.display_count = 0;
	}

	fn ensure_input(&mut self) -> CoreResult<&mut Enigo> {
		if self.input.is_none() {
			let backend = self.config.backend.ok_or_else(|| {
				DesktopError::new(
					ErrorCode::BackendUnavailable,
					"no native graphical desktop is available",
				)
			})?;
			match create_input(backend) {
				Ok(input) => {
					self.input = Some(input);
					self.input_error = None;
					let mut caps = self.capabilities.lock();
					caps.input = true;
					caps.input_permission = PERMISSION_GRANTED.to_string();
				},
				Err(error) => {
					self.input_error = Some(error.clone());
					let mut caps = self.capabilities.lock();
					caps.input = false;
					caps.input_permission = if error.code == ErrorCode::PermissionDenied {
						PERMISSION_DENIED.to_string()
					} else {
						PERMISSION_UNAVAILABLE.to_string()
					};
					drop(caps);
					return Err(error);
				},
			}
		}
		self.input.as_mut().ok_or_else(|| {
			self.input_error.clone().unwrap_or_else(|| {
				DesktopError::new(ErrorCode::InputFailed, "native input backend is unavailable")
			})
		})
	}

	fn enumerate_monitors(&self) -> CoreResult<Vec<MonitorSnapshot>> {
		let backend = self.config.backend.ok_or_else(|| {
			DesktopError::new(
				ErrorCode::BackendUnavailable,
				"no native graphical desktop is available; DISPLAY/WAYLAND_DISPLAY is unset",
			)
		})?;
		#[cfg(target_os = "linux")]
		if backend == ConcreteBackend::Wayland && std::env::var_os("DISPLAY").is_none() {
			let error = DesktopError::new(
				ErrorCode::BackendUnavailable,
				"Wayland sessions require an active XWayland DISPLAY for native capture and input; \
				 pure Wayland capture is unavailable",
			);
			self.record_capture_failure(&error);
			return Err(error);
		}
		#[cfg(target_os = "macos")]
		if backend == ConcreteBackend::Quartz && !macos_capture_permission() {
			let mut caps = self.capabilities.lock();
			caps.capture = false;
			caps.capture_permission = PERMISSION_DENIED.to_string();
			return Err(DesktopError::new(
				ErrorCode::PermissionDenied,
				"macOS Screen Recording permission is not granted for this process",
			));
		}
		let monitors = match Monitor::all() {
			Ok(monitors) => monitors,
			Err(source) => {
				let error = DesktopError::permission_or(
					ErrorCode::BackendUnavailable,
					format!("{} monitor enumeration failed: {source}", backend.name()),
				);
				self.record_capture_failure(&error);
				return Err(error);
			},
		};
		let mut snapshots = Vec::with_capacity(monitors.len());
		for monitor in monitors {
			let id = monitor.id().map_err(capture_metadata_error)?.to_string();
			if let DisplaySelection::Id(selected) = self.config.selection
				&& id != selected.to_string()
			{
				continue;
			}
			let name = monitor_name(&monitor);
			let x = monitor.x().map_err(capture_metadata_error)?;
			let y = monitor.y().map_err(capture_metadata_error)?;
			let width = monitor.width().map_err(capture_metadata_error)?;
			let height = monitor.height().map_err(capture_metadata_error)?;
			let scale = f64::from(monitor.scale_factor().map_err(capture_metadata_error)?);
			let is_primary = monitor.is_primary().map_err(capture_metadata_error)?;
			snapshots.push(MonitorSnapshot {
				#[cfg(not(target_os = "macos"))]
				monitor,
				display: LayoutDisplay { id, name, x, y, width, height, scale, is_primary },
			});
		}
		if snapshots.is_empty() {
			return Err(match self.config.selection {
				DisplaySelection::All => DesktopError::new(
					ErrorCode::BackendUnavailable,
					"native backend reported no active displays",
				),
				DisplaySelection::Id(id) => DesktopError::new(
					ErrorCode::InvalidOptions,
					format!("selected display id `{id}` is not active"),
				),
			});
		}
		snapshots.sort_by(|left, right| {
			(left.display.y, left.display.x, &left.display.id).cmp(&(
				right.display.y,
				right.display.x,
				&right.display.id,
			))
		});
		let mut coalesced: Vec<MonitorSnapshot> = Vec::with_capacity(snapshots.len());
		for snapshot in snapshots {
			if let Some(existing) = coalesced
				.iter_mut()
				.find(|existing| same_display_rect(&existing.display, &snapshot.display))
			{
				if snapshot.display.is_primary && !existing.display.is_primary {
					*existing = snapshot;
				}
			} else {
				coalesced.push(snapshot);
			}
		}
		validate_layout(
			&coalesced
				.iter()
				.map(|item| item.display.clone())
				.collect::<Vec<_>>(),
		)?;
		Ok(coalesced)
	}

	fn current_layout(&self) -> CoreResult<Vec<LayoutDisplay>> {
		Ok(self
			.enumerate_monitors()?
			.into_iter()
			.map(|snapshot| snapshot.display)
			.collect())
	}

	fn capture(&mut self) -> CoreResult<CoreCapture> {
		let snapshots = self.enumerate_monitors()?;
		let displays: Vec<_> = snapshots.iter().map(|item| item.display.clone()).collect();
		let (min_x, min_y, max_x, max_y) = validate_layout(&displays)?;
		let logical_width = u32::try_from(max_x - i64::from(min_x)).map_err(|_| {
			DesktopError::new(ErrorCode::LayoutChanged, "desktop logical width overflow")
		})?;
		let logical_height = u32::try_from(max_y - i64::from(min_y)).map_err(|_| {
			DesktopError::new(ErrorCode::LayoutChanged, "desktop logical height overflow")
		})?;

		let mut images = Vec::with_capacity(snapshots.len());
		let mut native_scale = 1.0f64;
		for snapshot in &snapshots {
			let image = match capture_monitor_image(snapshot) {
				Ok(image) => image,
				Err(error) => {
					self.record_capture_failure(&error);
					return Err(error);
				},
			};
			if image.width() == 0 || image.height() == 0 {
				let error = DesktopError::new(
					ErrorCode::CaptureFailed,
					format!("capture of display `{}` returned an empty image", snapshot.display.id),
				);
				self.record_capture_failure(&error);
				return Err(error);
			}
			native_scale = native_scale
				.max(f64::from(image.width()) / f64::from(snapshot.display.width))
				.max(f64::from(image.height()) / f64::from(snapshot.display.height));
			images.push(image);
		}
		let mut render_scale = native_scale;
		if let Some(max_width) = self.config.max_width {
			render_scale = render_scale.min(f64::from(max_width) / f64::from(logical_width));
		}
		if let Some(max_height) = self.config.max_height {
			render_scale = render_scale.min(f64::from(max_height) / f64::from(logical_height));
		}
		if !render_scale.is_finite() || render_scale <= 0.0 {
			return Err(DesktopError::new(
				ErrorCode::CaptureFailed,
				"computed composite scale is invalid",
			));
		}
		let target_width = scaled_edge(logical_width, render_scale).max(1);
		let target_height = scaled_edge(logical_height, render_scale).max(1);
		if u64::from(target_width) * u64::from(target_height) > MAX_COMPOSITE_PIXELS {
			return Err(DesktopError::new(
				ErrorCode::CaptureFailed,
				format!("composite {target_width}x{target_height} exceeds the native safety limit"),
			));
		}
		let mut composite = RgbaImage::from_pixel(target_width, target_height, Rgba([0, 0, 0, 255]));
		let mut frame_displays = Vec::with_capacity(displays.len());
		for ((snapshot, image), display) in snapshots.iter().zip(images).zip(displays) {
			let offset_x = u32::try_from(i64::from(display.x) - i64::from(min_x)).map_err(|_| {
				DesktopError::new(ErrorCode::LayoutChanged, "display x offset overflow")
			})?;
			let offset_y = u32::try_from(i64::from(display.y) - i64::from(min_y)).map_err(|_| {
				DesktopError::new(ErrorCode::LayoutChanged, "display y offset overflow")
			})?;
			let pixel_x = scaled_edge(offset_x, render_scale);
			let pixel_y = scaled_edge(offset_y, render_scale);
			let pixel_right = scaled_edge(offset_x + display.width, render_scale).min(target_width);
			let pixel_bottom = scaled_edge(offset_y + display.height, render_scale).min(target_height);
			let pixel_width = pixel_right.saturating_sub(pixel_x).max(1);
			let pixel_height = pixel_bottom.saturating_sub(pixel_y).max(1);
			let resized = if image.width() == pixel_width && image.height() == pixel_height {
				image
			} else {
				image::imageops::resize(&image, pixel_width, pixel_height, FilterType::Triangle)
			};
			image::imageops::replace(&mut composite, &resized, i64::from(pixel_x), i64::from(pixel_y));
			frame_displays.push(FrameDisplay { display, pixel_x, pixel_y, pixel_width, pixel_height });
			let _ = snapshot;
		}
		let mut png = Vec::with_capacity(composite.len() / 2);
		DynamicImage::ImageRgba8(composite)
			.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
			.map_err(|error| {
				DesktopError::new(ErrorCode::CaptureFailed, format!("PNG encoding failed: {error}"))
			})?;
		let geometry = FrameGeometry {
			width:    target_width,
			height:   target_height,
			displays: frame_displays,
		};
		self.returned_frame = Some(geometry.clone());
		let mut caps = self.capabilities.lock();
		caps.capture = true;
		caps.capture_permission = PERMISSION_GRANTED.to_string();
		caps.display_count = geometry.displays.len() as u32;
		drop(caps);
		Ok(CoreCapture { png, geometry })
	}

	fn ensure_coordinate_frame(
		&mut self,
		batch_frame: &BatchCoordinateFrame,
	) -> CoreResult<FrameGeometry> {
		let current = self.current_layout()?;
		let frame = batch_frame.validate(&current);
		if matches!(&frame, Err(error) if error.code == ErrorCode::LayoutChanged) {
			self.returned_frame = None;
		}
		frame
	}

	fn execute(
		&mut self,
		actions: Vec<ValidatedAction>,
		deadline: Instant,
	) -> CoreResult<CoreCapture> {
		// Freeze coordinate mapping to the last frame returned before this batch.
		// In-batch screenshot markers are deferred to the single final capture.
		let batch_frame = BatchCoordinateFrame::from_returned_frame(self.returned_frame.as_ref());
		execute_desktop_batch(
			self,
			actions,
			deadline,
			|worker, action| {
				match action {
					ValidatedAction::Click { x, y, button, count, modifiers } => {
						let frame = worker.ensure_coordinate_frame(&batch_frame)?;
						let (x, y) = frame.map_point(x, y)?;
						let input = worker.ensure_input()?;
						with_modifiers(input, &modifiers, |input| {
							click_at(input, x, y, button, count, &modifiers)
						})?;
					},
					ValidatedAction::Drag { path, modifiers } => {
						let frame = worker.ensure_coordinate_frame(&batch_frame)?;
						let mapped = path
							.into_iter()
							.map(|point| frame.map_point(point.x, point.y))
							.collect::<CoreResult<Vec<_>>>()?;
						let input = worker.ensure_input()?;
						with_modifiers(input, &modifiers, |input| drag_path(input, &mapped, &modifiers))?;
					},
					ValidatedAction::Keypress { keys } => {
						let parsed = parse_keypress(&keys)?;
						execute_keypress(worker.ensure_input()?, &parsed)?;
					},
					ValidatedAction::Move { x, y, modifiers } => {
						let frame = worker.ensure_coordinate_frame(&batch_frame)?;
						let (x, y) = frame.map_point(x, y)?;
						with_modifiers(worker.ensure_input()?, &modifiers, |input| {
							move_mouse(input, x, y)
						})?;
					},
					ValidatedAction::Screenshot => unreachable!("screenshot actions are deferred"),
					ValidatedAction::Scroll { x, y, scroll_x, scroll_y, modifiers } => {
						let frame = worker.ensure_coordinate_frame(&batch_frame)?;
						let (x, y) = frame.map_point(x, y)?;
						let input = worker.ensure_input()?;
						with_modifiers(input, &modifiers, |input| {
							move_mouse(input, x, y)?;
							let horizontal = scroll_steps(scroll_x);
							let vertical = scroll_steps(scroll_y);
							if horizontal != 0 {
								input
									.scroll(horizontal, Axis::Horizontal)
									.map_err(input_error)?;
							}
							if vertical != 0 {
								input
									.scroll(vertical, Axis::Vertical)
									.map_err(input_error)?;
							}
							Ok(())
						})?;
					},
					ValidatedAction::Type { text } => {
						worker.ensure_input()?.text(&text).map_err(input_error)?;
					},
					ValidatedAction::Wait => {
						let remaining = deadline.saturating_duration_since(Instant::now());
						if remaining.is_zero() {
							return Err(deadline_exceeded());
						}
						thread::sleep(WAIT_ACTION_DURATION.min(remaining));
					},
				}
				Ok(())
			},
			Self::capture,
		)
	}
}

fn scaled_edge(value: u32, scale: f64) -> u32 {
	(f64::from(value) * scale)
		.round()
		.clamp(0.0, f64::from(u32::MAX)) as u32
}

fn capture_metadata_error(error: impl fmt::Display) -> DesktopError {
	DesktopError::permission_or(
		ErrorCode::BackendUnavailable,
		format!("failed to read native display metadata: {error}"),
	)
}

#[cfg(target_os = "macos")]
fn monitor_name(monitor: &Monitor) -> String {
	// `friendly_name` uses AppKit's main-thread-only NSScreen API internally;
	// the persistent capture worker intentionally stays off the JS/main thread.
	monitor
		.name()
		.unwrap_or_else(|_| "Unknown display".to_string())
}

#[cfg(not(target_os = "macos"))]
fn monitor_name(monitor: &Monitor) -> String {
	monitor
		.friendly_name()
		.or_else(|_| monitor.name())
		.unwrap_or_else(|_| "Unknown display".to_string())
}

#[cfg(target_os = "linux")]
fn create_input(backend: ConcreteBackend) -> CoreResult<Enigo> {
	Enigo::new().map_err(|error| {
		DesktopError::permission_or(
			ErrorCode::BackendUnavailable,
			format!("{} native input initialization failed: {error}", backend.name()),
		)
	})
}

#[cfg(not(target_os = "linux"))]
fn create_input(backend: ConcreteBackend) -> CoreResult<Enigo> {
	#[cfg(target_os = "windows")]
	let _ = enigo::set_dpi_awareness();
	let settings = Settings { open_prompt_to_get_permissions: false, ..Settings::default() };
	match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Enigo::new(&settings))) {
		Ok(Ok(input)) => Ok(input),
		Ok(Err(error)) => Err(DesktopError::permission_or(
			ErrorCode::BackendUnavailable,
			format!("{} native input initialization failed: {error}", backend.name()),
		)),
		Err(_) => Err(DesktopError::new(
			ErrorCode::BackendUnavailable,
			format!("{} native input initialization failed unexpectedly", backend.name()),
		)),
	}
}

fn input_error(error: impl fmt::Display) -> DesktopError {
	DesktopError::permission_or(ErrorCode::InputFailed, format!("native input failed: {error}"))
}

fn deadline_exceeded() -> DesktopError {
	DesktopError::new(
		ErrorCode::DeadlineExceeded,
		"native action deadline exceeded; remaining batch actions were not executed",
	)
}

fn check_deadline(deadline: Instant) -> CoreResult<()> {
	if Instant::now() >= deadline {
		Err(deadline_exceeded())
	} else {
		Ok(())
	}
}

/// Reject batches whose mandatory `wait` time alone cannot finish inside the
/// worker deadline, keeping 5s of slack for real input and the final capture.
fn validate_batch_wait_budget(actions: &[ValidatedAction]) -> CoreResult<()> {
	let waits = actions
		.iter()
		.filter(|action| matches!(action, ValidatedAction::Wait))
		.count();
	let wait_total = WAIT_ACTION_DURATION.saturating_mul(u32::try_from(waits).unwrap_or(u32::MAX));
	if wait_total > OPERATION_TIMEOUT.saturating_sub(Duration::from_secs(5)) {
		return Err(DesktopError::new(
			ErrorCode::InvalidAction,
			"batch cannot complete within the 60s native deadline",
		));
	}
	Ok(())
}

#[cfg(any(target_os = "macos", test))]
const MODIFIER_CONTROL: u8 = 1 << 0;
#[cfg(any(target_os = "macos", test))]
const MODIFIER_SHIFT: u8 = 1 << 1;
#[cfg(any(target_os = "macos", test))]
const MODIFIER_ALT: u8 = 1 << 2;
#[cfg(any(target_os = "macos", test))]
const MODIFIER_META: u8 = 1 << 3;

#[cfg(any(target_os = "macos", test))]
fn modifier_mask(modifiers: &[Key]) -> u8 {
	modifiers.iter().fold(0, |mask, modifier| {
		mask
			| match modifier {
				Key::Control => MODIFIER_CONTROL,
				Key::Shift => MODIFIER_SHIFT,
				Key::Alt => MODIFIER_ALT,
				Key::Meta => MODIFIER_META,
				_ => 0,
			}
	})
}

#[cfg(target_os = "macos")]
fn quartz_modifier_flags(modifiers: &[Key]) -> CGEventFlags {
	let mask = modifier_mask(modifiers);
	let mut flags = CGEventFlags::empty();
	if mask & MODIFIER_CONTROL != 0 {
		flags |= CGEventFlags::CGEventFlagControl;
	}
	if mask & MODIFIER_SHIFT != 0 {
		flags |= CGEventFlags::CGEventFlagShift;
	}
	if mask & MODIFIER_ALT != 0 {
		flags |= CGEventFlags::CGEventFlagAlternate;
	}
	if mask & MODIFIER_META != 0 {
		flags |= CGEventFlags::CGEventFlagCommand;
	}
	flags
}

#[cfg(not(target_os = "macos"))]
fn click_at(
	input: &mut Enigo,
	x: i32,
	y: i32,
	button: MouseButton,
	count: u8,
	_modifiers: &[Key],
) -> CoreResult<()> {
	move_mouse(input, x, y)?;
	for _ in 0..count {
		input
			.button(button.into(), Direction::Click)
			.map_err(input_error)?;
	}
	Ok(())
}

#[cfg(target_os = "macos")]
fn click_at(
	_input: &mut Enigo,
	x: i32,
	y: i32,
	button: MouseButton,
	count: u8,
	modifiers: &[Key],
) -> CoreResult<()> {
	let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|()| {
		DesktopError::new(ErrorCode::InputFailed, "failed to create a Quartz pointer event source")
	})?;
	let (down, up, quartz_button, number) = match button {
		MouseButton::Left => {
			(CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left, 0)
		},
		MouseButton::Right => {
			(CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right, 1)
		},
		MouseButton::Wheel => {
			(CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center, 2)
		},
		MouseButton::Back => {
			(CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center, 3)
		},
		MouseButton::Forward => {
			(CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center, 4)
		},
	};
	let point = CGPoint::new(f64::from(x), f64::from(y));
	let flags = quartz_modifier_flags(modifiers);
	for click_state in 1..=i64::from(count) {
		for event_type in [down, up] {
			let event = CGEvent::new_mouse_event(source.clone(), event_type, point, quartz_button)
				.map_err(|()| {
					DesktopError::new(ErrorCode::InputFailed, "failed to create a Quartz pointer event")
				})?;
			event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, number);
			event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
			event.set_flags(flags);
			event.post(CGEventTapLocation::HID);
		}
	}
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn drag_path(input: &mut Enigo, path: &[(i32, i32)], _modifiers: &[Key]) -> CoreResult<()> {
	let (start_x, start_y) = path[0];
	move_mouse(input, start_x, start_y)?;
	input
		.button(Button::Left, Direction::Press)
		.map_err(input_error)?;
	let drag_result = path[1..]
		.iter()
		.try_for_each(|&(x, y)| move_mouse(input, x, y));
	let release_result = input
		.button(Button::Left, Direction::Release)
		.map_err(input_error);
	drag_result.and(release_result)
}

#[cfg(target_os = "macos")]
fn drag_path(_input: &mut Enigo, path: &[(i32, i32)], modifiers: &[Key]) -> CoreResult<()> {
	let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|()| {
		DesktopError::new(ErrorCode::InputFailed, "failed to create a Quartz pointer event source")
	})?;
	let flags = quartz_modifier_flags(modifiers);
	let post = |event_type, (x, y): (i32, i32)| -> CoreResult<()> {
		let event = CGEvent::new_mouse_event(
			source.clone(),
			event_type,
			CGPoint::new(f64::from(x), f64::from(y)),
			CGMouseButton::Left,
		)
		.map_err(|()| {
			DesktopError::new(ErrorCode::InputFailed, "failed to create a Quartz drag event")
		})?;
		event.set_flags(flags);
		event.post(CGEventTapLocation::HID);
		Ok(())
	};
	post(CGEventType::LeftMouseDown, path[0])?;
	let drag_result = path[1..]
		.iter()
		.copied()
		.try_for_each(|point| post(CGEventType::LeftMouseDragged, point));
	let release_result = post(CGEventType::LeftMouseUp, *path.last().expect("validated drag path"));
	drag_result.and(release_result)
}

#[cfg(not(target_os = "windows"))]
fn move_mouse(input: &mut Enigo, x: i32, y: i32) -> CoreResult<()> {
	input.move_mouse(x, y, Coordinate::Abs).map_err(input_error)
}

#[cfg(target_os = "windows")]
fn move_mouse(_input: &mut Enigo, x: i32, y: i32) -> CoreResult<()> {
	use std::mem::size_of;

	use windows_sys::Win32::UI::{
		Input::KeyboardAndMouse::{
			INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
			MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, SendInput,
		},
		WindowsAndMessaging::{
			GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
			SM_YVIRTUALSCREEN,
		},
	};
	// Win32 absolute input uses normalized coordinates over the virtual desktop;
	// MOUSEEVENTF_VIRTUALDESK is required for negative origins and secondary
	// monitors (enigo's default absolute path targets only the primary monitor).
	let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
	let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
	let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
	let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
	if width <= 1 || height <= 1 {
		return Err(DesktopError::new(
			ErrorCode::BackendUnavailable,
			"Win32 virtual desktop geometry is unavailable",
		));
	}
	let normalized_x =
		((i64::from(x - origin_x) * 65_535) / i64::from(width - 1)).clamp(0, 65_535) as i32;
	let normalized_y =
		((i64::from(y - origin_y) * 65_535) / i64::from(height - 1)).clamp(0, 65_535) as i32;
	let event = INPUT {
		r#type:    INPUT_MOUSE,
		Anonymous: INPUT_0 {
			mi: MOUSEINPUT {
				dx:          normalized_x,
				dy:          normalized_y,
				mouseData:   0,
				dwFlags:     MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
				time:        0,
				dwExtraInfo: 0,
			},
		},
	};
	let sent = unsafe { SendInput(1, &event, size_of::<INPUT>() as i32) };
	if sent == 1 {
		Ok(())
	} else {
		Err(DesktopError::new(
			ErrorCode::InputFailed,
			"Win32 SendInput failed while moving the pointer",
		))
	}
}

fn scroll_steps(delta: i32) -> i32 {
	if delta == 0 {
		0
	} else {
		delta.signum() * ((delta.unsigned_abs() + 50) / 100).max(1) as i32
	}
}

fn parse_modifiers(keys: Vec<String>) -> CoreResult<Vec<Key>> {
	let parsed = parse_keypress(&keys)?;
	let mut unique = Vec::with_capacity(parsed.len());
	for key in parsed {
		if !matches!(key, Key::Control | Key::Shift | Key::Alt | Key::Meta) {
			return Err(DesktopError::new(
				ErrorCode::InvalidAction,
				"mouse action keys may contain modifier keys only",
			));
		}
		if unique.contains(&key) {
			return Err(DesktopError::new(
				ErrorCode::InvalidAction,
				"mouse action contains a duplicate modifier key",
			));
		}
		unique.push(key);
	}
	Ok(unique)
}

fn parse_keypress(keys: &[String]) -> CoreResult<Vec<Key>> {
	let mut parsed = Vec::new();
	for key in keys {
		for component in key.split('+') {
			let component = component.trim();
			if component.is_empty() {
				return Err(DesktopError::new(
					ErrorCode::InvalidAction,
					format!("invalid empty component in keypress `{key}`"),
				));
			}
			parsed.push(normalize_keypress_key(parse_key(component)?));
		}
	}
	Ok(parsed)
}

fn normalize_keypress_key(key: Key) -> Key {
	let Key::Unicode(character) = key else {
		return key;
	};
	let mut lowercase = character.to_lowercase();
	match (lowercase.next(), lowercase.next()) {
		(Some(character), None) => Key::Unicode(character),
		_ => key,
	}
}

fn parse_key(value: &str) -> CoreResult<Key> {
	let normalized = value.to_ascii_uppercase();
	let key = match normalized.as_str() {
		"CTRL" | "CONTROL" => Key::Control,
		"SHIFT" => Key::Shift,
		"ALT" | "OPTION" => Key::Alt,
		"META" | "CMD" | "COMMAND" | "SUPER" | "WINDOWS" => Key::Meta,
		"ENTER" | "RETURN" => Key::Return,
		"ESC" | "ESCAPE" => Key::Escape,
		"TAB" => Key::Tab,
		"SPACE" => Key::Space,
		"BACKSPACE" => Key::Backspace,
		"DELETE" | "DEL" => Key::Delete,
		#[cfg(not(target_os = "macos"))]
		"INSERT" => Key::Insert,
		#[cfg(target_os = "macos")]
		"INSERT" => Key::Other(0x72),
		"HOME" => Key::Home,
		"END" => Key::End,
		"PAGEUP" => Key::PageUp,
		"PAGEDOWN" => Key::PageDown,
		"UP" | "ARROWUP" => Key::UpArrow,
		"DOWN" | "ARROWDOWN" => Key::DownArrow,
		"LEFT" | "ARROWLEFT" => Key::LeftArrow,
		"RIGHT" | "ARROWRIGHT" => Key::RightArrow,
		"CAPSLOCK" => Key::CapsLock,
		#[cfg(not(target_os = "macos"))]
		"NUMLOCK" => Key::Numlock,
		#[cfg(target_os = "macos")]
		"NUMLOCK" => Key::Other(0x47),
		#[cfg(not(target_os = "macos"))]
		"PRINTSCREEN" | "PRINTSCR" => Key::PrintScr,
		#[cfg(target_os = "macos")]
		"PRINTSCREEN" | "PRINTSCR" => {
			return Err(DesktopError::new(
				ErrorCode::InvalidAction,
				"Print Screen has no native macOS key",
			));
		},
		"F1" => Key::F1,
		"F2" => Key::F2,
		"F3" => Key::F3,
		"F4" => Key::F4,
		"F5" => Key::F5,
		"F6" => Key::F6,
		"F7" => Key::F7,
		"F8" => Key::F8,
		"F9" => Key::F9,
		"F10" => Key::F10,
		"F11" => Key::F11,
		"F12" => Key::F12,
		"F13" => Key::F13,
		"F14" => Key::F14,
		"F15" => Key::F15,
		"F16" => Key::F16,
		"F17" => Key::F17,
		"F18" => Key::F18,
		"F19" => Key::F19,
		"F20" => Key::F20,
		#[cfg(not(target_os = "macos"))]
		"F21" => Key::F21,
		#[cfg(not(target_os = "macos"))]
		"F22" => Key::F22,
		#[cfg(not(target_os = "macos"))]
		"F23" => Key::F23,
		#[cfg(not(target_os = "macos"))]
		"F24" => Key::F24,
		#[cfg(target_os = "macos")]
		"F21" | "F22" | "F23" | "F24" => {
			return Err(DesktopError::new(
				ErrorCode::InvalidAction,
				format!("{normalized} has no native macOS key"),
			));
		},
		_ => {
			let mut characters = value.chars();
			match (characters.next(), characters.next()) {
				(Some(character), None) => Key::Unicode(character),
				_ => {
					return Err(DesktopError::new(
						ErrorCode::InvalidAction,
						format!("unsupported key `{value}`"),
					));
				},
			}
		},
	};
	Ok(key)
}

/// Press every chord key in order, then release in reverse. A failed press
/// best-effort-releases what is already held; a failed release still attempts
/// every remaining held key and surfaces the first release error.
fn execute_keypress_with<E>(
	keys: &[Key],
	mut emit: impl FnMut(Key, Direction) -> std::result::Result<(), E>,
) -> std::result::Result<(), E> {
	if keys.len() == 1 {
		return emit(keys[0], Direction::Click);
	}
	let mut pressed = Vec::with_capacity(keys.len());
	for &key in keys {
		if let Err(error) = emit(key, Direction::Press) {
			for &held in pressed.iter().rev() {
				let _ = emit(held, Direction::Release);
			}
			return Err(error);
		}
		pressed.push(key);
	}
	let mut release_error = None;
	for &key in pressed.iter().rev() {
		if let Err(error) = emit(key, Direction::Release)
			&& release_error.is_none()
		{
			release_error = Some(error);
		}
	}
	match release_error {
		Some(error) => Err(error),
		None => Ok(()),
	}
}

fn execute_keypress(input: &mut Enigo, keys: &[Key]) -> CoreResult<()> {
	execute_keypress_with(keys, |key, direction| input.key(key, direction)).map_err(input_error)
}

fn with_modifiers(
	input: &mut Enigo,
	modifiers: &[Key],
	operation: impl FnOnce(&mut Enigo) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut pressed = Vec::with_capacity(modifiers.len());
	for &key in modifiers {
		if let Err(error) = input.key(key, Direction::Press) {
			for &held in pressed.iter().rev() {
				let _ = input.key(held, Direction::Release);
			}
			return Err(input_error(error));
		}
		pressed.push(key);
	}
	let operation_result = operation(input);
	let mut release_result = Ok(());
	for &key in pressed.iter().rev() {
		if let Err(error) = input.key(key, Direction::Release)
			&& release_result.is_ok()
		{
			release_result = Err(input_error(error));
		}
	}
	operation_result.and(release_result)
}

enum WorkerRequest {
	Capture(flume::Sender<CoreResult<CoreCapture>>),
	Execute {
		actions:  Vec<ValidatedAction>,
		deadline: Instant,
		reply:    flume::Sender<CoreResult<CoreCapture>>,
	},
	Close(flume::Sender<()>),
}

struct SessionLifecycle {
	tx:   Option<flume::Sender<WorkerRequest>>,
	done: flume::Receiver<()>,
	join: Option<JoinHandle<()>>,
}

struct SessionCore {
	lifecycle: Mutex<SessionLifecycle>,
}

impl SessionCore {
	fn start(
		config: SessionConfig,
		capabilities: Arc<Mutex<DesktopCapabilities>>,
	) -> CoreResult<Arc<Self>> {
		let (tx, rx) = flume::unbounded();
		let (done_tx, done_rx) = flume::bounded(1);
		let (ready_tx, ready_rx) = flume::bounded(1);
		let join = thread::Builder::new()
			.name("omp-desktop-session".to_string())
			.spawn(move || {
				let mut worker = DesktopWorker::new(config, capabilities);
				let _ = ready_tx.send(());
				while let Ok(request) = rx.recv() {
					match request {
						WorkerRequest::Capture(reply) => {
							let _ = reply.send(worker.capture());
						},
						WorkerRequest::Execute { actions, deadline, reply } => {
							let _ = reply.send(worker.execute(actions, deadline));
						},
						WorkerRequest::Close(reply) => {
							let _ = reply.send(());
							break;
						},
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|error| {
				DesktopError::new(
					ErrorCode::WorkerFailed,
					format!("failed to start native desktop worker: {error}"),
				)
			})?;
		ready_rx.recv_timeout(OPERATION_TIMEOUT).map_err(|error| {
			DesktopError::new(
				ErrorCode::WorkerFailed,
				format!("native desktop worker initialization did not complete: {error}"),
			)
		})?;
		Ok(Arc::new(Self {
			lifecycle: Mutex::new(SessionLifecycle {
				tx:   Some(tx),
				done: done_rx,
				join: Some(join),
			}),
		}))
	}

	fn capture(&self) -> CoreResult<CoreCapture> {
		let (reply_tx, reply_rx) = flume::bounded(1);
		self.send(WorkerRequest::Capture(reply_tx))?;
		reply_rx
			.recv_timeout(OPERATION_TIMEOUT)
			.map_err(worker_receive_error)?
	}

	fn execute(&self, actions: Vec<ValidatedAction>) -> CoreResult<CoreCapture> {
		validate_batch_wait_budget(&actions)?;
		let deadline = Instant::now() + OPERATION_TIMEOUT;
		let (reply_tx, reply_rx) = flume::bounded(1);
		self.send(WorkerRequest::Execute { actions, deadline, reply: reply_tx })?;
		// The worker enforces `deadline` itself; the extra slack guarantees its
		// DeadlineExceeded error reports before this channel timeout can fire.
		reply_rx
			.recv_timeout(OPERATION_TIMEOUT + Duration::from_secs(5))
			.map_err(worker_receive_error)?
	}

	fn send(&self, request: WorkerRequest) -> CoreResult<()> {
		let lifecycle = self.lifecycle.lock();
		let tx = lifecycle
			.tx
			.as_ref()
			.ok_or_else(|| DesktopError::new(ErrorCode::SessionClosed, "desktop session is closed"))?;
		tx.send(request).map_err(|_| {
			DesktopError::new(ErrorCode::WorkerFailed, "native desktop worker stopped unexpectedly")
		})
	}

	fn close(&self) -> CoreResult<()> {
		let mut lifecycle = self.lifecycle.lock();
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (reply_tx, reply_rx) = flume::bounded(1);
		tx.send(WorkerRequest::Close(reply_tx)).map_err(|_| {
			DesktopError::new(ErrorCode::WorkerFailed, "native desktop worker stopped before close")
		})?;
		reply_rx.recv_timeout(CLOSE_TIMEOUT).map_err(|error| {
			DesktopError::new(
				ErrorCode::WorkerFailed,
				format!("timed out closing native desktop worker: {error}"),
			)
		})?;
		lifecycle
			.done
			.recv_timeout(CLOSE_TIMEOUT)
			.map_err(|error| {
				DesktopError::new(
					ErrorCode::WorkerFailed,
					format!("native desktop worker did not exit after close: {error}"),
				)
			})?;
		if let Some(join) = lifecycle.join.take() {
			join.join().map_err(|_| {
				DesktopError::new(
					ErrorCode::WorkerFailed,
					"native desktop worker panicked during close",
				)
			})?;
		}
		Ok(())
	}
}

impl Drop for SessionCore {
	fn drop(&mut self) {
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(WorkerRequest::Close(reply));
		}
		// A blocking destructor can deadlock addon shutdown. A still-running
		// JoinHandle intentionally detaches here; explicit close remains bounded.
		let _ = lifecycle.join.take();
	}
}

fn worker_receive_error(error: flume::RecvTimeoutError) -> DesktopError {
	DesktopError::new(
		ErrorCode::WorkerFailed,
		format!("native desktop worker did not complete the operation: {error}"),
	)
}

/// Persistent, serialized native desktop capture/input session.
#[napi]
pub struct DesktopSession {
	core:         Arc<SessionCore>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}

#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		let (config, initial_capabilities) =
			SessionConfig::parse(options).map_err(napi::Error::from)?;
		let capabilities = Arc::new(Mutex::new(initial_capabilities));
		let core =
			SessionCore::start(config, Arc::clone(&capabilities)).map_err(napi::Error::from)?;
		Ok(Self { core, capabilities })
	}

	/// Current backend capability and permission state.
	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		self.capabilities.lock().clone()
	}

	/// Capture a fresh PNG composite of the selected display(s).
	#[napi]
	pub fn capture(&self) -> task::Promise<DesktopCapture> {
		let core = Arc::clone(&self.core);
		let capabilities = Arc::clone(&self.capabilities);
		task::blocking("desktop.capture", (), move |_| {
			core
				.capture()
				.map(|capture| capture.into_napi(&capabilities))
				.map_err(napi::Error::from)
		})
	}

	/// Execute a validated action batch in order, then return a fresh
	/// screenshot.
	#[napi]
	pub fn execute(&self, actions: Vec<DesktopAction>) -> Result<task::Promise<DesktopCapture>> {
		let actions = actions
			.into_iter()
			.map(ValidatedAction::try_from)
			.collect::<CoreResult<Vec<_>>>()
			.map_err(napi::Error::from)?;
		let core = Arc::clone(&self.core);
		let capabilities = Arc::clone(&self.capabilities);
		Ok(task::blocking("desktop.execute", (), move |_| {
			core
				.execute(actions)
				.map(|capture| capture.into_napi(&capabilities))
				.map_err(napi::Error::from)
		}))
	}

	/// Close the worker and native platform connections. Idempotent and bounded.
	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		let core = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| core.close().map_err(napi::Error::from))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn display(id: &str, x: i32, y: i32, width: u32, height: u32, scale: f64) -> LayoutDisplay {
		LayoutDisplay {
			id: id.to_string(),
			name: id.to_string(),
			x,
			y,
			width,
			height,
			scale,
			is_primary: id == "primary",
		}
	}

	fn frame(
		displays: Vec<(LayoutDisplay, u32, u32, u32, u32)>,
		width: u32,
		height: u32,
	) -> FrameGeometry {
		FrameGeometry {
			width,
			height,
			displays: displays
				.into_iter()
				.map(|(display, pixel_x, pixel_y, pixel_width, pixel_height)| FrameDisplay {
					display,
					pixel_x,
					pixel_y,
					pixel_width,
					pixel_height,
				})
				.collect(),
		}
	}

	fn action(action_type: &str) -> DesktopAction {
		DesktopAction {
			action_type: action_type.to_string(),
			x:           None,
			y:           None,
			button:      None,
			path:        None,
			keys:        None,
			scroll_x:    None,
			scroll_y:    None,
			text:        None,
		}
	}

	#[test]
	fn maps_scaled_composite_pixels_to_negative_global_coordinates() {
		let geometry = frame(
			vec![
				(display("left", -1280, 0, 1280, 1024, 1.0), 0, 0, 640, 512),
				(display("primary", 0, 0, 1920, 1080, 2.0), 640, 0, 960, 540),
			],
			1600,
			540,
		);
		assert_eq!(geometry.map_point(0, 0).unwrap(), (-1280, 0));
		assert_eq!(geometry.map_point(639, 511).unwrap(), (-2, 1022));
		assert_eq!(geometry.map_point(640, 0).unwrap(), (0, 0));
		assert_eq!(geometry.map_point(1599, 539).unwrap(), (1918, 1078));
	}

	#[test]
	fn rejects_pixels_in_a_composite_layout_gap() {
		let geometry = frame(
			vec![
				(display("primary", 0, 0, 100, 100, 1.0), 0, 0, 100, 100),
				(display("upper", 100, -50, 100, 50, 1.0), 100, 0, 100, 50),
			],
			200,
			150,
		);
		let error = geometry.map_point(150, 75).unwrap_err();
		assert_eq!(error.code, ErrorCode::CoordinateOutOfBounds);
	}

	#[test]
	fn layout_validation_rejects_overlap_duplicate_and_zero_size() {
		let overlapping =
			vec![display("a", 0, 0, 100, 100, 1.0), display("b", 50, 50, 100, 100, 1.0)];
		assert_eq!(validate_layout(&overlapping).unwrap_err().code, ErrorCode::LayoutChanged);
		let duplicate = vec![display("a", 0, 0, 100, 100, 1.0), display("a", 100, 0, 100, 100, 1.0)];
		assert_eq!(validate_layout(&duplicate).unwrap_err().code, ErrorCode::LayoutChanged);
		assert_eq!(
			validate_layout(&[display("a", 0, 0, 0, 100, 1.0)])
				.unwrap_err()
				.code,
			ErrorCode::LayoutChanged
		);
	}

	#[test]
	fn mirrored_outputs_are_recognized_for_enumeration_coalescing() {
		let primary = display("primary", 0, 0, 1920, 1080, 1.0);
		let mirror = display("mirror", 0, 0, 1920, 1080, 2.0);
		assert!(same_display_rect(&primary, &mirror));
		assert!(!same_display_rect(&primary, &display("offset", 1, 0, 1920, 1080, 1.0)));
	}

	#[test]
	fn linux_backends_reject_negative_origin_before_input() {
		let geometry =
			frame(vec![(display("left", -100, 0, 100, 100, 1.0), 0, 0, 100, 100)], 100, 100);
		let error = validate_xtest_frame(&geometry).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackendUnavailable);
		assert!(
			error
				.message
				.contains("cannot represent negative global desktop coordinates")
		);
	}

	#[test]
	fn x11_rejects_layouts_beyond_xtest_absolute_range() {
		let maximum =
			frame(vec![(display("wide", 0, 0, 32_768, 100, 1.0), 0, 0, 32_768, 100)], 32_768, 100);
		assert!(validate_xtest_frame(&maximum).is_ok());

		let oversized =
			frame(vec![(display("wide", 0, 0, 32_769, 100, 1.0), 0, 0, 32_769, 100)], 32_769, 100);
		let error = validate_xtest_frame(&oversized).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackendUnavailable);
		assert!(error.message.contains("0..=32767"));
	}

	#[test]
	fn batch_coordinates_remain_bound_to_prior_returned_frame() {
		let returned_display = display("primary", 0, 0, 100, 100, 1.0);
		let returned = frame(vec![(returned_display.clone(), 0, 0, 100, 100)], 100, 100);
		let batch = BatchCoordinateFrame::from_returned_frame(Some(&returned));

		let unseen =
			frame(vec![(display("primary", 100, 0, 100, 100, 1.0), 0, 0, 100, 100)], 100, 100);
		let mut published = Some(unseen);
		let mapped = batch
			.validate(std::slice::from_ref(&returned_display))
			.unwrap()
			.map_point(10, 10)
			.unwrap();
		assert_eq!(mapped, (10, 10));
		assert_eq!(published.take().unwrap().map_point(10, 10).unwrap(), (110, 10));
	}

	#[test]
	fn intermediate_screenshot_is_deferred_without_reordering_actions() {
		let actions =
			vec![ValidatedAction::Wait, ValidatedAction::Screenshot, ValidatedAction::Keypress {
				keys: vec!["A".to_string()],
			}];
		assert_eq!(executable_batch_actions(actions).collect::<Vec<_>>(), vec![
			ValidatedAction::Wait,
			ValidatedAction::Keypress { keys: vec!["A".to_string()] },
		]);
	}

	#[test]
	fn post_input_settle_depends_on_input_after_the_last_wait() {
		let input_actions = [
			ValidatedAction::Click {
				x:         0,
				y:         0,
				button:    MouseButton::Left,
				count:     1,
				modifiers: Vec::new(),
			},
			ValidatedAction::Drag {
				path:      vec![DesktopPoint { x: 0, y: 0 }, DesktopPoint { x: 1, y: 1 }],
				modifiers: Vec::new(),
			},
			ValidatedAction::Keypress { keys: vec!["A".to_string()] },
			ValidatedAction::Move { x: 0, y: 0, modifiers: Vec::new() },
			ValidatedAction::Scroll {
				x:         0,
				y:         0,
				scroll_x:  0,
				scroll_y:  1,
				modifiers: Vec::new(),
			},
			ValidatedAction::Type { text: "x".to_string() },
		];
		for input in input_actions {
			assert!(needs_post_input_settle(&[input]));
		}

		assert!(!needs_post_input_settle(&[ValidatedAction::Screenshot]));
		assert!(!needs_post_input_settle(&[ValidatedAction::Wait]));
		assert!(!needs_post_input_settle(&[
			ValidatedAction::Type { text: "x".to_string() },
			ValidatedAction::Wait,
		]));
		assert!(needs_post_input_settle(&[
			ValidatedAction::Type { text: "x".to_string() },
			ValidatedAction::Wait,
			ValidatedAction::Keypress { keys: vec!["A".to_string()] },
		]));
		assert!(needs_post_input_settle(&[
			ValidatedAction::Move { x: 0, y: 0, modifiers: Vec::new() },
			ValidatedAction::Screenshot,
		]));
	}

	#[test]
	fn post_input_settle_occurs_after_last_input_before_capture() {
		#[derive(Default)]
		struct BatchTiming {
			executed_actions: Vec<ValidatedAction>,
			last_input_at:    Option<Instant>,
			captured_at:      Option<Instant>,
		}

		let input = ValidatedAction::Type { text: "x".to_string() };
		let mut timing = BatchTiming::default();
		execute_desktop_batch(
			&mut timing,
			vec![ValidatedAction::Wait, input.clone(), ValidatedAction::Screenshot],
			Instant::now() + Duration::from_secs(1),
			|timing, action| {
				let is_input = matches!(&action, ValidatedAction::Type { .. });
				timing.executed_actions.push(action);
				if is_input {
					timing.last_input_at = Some(Instant::now());
				}
				Ok(())
			},
			|timing| {
				timing.captured_at = Some(Instant::now());
				Ok(())
			},
		)
		.unwrap();

		assert_eq!(timing.executed_actions, vec![ValidatedAction::Wait, input]);
		let last_input_at = timing.last_input_at.expect("input action should execute");
		let captured_at = timing.captured_at.expect("final capture should execute");
		let elapsed = captured_at
			.checked_duration_since(last_input_at)
			.expect("capture should follow input");
		assert!(
			elapsed >= MACOS_POST_INPUT_SETTLE_DURATION,
			"final capture started after {elapsed:?}, before the \
			 {MACOS_POST_INPUT_SETTLE_DURATION:?} post-input settle completed"
		);
	}

	#[test]
	fn coordinate_input_requires_a_previously_returned_frame() {
		let error = BatchCoordinateFrame::from_returned_frame(None)
			.validate(&[])
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::InvalidAction);
		assert_eq!(
			error.message,
			"coordinate input requires a screenshot returned by a completed prior request"
		);
	}

	#[test]
	fn keypress_release_failure_still_releases_every_held_key() {
		let keys = [Key::Control, Key::Shift, Key::Unicode('a')];
		let mut emitted = Vec::new();
		let error = execute_keypress_with(&keys, |key, direction| {
			emitted.push((key, direction));
			if direction == Direction::Release && key == Key::Unicode('a') {
				Err("first release failed")
			} else if direction == Direction::Release && key == Key::Shift {
				Err("second release failed")
			} else {
				Ok(())
			}
		})
		.unwrap_err();
		assert_eq!(error, "first release failed");
		assert_eq!(&emitted[3..], &[
			(Key::Unicode('a'), Direction::Release),
			(Key::Shift, Direction::Release),
			(Key::Control, Direction::Release),
		]);
	}

	#[test]
	fn keypress_letters_are_case_insensitive_without_implicit_shift() {
		assert_eq!(parse_keypress(&["CTRL+L".to_string()]).unwrap(), vec![
			Key::Control,
			Key::Unicode('l')
		]);
		assert_eq!(normalize_keypress_key(Key::Unicode('A')), Key::Unicode('a'));
		assert_eq!(parse_key("A").unwrap(), Key::Unicode('A'));
	}
	#[test]
	fn cancellation_is_permission_denied() {
		let error = DesktopError::permission_or(ErrorCode::BackendUnavailable, "request canceled");
		assert_eq!(error.code, ErrorCode::PermissionDenied);
	}

	#[test]
	fn layout_comparison_detects_geometry_scale_and_membership_changes() {
		let original = display("primary", 0, 0, 1920, 1080, 2.0);
		let geometry = frame(vec![(original.clone(), 0, 0, 1920, 1080)], 1920, 1080);
		assert!(same_layout(&geometry, std::slice::from_ref(&original)));
		assert!(!same_layout(&geometry, &[display("primary", 0, 0, 1920, 1080, 1.0)]));
		assert!(!same_layout(&geometry, &[display("other", 0, 0, 1920, 1080, 2.0)]));
	}

	#[test]
	fn scale_edges_and_scroll_deltas_match_ga_pixel_semantics() {
		assert_eq!(scaled_edge(3840, 0.5), 1920);
		assert_eq!(scaled_edge(2400, 0.5), 1200);
		assert_eq!(scroll_steps(0), 0);
		assert_eq!(scroll_steps(1), 1);
		assert_eq!(scroll_steps(99), 1);
		assert_eq!(scroll_steps(151), 2);
		assert_eq!(scroll_steps(-250), -3);
	}

	#[test]
	fn modifier_mask_preserves_all_ga_mouse_modifiers() {
		assert_eq!(modifier_mask(&[]), 0);
		assert_eq!(
			modifier_mask(&[Key::Control, Key::Shift, Key::Alt, Key::Meta]),
			MODIFIER_CONTROL | MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_META
		);
		assert_eq!(modifier_mask(&[Key::Meta, Key::Shift]), MODIFIER_META | MODIFIER_SHIFT);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn read_only_worker_startup_does_not_initialize_input() {
		let capabilities = Arc::new(Mutex::new(DesktopCapabilities {
			backend:            "x11".to_string(),
			display_server:     Some(":test".to_string()),
			capture:            true,
			input:              false,
			capture_permission: PERMISSION_UNKNOWN.to_string(),
			input_permission:   PERMISSION_UNKNOWN.to_string(),
			display_count:      0,
		}));
		let worker = DesktopWorker::new(
			SessionConfig {
				backend:    Some(ConcreteBackend::X11),
				selection:  DisplaySelection::All,
				max_width:  Some(1920),
				max_height: Some(1200),
			},
			Arc::clone(&capabilities),
		);
		assert!(worker.input.is_none());
		assert!(worker.input_error.is_none());
		let capabilities = capabilities.lock();
		assert!(!capabilities.input);
		assert_eq!(capabilities.input_permission, PERMISSION_UNKNOWN);
	}

	#[test]
	fn validates_every_ga_action_shape_without_emitting_input() {
		let mut click = action("click");
		click.x = Some(1);
		click.y = Some(2);
		click.button = Some("left".to_string());
		assert!(matches!(ValidatedAction::try_from(click).unwrap(), ValidatedAction::Click {
			count: 1,
			..
		}));

		let mut double = action("double_click");
		double.x = Some(1);
		double.y = Some(2);
		assert!(matches!(ValidatedAction::try_from(double).unwrap(), ValidatedAction::Click {
			button: MouseButton::Left,
			count: 2,
			..
		}));

		let mut drag = action("drag");
		drag.path = Some(vec![DesktopPoint { x: 1, y: 2 }, DesktopPoint { x: 3, y: 4 }]);
		assert!(matches!(ValidatedAction::try_from(drag).unwrap(), ValidatedAction::Drag { .. }));

		let mut keypress = action("keypress");
		keypress.keys = Some(vec!["CTRL".to_string(), "L".to_string()]);
		assert!(matches!(
			ValidatedAction::try_from(keypress).unwrap(),
			ValidatedAction::Keypress { .. }
		));

		let mut movement = action("move");
		movement.x = Some(1);
		movement.y = Some(2);
		assert!(matches!(ValidatedAction::try_from(movement).unwrap(), ValidatedAction::Move { .. }));
		assert_eq!(
			ValidatedAction::try_from(action("screenshot")).unwrap(),
			ValidatedAction::Screenshot
		);

		let mut scroll = action("scroll");
		scroll.x = Some(1);
		scroll.y = Some(2);
		scroll.scroll_x = Some(0);
		scroll.scroll_y = Some(100);
		assert!(matches!(ValidatedAction::try_from(scroll).unwrap(), ValidatedAction::Scroll { .. }));

		let mut typing = action("type");
		typing.text = Some("hello".to_string());
		assert!(matches!(ValidatedAction::try_from(typing).unwrap(), ValidatedAction::Type { .. }));
		assert_eq!(ValidatedAction::try_from(action("wait")).unwrap(), ValidatedAction::Wait);
	}

	#[test]
	fn rejects_missing_and_extraneous_action_fields_before_input() {
		let mut click = action("click");
		click.x = Some(1);
		click.y = Some(2);
		assert_eq!(ValidatedAction::try_from(click).unwrap_err().code, ErrorCode::InvalidAction);

		let mut double = action("double_click");
		double.x = Some(1);
		double.y = Some(2);
		double.button = Some("right".to_string());
		assert_eq!(ValidatedAction::try_from(double).unwrap_err().code, ErrorCode::InvalidAction);

		let mut screenshot = action("screenshot");
		screenshot.text = Some("not allowed".to_string());
		assert_eq!(ValidatedAction::try_from(screenshot).unwrap_err().code, ErrorCode::InvalidAction);

		let mut drag = action("drag");
		drag.path = Some(vec![DesktopPoint { x: 1, y: 2 }]);
		assert_eq!(ValidatedAction::try_from(drag).unwrap_err().code, ErrorCode::InvalidAction);
	}

	#[test]
	fn session_core_close_is_idempotent_without_pointer_input() {
		let capabilities = Arc::new(Mutex::new(DesktopCapabilities {
			backend:            "unavailable".to_string(),
			display_server:     None,
			capture:            false,
			input:              false,
			capture_permission: PERMISSION_UNAVAILABLE.to_string(),
			input_permission:   PERMISSION_UNAVAILABLE.to_string(),
			display_count:      0,
		}));
		let core = SessionCore::start(
			SessionConfig {
				backend:    None,
				selection:  DisplaySelection::All,
				max_width:  Some(1920),
				max_height: Some(1200),
			},
			capabilities,
		)
		.unwrap();
		core.close().unwrap();
		core.close().unwrap();
		assert_eq!(core.capture().unwrap_err().code, ErrorCode::SessionClosed);
	}

	fn unavailable_capabilities() -> Arc<Mutex<DesktopCapabilities>> {
		Arc::new(Mutex::new(DesktopCapabilities {
			backend:            "unavailable".to_string(),
			display_server:     None,
			capture:            false,
			input:              false,
			capture_permission: PERMISSION_UNAVAILABLE.to_string(),
			input_permission:   PERMISSION_UNAVAILABLE.to_string(),
			display_count:      0,
		}))
	}

	fn unavailable_config() -> SessionConfig {
		SessionConfig {
			backend:    None,
			selection:  DisplaySelection::All,
			max_width:  None,
			max_height: None,
		}
	}

	#[test]
	fn deadline_error_code_uses_the_desktop_prefix() {
		assert_eq!(ErrorCode::DeadlineExceeded.as_str(), "DESKTOP_DEADLINE_EXCEEDED");
	}

	#[test]
	fn wait_heavy_batches_are_rejected_before_reaching_the_worker() {
		assert!(validate_batch_wait_budget(&vec![ValidatedAction::Wait; 27]).is_ok());
		assert_eq!(
			validate_batch_wait_budget(&vec![ValidatedAction::Wait; 28])
				.unwrap_err()
				.code,
			ErrorCode::InvalidAction
		);
		// Enforcement point: SessionCore::execute rejects before the request can
		// reach the worker, so nothing sleeps.
		let core = SessionCore::start(unavailable_config(), unavailable_capabilities()).unwrap();
		assert_eq!(
			core
				.execute(vec![ValidatedAction::Wait; 28])
				.unwrap_err()
				.code,
			ErrorCode::InvalidAction
		);
		core.close().unwrap();
	}

	#[test]
	fn expired_deadline_short_circuits_before_any_action() {
		let mut worker = DesktopWorker::new(unavailable_config(), unavailable_capabilities());
		let error = worker
			.execute(vec![ValidatedAction::Wait], Instant::now())
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::DeadlineExceeded);
	}

	#[test]
	fn wait_clamps_to_the_remaining_deadline_budget() {
		let mut worker = DesktopWorker::new(unavailable_config(), unavailable_capabilities());
		let start = Instant::now();
		let error = worker
			.execute(vec![ValidatedAction::Wait], start + Duration::from_millis(50))
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::DeadlineExceeded);
		assert!(start.elapsed() < WAIT_ACTION_DURATION);
	}

	#[test]
	fn opt_in_real_capture_returns_decodable_png_and_monitor_metadata() {
		if std::env::var_os("OMP_NATIVE_DESKTOP_CAPTURE_TEST").is_none() {
			return;
		}
		let (config, capabilities) = SessionConfig::parse(Some(DesktopSessionOptions {
			backend:    Some("native".to_string()),
			display:    Some("all".to_string()),
			max_width:  Some(1920),
			max_height: Some(1200),
		}))
		.unwrap();
		let capabilities = Arc::new(Mutex::new(capabilities));
		let mut worker = DesktopWorker::new(config, capabilities);
		let capture = worker
			.capture()
			.expect("real native capture should succeed when opted in");
		let decoded = image::load_from_memory_with_format(&capture.png, ImageFormat::Png)
			.expect("capture must be a real PNG");
		assert_eq!(
			(decoded.width(), decoded.height()),
			(capture.geometry.width, capture.geometry.height)
		);
		assert!(!capture.geometry.displays.is_empty());
	}
}
