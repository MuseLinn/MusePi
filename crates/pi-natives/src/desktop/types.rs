use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

/// Monitor geometry in both global logical desktop coordinates and composite
/// screenshot pixels.
#[napi(object)]
#[derive(Debug, Clone)]
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

/// One capturable top-level window in global logical desktop coordinates.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopWindow {
	/// Backend-defined opaque window id, valid as a capture target while the
	/// window lives. Numeric on X11/Win32/macOS; a composite AT-SPI string on
	/// Wayland (e.g. `atspi::1.31:/org/a11y/atspi/accessible/1`). Never parse
	/// it.
	pub id:      String,
	/// Window title; may be empty for untitled windows.
	pub title:   String,
	/// Owning application name.
	pub app:     String,
	/// Owning process id when the platform exposes it.
	pub pid:     Option<u32>,
	pub x:       i32,
	pub y:       i32,
	pub width:   u32,
	pub height:  u32,
	/// Whether the window currently holds input focus.
	pub focused: bool,
}

#[napi(object)]
pub struct DesktopCapture {
	pub data:              Uint8Array,
	pub width:             u32,
	pub height:            u32,
	/// Pre-scaling capture width in native pixels; equals `width` when unscaled.
	pub source_width:      u32,
	/// Pre-scaling capture height in native pixels; equals `height` when
	/// unscaled.
	pub source_height:     u32,
	/// Dimensions of the full screenshot coordinate frame used by pointer input.
	pub coordinate_width:  u32,
	pub coordinate_height: u32,
	/// Region in the full screenshot's coordinates; zoom pixels are not input
	/// coordinates.
	pub region:            Option<CaptureRegion>,
	pub target:            String,
	pub displays:          Vec<DesktopDisplay>,
	pub backend:           String,
	pub display_server:    Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopCapabilities {
	pub backend: String,
	pub display_server: Option<String>,
	pub capture: bool,
	pub input: bool,
	pub ax: bool,
	pub background_window_input: bool,
	pub overlay: bool,
	pub delivery_modes: Vec<String>,
	pub capture_permission: String,
	pub input_permission: String,
	pub ax_permission: String,
	pub display_count: u32,
	/// Whether `visualRegions` can propose regions from a captured frame.
	/// True exactly when this backend can capture.
	pub visual_regions: Option<bool>,
	/// Physical-Escape stop for takeover input on this platform: `available`
	/// or `unsupported`. `controlState().escapeStop` reports what the held
	/// lease actually armed.
	pub escape_stop: Option<String>,
}

impl DesktopCapabilities {
	pub(crate) fn unavailable() -> Self {
		Self {
			backend: "unavailable".to_string(),
			display_server: None,
			capture: false,
			input: false,
			ax: false,
			background_window_input: false,
			overlay: false,
			delivery_modes: Vec::new(),
			capture_permission: "unavailable".to_string(),
			input_permission: "unavailable".to_string(),
			ax_permission: "unavailable".to_string(),
			display_count: 0,
			visual_regions: Some(false),
			escape_stop: Some("unsupported".to_string()),
		}
	}

	/// Fills the flags the session derives instead of the backend: proposals
	/// need captured pixels, and the Escape stop depends on the platform (and,
	/// on Linux, on the display server the backend reported).
	pub(crate) fn normalize(mut self) -> Self {
		self.visual_regions = Some(self.capture);
		self.escape_stop = Some(escape_stop_support(&self).to_string());
		self
	}
}

#[allow(
	clippy::missing_const_for_fn,
	reason = "the Linux branch reads the process environment, so this cannot be const there"
)]
fn escape_stop_support(capabilities: &DesktopCapabilities) -> &'static str {
	#[cfg(windows)]
	{
		let _ = capabilities;
		"available"
	}
	#[cfg(target_os = "linux")]
	{
		// The X11 monitor has no Wayland equivalent; Wayland input is limited
		// to windows the compositor already focused.
		let _ = capabilities;
		if std::env::var_os("WAYLAND_DISPLAY").is_some()
			|| std::env::var("XDG_SESSION_TYPE")
				.is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
		{
			"unsupported"
		} else {
			"available"
		}
	}
	#[cfg(not(any(windows, target_os = "linux")))]
	{
		let _ = capabilities;
		"unsupported"
	}
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct DesktopSessionOptions {
	pub display:         Option<String>,
	/// Counts the user's physical Escape under this key, shared by every
	/// session created with it and readable after a session dies.
	pub escape_stop_key: Option<String>,
}

