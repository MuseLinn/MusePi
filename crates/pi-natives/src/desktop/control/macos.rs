//! Listen-only event tap for the user's physical Escape.
//!
//! The tap runs on its own thread's run loop, never consumes or edits an
//! event, and reports one thing: a physical Escape press while a takeover
//! lease is held. Everything the tap classifies as injected — a source process
//! id, or this process's own event tag — is ignored, so the agent stopping its
//! own input is not the user asking it to stop.
use std::{
	ffi::c_void,
	ptr,
	thread::{self, JoinHandle},
};

use super::{CoreResult, DesktopError, EmergencyStop};
use crate::desktop::macos::SYNTHETIC_EVENT_TAG;

/// `kCGEventSourceUnixProcessID`: the process that posted the event, `0` for
/// hardware input.
const SOURCE_UNIX_PID: u32 = 41;
const SOURCE_USER_DATA: u32 = 42;
/// `kCGKeyboardEventKeycode`.
const KEYBOARD_KEYCODE: u32 = 9;
/// `NSEvent` key code 53, the Escape key.
const ESCAPE_KEYCODE: i64 = 53;
const KEY_DOWN: u32 = 10;
/// `kCGSessionEventTap`.
const SESSION_TAP: u32 = 1;

type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

#[repr(C)]
struct SourceContext {
	version:     isize,
	info:        Ref,
	retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	release:     Option<unsafe extern "C" fn(ConstRef)>,
	description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	equal:       Option<unsafe extern "C" fn(ConstRef, ConstRef) -> bool>,
	hash:        Option<unsafe extern "C" fn(ConstRef) -> usize>,
	schedule:    Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:      Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:     Option<unsafe extern "C" fn(Ref)>,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventTapEnable(tap: Ref, enable: bool);
	fn CGPreflightListenEventAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFMachPortInvalidate(port: Ref);
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopStop(run_loop: ConstRef);
	fn CFRunLoopWakeUp(run_loop: ConstRef);
	fn CFRetain(object: ConstRef) -> ConstRef;
	fn CFRelease(object: ConstRef);
}

struct TapContext<C> {
	inner: C,
	tap:   Ref,
}

/// Only key presses: Escape is acted on at the down event, and a release
/// carries nothing this monitor reports.
const fn monitor_mask() -> u64 {
	1 << KEY_DOWN
}

/// A physical Escape press: the hardware key, from no process, untagged.
/// An injected press from another tool, or one this process posted, is not the
/// user asking for the takeover to stop.
const fn physical_escape(kind: u32, key: i64, pid: i64, tag: i64) -> bool {
	kind == KEY_DOWN && key == ESCAPE_KEYCODE && pid == 0 && tag != SYNTHETIC_EVENT_TAG
}

unsafe extern "C" fn observe(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through invalidation.
	let context = unsafe { &*(user.cast::<TapContext<EmergencyStop>>()) };
	// The tap was disabled by the system (a timeout, or the user's input being
	// too slow to handle): re-enable it and treat it as a stop, because the
	// safety net the lease reported as armed is not watching right now.
	if kind == u32::MAX || kind == u32::MAX - 1 {
		context.inner.cancel();
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (key, pid, tag) = unsafe {
			(
				CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
			)
		};
		if physical_escape(kind, key, pid, tag) {
			context.inner.escape();
		}
	}
	// Listen-only: the event is always passed through untouched.
	event
}

unsafe extern "C" fn stop_loop(_: Ref) {
	// SAFETY: this callback runs on the monitor's own run loop.
	unsafe {
		CFRunLoopStop(CFRunLoopGetCurrent());
	}
}

/// A listen-only event tap running on its own thread's run loop until drop.
///
/// Dropping signals the stop source, wakes the run loop, joins the thread, and
/// the thread invalidates and releases the mach port itself. A tap that is
/// still live when the process dies is not invalidated first; `WindowServer`
/// can then re-deliver the event it was routing. The lease that holds this tap
/// drops it when its operation ends, which is the normal path.
struct TapThread {
	thread:      Option<JoinHandle<()>>,
	run_loop:    usize,
	stop_source: usize,
}

