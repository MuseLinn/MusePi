#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(target_os = "windows")]
mod input;
#[cfg(target_os = "windows")]
mod menus;
#[cfg(target_os = "windows")]
mod overlay;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::backend::{AxBackend, Backend, DeliveryMode, MouseButton, PointerEvent};
#[cfg(target_os = "windows")]
use super::error::CoreResult;
#[cfg(target_os = "windows")]
use super::frame::FrameGeometry;
#[cfg(target_os = "windows")]
use super::keys::KeyName;
#[cfg(target_os = "windows")]
use super::types::{
	CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

#[cfg(target_os = "windows")]
pub(crate) struct Win32Backend {
	display:      DisplaySelector,
	global_input: Enigo,
	ax:           Win32Ax,
	overlay:      Option<overlay::OverlayHandle>,
}

#[cfg(target_os = "windows")]
impl Win32Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		// Initialize DPI awareness before xcap or input observes desktop geometry,
		// keeping both APIs in the same per-monitor physical coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays(&display)?;
		// The overlay is best-effort: a session without a window still offers
		// full input, only without the second cursor.
		let overlay = overlay::OverlayHandle::try_create().ok();
		Ok(Self { display, global_input, ax: Win32Ax::new(), overlay })
	}

	/// Announces a takeover on the overlay. The cross-session real-input lease
	/// is taken by the session worker before this backend runs, so one
	/// operation owns input and focus at a time across processes. Window-message
	/// delivery announces nothing: it moves neither the shared cursor nor the
	/// system input queue.
	fn begin_input(&self, target: &Target, mode: DeliveryMode) {
		if super::control::needs_lease(target, mode)
			&& let Some(overlay) = &self.overlay
		{
			overlay.notice("foreground input is taking over mouse and keyboard");
		}
	}

	fn end_input(&self) {
		if let Some(overlay) = &self.overlay {
			overlay.hide();
		}
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count = capture::displays(&self.display)
			.map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			overlay: self.overlay.is_some(),
			delivery_modes: vec!["background".to_string(), "foreground".to_string()],
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
			// Derived by `DesktopCapabilities::normalize` in the session.
			visual_regions: false,
			escape_stop: String::new(),
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays(&self.display)
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<super::menus::DesktopMenuItem>> {
		menus::items(window, path)
	}

	fn menu_select(&mut self, window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
		menus::select(window, path)
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		capture::capture(&self.display, target)
	}

	fn hold_pointer(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
		button: MouseButton,
		duration: std::time::Duration,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.begin_input(target, mode);
		let result =
			input::hold_pointer(&mut self.global_input, target, x, y, button, duration, mode);
		self.end_input();
		result
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.begin_input(target, mode);
		let result = input::hold_keys(&mut self.global_input, target, keys, duration, mode);
		self.end_input();
		result
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.begin_input(target, mode);
		if let Some(overlay) = &self.overlay {
			overlay.show_event(&event);
		}
		let result = input::pointer(&mut self.global_input, target, event, mode);
		self.end_input();
		result
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		self.begin_input(target, mode);
		let result = input::type_text(&mut self.global_input, target, text, mode);
		self.end_input();
		result
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.begin_input(target, mode);
		let result = input::key_chord(&mut self.global_input, target, keys, mode);
		self.end_input();
		result
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		input::raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
	use super::super::{control, error::ErrorCode};

	/// Manual end-to-end: the real-input lease is machine-wide, so a second
	/// operation observes the first as busy. Ignored by default because it
	/// takes the real input lease.
	#[test]
	#[ignore = "needs an interactive desktop; acquires the real input lease"]
	fn real_input_lease_blocks_a_second_operation() {
		let source = control::CancellationSource::default();
		let first_token = source.token();
		let first = control::InputLease::acquire(&first_token, false)
			.expect("first operation acquires the lease");
		let second_token = control::CancellationSource::default().token();
		let busy = control::InputLease::acquire(&second_token, false)
			.err()
			.expect("second operation must observe a busy lease");
		assert_eq!(busy.code, ErrorCode::InputBusy);
		drop(first);
		control::InputLease::acquire(&first_token, false).expect("lease releases with the operation");
	}
}
