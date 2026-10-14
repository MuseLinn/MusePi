//! Second-cursor overlay: a click-through layered window visualizing agent
//! pointer intent.
//!
//! Stock Windows maintains a single system cursor, so the "agent mouse" is a
//! *drawn* cursor in this overlay, not a second input device. The window
//! covers the virtual desktop, ignores all mouse input
//! (`WS_EX_TRANSPARENT`), never activates (`WS_EX_NOACTIVATE`), and paints
//! with GDI into a 32-bit DIB pushed via `UpdateLayeredWindow`.
//!
//! Lifetimes: hidden after every pointer request; the UI thread is joined when
//! the owning backend drops, so no ghost cursor can outlive its session.

use std::{
	ffi::c_void,
	mem::size_of,
	ptr::null_mut,
	thread::{self, JoinHandle},
	time::Duration,
};

use flume::{Receiver, Sender};
use windows_sys::Win32::{
	Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM},
	Graphics::Gdi::{
		AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
		CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateCompatibleDC, CreateDIBSection, CreateFontW,
		CreatePen, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, DT_CENTER,
		DT_SINGLELINE, DT_VCENTER, DeleteDC, DeleteObject, DrawTextW, Ellipse, FW_NORMAL, GetDC,
		OUT_DEFAULT_PRECIS, PS_SOLID, Polygon, Polyline, ReleaseDC, RoundRect, SelectObject,
		SetBkMode, SetTextColor, TRANSPARENT,
	},
	System::LibraryLoader::GetModuleHandleW,
	UI::WindowsAndMessaging::{
		CREATESTRUCTW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
		GWLP_USERDATA, GetSystemMetrics, GetWindowLongPtrW, MSG, PM_REMOVE, PeekMessageW,
		PostMessageW, PostQuitMessage, RegisterClassW, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
		SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER,
		SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, ULW_ALPHA,
		UpdateLayeredWindow, WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE, WM_NCCREATE, WM_QUIT, WNDCLASSW,
		WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
		WS_POPUP,
	},
};

use super::{
	super::{
		backend::PointerEvent,
		error::{CoreResult, DesktopError},
	},
	capture,
};

const CLASS_NAME: &str = "MusepiSecondCursorOverlay";
/// Points drawn per drag preview; the input path itself is capped separately.
const MAX_PREVIEW_POINTS: usize = 512;
/// Shape opacity after the premultiply pass.
const SHAPE_ALPHA: u32 = 232;
const CURSOR_BLUE: u32 = 0x00eb_6325;
const WHITE: u32 = 0x00ff_ffff;
const BANNER_FILL: u32 = 0x0018_1818;

fn wide(text: &str) -> Vec<u16> {
	text.encode_utf16().chain([0]).collect()
}

enum OverlayCommand {
	Cursor(i32, i32),
	Click(i32, i32),
	Path(Vec<(i32, i32)>),
	Notice(String),
	Hide,
	Stop,
}

/// Drawn scene in window-local physical pixels.
#[derive(Default)]
struct Scene {
	cursor: Option<(i32, i32)>,
	pill:   Option<(i32, i32)>,
	path:   Vec<(i32, i32)>,
	banner: Option<String>,
}

fn apply(scene: &mut Scene, command: OverlayCommand) {
	match command {
		OverlayCommand::Cursor(x, y) => {
			scene.cursor = Some((x, y));
			scene.pill = None;
			scene.path.clear();
		},
		OverlayCommand::Click(x, y) => {
			scene.cursor = Some((x, y));
			scene.pill = Some((x, y));
			scene.path.clear();
		},
		OverlayCommand::Path(points) => {
			scene.cursor = points.last().copied();
			scene.pill = None;
			scene.path = points;
		},
		OverlayCommand::Notice(text) => scene.banner = Some(text),
		OverlayCommand::Hide => *scene = Scene::default(),
		OverlayCommand::Stop => {},
	}
}

struct Layer {
	mem_dc:      *mut c_void,
	bitmap:      *mut c_void,
	prev_bitmap: *mut c_void,
	pixels:      *mut u32,
	width:       i32,
	height:      i32,
	screen_dc:   *mut c_void,
	font:        *mut c_void,
}

