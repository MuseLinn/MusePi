#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(target_os = "windows")]
mod input;
#[cfg(target_os = "windows")]
mod lease;
#[cfg(target_os = "windows")]
mod overlay;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::backend::{AxBackend, Backend, DeliveryMode, PointerEvent};
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
	lease:        Option<lease::Win32Lease>,
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
		Ok(Self { display, global_input, ax: Win32Ax::new(), lease: None, overlay })
	}

	/// Acquires the cross-session real-input lease when the request touches
	/// shared input, and announces the takeover on the overlay. Window-message
	/// delivery bypasses both: it moves neither the shared cursor nor the
	/// system input queue.
	fn begin_input(&mut self, target: &Target, mode: DeliveryMode) -> CoreResult<()> {
		if !super::lease::needs_lease(target, mode) {
			return Ok(());
		}
		if self.lease.is_none() {
			self.lease = Some(lease::acquire()?);
		}
		if let Some(overlay) = &self.overlay {
			overlay.notice("foreground input is taking over mouse and keyboard");
		}
		Ok(())
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
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays(&self.display)
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		capture::capture(&self.display, target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.begin_input(target, mode)?;
		if let Some(overlay) = &self.overlay {
			overlay.show_event(&event);
		}
		let result = input::pointer(&mut self.global_input, target, event, mode);
		self.end_input();
		result
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		self.begin_input(target, mode)?;
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
		self.begin_input(target, mode)?;
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

#[cfg(test)]
mod tests {
	use super::{super::error::ErrorCode, *};

	/// Manual end-to-end: the backend acquires the machine-wide lease, and a
	/// second backend observes it as busy. Ignored by default because it
	/// touches real global lease state and creates overlay windows.
	#[test]
	#[ignore = "needs an interactive desktop; acquires the real input lease"]
	fn backend_lease_blocks_second_backend() {
		let mut first = Win32Backend::new(DisplaySelector::All).expect("first backend starts");
		first
			.begin_input(&Target::Desktop, DeliveryMode::Background)
			.expect("first backend acquires the lease");
		let mut second = Win32Backend::new(DisplaySelector::All).expect("second backend starts");
		let busy = second
			.begin_input(&Target::Desktop, DeliveryMode::Background)
			.expect_err("second backend must observe a busy lease");
		assert_eq!(busy.code, ErrorCode::InputBusy);
	}
}
