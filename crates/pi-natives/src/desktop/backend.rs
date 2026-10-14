use image::RgbaImage;

use super::{
	ax::{AxHandle, AxProps},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, Target},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveryMode {
	#[default]
	Background,
	Foreground,
}

impl DeliveryMode {
	pub(crate) fn parse(value: Option<&str>) -> Self {
		if value.is_some_and(|value| value.trim().eq_ignore_ascii_case("foreground")) {
			Self::Foreground
		} else {
			Self::Background
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
	#[default]
	Left,
	Right,
	Middle,
}

impl MouseButton {
	pub(crate) fn parse(value: Option<&str>) -> CoreResult<Self> {
		match value.map(str::trim) {
			None => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("left") => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("right") => Ok(Self::Right),
			Some(value) if value.eq_ignore_ascii_case("middle") => Ok(Self::Middle),
			Some(value) => Err(DesktopError::input_failed(format!("unknown button '{value}'"))),
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
	pub ctrl:  bool,
	pub alt:   bool,
	pub shift: bool,
	pub meta:  bool,
}

/// Pacing between synthesized global-input events.
///
/// Waits occur after moving to the start, after button-down, after each
/// following move, and after button-up respectively. `0` skips that wait; it
/// does not promise zero latency or that the target can process the stream.
/// Defaults mirror the field-tested click/drag cadence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::struct_field_names, reason = "shared `_ms` suffix documents the millisecond unit")]
pub struct InputTiming {
	pub move_settle_ms: u16,
	pub press_ms:       u16,
	pub step_ms:        u16,
	pub after_ms:       u16,
}

impl InputTiming {
	/// Single-click cadence.
	pub const CLICK: Self =
		Self { move_settle_ms: 40, press_ms: 25, step_ms: 0, after_ms: 60 };
	/// Drag-path cadence.
	pub const DRAG: Self =
		Self { move_settle_ms: 0, press_ms: 12, step_ms: 8, after_ms: 12 };
}

/// Upper bound for drag paths so a malformed path cannot queue an unbounded
/// event burst. Enforced once in `Worker::process` so every backend inherits
/// it.
pub(crate) const MAX_DRAG_POINTS: usize = 1024;

pub(crate) fn check_drag_len(path: &[(f64, f64)]) -> CoreResult<()> {
	if path.len() > MAX_DRAG_POINTS {
		return Err(DesktopError::input_failed(format!(
			"drag path has {} points, exceeding the {MAX_DRAG_POINTS}-point limit",
			path.len()
		)));
	}
	Ok(())
}

#[derive(Debug, Clone)]
pub enum PointerEvent {
	Click {
		x:         f64,
		y:         f64,
		button:    MouseButton,
		count:     u32,
		modifiers: Modifiers,
	},
	Move {
		x: f64,
		y: f64,
	},
	Drag {
		path:      Vec<(f64, f64)>,
		button:    MouseButton,
		modifiers: Modifiers,
	},
	Scroll {
		x:  f64,
		y:  f64,
		dx: f64,
		dy: f64,
	},
}

pub trait Backend: Send {
	fn capabilities(&mut self) -> DesktopCapabilities;
	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>>;
	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>>;
	fn capture(
		&mut self,
		target: &Target,
		caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)>;
	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()>;
	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()>;
	fn key_chord(&mut self, target: &Target, keys: &[KeyName], mode: DeliveryMode)
	-> CoreResult<()>;
	fn raise_window(&mut self, id: &str) -> CoreResult<()>;
	fn ax(&mut self) -> Option<&mut dyn AxBackend>;
}

pub trait AxBackend {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle>;
	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps>;
	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>>;
	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>>;
	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()>;
	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()>;
	fn focus(&mut self, h: &AxHandle) -> CoreResult<()>;
	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>>;
	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>>;
	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>>;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn delivery_only_escalates_explicit_foreground() {
		assert_eq!(DeliveryMode::parse(None), DeliveryMode::Background);
		assert_eq!(DeliveryMode::parse(Some("garbage")), DeliveryMode::Background);
		assert_eq!(DeliveryMode::parse(Some(" FoReGrOuNd ")), DeliveryMode::Foreground);
	}

	#[test]
	fn drag_cap_rejects_overlong_paths() {
		assert!(check_drag_len(&vec![(0.0, 0.0); MAX_DRAG_POINTS]).is_ok());
		assert!(check_drag_len(&vec![(0.0, 0.0); MAX_DRAG_POINTS + 1]).is_err());
	}

	#[test]
	fn input_timing_defaults_match_field_cadence() {
		assert_eq!(InputTiming::CLICK, InputTiming {
			move_settle_ms: 40,
			press_ms:       25,
			step_ms:        0,
			after_ms:       60,
		});
		assert_eq!(InputTiming::DRAG, InputTiming {
			move_settle_ms: 0,
			press_ms:       12,
			step_ms:        8,
			after_ms:       12,
		});
	}
}