impl Layer {
	fn create(width: i32, height: i32) -> CoreResult<Self> {
		// SAFETY: GetDC with a null window returns the screen DC.
		let screen_dc = unsafe { GetDC(null_mut()) };
		if screen_dc.is_null() {
			return Err(DesktopError::capture_failed("overlay failed to get the screen DC"));
		}
		// SAFETY: compatible-DC creation only needs a live source DC.
		let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
		if mem_dc.is_null() {
			// SAFETY: screen_dc came from GetDC and is still owned here.
			unsafe { ReleaseDC(null_mut(), screen_dc) };
			return Err(DesktopError::capture_failed("overlay failed to create a memory DC"));
		}
		// SAFETY: zeroed BITMAPINFO is a valid empty header before fields are set.
		let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
		info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
		info.bmiHeader.biWidth = width;
		info.bmiHeader.biHeight = -height;
		info.bmiHeader.biPlanes = 1;
		info.bmiHeader.biBitCount = 32;
		info.bmiHeader.biCompression = BI_RGB;
		let mut bits: *mut c_void = null_mut();
		// SAFETY: info describes a top-down 32-bit DIB; bits receives the
		// pixel buffer owned by the returned bitmap.
		let bitmap =
			unsafe { CreateDIBSection(mem_dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0) };
		if bitmap.is_null() || bits.is_null() {
			// SAFETY: both DCs are live and owned here.
			unsafe {
				DeleteDC(mem_dc);
				ReleaseDC(null_mut(), screen_dc);
			}
			return Err(DesktopError::capture_failed("overlay failed to allocate the DIB"));
		}
		// SAFETY: bitmap is live; selecting it into the memory DC is required
		// before any drawing. The previous bitmap is kept for Drop.
		let prev_bitmap = unsafe { SelectObject(mem_dc, bitmap) };
		// SAFETY: scalar font description; a null font only degrades the
		// banner text and is tolerated at draw time.
		let font = unsafe {
			CreateFontW(
				-20,
				0,
				0,
				0,
				FW_NORMAL as i32,
				0,
				0,
				0,
				DEFAULT_CHARSET as u32,
				OUT_DEFAULT_PRECIS as u32,
				CLIP_DEFAULT_PRECIS as u32,
				CLEARTYPE_QUALITY as u32,
				DEFAULT_PITCH as u32,
				wide("Segoe UI").as_ptr(),
			)
		};
		Ok(Self {
			mem_dc,
			bitmap,
			prev_bitmap,
			pixels: bits as *mut u32,
			width,
			height,
			screen_dc,
			font,
		})
	}

	fn paint(&self, hwnd: HWND, origin: (i32, i32), scene: &Scene) {
		let count = (self.width as usize).saturating_mul(self.height as usize);
		// SAFETY: pixels spans exactly the live DIB; this thread owns all drawing.
		let pixels = unsafe { std::slice::from_raw_parts_mut(self.pixels, count) };
		pixels.fill(0);
		draw_scene(self.mem_dc, self.font, self.width, self.height, scene);
		for pixel in pixels.iter_mut() {
			let rgb = *pixel & 0x00ff_ffff;
			if rgb != 0 {
				let r = ((rgb >> 16) & 0xff) * SHAPE_ALPHA / 255;
				let g = ((rgb >> 8) & 0xff) * SHAPE_ALPHA / 255;
				let b = (rgb & 0xff) * SHAPE_ALPHA / 255;
				*pixel = (SHAPE_ALPHA << 24) | (r << 16) | (g << 8) | b;
			}
		}
		let dst = POINT { x: origin.0, y: origin.1 };
		let size = SIZE { cx: self.width, cy: self.height };
		let src = POINT { x: 0, y: 0 };
		let blend = BLENDFUNCTION {
			BlendOp:             AC_SRC_OVER as u8,
			BlendFlags:          0,
			SourceConstantAlpha: 255,
			AlphaFormat:         AC_SRC_ALPHA as u8,
		};
		// SAFETY: all handles and structs are live; a zero return only leaves
		// the previous frame on screen.
		unsafe {
			UpdateLayeredWindow(
				hwnd,
				self.screen_dc,
				&dst,
				&size,
				self.mem_dc,
				&src,
				0,
				&blend,
				ULW_ALPHA,
			)
		};
	}
}

