//! Pure-Rust X11 desktop capture and input backend for [`crate::desktop`].
//!
//! Speaks the X11 wire protocol directly through x11rb's `RustConnection`, so
//! the core addon acquires no C GUI `DT_NEEDED` entries (libxcb, libpipewire,
//! libxkbcommon, libwayland) and keeps `dlopen` working on headless servers.
//! Capture uses core `GetImage` over the root window, monitor enumeration uses
//! RandR 1.5 monitors, and input is synthesized with XTest — which also works
//! under XWayland, where XTest coordinates land in the same X11 global space
//! `GetImage` composites from.
//!
//! The types mirror the names, variants, and call shapes of the enigo/xcap
//! surface `crate::desktop` compiles against on macOS and Windows, so the
//! session core stays platform-agnostic.
//!
//! Everything protocol-facing is `cfg(target_os = "linux")`; the pure
//! conversion and mapping helpers below compile under `cfg(test)` on every
//! platform so they can be unit-tested without a live X server.

use image::RgbaImage;
use xkeysym::Keysym;

/// Scroll axis, mirroring `enigo::Axis`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
	Horizontal,
	Vertical,
}

/// Pointer button, mirroring `enigo::Button`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
	Left,
	Middle,
	Right,
	Back,
	Forward,
}

/// Key selector, mirroring the `enigo::Key` variants `crate::desktop` uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
	Control,
	Shift,
	Alt,
	Meta,
	Return,
	Escape,
	Tab,
	Space,
	Backspace,
	Delete,
	Insert,
	Home,
	End,
	PageUp,
	PageDown,
	UpArrow,
	DownArrow,
	LeftArrow,
	RightArrow,
	CapsLock,
	Numlock,
	PrintScr,
	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	F13,
	F14,
	F15,
	F16,
	F17,
	F18,
	F19,
	F20,
	F21,
	F22,
	F23,
	F24,
	Unicode(char),
}

/// Coordinate mode, mirroring `enigo::Coordinate`. `XTest` motion with detail
/// 0 is always absolute in root coordinates, which is the only mode the session
/// core uses.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Coordinate {
	Abs,
}

/// Key/button transition, mirroring `enigo::Direction`.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
	Press,
	Release,
	Click,
}

/// X11 pointer button numbers for scroll emulation: 4/5 scroll up/down and
/// 6/7 scroll left/right, one press/release pair per step.
const fn scroll_button(axis: Axis, negative: bool) -> u8 {
	match (axis, negative) {
		(Axis::Vertical, true) => 4,
		(Axis::Vertical, false) => 5,
		(Axis::Horizontal, true) => 6,
		(Axis::Horizontal, false) => 7,
	}
}

/// Core-protocol pointer button numbers (`Back`/`Forward` follow the
/// conventional 8/9 mapping every toolkit understands).
const fn button_detail(button: Button) -> u8 {
	match button {
		Button::Left => 1,
		Button::Middle => 2,
		Button::Right => 3,
		Button::Back => 8,
		Button::Forward => 9,
	}
}

/// Keysym for one typed character. `'\n'` intentionally maps to `Return`
/// rather than the historical `Linefeed` keysym `xkb_utf32_to_keysym` would
/// produce, because applications expect Enter.
fn keysym_for_char(ch: char) -> u32 {
	match ch {
		'\n' | '\r' => Keysym::Return.raw(),
		'\t' => Keysym::Tab.raw(),
		_ => Keysym::from_char(ch).raw(),
	}
}

/// Keysym for a named key or typed character.
fn keysym_for_key(key: Key) -> u32 {
	let keysym = match key {
		Key::Control => Keysym::Control_L,
		Key::Shift => Keysym::Shift_L,
		Key::Alt => Keysym::Alt_L,
		Key::Meta => Keysym::Super_L,
		Key::Return => Keysym::Return,
		Key::Escape => Keysym::Escape,
		Key::Tab => Keysym::Tab,
		Key::Space => Keysym::space,
		Key::Backspace => Keysym::BackSpace,
		Key::Delete => Keysym::Delete,
		Key::Insert => Keysym::Insert,
		Key::Home => Keysym::Home,
		Key::End => Keysym::End,
		Key::PageUp => Keysym::Prior,
		Key::PageDown => Keysym::Next,
		Key::UpArrow => Keysym::Up,
		Key::DownArrow => Keysym::Down,
		Key::LeftArrow => Keysym::Left,
		Key::RightArrow => Keysym::Right,
		Key::CapsLock => Keysym::Caps_Lock,
		Key::Numlock => Keysym::Num_Lock,
		Key::PrintScr => Keysym::Print,
		Key::F1 => Keysym::F1,
		Key::F2 => Keysym::F2,
		Key::F3 => Keysym::F3,
		Key::F4 => Keysym::F4,
		Key::F5 => Keysym::F5,
		Key::F6 => Keysym::F6,
		Key::F7 => Keysym::F7,
		Key::F8 => Keysym::F8,
		Key::F9 => Keysym::F9,
		Key::F10 => Keysym::F10,
		Key::F11 => Keysym::F11,
		Key::F12 => Keysym::F12,
		Key::F13 => Keysym::F13,
		Key::F14 => Keysym::F14,
		Key::F15 => Keysym::F15,
		Key::F16 => Keysym::F16,
		Key::F17 => Keysym::F17,
		Key::F18 => Keysym::F18,
		Key::F19 => Keysym::F19,
		Key::F20 => Keysym::F20,
		Key::F21 => Keysym::F21,
		Key::F22 => Keysym::F22,
		Key::F23 => Keysym::F23,
		Key::F24 => Keysym::F24,
		Key::Unicode(ch) => return keysym_for_char(ch),
	};
	keysym.raw()
}