impl TapThread {
	fn start<C: Send + 'static>(
		label: &'static str,
		inner: C,
		callback: Callback,
	) -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name("desktop-escape".into())
			.spawn(move || {
				let mut context = TapContext { inner, tap: ptr::null_mut() };
				// SAFETY: listen-only session tap; the context outlives the tap
				// because this thread invalidates the tap before returning.
				let tap = unsafe {
					CGEventTapCreate(
						SESSION_TAP,
						0,
						1,
						monitor_mask(),
						callback,
						ptr::from_mut(&mut context).cast(),
					)
				};
				if tap.is_null() {
					let _ = ready.send(None);
					return;
				}
				context.tap = tap;
				let mut stop_context = SourceContext {
					version:     0,
					info:        ptr::null_mut(),
					retain:      None,
					release:     None,
					description: None,
					equal:       None,
					hash:        None,
					schedule:    None,
					cancel:      None,
					perform:     Some(stop_loop),
				};
				// SAFETY: valid create-rule tap and version-zero run-loop context.
				let (source, stop_source) = unsafe {
					(
						CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0),
						CFRunLoopSourceCreate(ptr::null_mut(), -1, &raw mut stop_context),
					)
				};
				if source.is_null() || stop_source.is_null() {
					// SAFETY: release exactly the objects successfully created above.
					unsafe {
						if !source.is_null() {
							CFRelease(source);
						}
						if !stop_source.is_null() {
							CFRelease(stop_source);
						}
						CFMachPortInvalidate(tap);
						CFRelease(tap);
					}
					let _ = ready.send(None);
					return;
				}
				// SAFETY: both sources stay retained throughout the loop; the
				// owner gets its own retains for the signal/wakeup request.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopAddSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CGEventTapEnable(tap, true);
					let _ =
						ready.send(Some((CFRetain(run_loop) as usize, CFRetain(stop_source) as usize)));
					CFRunLoopRun();
					CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopRemoveSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CFMachPortInvalidate(tap);
					CFRelease(source);
					CFRelease(stop_source);
					CFRelease(tap);
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start {label} monitor: {error}"))
			})?;
		let Some((run_loop, stop_source)) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::permission_denied(format!(
				"cannot start the {label} monitor: macOS refused its event tap, so no input was sent; \
				 check Accessibility and Input Monitoring for the app that launched MusePi"
			)));
		};
		Ok(Self { thread: Some(worker), run_loop, stop_source })
	}
}

impl Drop for TapThread {
	fn drop(&mut self) {
		// SAFETY: these retains belong to this owner. A signaled source stays
		// pending even when the stop races the first `CFRunLoopRun` call.
		unsafe {
			CFRunLoopSourceSignal(self.stop_source as Ref);
			CFRunLoopWakeUp(self.run_loop as ConstRef);
			CFRelease(self.stop_source as ConstRef);
			CFRelease(self.run_loop as ConstRef);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

/// Whether this process can install a listen-only event tap at all. The
/// capability answer and the lease's own `Armed`/`Unavailable` read the same
/// permission, so the host never sees a working safety net reported as absent.
pub(crate) fn escape_stop_supported() -> bool {
	// SAFETY: preflight has no preconditions and creates nothing.
	unsafe { CGPreflightListenEventAccess() }
}

/// The user's physical Escape, watching only while a takeover lease holds it.
pub(super) struct EscapeMonitor {
	_tap: TapThread,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Self> {
		let tap = TapThread::start("emergency Escape", emergency, observe)?;
		Ok(Self { _tap: tap })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn only_physical_escape_cancels() {
		assert!(physical_escape(KEY_DOWN, 53, 0, 0));
		assert!(!physical_escape(KEY_DOWN, 53, 0, SYNTHETIC_EVENT_TAG));
		assert!(!physical_escape(KEY_DOWN, 53, 42, 0));
		assert!(!physical_escape(KEY_DOWN, 0, 0, 0));
		assert!(!physical_escape(11, 53, 0, 0), "a release is not a press");
		assert!(!physical_escape(12, 53, 0, 0), "a modifier change is not a press");
	}

	#[test]
	fn the_tap_listens_for_key_presses_only() {
		assert_eq!(monitor_mask(), 1 << KEY_DOWN, "only key presses are watched");
		for kind in [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 25, 26] {
			assert_eq!(monitor_mask() & (1 << kind), 0, "{kind}");
		}
	}
}
