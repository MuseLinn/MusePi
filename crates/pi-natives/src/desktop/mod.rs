mod applications;
mod ax;
mod backend;
mod control;
mod error;
mod frame;
// The hand-back rule is read only by the macOS front-app hold; its tests run on
// every platform, so the rules stay compiled and checked everywhere.
#[cfg_attr(
	not(target_os = "macos"),
	allow(dead_code, reason = "only macOS holds an app to put back")
)]
mod front_app;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod regions;
// Menu label matching is shared vocabulary. Windows and Linux route menus
// natively; macOS has no menu route yet, where every helper here is uncalled,
// so the dead-code and redundant-pub(crate) lints would fire on -Dwarnings.
#[cfg_attr(
	not(any(target_os = "windows", target_os = "linux", test)),
	allow(
		dead_code,
		clippy::redundant_pub_crate,
		reason = "consumed by the windows and linux menu backends and by this module's tests"
	)
)]
mod menus;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	collections::HashMap,
	panic::AssertUnwindSafe,
	sync::{Arc, atomic::AtomicU32},
	thread::{self, JoinHandle},
	time::Duration,
};

use applications::{Application, ApplicationOpenOptions, ApplicationQuery};
use ax::{AxRegistry, register_node};
use backend::{Backend, DeliveryMode, MouseButton, PointerEvent};
use control::{CancellationSource, OperationToken};
use error::{CoreResult, DesktopError};
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
pub use menus::DesktopMenuItem;
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use parking_lot::Mutex;
pub use types::*;

use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(1);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	MenuItems(Vec<DesktopMenuItem>),
	Capture(DesktopCapture),
	VisualRegions(VisualRegions),
	Unit,
	Snapshot(AxSnapshot),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
}

type Reply = flume::Sender<CoreResult<Response>>;