/// Borrowed view of a `GetKeyboardMapping` reply for pure lookups.
struct KeymapView<'a> {
	min_keycode:         u8,
	keysyms_per_keycode: u8,
	keysyms:             &'a [u32],
}

/// Find a keycode producing `keysym` in the first keyboard group. Returns the
/// keycode and whether Shift (column 1) is required. Any unshifted binding is
/// preferred over any shifted one.
fn keysym_position(view: &KeymapView<'_>, keysym: u32) -> Option<(u8, bool)> {
	if keysym == 0 || view.keysyms_per_keycode == 0 {
		return None;
	}
	let per = usize::from(view.keysyms_per_keycode);
	let mut shifted = None;
	for (row, chunk) in view.keysyms.chunks_exact(per).enumerate() {
		let keycode = view.min_keycode.checked_add(row as u8)?;
		if chunk[0] == keysym {
			return Some((keycode, false));
		}
		if shifted.is_none() && per > 1 && chunk[1] == keysym {
			shifted = Some(keycode);
		}
	}
	shifted.map(|keycode| (keycode, true))
}

/// Find a keycode with no bound keysyms, preferring high keycodes so a
/// temporary binding stays clear of real keyboard rows.
fn spare_keycode(view: &KeymapView<'_>) -> Option<u8> {
	if view.keysyms_per_keycode == 0 {
		return None;
	}
	let per = usize::from(view.keysyms_per_keycode);
	let rows = view.keysyms.len() / per;
	(0..rows).rev().find_map(|row| {
		view.keysyms[row * per..(row + 1) * per]
			.iter()
			.all(|&keysym| keysym == 0)
			.then(|| view.min_keycode.checked_add(row as u8))
			.flatten()
	})
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ColorMasks {
	red:   u32,
	green: u32,
	blue:  u32,
}

#[derive(Clone, Copy)]
struct ComponentMask {
	mask:  u32,
	shift: u32,
	max:   u32,
}

impl ComponentMask {
	fn new(name: &str, mask: u32) -> Result<Self, String> {
		if mask == 0 {
			return Err(format!("X11 TrueColor {name} mask is zero"));
		}
		let shift = mask.trailing_zeros();
		let max = mask >> shift;
		if max & max.wrapping_add(1) != 0 {
			return Err(format!("X11 TrueColor {name} mask {mask:#x} is not contiguous"));
		}
		Ok(Self { mask, shift, max })
	}

	fn decode(self, pixel: u32) -> u8 {
		let component = (pixel & self.mask) >> self.shift;
		((u64::from(component) * 255 + u64::from(self.max) / 2) / u64::from(self.max)) as u8
	}
}

fn color_components(masks: ColorMasks, bits_per_pixel: u8) -> Result<[ComponentMask; 3], String> {
	if masks.red & masks.green != 0 || masks.red & masks.blue != 0 || masks.green & masks.blue != 0 {
		return Err(format!(
			"X11 TrueColor masks overlap: red {:#x}, green {:#x}, blue {:#x}",
			masks.red, masks.green, masks.blue
		));
	}
	let combined = masks.red | masks.green | masks.blue;
	if bits_per_pixel < 32 && combined >= (1u32 << bits_per_pixel) {
		return Err(format!(
			"X11 TrueColor masks {combined:#x} exceed {bits_per_pixel} bits per pixel"
		));
	}
	Ok([
		ComponentMask::new("red", masks.red)?,
		ComponentMask::new("green", masks.green)?,
		ComponentMask::new("blue", masks.blue)?,
	])
}

/// Convert a `GetImage` `ZPixmap` reply into RGBA with alpha forced to 255.
/// Uses the root `TrueColor` visual's channel masks, including RGB/BGR layouts
/// and depths such as 30-bit color, and honors image byte order and scanline
/// padding.
fn zpixmap_to_rgba(
	data: &[u8],
	width: u32,
	height: u32,
	depth: u8,
	bits_per_pixel: u8,
	scanline_pad: u8,
	lsb_first: bool,
	masks: ColorMasks,
) -> Result<RgbaImage, String> {
	if !(24..=32).contains(&depth) {
		return Err(format!(
			"unsupported X11 image depth {depth}; a depth from 24 through 32 with a TrueColor visual \
			 is required"
		));
	}
	let bytes_per_pixel = match bits_per_pixel {
		24 => 3usize,
		32 => 4usize,
		other => return Err(format!("unsupported X11 pixel size of {other} bits per pixel")),
	};
	let [red, green, blue] = color_components(masks, bits_per_pixel)?;
	let width_usize = width as usize;
	let height_usize = height as usize;
	let pad_bits = usize::from(scanline_pad).max(8);
	let stride = (width_usize * usize::from(bits_per_pixel)).div_ceil(pad_bits) * pad_bits / 8;
	let needed = stride
		.checked_mul(height_usize)
		.filter(|&bytes| bytes <= data.len());
	if needed.is_none() {
		return Err(format!(
			"X11 image data is truncated: {width}x{height} at {bits_per_pixel} bpp needs \
			 {stride}x{height} bytes, got {}",
			data.len()
		));
	}
	let mut rgba = Vec::with_capacity(width_usize * height_usize * 4);
	for row in data.chunks_exact(stride).take(height_usize) {
		for pixel in row[..width_usize * bytes_per_pixel].chunks_exact(bytes_per_pixel) {
			let value = if lsb_first {
				pixel
					.iter()
					.rev()
					.fold(0u32, |acc, &byte| acc << 8 | u32::from(byte))
			} else {
				pixel
					.iter()
					.fold(0u32, |acc, &byte| acc << 8 | u32::from(byte))
			};
			rgba.extend_from_slice(&[red.decode(value), green.decode(value), blue.decode(value), 255]);
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| "X11 image dimensions are inconsistent".to_string())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldTempReleaseOperation {
	Release(u8),
	Restore(u8),
}

fn finish_held_temp_release<E>(
	held_temp: &mut Vec<(u32, u8)>,
	index: usize,
	mut perform: impl FnMut(HeldTempReleaseOperation) -> Result<(), E>,
) -> Result<(), E> {
	let keycode = held_temp[index].1;
	perform(HeldTempReleaseOperation::Release(keycode))?;
	perform(HeldTempReleaseOperation::Restore(keycode))?;
	held_temp.remove(index);
	Ok(())
}

/// One step of last-resort keyboard cleanup when the input connection drops.
enum X11CleanupOperation<'a> {
	/// Release a keycode a `Press` left held.
	Release(u8),
	/// Restore a temporarily rebound keycode row to all-zero keysyms; the row
	/// must span exactly the server's `keysyms_per_keycode` width.
	Restore(u8, &'a [u32]),
}

/// Release every held keycode in reverse order, then restore the rows whose
/// checked release succeeded. Failures never stop cleanup of later keys; the
/// first error is surfaced after all safe work has been attempted.
fn cleanup_x11_keyboard_state<E>(
	held_keycodes: &[u8],
	keysyms_per_code: u8,
	mut perform: impl FnMut(X11CleanupOperation<'_>) -> Result<(), E>,
) -> Result<(), E> {
	let mut first_error = None;
	let mut released = Vec::with_capacity(held_keycodes.len());
	for &keycode in held_keycodes.iter().rev() {
		match perform(X11CleanupOperation::Release(keycode)) {
			Ok(()) => released.push(keycode),
			Err(error) if first_error.is_none() => first_error = Some(error),
			Err(_) => {},
		}
	}
	released.sort_unstable();
	released.dedup();
	let empty_row = vec![0; usize::from(keysyms_per_code)];
	for keycode in released {
		if let Err(error) = perform(X11CleanupOperation::Restore(keycode, &empty_row))
			&& first_error.is_none()
		{
			first_error = Some(error);
		}
	}
	match first_error {
		Some(error) => Err(error),
		None => Ok(()),
	}
}

#[cfg(target_os = "linux")]
mod x11 {
	use std::sync::Arc;

	use image::RgbaImage;
	use x11rb::{
		connection::Connection,
		protocol::{
			randr::ConnectionExt as _,
			xproto::{
				BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt as _, ImageFormat, ImageOrder,
				KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT, VisualClass, Window,
			},
			xtest::ConnectionExt as _,
		},
		rust_connection::RustConnection,
	};
	use xkeysym::Keysym;

	use super::{
		Axis, Button, ColorMasks, Coordinate, Direction, HeldTempReleaseOperation, Key, KeymapView,
		X11CleanupOperation, button_detail, cleanup_x11_keyboard_state, color_components,
		finish_held_temp_release, keysym_for_char, keysym_for_key, keysym_position, scroll_button,
		spare_keycode, zpixmap_to_rgba,
	};

	/// Capture/metadata-side failure. Stringly typed on purpose: the session
	/// core only forwards it through `Display`-generic error mappers.
	#[derive(Clone, Debug)]
	pub struct X11Error(String);

	impl std::fmt::Display for X11Error {
		fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
			f.write_str(&self.0)
		}
	}

	/// Input-side failure, kept distinct so call sites map it to
	/// `DESKTOP_INPUT_FAILED` rather than a capture error.
	#[derive(Clone, Debug)]
	pub struct X11InputError(String);

	impl std::fmt::Display for X11InputError {
		fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
			f.write_str(&self.0)
		}
	}

	fn connect_error(error: impl std::fmt::Display) -> String {
		format!(
			"X11 connection failed; ensure DISPLAY points at a reachable X server (Wayland sessions \
			 need XWayland): {error}"
		)
	}

	fn capture_error(error: impl std::fmt::Display) -> X11Error {
		X11Error(format!("X11 request failed: {error}"))
	}

	fn input_request_error(error: impl std::fmt::Display) -> X11InputError {
		X11InputError(format!("X11 input request failed: {error}"))
	}

	/// One `RandR` monitor plus the shared session connection used to capture
	/// it.
	///
	/// Matches the `xcap::Monitor` call shapes `crate::desktop` uses; the
	/// `Result` accessors exist purely for that signature parity.
	#[derive(Debug)]
	pub struct Monitor {
		conn:        Arc<RustConnection>,
		root:        Window,
		color_masks: ColorMasks,
		id:          u32,
		name:        String,
		x:           i32,
		y:           i32,
		width:       u32,
		height:      u32,
		primary:     bool,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "accessor signatures mirror xcap::Monitor so desktop.rs call sites stay identical"
	)]
	impl Monitor {
		/// Enumerate active `RandR` monitors over a fresh connection shared by
		/// the returned monitors for their captures.
		pub fn all() -> Result<Vec<Self>, X11Error> {
			let (conn, screen_num) =
				x11rb::connect(None).map_err(|error| X11Error(connect_error(error)))?;
			let conn = Arc::new(conn);
			let screen = conn
				.setup()
				.roots
				.get(screen_num)
				.ok_or_else(|| X11Error("X11 setup reported no default screen".to_string()))?;
			let root = screen.root;
			let root_visual = screen
				.allowed_depths
				.iter()
				.flat_map(|depth| &depth.visuals)
				.find(|visual| visual.visual_id == screen.root_visual)
				.ok_or_else(|| {
					X11Error(format!(
						"X server setup does not describe root visual {}",
						screen.root_visual
					))
				})?;
			if root_visual.class != VisualClass::TRUE_COLOR {
				return Err(X11Error(format!(
					"unsupported X11 root visual class {:?}; TrueColor is required",
					root_visual.class
				)));
			}
			let color_masks = ColorMasks {
				red:   root_visual.red_mask,
				green: root_visual.green_mask,
				blue:  root_visual.blue_mask,
			};
			color_components(color_masks, 32).map_err(X11Error)?;
			let reply = conn
				.randr_get_monitors(root, true)
				.map_err(capture_error)?
				.reply()
				.map_err(|error| X11Error(format!("RandR monitor enumeration failed: {error}")))?;
			let mut monitors = Vec::with_capacity(reply.monitors.len().max(1));
			for info in reply.monitors {
				// The monitor name atom is stable for the X server session and
				// doubles as the stable display id.
				let name = conn
					.get_atom_name(info.name)
					.ok()
					.and_then(|cookie| cookie.reply().ok())
					.map_or_else(
						|| format!("Monitor {}", info.name),
						|atom| String::from_utf8_lossy(&atom.name).into_owned(),
					);
				monitors.push(Self {
					conn: Arc::clone(&conn),
					root,
					color_masks,
					id: info.name,
					name,
					x: i32::from(info.x),
					y: i32::from(info.y),
					width: u32::from(info.width),
					height: u32::from(info.height),
					primary: info.primary,
				});
			}
			if monitors.is_empty() {
				// RandR-less or misconfigured servers (some Xvfb/Xvnc setups)
				// still expose the core screen geometry.
				monitors.push(Self {
					conn: Arc::clone(&conn),
					root,
					color_masks,
					id: 0,
					name: "Screen".to_string(),
					x: 0,
					y: 0,
					width: u32::from(screen.width_in_pixels),
					height: u32::from(screen.height_in_pixels),
					primary: true,
				});
			}
			Ok(monitors)
		}

		pub const fn id(&self) -> Result<u32, X11Error> {
			Ok(self.id)
		}

		pub fn name(&self) -> Result<String, X11Error> {
			Ok(self.name.clone())
		}

		pub fn friendly_name(&self) -> Result<String, X11Error> {
			Ok(self.name.clone())
		}

		pub const fn x(&self) -> Result<i32, X11Error> {
			Ok(self.x)
		}

		pub const fn y(&self) -> Result<i32, X11Error> {
			Ok(self.y)
		}

		pub const fn width(&self) -> Result<u32, X11Error> {
			Ok(self.width)
		}

		pub const fn height(&self) -> Result<u32, X11Error> {
			Ok(self.height)
		}

		/// X11 global coordinates are physical pixels, and `XTest` input uses
		/// the very same space, so the capture/input correlation is exact at
		/// scale 1.0 regardless of any client-side `HiDPI` scaling.
		pub const fn scale_factor(&self) -> Result<f32, X11Error> {
			Ok(1.0)
		}

		pub const fn is_primary(&self) -> Result<bool, X11Error> {
			Ok(self.primary)
		}

		/// Capture this monitor's rectangle from the root window as RGBA.
		pub fn capture_image(&self) -> Result<RgbaImage, X11Error> {
			let x = i16::try_from(self.x)
				.map_err(|_| X11Error("monitor origin exceeds the X11 coordinate space".into()))?;
			let y = i16::try_from(self.y)
				.map_err(|_| X11Error("monitor origin exceeds the X11 coordinate space".into()))?;
			let width = u16::try_from(self.width)
				.map_err(|_| X11Error("monitor size exceeds the X11 coordinate space".into()))?;
			let height = u16::try_from(self.height)
				.map_err(|_| X11Error("monitor size exceeds the X11 coordinate space".into()))?;
			let reply = self
				.conn
				.get_image(ImageFormat::Z_PIXMAP, self.root, x, y, width, height, !0)
				.map_err(capture_error)?
				.reply()
				.map_err(|error| X11Error(format!("X11 GetImage failed: {error}")))?;
			let setup = self.conn.setup();
			let format = setup
				.pixmap_formats
				.iter()
				.find(|format| format.depth == reply.depth)
				.ok_or_else(|| {
					X11Error(format!("X server advertises no pixmap format for depth {}", reply.depth))
				})?;
			zpixmap_to_rgba(
				&reply.data,
				self.width,
				self.height,
				reply.depth,
				format.bits_per_pixel,
				format.scanline_pad,
				setup.image_byte_order == ImageOrder::LSB_FIRST,
				self.color_masks,
			)
			.map_err(X11Error)
		}
	}

	/// XTest-backed input synthesizer owning its own connection, mirroring the
	/// `enigo::Enigo` call shapes.
	///
	/// The keyboard mapping is cached; it only changes underneath us if the
	/// user swaps layouts mid-session, and our own temporary bindings are
	/// written back before anyone else can observe them.
	#[derive(Debug)]
	pub struct Input {
		conn:                RustConnection,
		root:                Window,
		min_keycode:         u8,
		keysyms_per_keycode: u8,
		keysyms:             Vec<u32>,
		/// Keysyms currently held down through a temporary spare-keycode
		/// binding; the binding must survive until the matching release.
		held_temp:           Vec<(u32, u8)>,
	}

	impl Input {
		/// Connect and verify the XTEST extension is usable.
		pub fn new() -> Result<Self, X11InputError> {
			let (conn, screen_num) =
				x11rb::connect(None).map_err(|error| X11InputError(connect_error(error)))?;
			let setup = conn.setup();
			let root = setup
				.roots
				.get(screen_num)
				.ok_or_else(|| X11InputError("X11 setup reported no default screen".to_string()))?
				.root;
			let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
			conn
				.xtest_get_version(2, 2)
				.map_err(input_request_error)?
				.reply()
				.map_err(|error| {
					X11InputError(format!(
						"the X server does not support the XTEST extension required for native input: \
						 {error}"
					))
				})?;
			let mapping = conn
				.get_keyboard_mapping(min_keycode, max_keycode - min_keycode + 1)
				.map_err(input_request_error)?
				.reply()
				.map_err(input_request_error)?;
			Ok(Self {
				conn,
				root,
				min_keycode,
				keysyms_per_keycode: mapping.keysyms_per_keycode,
				keysyms: mapping.keysyms,
				held_temp: Vec::new(),
			})
		}

		/// Absolute pointer motion in root (global desktop) coordinates.
		pub fn move_mouse(
			&mut self,
			x: i32,
			y: i32,
			_coordinate: Coordinate,
		) -> Result<(), X11InputError> {
			let x = i16::try_from(x).map_err(|_| {
				X11InputError(format!("pointer x coordinate {x} exceeds the X11 coordinate space"))
			})?;
			let y = i16::try_from(y).map_err(|_| {
				X11InputError(format!("pointer y coordinate {y} exceeds the X11 coordinate space"))
			})?;
			self.fake_input(MOTION_NOTIFY_EVENT, 0, x, y)
		}

		pub fn button(&mut self, button: Button, direction: Direction) -> Result<(), X11InputError> {
			let detail = button_detail(button);
			if matches!(direction, Direction::Press | Direction::Click) {
				self.fake_input(BUTTON_PRESS_EVENT, detail, 0, 0)?;
			}
			if matches!(direction, Direction::Release | Direction::Click) {
				self.fake_input(BUTTON_RELEASE_EVENT, detail, 0, 0)?;
			}
			Ok(())
		}

		/// Scroll by whole steps: one button 4/5/6/7 click pair per step.
		pub fn scroll(&mut self, steps: i32, axis: Axis) -> Result<(), X11InputError> {
			let detail = scroll_button(axis, steps < 0);
			for _ in 0..steps.unsigned_abs() {
				self.fake_input(BUTTON_PRESS_EVENT, detail, 0, 0)?;
				self.fake_input(BUTTON_RELEASE_EVENT, detail, 0, 0)?;
			}
			Ok(())
		}

		pub fn key(&mut self, key: Key, direction: Direction) -> Result<(), X11InputError> {
			self.send_keysym(keysym_for_key(key), direction)
		}

		pub fn text(&mut self, text: &str) -> Result<(), X11InputError> {
			for ch in text.chars() {
				self.send_keysym(keysym_for_char(ch), Direction::Click)?;
			}
			Ok(())
		}

		fn view(&self) -> KeymapView<'_> {
			KeymapView {
				min_keycode:         self.min_keycode,
				keysyms_per_keycode: self.keysyms_per_keycode,
				keysyms:             &self.keysyms,
			}
		}

		fn fake_input(
			&self,
			event_type: u8,
			detail: u8,
			x: i16,
			y: i16,
		) -> Result<(), X11InputError> {
			self
				.conn
				.xtest_fake_input(event_type, detail, x11rb::CURRENT_TIME, self.root, x, y, 0)
				.map_err(input_request_error)?
				.check()
				.map_err(input_request_error)
		}

		fn send_keysym(&mut self, keysym: u32, direction: Direction) -> Result<(), X11InputError> {
			if keysym == 0 {
				return Err(X11InputError(
					"character cannot be represented as an X11 keysym".to_string(),
				));
			}
			// A release must reuse the temporary keycode its press bound. The
			// record remains until both checked release and restoration succeed.
			if matches!(direction, Direction::Release)
				&& let Some(index) = self.held_temp.iter().position(|&(held, _)| held == keysym)
			{
				self.finish_temp_release(index)
			} else {
				match keysym_position(&self.view(), keysym) {
					Some((keycode, false)) => self.send_key_transition(keycode, direction),
					Some((keycode, true)) => self.send_shifted(keycode, direction),
					None => self.send_temp_bound(keysym, direction),
				}
			}
		}

		fn send_key_transition(
			&self,
			keycode: u8,
			direction: Direction,
		) -> Result<(), X11InputError> {
			if matches!(direction, Direction::Press | Direction::Click) {
				self.fake_input(KEY_PRESS_EVENT, keycode, 0, 0)?;
			}
			if matches!(direction, Direction::Release | Direction::Click) {
				self.fake_input(KEY_RELEASE_EVENT, keycode, 0, 0)?;
			}
			Ok(())
		}

		/// The keysym only exists at shift level 1, so wrap the transition in
		/// a synthetic Shift press/release.
		fn send_shifted(&self, keycode: u8, direction: Direction) -> Result<(), X11InputError> {
			let (shift, _) = keysym_position(&self.view(), Keysym::Shift_L.raw())
				.ok_or_else(|| X11InputError("keyboard mapping has no Shift keycode".to_string()))?;
			self.fake_input(KEY_PRESS_EVENT, shift, 0, 0)?;
			let result = self.send_key_transition(keycode, direction);
			let release = self.fake_input(KEY_RELEASE_EVENT, shift, 0, 0);
			result.and(release)
		}

		/// The keysym is not bound anywhere: temporarily bind it to a spare
		/// keycode, synthesize the transition, and restore the mapping.
		fn send_temp_bound(
			&mut self,
			keysym: u32,
			direction: Direction,
		) -> Result<(), X11InputError> {
			let keycode = spare_keycode(&self.view()).ok_or_else(|| {
				X11InputError(
					"no spare X11 keycode is available to bind an unmapped keysym".to_string(),
				)
			})?;
			self.write_keycode_row(keycode, keysym)?;
			let index = self.held_temp.len();
			self.held_temp.push((keysym, keycode));
			match direction {
				Direction::Click => {
					self.fake_input(KEY_PRESS_EVENT, keycode, 0, 0)?;
					self.finish_temp_release(index)
				},
				Direction::Press => self.fake_input(KEY_PRESS_EVENT, keycode, 0, 0),
				Direction::Release => self.finish_temp_release(index),
			}
		}

		fn finish_temp_release(&mut self, index: usize) -> Result<(), X11InputError> {
			let mut held_temp = std::mem::take(&mut self.held_temp);
			let result =
				finish_held_temp_release(&mut held_temp, index, |operation| match operation {
					HeldTempReleaseOperation::Release(keycode) => {
						self.fake_input(KEY_RELEASE_EVENT, keycode, 0, 0)
					},
					HeldTempReleaseOperation::Restore(keycode) => self.write_keycode_row(keycode, 0),
				});
			self.held_temp = held_temp;
			result
		}

		/// Write one keycode's keysym row verbatim and synchronously check the
		/// server's protocol response before any following fake event.
		fn write_row(&self, keycode: u8, row: &[u32]) -> Result<(), X11InputError> {
			self
				.conn
				.change_keyboard_mapping(1, keycode, self.keysyms_per_keycode, row)
				.map_err(input_request_error)?
				.check()
				.map_err(input_request_error)
		}

		/// Rewrite one keycode's keysym row (all columns) to a single keysym
		/// and mirror the change into the cached mapping.
		fn write_keycode_row(&mut self, keycode: u8, keysym: u32) -> Result<(), X11InputError> {
			let per = usize::from(self.keysyms_per_keycode);
			self.write_row(keycode, &vec![keysym; per])?;
			let start = (usize::from(keycode) - usize::from(self.min_keycode)) * per;
			self.keysyms[start..start + per].fill(keysym);
			Ok(())
		}
	}

	impl Drop for Input {
		fn drop(&mut self) {
			// Release every held temporary key in reverse order. Restore only
			// bindings whose checked release succeeded, so a failed release never
			// turns a still-held keycode back into an unrelated row.
			let held = std::mem::take(&mut self.held_temp);
			let held_keycodes: Vec<u8> = held.iter().map(|&(_, keycode)| keycode).collect();
			let _ =
				cleanup_x11_keyboard_state(&held_keycodes, self.keysyms_per_keycode, |operation| {
					match operation {
						X11CleanupOperation::Release(keycode) => {
							self.fake_input(KEY_RELEASE_EVENT, keycode, 0, 0)
						},
						X11CleanupOperation::Restore(keycode, row) => self.write_row(keycode, row),
					}
				});
		}
	}
}

