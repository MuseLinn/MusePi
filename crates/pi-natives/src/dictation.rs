#[cfg(windows)]
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{
	bindgen_prelude::Result,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
#[cfg(windows)]
use parking_lot::Mutex;

type DictationCallback = ThreadsafeFunction<String, UnknownReturnValue>;

#[napi]
pub struct DictationKeyMonitor {
	#[cfg(windows)]
	monitor: Mutex<Option<windows_hook::WindowsDictationMonitor>>,
}

#[napi]
impl DictationKeyMonitor {
	#[napi(constructor)]
	pub fn new(
		accelerator: String,
		#[napi(ts_arg_type = "(event: \"press\" | \"release\") => void")] callback: DictationCallback,
	) -> Result<Self> {
		let chord = HoldChord::parse(&accelerator).map_err(napi::Error::from_reason)?;
		#[cfg(windows)]
		{
			Ok(Self {
				monitor: Mutex::new(Some(windows_hook::WindowsDictationMonitor::start(
					chord, callback,
				)?)),
			})
		}
		#[cfg(not(windows))]
		{
			let _ = (chord, callback);
			Err(napi::Error::from_reason(
				"Hold-to-talk keyboard monitoring is only supported on Windows",
			))
		}
	}

	#[napi]
	#[cfg_attr(
		not(windows),
		allow(
			clippy::missing_const_for_fn,
			reason = "the Windows implementation locks a mutex-backed monitor"
		)
	)]
	pub fn close(&self) {
		#[cfg(windows)]
		self.monitor.lock().take();
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DictationTransition {
	Press,
	Release,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HoldChord {
	key:       u32,
	modifiers: Vec<u32>,
}

impl HoldChord {
	pub fn parse(accelerator: &str) -> std::result::Result<Self, String> {
		let mut modifiers = Vec::new();
		let mut key = None;
		for token in accelerator.split('+').map(str::trim) {
			let modifier = match token.to_ascii_lowercase().as_str() {
				"commandorcontrol" | "command" | "cmd" | "control" | "ctrl" => Some(0x11),
				"alt" | "option" => Some(0x12),
				"shift" => Some(0x10),
				"super" | "meta" | "win" => Some(0x5b),
				_ => None,
			};
			if let Some(modifier) = modifier {
				if !modifiers.contains(&modifier) {
					modifiers.push(modifier);
				}
				continue;
			}
			if key.is_some() {
				return Err(format!("multiple main keys in {accelerator}"));
			}
			key = Some(parse_key(token)?);
		}
		if modifiers.is_empty() {
			return Err("hold chord requires a modifier".into());
		}
		Ok(Self { key: key.ok_or_else(|| "hold chord requires a main key".to_string())?, modifiers })
	}

	pub const fn key(&self) -> u32 {
		self.key
	}

	pub fn modifiers(&self) -> &[u32] {
		&self.modifiers
	}
}

fn parse_key(token: &str) -> std::result::Result<u32, String> {
	let named = match token {
		"Space" => 0x20,
		"Enter" => 0x0d,
		"Tab" => 0x09,
		"Backspace" => 0x08,
		"Delete" => 0x2e,
		"Insert" => 0x2d,
		"Home" => 0x24,
		"End" => 0x23,
		"PageUp" => 0x21,
		"PageDown" => 0x22,
		"ArrowUp" => 0x26,
		"ArrowDown" => 0x28,
		"ArrowLeft" => 0x25,
		"ArrowRight" => 0x27,
		_ => {
			if let Some(number) = token
				.strip_prefix('F')
				.and_then(|value| value.parse::<u32>().ok())
				&& (1..=24).contains(&number)
			{
				0x70 + number - 1
			} else if token.len() == 1
				&& token
					.chars()
					.next()
					.is_some_and(|value| value.is_ascii_alphanumeric())
			{
				u32::from(token.as_bytes()[0].to_ascii_uppercase())
			} else {
				return Err(format!("unsupported dictation key {token}"));
			}
		},
	};
	Ok(named)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyEventKind {
	Down,
	Up,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyEvent {
	pub key:            u32,
	pub kind:           KeyEventKind,
	pub injected:       bool,
	pub modifiers_held: bool,
}

pub struct HoldChordMonitor {
	chord:  HoldChord,
	active: bool,
}

impl HoldChordMonitor {
	pub const fn new(chord: HoldChord) -> Self {
		Self { chord, active: false }
	}

	pub const fn chord(&self) -> &HoldChord {
		&self.chord
	}

	pub fn reduce(&mut self, event: KeyEvent) -> Option<DictationTransition> {
		if event.injected {
			return None;
		}
		match event.kind {
			KeyEventKind::Down => {
				if !self.active && event.key == self.chord.key && event.modifiers_held {
					self.active = true;
					return Some(DictationTransition::Press);
				}
			},
			KeyEventKind::Up => {
				if self.active
					&& (event.key == self.chord.key || self.chord.modifiers.contains(&event.key))
				{
					self.active = false;
					return Some(DictationTransition::Release);
				}
			},
		}
		None
	}
}

#[cfg(windows)]
mod windows_hook {
	use std::{
		cell::RefCell,
		thread::{self, JoinHandle},
	};

	use napi::bindgen_prelude::Result;
	use windows_sys::Win32::{
		Foundation::{LPARAM, LRESULT, WPARAM},
		System::Threading::GetCurrentThreadId,
		UI::{
			Input::KeyboardAndMouse::GetAsyncKeyState,
			WindowsAndMessaging::{
				CallNextHookEx, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PM_NOREMOVE,
				PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
				WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
			},
		},
	};

	use super::{
		DictationCallback, DictationTransition, HoldChord, HoldChordMonitor, KeyEvent, KeyEventKind,
		ThreadsafeFunctionCallMode,
	};

	struct ActiveMonitor {
		monitor:  HoldChordMonitor,
		callback: DictationCallback,
	}

	thread_local! { static ACTIVE: RefCell<Option<ActiveMonitor>> = const { RefCell::new(None) }; }

	unsafe extern "system" fn observe(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
		if code >= 0 {
			let kind = match message as u32 {
				WM_KEYDOWN | WM_SYSKEYDOWN => Some(KeyEventKind::Down),
				WM_KEYUP | WM_SYSKEYUP => Some(KeyEventKind::Up),
				_ => None,
			};
			if let Some(kind) = kind {
				// SAFETY: a nonnegative keyboard hook callback provides this structure.
				let key = unsafe { &*(data as *const KBDLLHOOKSTRUCT) };
				ACTIVE.with_borrow_mut(|active| {
					if let Some(active) = active {
						let modifiers_held = active.monitor.chord().modifiers().iter().all(|modifier| {
							// SAFETY: this only reads the asynchronous state of a virtual key.
							(unsafe { GetAsyncKeyState(*modifier as i32) }) < 0
						});
						let transition = active.monitor.reduce(KeyEvent {
							key: key.vkCode,
							kind,
							injected: key.flags & LLKHF_INJECTED != 0,
							modifiers_held,
						});
						let event = match transition {
							Some(DictationTransition::Press) => Some("press"),
							Some(DictationTransition::Release) => Some("release"),
							None => None,
						};
						if let Some(event) = event {
							active
								.callback
								.call(Ok(event.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
						}
					}
				});
			}
		}
		// SAFETY: forward every original event unchanged.
		unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
	}

	pub(super) struct WindowsDictationMonitor {
		thread: Option<JoinHandle<()>>,
		id:     u32,
	}

	impl WindowsDictationMonitor {
		pub(super) fn start(chord: HoldChord, callback: DictationCallback) -> Result<Self> {
			let (ready, receive) = flume::bounded(1);
			let worker = thread::Builder::new()
				.name("dictation-hotkey".into())
				.spawn(move || {
					ACTIVE.with_borrow_mut(|slot| {
						*slot = Some(ActiveMonitor { monitor: HoldChordMonitor::new(chord), callback });
					});
					// SAFETY: this process-local hook is owned by its dedicated thread.
					let hook = unsafe {
						SetWindowsHookExW(WH_KEYBOARD_LL, Some(observe), std::ptr::null_mut(), 0)
					};
					if hook.is_null() {
						let _ = ready.send(None);
						ACTIVE.with_borrow_mut(|slot| *slot = None);
						return;
					}
					// SAFETY: create this thread's message queue before publishing its id.
					let mut message: MSG = unsafe { std::mem::zeroed() };
					// SAFETY: message is writable storage owned by this thread.
					unsafe { PeekMessageW(&raw mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE) };
					// SAFETY: GetCurrentThreadId has no preconditions.
					let _ = ready.send(Some(unsafe { GetCurrentThreadId() }));
					loop {
						// SAFETY: message remains writable until this thread exits its loop.
						let status = unsafe { GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) };
						if status <= 0 {
							break;
						}
					}
					// SAFETY: this thread installed and still owns the hook.
					unsafe { UnhookWindowsHookEx(hook) };
					ACTIVE.with_borrow_mut(|slot| *slot = None);
				})
				.map_err(|error| {
					napi::Error::from_reason(format!("cannot start dictation keyboard monitor: {error}"))
				})?;
			let Some(id) = receive.recv().ok().flatten() else {
				let _ = worker.join();
				return Err(napi::Error::from_reason(
					"cannot install the global hold-to-talk keyboard monitor",
				));
			};
			Ok(Self { thread: Some(worker), id })
		}
	}

	impl Drop for WindowsDictationMonitor {
		fn drop(&mut self) {
			// SAFETY: id names the dedicated live monitor thread; teardown does not retain
			// input.
			unsafe { PostThreadMessageW(self.id, WM_QUIT, 0, 0) };
			if let Some(worker) = self.thread.take()
				&& worker.thread().id() != thread::current().id()
			{
				let _ = worker.join();
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{DictationTransition, HoldChord, HoldChordMonitor, KeyEvent, KeyEventKind};

	fn event(key: u32, kind: KeyEventKind) -> KeyEvent {
		KeyEvent { key, kind, injected: false, modifiers_held: true }
	}

	#[test]
	fn parses_supported_accelerators_and_rejects_bare_keys() {
		let chord = HoldChord::parse("CommandOrControl+Alt+Space").unwrap();
		assert_eq!(chord.key(), 0x20);
		assert_eq!(chord.modifiers(), &[0x11, 0x12]);
		assert!(HoldChord::parse("Control+Shift+F4").is_ok());
		assert!(HoldChord::parse("Space").is_err());
		assert!(HoldChord::parse("Control+NotAKey").is_err());
		assert!(HoldChord::parse("Control+Escape").is_err());
	}

	#[test]
	fn emits_one_press_and_release_across_repeat_and_unrelated_keys() {
		let chord = HoldChord::parse("Control+Alt+Space").unwrap();
		let mut monitor = HoldChordMonitor::new(chord);
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Down)), Some(DictationTransition::Press));
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Down)), None);
		assert_eq!(monitor.reduce(event(0x41, KeyEventKind::Down)), None);
		assert_eq!(monitor.reduce(event(0x41, KeyEventKind::Up)), None);
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Up)), Some(DictationTransition::Release));
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Up)), None);
	}

	#[test]
	fn releasing_a_required_modifier_finishes_before_the_main_key() {
		let chord = HoldChord::parse("Control+Alt+Space").unwrap();
		let mut monitor = HoldChordMonitor::new(chord);
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Down)), Some(DictationTransition::Press));
		assert_eq!(monitor.reduce(event(0x11, KeyEventKind::Up)), Some(DictationTransition::Release));
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Up)), None);
	}

	#[test]
	fn ignores_injected_events_and_chords_without_modifiers() {
		let chord = HoldChord::parse("Control+Space").unwrap();
		let mut monitor = HoldChordMonitor::new(chord);
		let mut injected = event(0x20, KeyEventKind::Down);
		injected.injected = true;
		assert_eq!(monitor.reduce(injected), None);
		assert_eq!(
			monitor.reduce(KeyEvent { modifiers_held: false, ..event(0x20, KeyEventKind::Down) }),
			None
		);
		assert_eq!(monitor.reduce(event(0x20, KeyEventKind::Up)), None);
	}
}