impl Drop for Layer {
	fn drop(&mut self) {
		// SAFETY: every handle was created by `create` on this thread and is
		// released exactly once here.
		unsafe {
			if !self.font.is_null() {
				DeleteObject(self.font);
			}
			// Deselect before deleting: destroying a selected GDI object is UB.
			SelectObject(self.mem_dc, self.prev_bitmap);
			if !self.bitmap.is_null() {
				DeleteObject(self.bitmap);
			}
			if !self.mem_dc.is_null() {
				DeleteDC(self.mem_dc);
			}
			if !self.screen_dc.is_null() {
				ReleaseDC(null_mut(), self.screen_dc);
			}
		}
	}
}

fn brush(color: u32) -> *mut c_void {
	// SAFETY: solid-brush creation is stateless; callers delete the result.
	unsafe { CreateSolidBrush(color) }
}

fn pen(width: i32, color: u32) -> *mut c_void {
	// SAFETY: pen creation is stateless; callers delete the result.
	unsafe { CreatePen(PS_SOLID, width, color) }
}

fn draw_scene(dc: *mut c_void, font: *mut c_void, width: i32, height: i32, scene: &Scene) {
	if scene.path.len() > 1 {
		let line: Vec<POINT> = scene.path.iter().map(|&(x, y)| POINT { x, y }).collect();
		let pen = pen(4, CURSOR_BLUE);
		// SAFETY: dc, pen and points are live for the call.
		unsafe {
			let previous = SelectObject(dc, pen);
			Polyline(dc, line.as_ptr(), line.len() as i32);
			SelectObject(dc, previous);
			DeleteObject(pen);
		}
	}
	if let Some((x, y)) = scene.pill {
		let ring = pen(3, WHITE);
		let fill = brush(CURSOR_BLUE);
		// SAFETY: dc and both objects are live for the calls.
		unsafe {
			let previous_pen = SelectObject(dc, ring);
			Ellipse(dc, x - 15, y - 15, x + 15, y + 15);
			let previous_brush = SelectObject(dc, fill);
			Ellipse(dc, x - 11, y - 11, x + 11, y + 11);
			SelectObject(dc, previous_brush);
			SelectObject(dc, previous_pen);
			DeleteObject(ring);
			DeleteObject(fill);
		}
	}
	if let Some((x, y)) = scene.cursor {
		let arrow = [
			POINT { x, y },
			POINT { x, y: y + 30 },
			POINT { x: x + 8, y: y + 23 },
			POINT { x: x + 12, y: y + 32 },
			POINT { x: x + 15, y: y + 30 },
			POINT { x: x + 11, y: y + 22 },
			POINT { x: x + 18, y: y + 22 },
		];
		let outline = pen(2, WHITE);
		let fill = brush(CURSOR_BLUE);
		// SAFETY: dc and both objects are live for the call.
		unsafe {
			let previous_pen = SelectObject(dc, outline);
			let previous_brush = SelectObject(dc, fill);
			Polygon(dc, arrow.as_ptr(), arrow.len() as i32);
			SelectObject(dc, previous_brush);
			SelectObject(dc, previous_pen);
			DeleteObject(outline);
			DeleteObject(fill);
		}
	}
	if let Some(text) = &scene.banner {
		draw_banner(dc, font, width, height, text);
	}
}

fn draw_banner(dc: *mut c_void, font: *mut c_void, width: i32, height: i32, text: &str) {
	let banner_width = (width - 80).clamp(240, 760);
	let banner_height = 46;
	let x0 = (width - banner_width) / 2;
	let y0 = height - banner_height - 48;
	if x0 < 0 || y0 < 0 {
		return;
	}
	let fill = brush(BANNER_FILL);
	let edge = pen(1, BANNER_FILL);
	// SAFETY: dc and all objects are live for the calls below.
	unsafe {
		let previous_pen = SelectObject(dc, edge);
		let previous_brush = SelectObject(dc, fill);
		RoundRect(dc, x0, y0, x0 + banner_width, y0 + banner_height, 14, 14);
		SelectObject(dc, previous_brush);
		SelectObject(dc, previous_pen);
		DeleteObject(edge);
		DeleteObject(fill);
		if !font.is_null() {
			let previous_font = SelectObject(dc, font);
			SetBkMode(dc, TRANSPARENT as i32);
			SetTextColor(dc, WHITE);
			let mut area = RECT {
				left:   x0 + 16,
				top:    y0,
				right:  x0 + banner_width - 16,
				bottom: y0 + banner_height,
			};
			let wide: Vec<u16> = text.encode_utf16().take(180).collect();
			DrawTextW(
				dc,
				wide.as_ptr(),
				wide.len() as i32,
				&mut area,
				DT_CENTER | DT_VCENTER | DT_SINGLELINE,
			);
			SelectObject(dc, previous_font);
		}
	}
}