#[cfg(target_os = "linux")]
pub use x11::{Input, Monitor, X11Error, X11InputError};

#[cfg(test)]
mod tests {
	use super::*;

	const RGB_MASKS: ColorMasks =
		ColorMasks { red: 0x00ff_0000, green: 0x0000_ff00, blue: 0x0000_00ff };

	#[test]
	fn scroll_steps_map_to_x11_wheel_buttons() {
		assert_eq!(scroll_button(Axis::Vertical, true), 4);
		assert_eq!(scroll_button(Axis::Vertical, false), 5);
		assert_eq!(scroll_button(Axis::Horizontal, true), 6);
		assert_eq!(scroll_button(Axis::Horizontal, false), 7);
	}

	#[test]
	fn pointer_buttons_map_to_core_protocol_details() {
		assert_eq!(button_detail(Button::Left), 1);
		assert_eq!(button_detail(Button::Middle), 2);
		assert_eq!(button_detail(Button::Right), 3);
		assert_eq!(button_detail(Button::Back), 8);
		assert_eq!(button_detail(Button::Forward), 9);
	}

	#[test]
	fn char_keysyms_cover_latin1_control_and_unicode_planes() {
		assert_eq!(keysym_for_char('a'), 0x61);
		assert_eq!(keysym_for_char('A'), 0x41);
		assert_eq!(keysym_for_char('é'), 0xe9);
		assert_eq!(keysym_for_char('\n'), 0xff0d);
		assert_eq!(keysym_for_char('\r'), 0xff0d);
		assert_eq!(keysym_for_char('\t'), 0xff09);
		assert_eq!(keysym_for_char('あ'), 0x0100_0000 + 0x3042);
	}