/// Whether this session currently holds explicit task ownership.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopControlState {
	pub active:      bool,
	/// What the held lease armed for takeover input: `armed`, `unavailable`
	/// (the platform monitor failed to start), `unsupported` (no monitor on
	/// this platform), or `not_requested` when no lease is held.
	pub escape_stop: String,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CaptureCaps {
	pub max_width:  Option<u32>,
	pub max_height: Option<u32>,
}

/// Rectangle in pixels of the most recent full screenshot of the same target.
#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureRegion {
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct VisualRegionsOptions {
	/// Most proposals to return, 1–64; defaults to 24.
	pub max_regions: Option<u32>,
}

/// One proposed region from the last captured frame.
///
/// A proposal is not an element: this backend has no OCR or semantics, so
/// `label` stays absent and the rectangle is the whole claim.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct VisualRegion {
	/// 1-based position in reading order within this result.
	pub id:         u32,
	/// Half-open rectangle in screenshot-frame pixels, left/top origin: `x`
	/// and `y` are included, `x + width` and `y + height` are excluded.
	pub x:          u32,
	pub y:          u32,
	pub width:      u32,
	pub height:     u32,
	/// Coarse shape class: `text`, `row`, or `block`.
	pub kind:       String,
	/// Always absent: this backend runs no OCR.
	pub label:      Option<String>,
	/// 0–1 boundary-evidence strength, not semantic certainty.
	pub confidence: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct VisualRegions {
	pub target:    String,
	/// Screenshot-frame width the rectangles are expressed in.
	pub width:     u32,
	/// Screenshot-frame height the rectangles are expressed in.
	pub height:    u32,
	pub regions:   Vec<VisualRegion>,
	/// True when more proposals existed than `maxRegions` allowed.
	pub truncated: bool,
	/// Why `regions` is empty: `uniform`, `low_contrast`, or `too_small`;
	/// absent when proposals exist. An empty list is not an error.
	pub reason:    Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct PointerOptions {
	pub button:        Option<String>,
	pub count:         Option<u32>,
	pub modifiers:     Option<Vec<String>>,
	pub delivery_mode: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct DesktopPoint {
	pub x: f64,
	pub y: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AxNode {
	#[napi(js_name = "ref")]
	pub ref_:        String,
	pub role:        String,
	pub native_role: String,
	pub title:       Option<String>,
	pub value:       Option<String>,
	pub description: Option<String>,
	pub enabled:     bool,
	pub focused:     bool,
	pub x:           Option<f64>,
	pub y:           Option<f64>,
	pub width:       Option<f64>,
	pub height:      Option<f64>,
	pub actions:     Option<Vec<String>>,
	pub child_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AxSnapshot {
	pub text:       String,
	pub node_count: u32,
	pub truncated:  bool,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct AxSnapshotOptions {
	pub max_depth: Option<u32>,
	pub max_nodes: Option<u32>,
	pub all:       Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct AxQuery {
	pub role:  Option<String>,
	pub title: Option<String>,
	pub value: Option<String>,
	pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
	Desktop,
	Window(String),
}

impl Target {
	pub(crate) fn parse(value: &str) -> Self {
		if value.eq_ignore_ascii_case("desktop") {
			Self::Desktop
		} else {
			Self::Window(value.to_string())
		}
	}

	pub(crate) fn key(&self) -> &str {
		match self {
			Self::Desktop => "desktop",
			Self::Window(id) => id,
		}
	}
}

#[derive(Debug, Clone)]
pub enum DisplaySelector {
	All,
	Id(String),
}

impl DisplaySelector {
	pub(crate) fn parse(display: Option<String>) -> Self {
		match display {
			Some(id) if !id.trim().is_empty() && !id.eq_ignore_ascii_case("all") => Self::Id(id),
			_ => Self::All,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn capture_implies_region_proposals() {
		let capturing =
			DesktopCapabilities { capture: true, ..DesktopCapabilities::unavailable() }.normalize();
		assert_eq!(capturing.visual_regions, Some(true));
		let deaf =
			DesktopCapabilities { capture: false, ..DesktopCapabilities::unavailable() }.normalize();
		assert_eq!(deaf.visual_regions, Some(false));
	}

	#[test]
	fn the_unavailable_state_advertises_nothing() {
		let caps = DesktopCapabilities::unavailable();
		assert!(!caps.capture);
		assert_eq!(caps.visual_regions, Some(false));
		assert_eq!(caps.escape_stop.as_deref(), Some("unsupported"));
	}
}