struct OverlayState {
	layer:  Layer,
	scene:  Scene,
	origin: (i32, i32),
}

impl OverlayState {
	fn resize_to_current(&mut self, hwnd: HWND) {
		let (origin_x, origin_y, width, height) = virtual_geometry();
		if width <= 0 || height <= 0 {
			return;
		}
		// SAFETY: reposition/resize without activation or z-order change.
		unsafe {
			SetWindowPos(
				hwnd,
				null_mut(),
				origin_x,
				origin_y,
				width,
				height,
				SWP_NOZORDER | SWP_NOACTIVATE,
			)
		};
		if width == self.layer.width && height == self.layer.height {
			self.origin = (origin_x, origin_y);
			return;
		}
		if let Ok(layer) = Layer::create(width, height) {
			self.layer = layer;
			self.origin = (origin_x, origin_y);
		}
	}
}

fn state_of(hwnd: HWND) -> *mut OverlayState {
	// SAFETY: USERDATA holds the live state pointer installed at NCCREATE;
	// callers dereference it only on this thread before teardown.
	unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState }
}

unsafe extern "system" fn wnd_proc(
	hwnd: HWND,
	msg: u32,
	wparam: WPARAM,
	lparam: LPARAM,
) -> LRESULT {
	match msg {
		WM_NCCREATE => {
			// SAFETY: lparam is a valid CREATESTRUCTW during NCCREATE.
			let create = unsafe { &*(lparam as *const CREATESTRUCTW) };
			// SAFETY: USERDATA slot is ours from this process; the pointer was
			// passed as lpParam by our own CreateWindowExW call above.
			unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
			// SAFETY: default handling during window creation.
			unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
		},
		WM_CLOSE => {
			// SAFETY: destroying our own window from its own thread.
			unsafe { DestroyWindow(hwnd) };
			0
		},
		WM_DESTROY => {
			// SAFETY: quits our own pump loop; the thread joins afterwards.
			unsafe { PostQuitMessage(0) };
			0
		},
		WM_DISPLAYCHANGE => {
			let state = state_of(hwnd);
			if !state.is_null() {
				// SAFETY: state is live (see state_of); resize then repaint.
				unsafe { (*state).resize_to_current(hwnd) };
				// SAFETY: state is live (see state_of); repaint the retained scene.
				unsafe {
					let state = &*state;
					state.layer.paint(hwnd, state.origin, &state.scene);
				}
			}
			0
		},
		_ => {
			// SAFETY: default handling for any other message on our own window.
			unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
		},
	}
}

fn virtual_geometry() -> (i32, i32, i32, i32) {
	// SAFETY: GetSystemMetrics has no preconditions.
	unsafe {
		(
			GetSystemMetrics(SM_XVIRTUALSCREEN),
			GetSystemMetrics(SM_YVIRTUALSCREEN),
			GetSystemMetrics(SM_CXVIRTUALSCREEN),
			GetSystemMetrics(SM_CYVIRTUALSCREEN),
		)
	}
}

fn overlay_thread(rx: Receiver<OverlayCommand>, ready: Sender<CoreResult<usize>>) {
	let result = run_overlay(rx, &ready);
	if let Err(error) = result {
		let _ = ready.try_send(Err(error));
	}
}