	#[test]
	fn named_keys_resolve_to_expected_keysyms() {
		assert_eq!(keysym_for_key(Key::Return), 0xff0d);
		assert_eq!(keysym_for_key(Key::Escape), 0xff1b);
		assert_eq!(keysym_for_key(Key::Space), 0x20);
		assert_eq!(keysym_for_key(Key::PageUp), 0xff55);
		assert_eq!(keysym_for_key(Key::PageDown), 0xff56);
		assert_eq!(keysym_for_key(Key::Control), 0xffe3);
		assert_eq!(keysym_for_key(Key::Meta), 0xffeb);
		assert_eq!(keysym_for_key(Key::PrintScr), 0xff61);
		assert_eq!(keysym_for_key(Key::F1), 0xffbe);
		assert_eq!(keysym_for_key(Key::F24), 0xffd5);
		assert_eq!(keysym_for_key(Key::Unicode('x')), 0x78);
	}

	#[test]
	fn keysym_lookup_prefers_unshifted_bindings_and_reports_shift_levels() {
		let keysyms = [0x61, 0x41, 0x62, 0x61, 0, 0];
		let view = KeymapView {
			min_keycode:         8,
			keysyms_per_keycode: 2,
			keysyms:             &keysyms,
		};
		assert_eq!(keysym_position(&view, 0x61), Some((8, false)));
		assert_eq!(keysym_position(&view, 0x41), Some((8, true)));
		assert_eq!(keysym_position(&view, 0x62), Some((9, false)));
		assert_eq!(keysym_position(&view, 0x63), None);
		assert_eq!(keysym_position(&view, 0), None);
	}