enum Request {
	Capabilities {
		reply: Reply,
	},
	ListDisplays {
		reply: Reply,
	},
	ListWindows {
		reply: Reply,
	},
	Capture {
		target: Target,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	CaptureRegion {
		target: Target,
		region: CaptureRegion,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	VisualRegions {
		target:  Target,
		options: VisualRegionsOptions,
		reply:   Reply,
	},
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target: Target,
		x:      f64,
		y:      f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target: Target,
		x:      f64,
		y:      f64,
		dx:     f64,
		dy:     f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	TypeText {
		target: Target,
		text:   String,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	KeyChord {
		target: Target,
		keys:   Vec<keys::KeyName>,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	HoldKeys {
		target:   Target,
		keys:     Vec<keys::KeyName>,
		duration: Duration,
		mode:     DeliveryMode,
		reply:    Reply,
	},
	HoldPointer {
		target:   Target,
		x:        f64,
		y:        f64,
		button:   MouseButton,
		duration: Duration,
		mode:     DeliveryMode,
		reply:    Reply,
	},
	RaiseWindow {
		id:    String,
		reply: Reply,
	},
	MenuItems {
		window: String,
		path:   Vec<String>,
		reply:  Reply,
	},
	MenuSelect {
		window: String,
		path:   Vec<String>,
		reply:  Reply,
	},
	AxSnapshot {
		target:  Target,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	AxQuery {
		target: Target,
		query:  AxQuery,
		reply:  Reply,
	},
	AxElementAt {
		target: Target,
		x:      f64,
		y:      f64,
		reply:  Reply,
	},
	AxFocused {
		reply: Reply,
	},
	AxNode {
		reference: String,
		reply:     Reply,
	},
	AxAttributes {
		reference: String,
		reply:     Reply,
	},
	AxChildren {
		reference: String,
		reply:     Reply,
	},
	AxParent {
		reference: String,
		reply:     Reply,
	},
	AxPerform {
		reference: String,
		action:    String,
		reply:     Reply,
	},
	AxSetValue {
		reference: String,
		value:     String,
		reply:     Reply,
	},
	AxFocus {
		reference: String,
		reply:     Reply,
	},
	AxClick {
		reference: String,
		options:   ParsedPointerOptions,
		reply:     Reply,
	},
	Close {
		reply: Reply,
	},
}

impl Request {
	fn reply(self, result: CoreResult<Response>) {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
			| Self::CaptureRegion { reply, .. }
			| Self::VisualRegions { reply, .. }
			| Self::Click { reply, .. }
			| Self::MoveMouse { reply, .. }
			| Self::Drag { reply, .. }
			| Self::Scroll { reply, .. }
			| Self::TypeText { reply, .. }
			| Self::KeyChord { reply, .. }
			| Self::HoldKeys { reply, .. }
			| Self::HoldPointer { reply, .. }
			| Self::RaiseWindow { reply, .. }
			| Self::MenuItems { reply, .. }
			| Self::MenuSelect { reply, .. }
			| Self::AxSnapshot { reply, .. }
			| Self::AxQuery { reply, .. }
			| Self::AxElementAt { reply, .. }
			| Self::AxFocused { reply }
			| Self::AxNode { reply, .. }
			| Self::AxAttributes { reply, .. }
			| Self::AxChildren { reply, .. }
			| Self::AxParent { reply, .. }
			| Self::AxPerform { reply, .. }
			| Self::AxSetValue { reply, .. }
			| Self::AxFocus { reply, .. }
			| Self::AxClick { reply, .. }
			| Self::Close { reply } => reply,
		};
		let _ = reply.send(result);
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}

	/// The target and delivery mode of a request that sends input to the
	/// machine, which is what the cross-session real-input lease guards.
	fn input_scope(&self) -> Option<(Target, DeliveryMode)> {
		match self {
			Self::Click { target, options, .. } | Self::Drag { target, options, .. } => {
				Some((target.clone(), options.mode))
			},
			Self::MoveMouse { target, mode, .. }
			| Self::Scroll { target, mode, .. }
			| Self::TypeText { target, mode, .. }
			| Self::KeyChord { target, mode, .. }
			| Self::HoldKeys { target, mode, .. }
			| Self::HoldPointer { target, mode, .. } => Some((target.clone(), *mode)),
			// The window a reference names is resolved on the worker, so a
			// takeover request holds global input as the desktop target it clicks
			// into. A background one is delivered to that window like any other
			// window-message input, and takes no machine-level lease.
			Self::AxClick { options, .. } if control::is_takeover(options.mode) => {
				Some((Target::Desktop, options.mode))
			},
			Self::AxClick { .. } => None,
			_ => None,
		}
	}
}

#[derive(Clone, Copy)]
struct ParsedPointerOptions {
	button:    MouseButton,
	count:     u32,
	modifiers: backend::Modifiers,
	mode:      DeliveryMode,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		Ok(Self {
			button:    MouseButton::parse(options.button.as_deref())?,
			count:     options.count.unwrap_or(1).max(1),
			modifiers: parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			mode:      DeliveryMode::parse(options.delivery_mode.as_deref()),
		})
	}
}

struct Worker {
	backend:      CoreResult<Box<dyn Backend>>,
	registry:     AxRegistry,
	frames:       HashMap<String, FrameGeometry>,
	/// Analysis pixels of recent captures, bounded by frame count and bytes.
	/// Only a full `Capture` writes here: zoom pixels are not frame pixels.
	pixels:       regions::FrameCache,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}

impl Worker {
	fn new(selector: DisplaySelector, capabilities: Arc<Mutex<DesktopCapabilities>>) -> Self {
		let backend = create_backend(selector);
		Self {
			backend,
			registry: AxRegistry::default(),
			frames: HashMap::new(),
			pixels: regions::FrameCache::new(),
			capabilities,
		}
	}

	fn backend(&mut self) -> CoreResult<&mut Box<dyn Backend>> {
		self.backend.as_mut().map_err(|error| error.clone())
	}

	fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		let windows = self.backend()?.windows()?;
		match target {
			Target::Window(id) => windows
				.into_iter()
				.find(|window| window.id == *id)
				.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found"))),
			Target::Desktop => windows
				.into_iter()
				.find(|window| window.focused)
				.ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
		}
	}

	fn frame(&self, target: &Target) -> CoreResult<FrameGeometry> {
		self.frames.get(target.key()).cloned().ok_or_else(|| {
			DesktopError::invalid_coordinate_frame(format!(
				"no capture of '{}' yet — take a screenshot of this target first; coordinate input is \
				 in pixels of that screenshot",
				target.key()
			))
		})
	}

	/// The frame coordinate input reads, with the target's current window so a
	/// resized window is refused instead of mapped onto stale pixels.
	fn validated_frame(
		&mut self,
		target: &Target,
	) -> CoreResult<(FrameGeometry, Option<DesktopWindow>)> {
		let frame = self.frame(target)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		frame.validate_window(current.as_ref())?;
		Ok((frame, current))
	}

	/// The display catalogue a capture reports: the desktop's own displays, or
	/// the captured window seen as one pseudo-display.
	fn capture_source(
		&mut self,
		target: &Target,
		width: u32,
		height: u32,
		layout: &[DesktopDisplay],
	) -> CoreResult<Vec<DesktopDisplay>> {
		match target {
			Target::Desktop => Ok(layout.to_vec()),
			Target::Window(_) => {
				let window = self.window(target)?;
				let display = DesktopDisplay {
					id:           window.id.clone(),
					name:         format!("{} — {}", window.app, window.title),
					x:            window.x,
					y:            window.y,
					width:        window.width,
					height:       window.height,
					scale:        f64::from(width) / f64::from(window.width.max(1)),
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  width,
					pixel_height: height,
					is_primary:   false,
				};
				Ok(vec![display])
			},
		}
	}

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let (frame, current) = self.validated_frame(target)?;
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	/// Backend capabilities with the flags this session derives, cached for
	/// callers that read capabilities without a round trip.
	fn capabilities(&mut self) -> CoreResult<DesktopCapabilities> {
		let capabilities = self.backend()?.capabilities().normalize();
		*self.capabilities.lock() = capabilities.clone();
		Ok(capabilities)
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	/// Runs one request under the operation that owns it: an input operation
	/// takes the cross-session real-input lease first, and a takeover one arms
	/// the physical-Escape stop.
	fn process(&mut self, request: &Request, token: &OperationToken) -> CoreResult<Response> {
		// A cancel stops work submitted before it, so a request queued behind an
		// earlier one never runs: the token was taken when the host submitted it.
		token.check()?;
		let _lease = request
			.input_scope()
			.filter(|(target, mode)| control::needs_lease(target, *mode))
			.map(|(_, mode)| control::InputLease::acquire(token, control::is_takeover(mode)))
			.transpose()?;
		self.dispatch(request)
	}

	fn dispatch(&mut self, request: &Request) -> CoreResult<Response> {
		match request {
			Request::Capabilities { .. } => {
				let caps = match self.backend.as_mut() {
					Ok(backend) => backend.capabilities().normalize(),
					Err(_) => DesktopCapabilities::unavailable(),
				};
				*self.capabilities.lock() = caps.clone();
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::MenuItems { window, path, .. } => {
				let backend = self.backend()?;
				let target = backend
					.windows()?
					.into_iter()
					.find(|candidate| candidate.id == *window)
					.ok_or_else(|| DesktopError::window_not_found(format!("window {window} is gone")))?;
				Ok(Response::MenuItems(backend.menu_items(&target, path)?))
			},
			Request::MenuSelect { window, path, .. } => {
				let backend = self.backend()?;
				let target = backend
					.windows()?
					.into_iter()
					.find(|candidate| candidate.id == *window)
					.ok_or_else(|| DesktopError::window_not_found(format!("window {window} is gone")))?;
				backend.menu_select(&target, path)?;
				Ok(Response::Unit)
			},
			Request::Capture { target, caps, .. } => {
				let (image, mut geometry) = self.backend()?.capture(target, caps)?;
				let source_width = image.width();
				let source_height = image.height();
				let image = apply_capture_caps(image, &mut geometry, caps)?;
				let width = image.width();
				let height = image.height();
				// The display layout is recorded for every target, so a later zoom
				// can refuse a frame the desktop has outgrown.
				let layout = self.backend()?.displays()?;
				geometry.record_layout(&layout)?;
				let source = self.capture_source(target, width, height, &layout)?;
				let displays = geometry.display_metadata(&source);
				let png = encode_png(&image)?;
				self.frames.insert(target.key().to_string(), geometry);
				// The full frame is the only capture whose pixels are a
				// coordinate frame; region proposals read exactly these.
				self
					.pixels
					.insert(target.key().to_string(), regions::luma_frame(&image));
				let capabilities = self.capabilities()?;
				*self.capabilities.lock() = capabilities.clone();
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					coordinate_width: width,
					coordinate_height: height,
					region: None,
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::CaptureRegion { target, region, caps, .. } => {
				let (base, _) = self.validated_frame(target)?;
				base.validate_region(region)?;
				// Refuse a frame the desktop has outgrown before spending a capture
				// on it; the crop below still checks the fresh geometry.
				let layout = self.backend()?.displays().map_err(|error| {
					DesktopError::invalid_coordinate_frame(format!(
						"could not validate captured display layout: {error}"
					))
				})?;
				base.validate_layout(&layout)?;
				// Zoom shows native detail, so it re-captures the target at its own
				// resolution instead of upscaling the frame the caller saw.
				let (image, fresh) = self.backend()?.capture(target, &CaptureCaps::default())?;
				let (fresh_width, fresh_height) = fresh.dimensions();
				let source = self.capture_source(target, fresh_width, fresh_height, &layout)?;
				let (image, source_width, source_height) =
					base.crop_region(image, &fresh, region, caps)?;
				let width = image.width();
				let height = image.height();
				let (coordinate_width, coordinate_height) = base.dimensions();
				let displays = base.display_metadata(&source);
				let png = encode_png(&image)?;
				let capabilities = self.capabilities()?;
				*self.capabilities.lock() = capabilities.clone();
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					coordinate_width,
					coordinate_height,
					region: Some(*region),
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::VisualRegions { target, options, .. } => {
				if !self.capabilities()?.visual_regions {
					return Err(DesktopError::unsupported(
						"region proposals need a backend that can capture frames",
					));
				}
				let key = target.key();
				// A target without a usable cached frame is `NoFrame`, whether it
				// was never captured or its frame was evicted: the fix is the same
				// screenshot, and it is not a coordinate mistake.
				if self.pixels.get(key).is_none() {
					return Err(DesktopError::no_frame(format!(
						"no cached pixels for '{key}' — take a screenshot of this target first; region \
						 proposals read the pixels of that screenshot"
					)));
				}
				let (frame, _) = self.validated_frame(target)?;
				if matches!(target, Target::Desktop) {
					// Proposals are frame coordinates: a desktop layout that moved
					// since the capture would put every rectangle in the wrong display.
					let layout = self.backend()?.displays().map_err(|error| {
						DesktopError::invalid_coordinate_frame(format!(
							"could not validate the captured display layout: {error}"
						))
					})?;
					frame.validate_layout(&layout)?;
				}
				let image = self.pixels.get(key).ok_or_else(|| {
					DesktopError::no_frame(format!(
						"no cached pixels for '{key}' — take a screenshot of this target first; region \
						 proposals read the pixels of that screenshot"
					))
				})?;
				let (frame_width, frame_height) = frame.dimensions();
				if image.dimensions() != (frame_width, frame_height) {
					return Err(DesktopError::invalid_coordinate_frame(
						"cached pixels no longer match the last capture of this target; take a \
						 screenshot again before asking for region proposals",
					));
				}
				let proposals =
					regions::propose(image, options.max_regions.unwrap_or(regions::DEFAULT_MAX_REGIONS));
				let width = frame_width;
				let height = frame_height;
				let regions = proposals
					.regions
					.into_iter()
					// The frame is the one coordinate source: a proposal that would
					// fall outside it is a detector bug, not a clickable region.
					.filter(|proposal| {
						frame
							.validate_region(&CaptureRegion {
								x:      f64::from(proposal.x),
								y:      f64::from(proposal.y),
								width:  f64::from(proposal.width),
								height: f64::from(proposal.height),
							})
							.is_ok()
					})
					.enumerate()
					.map(|(index, proposal)| VisualRegion {
						id:         u32::try_from(index + 1).unwrap_or(u32::MAX),
						x:          proposal.x,
						y:          proposal.y,
						width:      proposal.width,
						height:     proposal.height,
						kind:       proposal.kind.to_string(),
						label:      None,
						confidence: proposal.confidence,
					})
					.collect();
				Ok(Response::VisualRegions(VisualRegions {
					target: key.to_string(),
					width,
					height,
					regions,
					truncated: proposals.truncated,
					reason: proposals.reason.map(|reason| reason.as_str().to_string()),
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::MoveMouse { target, x, y, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self
					.backend()?
					.pointer(target, PointerEvent::Move { x, y }, &frame, *mode)?;
				Ok(Response::Unit)
			},
			Request::Drag { target, path, options, .. } => {
				backend::check_drag_len(path)?;
				let frame = self.frame(target)?;
				let current = if matches!(target, Target::Window(_)) {
					Some(self.window(target)?)
				} else {
					None
				};
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Drag {
						path:      mapped,
						button:    options.button,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Scroll { target, x, y, dx, dy, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					*mode,
				)?;
				Ok(Response::Unit)
			},
			Request::TypeText { target, text, mode, .. } => {
				self.backend()?.type_text(target, text, *mode)?;
				Ok(Response::Unit)
			},
			Request::KeyChord { target, keys, mode, .. } => {
				self.backend()?.key_chord(target, keys, *mode)?;
				Ok(Response::Unit)
			},
			Request::HoldKeys { target, keys, duration, mode, .. } => {
				self.backend()?.hold_keys(target, keys, *duration, *mode)?;
				Ok(Response::Unit)
			},
			Request::HoldPointer { target, x, y, button, duration, mode, .. } => {
				// Same coordinate contract as click: pixels of the latest capture of
				// this target, mapped to the screen frame the backend receives.
				let (x, y, _) = self.map_point(target, *x, *y)?;
				self
					.backend()?
					.hold_pointer(target, x, y, *button, *duration, *mode)?;
				Ok(Response::Unit)
			},
			Request::RaiseWindow { id, .. } => {
				self.backend()?.raise_window(id)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Snapshot(ax::snapshot(ax, registry, &window, options)?))
			},
			Request::AxQuery { target, query, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Nodes(ax::query(ax, registry, &window, query)?))
			},
			Request::AxElementAt { target, x, y, .. } => {
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let backend = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Node(ax::element_at_node(backend, registry, target.key(), *x, *y)?))
			},
			Request::AxFocused { .. } => {
				let handle = self.ax()?.focused_element()?;
				let node = match handle {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, "desktop", h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxNode { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let props = self.ax()?.props(&h)?;
				Ok(Response::Node(Some(axnode(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let mut attributes = self.ax()?.attributes(&h)?;
				for (_, value) in &mut attributes {
					if value.chars().count() > 200 {
						*value = value
							.chars()
							.take(199)
							.chain(std::iter::once('…'))
							.collect();
					}
				}
				Ok(Response::Attributes(attributes))
			},
			Request::AxChildren { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let handles = self.ax()?.children(&h)?;
				let mut nodes = Vec::with_capacity(handles.len());
				for h in handles {
					let (backend, registry) = (&mut self.backend, &mut self.registry);
					let ax = backend
						.as_mut()
						.map_err(|error| error.clone())?
						.ax()
						.ok_or_else(DesktopError::ax_unsupported)?;
					nodes.push(register_node(ax, registry, &target, h)?);
				}
				Ok(Response::Nodes(nodes))
			},
			Request::AxParent { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let parent = self.ax()?.parent(&h)?;
				let node = match parent {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, &target, h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxPerform { reference, action, .. } => {
				let h = self.registry.resolve(reference)?;
				if action.eq_ignore_ascii_case("press") {
					ax::ax_press(self.ax()?, &h)?;
				} else {
					self.ax()?.perform(&h, action)?;
				}
				Ok(Response::Unit)
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxFocus { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.focus(&h)?;
				Ok(Response::Unit)
			},
			Request::AxClick { reference, options, .. } => {
				let h = self.registry.resolve(reference)?;
				let bounds = self.ax()?.props(&h)?.bounds.ok_or_else(|| {
					DesktopError::ax_failed(format!("{reference} has no clickable bounds"))
				})?;
				let x = bounds.x + bounds.width / 2.0;
				let y = bounds.y + bounds.height / 2.0;
				let windows = self.backend()?.windows()?;
				let window = windows
					.into_iter()
					.find(|w| {
						x >= f64::from(w.x)
							&& x < f64::from(w.x + w.width as i32)
							&& y >= f64::from(w.y)
							&& y < f64::from(w.y + w.height as i32)
					})
					.ok_or_else(|| {
						DesktopError::window_not_found(format!("no window contains {reference}"))
					})?;
				let target = Target::Window(window.id);
				self.backend()?.pointer(
					&target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&FrameGeometry::identity_global(),
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

fn axnode(reference: String, props: ax::AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

#[cfg(target_os = "macos")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(macos::MacosBackend::new(selector)?))
}
#[cfg(target_os = "windows")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(win32::Win32Backend::new(selector)?))
}
#[cfg(target_os = "linux")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	linux::new_backend(selector)
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn create_backend(_: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Err(DesktopError::capture_failed("desktop backend unavailable on this platform"))
}

/// One queued request with the operation generation it was submitted under, so
/// a cancel stops queued work rather than only the operation in flight.
struct QueuedRequest {
	request: Request,
	token:   OperationToken,
}

struct Lifecycle {
	tx:     Option<flume::Sender<QueuedRequest>>,
	done:   Option<flume::Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:     DisplaySelector,
	lifecycle:    Mutex<Lifecycle>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
	cancellation: CancellationSource,
}
impl SessionCore {
	fn new(selector: DisplaySelector, escape_stops: Arc<AtomicU32>) -> Arc<Self> {
		Arc::new(Self {
			selector,
			lifecycle: Mutex::new(Lifecycle {
				tx:     None,
				done:   None,
				join:   None,
				closed: false,
			}),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
			cancellation: CancellationSource::counting_escapes(escape_stops),
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<QueuedRequest>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<QueuedRequest>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let join = thread::Builder::new()
			.name("musepi-desktop-session".into())
			.spawn(move || {
				let mut worker = Worker::new(selector, caps);
				while let Ok(QueuedRequest { request, token }) = rx.recv() {
					let close = request.is_close();
					let _scope = token.enter();
					let result =
						std::panic::catch_unwind(AssertUnwindSafe(|| worker.process(&request, &token)))
							.unwrap_or_else(|_| {
								Err(DesktopError::internal("native desktop worker panicked"))
							});
					request.reply(result);
					if close {
						break;
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(
		&self,
		token: OperationToken,
		make: impl FnOnce(Reply) -> Request,
	) -> CoreResult<Response> {
		let (txr, rxr) = flume::bounded(1);
		self
			.ensure_started()?
			.send(QueuedRequest { request: make(txr), token })
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))?;
		rxr.recv_timeout(OPERATION_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
		})?
	}

	fn close(&self) -> CoreResult<()> {
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(QueuedRequest {
			request: Request::Close { reply: rtx },
			token:   self.cancellation.token(),
		})
		.map_err(|_| DesktopError::closed())?;
		let _ = rrx.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("timed out closing native desktop worker: {e}"))
		})?;
		if let Some(done) = lifecycle.done.take() {
			done.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
				DesktopError::timeout(format!("native desktop worker did not exit: {e}"))
			})?;
		}
		if let Some(join) = lifecycle.join.take() {
			join
				.join()
				.map_err(|_| DesktopError::internal("native desktop worker panicked during close"))?;
		}
		Ok(())
	}
}
impl Drop for SessionCore {
	fn drop(&mut self) {
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(QueuedRequest {
				request: Request::Close { reply },
				token:   self.cancellation.token(),
			});
		}
		let _ = lifecycle.join.take();
	}
}

fn response_unit(response: Response) -> CoreResult<()> {
	if matches!(response, Response::Unit) {
		Ok(())
	} else {
		Err(DesktopError::internal("unexpected desktop worker response"))
	}
}

/// Physical-Escape stops counted under `key` by every desktop session created
/// with it, including closed ones, until the key is forgotten.
#[napi]
pub fn desktop_escape_stops(key: String) -> u32 {
	control::escape_stops(&key)
}

/// Drops the stop count kept under `key` once no session will use it again.
#[napi]
pub fn forget_desktop_escape_stops(key: String) {
	control::forget_escape_stops(&key);
}

/// Persistent, serialized native desktop capture/input/accessibility session.
#[napi]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}
impl Drop for DesktopSession {
	fn drop(&mut self) {
		// A running async task can retain SessionCore after its JS wrapper dies.
		// Cancel that work now rather than waiting for the last Arc to disappear.
		self.core.cancellation.cancel();
	}
}
#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		let options = options.unwrap_or_default();
		let escape_stops = control::escape_stop_counter(options.escape_stop_key.as_deref());
		Ok(Self { core: SessionCore::new(DisplaySelector::parse(options.display), escape_stops) })
	}

	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		match self
			.core
			.call(self.core.cancellation.token(), |reply| Request::Capabilities { reply })
		{
			Ok(Response::Capabilities(c)) => c,
			_ => self.core.capabilities.lock().clone(),
		}
	}

	#[napi]
	pub fn list_displays(&self) -> Result<task::Promise<Vec<DesktopDisplay>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listDisplays", (), move |_| {
			match c.call(token, |reply| Request::ListDisplays { reply })? {
				Response::Displays(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_windows(&self) -> Result<task::Promise<Vec<DesktopWindow>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listWindows", (), move |_| {
			match c.call(token, |reply| Request::ListWindows { reply })? {
				Response::Windows(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_items(
		&self,
		window: String,
		path: Vec<String>,
	) -> Result<task::Promise<Vec<DesktopMenuItem>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.menuItems", (), move |_| {
			match c.call(token, |reply| Request::MenuItems { window, path, reply })? {
				Response::MenuItems(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_select(&self, window: String, path: Vec<String>) -> Result<task::Promise<()>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.menuSelect", (), move |_| {
			match c.call(token, |reply| Request::MenuSelect { window, path, reply })? {
				Response::Unit => Ok(()),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_applications(
		&self,
		query: Option<ApplicationQuery>,
	) -> Result<task::Promise<Vec<Application>>> {
		Ok(task::blocking("desktop.listApplications", (), move |_| {
			applications::list(query.unwrap_or_default()).map_err(Into::into)
		}))
	}

	#[napi]
	pub fn open_application(
		&self,
		target: String,
		options: Option<ApplicationOpenOptions>,
	) -> Result<task::Promise<Application>> {
		Ok(task::blocking("desktop.openApplication", (), move |_| {
			applications::open(&target, options.unwrap_or_default()).map_err(Into::into)
		}))
	}

	#[napi]
	pub fn capture(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.capture", (), move |_| {
			match c.call(token, |reply| Request::Capture {
				target,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Capture a fresh native-detail region without replacing the full input
	/// coordinate frame.
	#[napi]
	pub fn capture_region(
		&self,
		target: String,
		region: CaptureRegion,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.captureRegion", (), move |_| {
			match c.call(token, |reply| Request::CaptureRegion {
				target,
				region,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Propose clickable regions from the pixels of the most recent screenshot
	/// of `target`. A pure read: it sends no input, changes no focus and takes
	/// no input lease. Rectangles are half-open pixels of that screenshot;
	/// `regions: []` with a `reason` means the frame had nothing to propose.
	#[napi]
	pub fn visual_regions(
		&self,
		target: String,
		options: Option<VisualRegionsOptions>,
	) -> Result<task::Promise<VisualRegions>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		let options = options.unwrap_or_default();
		Ok(task::blocking("desktop.visualRegions", (), move |_| {
			match c.call(token, |reply| Request::VisualRegions { target, options, reply })? {
				Response::VisualRegions(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn click(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.click", move |reply| Request::Click {
			target: Target::parse(&target),
			x,
			y,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn move_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.moveMouse", move |reply| Request::MoveMouse {
			target: Target::parse(&target),
			x,
			y,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn drag(
		&self,
		target: String,
		path: Vec<DesktopPoint>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		let path = path.into_iter().map(|p| (p.x, p.y)).collect();
		Ok(self.unit("desktop.drag", move |reply| Request::Drag {
			target: Target::parse(&target),
			path,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn scroll(
		&self,
		target: String,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.scroll", move |reply| Request::Scroll {
			target: Target::parse(&target),
			x,
			y,
			dx,
			dy,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn type_text(
		&self,
		target: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.typeText", move |reply| Request::TypeText {
			target: Target::parse(&target),
			text,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn key_chord(
		&self,
		target: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.keyChord", move |reply| Request::KeyChord {
			target: Target::parse(&target),
			keys,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn hold_pointer(
		&self,
		target: String,
		x: f64,
		y: f64,
		duration_ms: u32,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		if !(50..=10_000).contains(&duration_ms) {
			return Err(napi::Error::from(DesktopError::invalid_target(
				"hold duration must be between 50 and 10000 ms",
			)));
		}
		let parsed = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.holdPointer", move |reply| Request::HoldPointer {
			target: Target::parse(&target),
			x,
			y,
			button: parsed.button,
			duration: Duration::from_millis(u64::from(duration_ms)),
			mode: parsed.mode,
			reply,
		}))
	}

	#[napi]
	pub fn hold_keys(
		&self,
		target: String,
		keys: Vec<String>,
		duration_ms: u32,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		if !(50..=10_000).contains(&duration_ms) {
			return Err(napi::Error::from(DesktopError::invalid_target(
				"hold duration must be between 50 and 10000 ms",
			)));
		}
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.holdKeys", move |reply| Request::HoldKeys {
			target: Target::parse(&target),
			keys,
			duration: Duration::from_millis(u64::from(duration_ms)),
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn raise_window(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self
			.unit("desktop.raiseWindow", move |reply| Request::RaiseWindow { id: window_id, reply }))
	}

	#[napi]
	pub fn ax_snapshot(
		&self,
		target: String,
		opts: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<AxSnapshot>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axSnapshot", (), move |_| {
			match c.call(token, |reply| Request::AxSnapshot {
				target: Target::parse(&target),
				options: opts.unwrap_or_default(),
				reply,
			})? {
				Response::Snapshot(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_query(&self, target: String, query: AxQuery) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axQuery", move |reply| Request::AxQuery {
			target: Target::parse(&target),
			query,
			reply,
		}))
	}

	/// Accessibility hit-test at global logical desktop coordinates; needs no
	/// prior capture.
	#[napi]
	pub fn ax_element_at(
		&self,
		target: String,
		x: f64,
		y: f64,
	) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axElementAt", move |reply| Request::AxElementAt {
			target: Target::parse(&target),
			x,
			y,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focused(&self) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axFocused", move |reply| Request::AxFocused { reply }))
	}

	#[napi]
	pub fn ax_node(&self, reference: String) -> Result<task::Promise<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axNode", (), move |_| {
			match c.call(token, |reply| Request::AxNode { reference, reply })? {
				Response::Node(Some(v)) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_attributes(&self, reference: String) -> Result<task::Promise<Vec<(String, String)>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axAttributes", (), move |_| {
			match c.call(token, |reply| Request::AxAttributes { reference, reply })? {
				Response::Attributes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_children(&self, reference: String) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axChildren", move |reply| Request::AxChildren { reference, reply }))
	}

	#[napi]
	pub fn ax_parent(&self, reference: String) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axParent", move |reply| Request::AxParent { reference, reply }))
	}

	#[napi]
	pub fn ax_perform(&self, reference: String, action: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axPerform", move |reply| Request::AxPerform {
			reference,
			action,
			reply,
		}))
	}

	#[napi]
	pub fn ax_set_value(&self, reference: String, value: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axSetValue", move |reply| Request::AxSetValue {
			reference,
			value,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focus(&self, reference: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axFocus", move |reply| Request::AxFocus { reference, reply }))
	}

	#[napi]
	pub fn ax_click(
		&self,
		reference: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.axClick", move |reply| Request::AxClick {
			reference,
			options: o,
			reply,
		}))
	}

	/// Immediately cancel operations submitted before this call. Later
	/// operations may proceed.
	#[napi]
	pub fn cancel(&self) {
		self.core.cancellation.cancel();
	}

	/// How many times the user's physical Escape has stopped takeover input in
	/// this session, or under its `escapeStopKey`. Host cancels, retirement and
	/// release never count, so a rise tells the host the user stopped the work.
	#[napi(getter)]
	pub fn escape_stops(&self) -> u32 {
		self.core.cancellation.escape_stops()
	}

	/// Native ownership only. Human approval is required by the host before
	/// calling this method.
	#[napi]
	pub fn acquire_control(&self) -> Result<task::Promise<DesktopControlState>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.acquireControl", (), move |_| {
			token.check()?;
			if c.lifecycle.lock().closed {
				return Err(DesktopError::closed().into());
			}
			c.cancellation.acquire_control(&token)?;
			if let Err(error) = token.check() {
				c.cancellation.release_control();
				return Err(error.into());
			}
			let (active, escape_stop) = c.cancellation.control_state();
			Ok(DesktopControlState { active, escape_stop: escape_stop.as_str().to_string() })
		}))
	}

	#[napi]
	pub fn release_control(&self) {
		self.core.cancellation.release_control();
	}

	#[napi]
	pub fn control_state(&self) -> DesktopControlState {
		let (active, escape_stop) = self.core.cancellation.control_state();
		DesktopControlState { active, escape_stop: escape_stop.as_str().to_string() }
	}

	/// Retire queued work from a completed helper without revoking held control.
	#[napi]
	pub fn retire(&self) {
		self.core.cancellation.retire();
	}

	/// Sets when the current computer run ends, `remaining_ms` from now; each
	/// run sets it before its first call. Input waiting for a Wayland portal
	/// permission prompt gives up shortly before it.
	#[napi]
	pub fn set_run_deadline(&self, remaining_ms: f64) {
		let deadline = Duration::try_from_secs_f64(remaining_ms.max(0.0) / 1000.0)
			.ok()
			.and_then(|remaining| std::time::Instant::now().checked_add(remaining));
		#[cfg(target_os = "linux")]
		self.core.cancellation.set_deadline(deadline);
		#[cfg(not(target_os = "linux"))]
		let _ = deadline;
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		self.cancel();
		let c = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| c.close().map_err(Into::into))
	}
}
impl DesktopSession {
	fn unit(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			c.call(token, make)
				.and_then(response_unit)
				.map_err(Into::into)
		})
	}

	fn nodes(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Vec<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Nodes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}

	fn node(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Node(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}
}

#[cfg(test)]
mod capture_tests {
	use image::RgbaImage;

	use super::*;
	use crate::desktop::{
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path, over one 64×48 display. Counts capture calls and keeps a
	/// mutable display layout so zoom tests can tell a re-capture from a reuse
	/// and a stale frame from a current one. Exists to exercise `Worker` without
	/// a display.
	struct FakeWaylandBackend {
		window:   DesktopWindow,
		layout:   Arc<Mutex<Vec<DesktopDisplay>>>,
		captures: Arc<Mutex<u32>>,
		scene:    bool,
		capture:  bool,
	}

	impl FakeWaylandBackend {
		fn new() -> Self {
			Self { scene: true, capture: true, ..Self::empty() }
		}

		/// A capturable target whose frames carry no structure.
		fn uniform() -> Self {
			Self { scene: false, ..Self::new() }
		}

		/// A backend that reports itself unable to capture.
		fn deaf() -> Self {
			Self { capture: false, ..Self::new() }
		}

		fn empty() -> Self {
			Self {
				window:   DesktopWindow {
					id:      WAYLAND_ID.to_string(),
					title:   "Obsidian".to_string(),
					app:     "obsidian".to_string(),
					pid:     Some(1234),
					x:       0,
					y:       0,
					width:   64,
					height:  48,
					focused: true,
				},
				layout:   Arc::new(Mutex::new(vec![DesktopDisplay {
					id:           "screen-1".to_string(),
					name:         "test".to_string(),
					x:            0,
					y:            0,
					width:        64,
					height:       48,
					scale:        1.0,
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  64,
					pixel_height: 48,
					is_primary:   true,
				}])),
				captures: Arc::new(Mutex::new(0)),
				scene:    true,
				capture:  true,
			}
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: self.capture,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(self.layout.lock().clone())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(vec![self.window.clone()])
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			*self.captures.lock() += 1;
			let scene = |width: u32, height: u32| {
				if !self.scene {
					return RgbaImage::new(width, height);
				}
				let mut image = RgbaImage::from_pixel(width, height, image::Rgba([24, 24, 24, 255]));
				for y in height / 4..height * 3 / 4 {
					for x in width / 4..width * 3 / 4 {
						image.put_pixel(x, y, image::Rgba([230, 230, 230, 255]));
					}
				}
				image
			};
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = scene(self.window.width, self.window.height);
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop => {
					let layout = self.layout.lock().clone();
					let image = scene(64, 48);
					Ok((image, FrameGeometry::for_displays(&layout)))
				},
			}
		}

		fn pointer(
			&mut self,
			_: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
		) -> CoreResult<()> {
			unreachable!("pointer not exercised")
		}

		fn type_text(&mut self, _: &Target, _: &str, _: DeliveryMode) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(&mut self, _: &Target, _: &[KeyName], _: DeliveryMode) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn raise_window(&mut self, _: &str) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			None
		}
	}

	fn worker_with(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend:      Ok(Box::new(backend)),
			registry:     AxRegistry::default(),
			frames:       HashMap::new(),
			pixels:       regions::FrameCache::new(),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
		}
	}

	fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let response = worker
			.process(&capture_request(Target::Window(WAYLAND_ID.to_string())), &token)
			.expect("wayland window id should be accepted by capture");
		let Response::Capture(capture) = response else {
			panic!("expected a capture response");
		};
		assert_eq!(capture.target, WAYLAND_ID);
		assert_eq!(capture.width, 64);
		assert_eq!(capture.height, 48);
		assert_eq!(capture.backend, "wayland");
	}

	/// Unknown ids still fail — but as `WindowNotFound` from the backend lookup,
	/// never as an `InvalidTarget` pre-parse rejection of a non-`u64` id.
	#[test]
	fn capture_rejects_unknown_window_id_via_backend_lookup() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let Err(err) =
			worker.process(&capture_request(Target::Window("does-not-exist".to_string())), &token)
		else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}

	fn zoom_request(target: Target, region: CaptureRegion, caps: CaptureCaps) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::CaptureRegion { target, region, caps, reply }
	}

	/// A zoom shows native detail: it captures again instead of enlarging the
	/// capped PNG the caller already has, reports the full frame's coordinate
	/// size, and leaves the frame pointer input reads untouched.
	#[test]
	fn zoom_uses_fresh_native_pixels_and_preserves_the_full_click_frame() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let (reply, _rx) = flume::bounded(1);
		worker
			.process(
				&Request::Capture {
					target: target.clone(),
					caps: CaptureCaps { max_width: Some(32), max_height: None },
					reply,
				},
				&token,
			)
			.unwrap();
		let base = worker.frame(&target).unwrap();
		let region = CaptureRegion { x: 8.0, y: 6.0, width: 8.0, height: 6.0 };
		let Response::Capture(zoom) = worker
			.process(
				&zoom_request(target.clone(), region, CaptureCaps {
					max_width:  Some(8),
					max_height: None,
				}),
				&token,
			)
			.unwrap()
		else {
			panic!("expected zoom capture");
		};
		assert_eq!(*captures.lock(), 2, "zoom must capture again, not enlarge the old PNG");
		assert_eq!((zoom.source_width, zoom.source_height), (16, 12));
		assert_eq!((zoom.width, zoom.height), (8, 6));
		assert_eq!((zoom.coordinate_width, zoom.coordinate_height), (32, 24));
		assert_eq!(zoom.region, Some(region));
		assert_eq!(worker.frame(&target).unwrap(), base, "zoom must not replace the click frame");
		assert_eq!(worker.map_point(&target, 16.0, 12.0).unwrap().0, 32.0);
	}

	/// A frame that is missing, has an invalid rectangle, or belongs to a
	/// display layout that has changed since is refused before any capture.
	#[test]
	fn zoom_rejects_missing_invalid_and_stale_frames_before_capture() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let layout = Arc::clone(&backend.layout);
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let region = CaptureRegion { x: 0.0, y: 0.0, width: 8.0, height: 6.0 };
		let request = zoom_request(target.clone(), region, CaptureCaps::default());
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 0);
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let invalid =
			zoom_request(target, CaptureRegion { x: f64::NAN, ..region }, CaptureCaps::default());
		assert_eq!(
			worker.process(&invalid, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		layout.lock()[0].scale = 2.0;
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 1, "invalid zoom must not reach the capture backend");
	}

	// Not ported: upstream's
	// `desktop_zoom_pins_captured_display_after_active_focus_changes`. It switches
	// the session's active display at runtime; MusePi fixes the selector once at
	// construction (`DisplaySelector::All` or one id), so there is no active
	// display that can change under a captured frame to pin.

	/// A cancel stops work submitted before it, not only the operation in
	/// flight: a queued capture fails without reaching the backend or replacing
	/// the frame a click would use.
	#[test]
	fn cancel_fails_a_queued_capture_without_replacing_the_frame() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let base = worker.frame(&target).unwrap();
		let queued_source = control::CancellationSource::default();
		let queued = queued_source.token();
		queued_source.cancel();
		let error = worker
			.process(&capture_request(target.clone()), &queued)
			.err()
			.expect("a cancelled queued capture must fail");
		assert_eq!(error.code, ErrorCode::Cancelled);
		assert_eq!(*captures.lock(), 1, "a cancelled capture never reaches the backend");
		assert_eq!(worker.frame(&target).unwrap(), base, "a cancelled capture keeps the frame");
	}

	fn regions_request(target: Target, options: VisualRegionsOptions) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::VisualRegions { target, options, reply }
	}

	/// Proposals read the last screenshot's pixels; with none cached the call
	/// fails as `NoFrame` and tells the caller to screenshot first.
	#[test]
	fn regions_without_a_screenshot_report_no_frame() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let error = worker
			.process(
				&regions_request(
					Target::Window(WAYLAND_ID.to_string()),
					VisualRegionsOptions::default(),
				),
				&token,
			)
			.err()
			.expect("regions need a captured frame");
		assert_eq!(error.code, ErrorCode::NoFrame);
		assert!(error.message.contains("screenshot"), "the error must name screenshot(): {error}");
	}

	/// Regions reuse the frame the screenshot returned — no second capture —
	/// and report half-open rectangles inside that frame.
	#[test]
	fn regions_reuse_the_last_screenshot_and_stay_inside_its_frame() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let Response::VisualRegions(result) = worker
			.process(&regions_request(target, VisualRegionsOptions::default()), &token)
			.unwrap()
		else {
			panic!("expected region proposals");
		};
		assert_eq!(*captures.lock(), 1, "regions must not capture again");
		assert_eq!((result.width, result.height), (64, 48));
		assert!(!result.regions.is_empty(), "the card in the frame is a proposal");
		assert!(result.reason.is_none());
		assert!(!result.truncated);
		for (index, region) in result.regions.iter().enumerate() {
			assert_eq!(region.id, index as u32 + 1, "ids are reading-order ordinals");
			assert!(region.x + region.width <= 64 && region.y + region.height <= 48);
			assert!(region.width > 0 && region.height > 0);
			assert!((0.0..=1.0).contains(&region.confidence));
			assert!(region.label.is_none(), "region proposals carry no OCR labels");
		}
	}

	/// A flat frame is a successful analysis that found nothing: `regions: []`
	/// with `reason: "uniform"`, never an error and never a fabricated region.
	#[test]
	fn regions_treat_a_uniform_frame_as_an_empty_success() {
		let backend = FakeWaylandBackend::uniform();
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let Response::VisualRegions(result) = worker
			.process(&regions_request(target, VisualRegionsOptions::default()), &token)
			.unwrap()
		else {
			panic!("expected region proposals");
		};
		assert!(result.regions.is_empty());
		assert_eq!(result.reason.as_deref(), Some("uniform"));
	}

	/// Proposals are frame coordinates: a desktop layout that moved after the
	/// screenshot is refused instead of returning rectangles for other displays.
	#[test]
	fn regions_refuse_a_layout_that_moved_since_the_screenshot() {
		let backend = FakeWaylandBackend::new();
		let layout = Arc::clone(&backend.layout);
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = control::CancellationSource::default().token();
		let target = Target::Desktop;
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		layout.lock()[0].scale = 2.0;
		let error = worker
			.process(&regions_request(target, VisualRegionsOptions::default()), &token)
			.err()
			.expect("a moved layout must be refused");
		assert_eq!(error.code, ErrorCode::InvalidCoordinateFrame);
		assert_eq!(*captures.lock(), 1, "a refused request must not capture again");
	}

	#[test]
	fn regions_are_unsupported_when_the_backend_cannot_capture() {
		let mut worker = worker_with(FakeWaylandBackend::deaf());
		let token = control::CancellationSource::default().token();
		let error = worker
			.process(
				&regions_request(
					Target::Window(WAYLAND_ID.to_string()),
					VisualRegionsOptions::default(),
				),
				&token,
			)
			.err()
			.expect("region proposals need capture");
		assert_eq!(error.code, ErrorCode::Unsupported);
	}

	/// Region proposals are a pure read: holding this process's real input
	/// ownership must not make them fail.
	#[test]
	fn regions_take_no_input_lease() {
		let _serial = control::OWNERSHIP_TEST.lock();
		let blocking = control::CancellationSource::default();
		let blocker_token = blocking.token();
		let blocker =
			control::InputLease::acquire(&blocker_token, false).expect("blocker owns input");
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let result = worker
			.process(&regions_request(target, VisualRegionsOptions::default()), &token)
			.expect("regions must not wait on the input lease");
		assert!(matches!(result, Response::VisualRegions(_)));
		drop(blocker);
	}

	#[test]
	fn capabilities_advertise_regions_and_the_escape_stop_state() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let (reply, _rx) = flume::bounded(1);
		let Response::Capabilities(capabilities) = worker
			.process(&Request::Capabilities { reply }, &token)
			.unwrap()
		else {
			panic!("expected capabilities");
		};
		assert!(capabilities.visual_regions, "capture implies region proposals");
		let escape_stop = capabilities.escape_stop.as_str();
		assert!(
			matches!(escape_stop, "available" | "unsupported"),
			"unexpected escape stop state {escape_stop}"
		);
	}

	fn ax_click_request(options: Option<PointerOptions>) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::AxClick {
			reference: "ax:missing".to_string(),
			options: ParsedPointerOptions::parse(options).unwrap(),
			reply,
		}
	}

	/// A background `axClick` is window-message input and must not take the
	/// machine-level input lease; only takeover input does. Holding this
	/// process's real input ownership makes any attempt report `InputBusy`.
	#[test]
	fn background_ax_click_takes_no_machine_lease() {
		let _serial = control::OWNERSHIP_TEST.lock();
		let blocking = control::CancellationSource::default();
		let blocker_token = blocking.token();
		let blocker =
			control::InputLease::acquire(&blocker_token, false).expect("blocker owns input");
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = control::CancellationSource::default().token();
		let background = worker
			.process(&ax_click_request(None), &token)
			.err()
			.expect("an unresolved reference still fails");
		assert_ne!(
			background.code,
			ErrorCode::InputBusy,
			"a background ax click must not wait on the machine lease"
		);
		let takeover = ax_click_request(Some(PointerOptions {
			delivery_mode: Some("foreground".to_string()),
			..PointerOptions::default()
		}));
		assert_eq!(
			worker.process(&takeover, &token).err().unwrap().code,
			ErrorCode::InputBusy,
			"a takeover ax click needs the machine lease"
		);
		drop(blocker);
	}
}