#[allow(clippy::too_many_lines, reason = "single-pass startup/teardown sequence for one window")]
fn run_overlay(rx: Receiver<OverlayCommand>, ready: &Sender<CoreResult<usize>>) -> CoreResult<()> {
	let class = wide(CLASS_NAME);
	// SAFETY: GetModuleHandleW with a null name returns this module.
	let instance: HINSTANCE = unsafe { GetModuleHandleW(null_mut()) };
	let wc = WNDCLASSW {
		style:         0,
		lpfnWndProc:   Some(wnd_proc),
		cbClsExtra:    0,
		cbWndExtra:    0,
		hInstance:     instance,
		hIcon:         null_mut(),
		hCursor:       null_mut(),
		hbrBackground: null_mut(),
		lpszMenuName:  null_mut(),
		lpszClassName: class.as_ptr(),
	};
	// SAFETY: wc borrows only the live class-name buffer.
	if unsafe { RegisterClassW(&wc) } == 0 {
		// SAFETY: GetLastError is stateless and read immediately.
		let code = unsafe { GetLastError() };
		return Err(DesktopError::capture_failed(format!(
			"overlay failed to register the window class ({code})"
		)));
	}
	let (origin_x, origin_y, width, height) = virtual_geometry();
	if width <= 0 || height <= 0 {
		return Err(DesktopError::capture_failed("overlay found no virtual desktop geometry"));
	}
	let layer = Layer::create(width, height)?;
	let mut state_box =
		Box::new(OverlayState { layer, scene: Scene::default(), origin: (origin_x, origin_y) });
	// SAFETY: the box is held in `state` until exactly one teardown site
	// takes it; the pointer is dereferenced only on this thread before that.
	let state_ptr: *mut OverlayState = &mut *state_box;
	let mut state = Some(state_box);
	// SAFETY: ex-style combination makes the window layered, click-through,
	// topmost and never-activating; lpParam carries the live state pointer
	// stored at NCCREATE.
	let hwnd = unsafe {
		CreateWindowExW(
			WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
			class.as_ptr(),
			null_mut(),
			WS_POPUP,
			origin_x,
			origin_y,
			width,
			height,
			null_mut(),
			null_mut(),
			instance,
			state_ptr as *const c_void,
		)
	};
	if hwnd.is_null() {
		// SAFETY: GetLastError is stateless and read immediately.
		let code = unsafe { GetLastError() };
		// SAFETY: hwnd creation failed, so the state has no window; reclaim it.
		drop(state.take());
		return Err(DesktopError::capture_failed(format!(
			"overlay failed to create the window ({code})"
		)));
	}
	// SAFETY: showing without activation keeps focus where it is; the initial
	// frame is fully transparent.
	unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
	// SAFETY: the state box was just stored; no teardown has run yet.
	let initial: &OverlayState = unsafe { &*state_ptr };
	initial.layer.paint(hwnd, initial.origin, &initial.scene);
	if ready.send(Ok(hwnd as usize)).is_err() {
		// SAFETY: destroys our own window; the state is reclaimed exactly
		// once via take below (DestroyWindow dispatches synchronously while
		// the state is still held).
		unsafe {
			DestroyWindow(hwnd);
		}
		drop(state.take());
		return Err(DesktopError::internal("overlay startup was abandoned"));
	}
	let mut dirty = false;
	loop {
		while let Ok(command) = rx.try_recv() {
			if matches!(command, OverlayCommand::Stop) {
				// Shutdown requested; the state is reclaimed exactly once here.
				drop(state.take());
				return Ok(());
			}
			// SAFETY: the state box is held until a teardown site takes it,
			// and every take path returns immediately.
			let current: &mut OverlayState = unsafe { &mut *state_ptr };
			apply(&mut current.scene, command);
			dirty = true;
		}
		if dirty {
			// SAFETY: same lifetime as above; no teardown runs inside the
			// command drain without returning first.
			let current: &OverlayState = unsafe { &*state_ptr };
			current.layer.paint(hwnd, current.origin, &current.scene);
			dirty = false;
		}
		// SAFETY: zeroed MSG pumped for this thread only.
		let mut message: MSG = unsafe { std::mem::zeroed() };
		// SAFETY: PeekMessageW on this thread's queue; WM_QUIT ends the loop.
		let has_message = unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } != 0;
		if has_message {
			if message.message == WM_QUIT {
				break;
			}
			// SAFETY: message pump for our own thread queue.
			unsafe {
				TranslateMessage(&message);
				DispatchMessageW(&message);
			}
		} else {
			thread::sleep(Duration::from_millis(8));
		}
	}
	// Pump exited; the state is reclaimed exactly once here.
	drop(state.take());
	Ok(())
}

/// Second-cursor overlay handle owned by the Win32 backend.
pub(crate) struct OverlayHandle {
	tx:     Sender<OverlayCommand>,
	hwnd:   HWND,
	thread: Option<JoinHandle<()>>,
}

// SAFETY: the handle only posts messages to its window and joins its thread;
// the raw window handle itself is never dereferenced here.
unsafe impl Send for OverlayHandle {}