	#[test]
	fn spare_keycode_scan_prefers_the_highest_unbound_row() {
		let keysyms = [0, 0, 0x61, 0x41, 0, 0, 0, 0];
		let view = KeymapView {
			min_keycode:         8,
			keysyms_per_keycode: 2,
			keysyms:             &keysyms,
		};
		assert_eq!(spare_keycode(&view), Some(11));
		let full = [0x61, 0x41];
		let view =
			KeymapView { min_keycode: 8, keysyms_per_keycode: 2, keysyms: &full };
		assert_eq!(spare_keycode(&view), None);
	}

	#[test]
	fn depth24_lsb_bgrx_converts_to_rgba() {
		let data = [0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00];
		let image = zpixmap_to_rgba(&data, 2, 1, 24, 32, 32, true, RGB_MASKS).unwrap();
		assert_eq!(image.get_pixel(0, 0).0, [0xff, 0x00, 0x00, 0xff]);
		assert_eq!(image.get_pixel(1, 0).0, [0x00, 0x00, 0xff, 0xff]);
	}

	#[test]
	fn depth24_msb_xrgb_converts_to_rgba() {
		let data = [0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff];
		let image = zpixmap_to_rgba(&data, 2, 1, 24, 32, 32, false, RGB_MASKS).unwrap();
		assert_eq!(image.get_pixel(0, 0).0, [0xff, 0x00, 0x00, 0xff]);
		assert_eq!(image.get_pixel(1, 0).0, [0x00, 0x00, 0xff, 0xff]);
	}

	#[test]
	fn depth32_alpha_is_forced_opaque() {
		let data = [0x10, 0x20, 0x30, 0x00];
		let image = zpixmap_to_rgba(&data, 1, 1, 32, 32, 32, true, RGB_MASKS).unwrap();
		assert_eq!(image.get_pixel(0, 0).0, [0x30, 0x20, 0x10, 0xff]);
	}

	#[test]
	fn packed_24bpp_rows_honor_scanline_padding() {
		let data = [0x01, 0x02, 0x03, 0x00, 0x04, 0x05, 0x06, 0x00];
		let image = zpixmap_to_rgba(&data, 1, 2, 24, 24, 32, true, RGB_MASKS).unwrap();
		assert_eq!(image.get_pixel(0, 0).0, [0x03, 0x02, 0x01, 0xff]);
		assert_eq!(image.get_pixel(0, 1).0, [0x06, 0x05, 0x04, 0xff]);
	}

	#[test]
	fn shallow_depths_and_short_buffers_are_rejected() {
		assert!(
			zpixmap_to_rgba(&[0; 8], 2, 1, 16, 16, 16, true, RGB_MASKS)
				.unwrap_err()
				.contains("depth 16")
		);
		assert!(
			zpixmap_to_rgba(&[0; 4], 2, 1, 24, 32, 32, true, RGB_MASKS)
				.unwrap_err()
				.contains("truncated")
		);
	}