impl OverlayHandle {
	pub(crate) fn try_create() -> CoreResult<Self> {
		let (tx, rx) = flume::unbounded::<OverlayCommand>();
		let (ready_tx, ready_rx) = flume::bounded::<CoreResult<usize>>(1);
		let thread = thread::Builder::new()
			.name("omp-cu-overlay".into())
			.spawn(move || overlay_thread(rx, ready_tx))
			.map_err(|error| {
				DesktopError::internal(format!("overlay failed to start its UI thread: {error}"))
			})?;
		let hwnd_value: usize = ready_rx
			.recv()
			.map_err(|_| DesktopError::internal("overlay UI thread exited during startup"))??;
		let hwnd = hwnd_value as HWND;
		Ok(Self { tx, hwnd, thread: Some(thread) })
	}

	fn send(&self, command: OverlayCommand) {
		let _ = self.tx.send(command);
	}

	pub(crate) fn show_event(&self, event: &PointerEvent) {
		match event {
			PointerEvent::Click { x, y, .. } => {
				if let Ok(point) = capture::logical_to_physical(*x, *y) {
					self.send(OverlayCommand::Click(point.0, point.1));
				}
			},
			PointerEvent::Move { x, y } => {
				if let Ok(point) = capture::logical_to_physical(*x, *y) {
					self.send(OverlayCommand::Cursor(point.0, point.1));
				}
			},
			PointerEvent::Drag { path, .. } => {
				let mut points = Vec::new();
				for (x, y) in path.iter().take(MAX_PREVIEW_POINTS) {
					if let Ok(point) = capture::logical_to_physical(*x, *y) {
						points.push(point);
					}
				}
				if !points.is_empty() {
					self.send(OverlayCommand::Path(points));
				}
			},
			PointerEvent::Scroll { x, y, .. } => {
				if let Ok(point) = capture::logical_to_physical(*x, *y) {
					self.send(OverlayCommand::Cursor(point.0, point.1));
				}
			},
		}
	}

	pub(crate) fn notice(&self, text: &str) {
		self.send(OverlayCommand::Notice(text.to_string()));
	}

	pub(crate) fn hide(&self) {
		self.send(OverlayCommand::Hide);
	}
}

impl Drop for OverlayHandle {
	fn drop(&mut self) {
		self.send(OverlayCommand::Stop);
		// SAFETY: hwnd was validated at creation; posting close wakes the
		// pump so the join below cannot hang on a live thread.
		unsafe { PostMessageW(self.hwnd, WM_CLOSE, 0, 0) };
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Manual smoke: briefly flashes the second cursor. Ignored by default
	/// because it needs a real interactive desktop.
	#[test]
	#[ignore = "needs an interactive desktop; flashes a visible overlay"]
	fn overlay_lifecycle_smoke() {
		let overlay = OverlayHandle::try_create().expect("overlay created");
		overlay.notice("smoke test");
		overlay.show_event(&PointerEvent::Move { x: 200.0, y: 200.0 });
		std::thread::sleep(std::time::Duration::from_millis(800));
		overlay.hide();
	}

	/// Visual proof: draws cursor + click pill + banner, captures the desktop
	/// and writes it to the temp dir for human inspection. Ignored by
	/// default; run explicitly and open the printed PNG path.
	#[test]
	#[ignore = "needs an interactive desktop; writes a proof PNG to the temp dir"]
	fn overlay_visual_proof() {
		use super::super::super::{
			backend::{Modifiers, MouseButton},
			types::{DisplaySelector, Target},
		};

		let overlay = OverlayHandle::try_create().expect("overlay created");
		overlay.notice("visual proof");
		overlay.show_event(&PointerEvent::Click {
			x:         320.0,
			y:         240.0,
			button:    MouseButton::Left,
			count:     1,
			modifiers: Modifiers::default(),
		});
		std::thread::sleep(std::time::Duration::from_millis(500));
		let (image, _) =
			super::capture::capture(&DisplaySelector::All, &Target::Desktop).expect("desktop capture");
		// Proof location: the crate target dir (always writable, git-ignored).
		let mut path = std::env::current_exe().expect("test executable path");
		path.pop();
		path.pop();
		let path = path.join("musepi-overlay-proof.png");
		image.save(&path).expect("proof PNG saved");
		println!("proof PNG: {}", path.display());
		overlay.hide();
	}
}