	#[test]
	fn visual_masks_decode_bgr_and_depth30_components() {
		let bgr_masks = ColorMasks { red: 0x0000_00ff, green: 0x0000_ff00, blue: 0x00ff_0000 };
		let bgr =
			zpixmap_to_rgba(&[0xff, 0x00, 0x00, 0x00], 1, 1, 24, 32, 32, true, bgr_masks).unwrap();
		assert_eq!(bgr.get_pixel(0, 0).0, [0xff, 0x00, 0x00, 0xff]);

		let depth30_masks = ColorMasks { red: 0x3ff0_0000, green: 0x000f_fc00, blue: 0x0000_03ff };
		let depth30 =
			zpixmap_to_rgba(&0x3ff8_0000u32.to_le_bytes(), 1, 1, 30, 32, 32, true, depth30_masks)
				.unwrap();
		assert_eq!(depth30.get_pixel(0, 0).0, [0xff, 0x80, 0x00, 0xff]);
	}

	#[test]
	fn invalid_visual_masks_are_rejected_explicitly() {
		let zero = ColorMasks { red: 0, green: 0xff00, blue: 0xff };
		assert!(
			zpixmap_to_rgba(&[0; 4], 1, 1, 24, 32, 32, true, zero)
				.unwrap_err()
				.contains("red mask is zero")
		);
		let overlap = ColorMasks { red: 0xff, green: 0xff, blue: 0xff00 };
		assert!(
			zpixmap_to_rgba(&[0; 4], 1, 1, 24, 32, 32, true, overlap)
				.unwrap_err()
				.contains("masks overlap")
		);
		let noncontiguous = ColorMasks { red: 0x5, green: 0x70, blue: 0x380 };
		assert!(
			zpixmap_to_rgba(&[0; 4], 1, 1, 24, 32, 32, true, noncontiguous)
				.unwrap_err()
				.contains("not contiguous")
		);
	}

	#[test]
	fn temp_release_record_survives_until_release_and_restore_both_succeed() {
		let mut held = vec![(0x0100_3042, 42)];
		let mut observed = Vec::new();
		let error = finish_held_temp_release(&mut held, 0, |operation| {
			observed.push(operation);
			match operation {
				HeldTempReleaseOperation::Release(_) => Err("release failed"),
				HeldTempReleaseOperation::Restore(_) => Ok(()),
			}
		})
		.unwrap_err();
		assert_eq!(error, "release failed");
		assert_eq!(held, vec![(0x0100_3042, 42)]);
		assert_eq!(observed, vec![HeldTempReleaseOperation::Release(42)]);

		observed.clear();
		let error = finish_held_temp_release(&mut held, 0, |operation| {
			observed.push(operation);
			match operation {
				HeldTempReleaseOperation::Release(_) => Ok(()),
				HeldTempReleaseOperation::Restore(_) => Err("restore failed"),
			}
		})
		.unwrap_err();
		assert_eq!(error, "restore failed");
		assert_eq!(held, vec![(0x0100_3042, 42)]);
		assert_eq!(observed, vec![
			HeldTempReleaseOperation::Release(42),
			HeldTempReleaseOperation::Restore(42),
		]);

		finish_held_temp_release(&mut held, 0, |_| Ok::<(), &str>(())).unwrap();
		assert!(held.is_empty());
	}

	#[test]
	fn x11_cleanup_continues_after_errors_and_restores_exact_row_width() {
		#[derive(Debug, PartialEq, Eq)]
		enum Observed {
			Release(u8),
			Restore(u8, Vec<u32>),
		}
		let mut observed = Vec::new();
		let error = cleanup_x11_keyboard_state(&[1, 2, 3], 4, |operation| {
			match operation {
				X11CleanupOperation::Release(keycode) => {
					observed.push(Observed::Release(keycode));
					if keycode == 3 {
						return Err("first cleanup failure");
					}
				},
				X11CleanupOperation::Restore(keycode, row) => {
					observed.push(Observed::Restore(keycode, row.to_vec()));
					if keycode == 2 {
						return Err("later cleanup failure");
					}
				},
			}
			Ok(())
		})
		.unwrap_err();
		assert_eq!(error, "first cleanup failure");
		assert_eq!(observed, vec![
			Observed::Release(3),
			Observed::Release(2),
			Observed::Release(1),
			Observed::Restore(1, vec![0, 0, 0, 0]),
			Observed::Restore(2, vec![0, 0, 0, 0]),
		]);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn opt_in_x11_capture_and_checked_input_smoke() {
		if std::env::var_os("OMP_NATIVE_DESKTOP_X11_TEST").is_none() {
			return;
		}
		let monitor = Monitor::all()
			.expect("X11 monitor enumeration should succeed")
			.into_iter()
			.next()
			.expect("X11 should report a screen");
		let image = monitor
			.capture_image()
			.expect("X11 root capture should succeed");
		assert!(image.width() > 0 && image.height() > 0);

		let mut input = Input::new().expect("XTest input should initialize without a portal");
		input.move_mouse(20, 20, Coordinate::Abs).unwrap();
		input.key(Key::Unicode('x'), Direction::Click).unwrap();
		input.text("あ").unwrap();
	}
}
