//! Cancellation and exclusive task/operation ownership of desktop mutations.
//!
//! Explicit control keeps the kernel lease between operations. Revocation stops
//! fresh work immediately, but an in-flight operation retains ownership until
//! its held input and focus have been restored.
//!
//! Mid-gesture cancellation is wired into the Windows input loops. Other
//! backends still cancel at operation boundaries, where [`InputLease`] refuses
//! a stale token, so the steps below are unused there.
#![cfg_attr(
	not(windows),
	allow(
		dead_code,
		reason = "mid-gesture cancellation is wired into the Windows input loops; a backend that \
		          never calls it cancels at operation boundaries instead"
	)
)]
use std::{
	cell::{Cell, RefCell},
	collections::HashMap,
	marker::PhantomData,
	rc::Rc,
	sync::{
		Arc, LazyLock, Weak,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};

use super::{
	backend::DeliveryMode,
	error::{CoreResult, DesktopError},
	types::Target,
};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use linux::escape_stop_supported;
#[cfg(target_os = "macos")]
pub(crate) use macos::escape_stop_supported;

/// Reports whether an input request needs the cross-session real-input lease:
/// any path that moves the shared system cursor or injects into the system
/// input queue. Window-message delivery (`Background` on a window target)
/// touches neither and bypasses the lease.
pub(crate) const fn needs_lease(target: &Target, mode: DeliveryMode) -> bool {
	match mode {
		DeliveryMode::Foreground => true,
		// `Background` on the desktop target still goes through global input.
		DeliveryMode::Background => matches!(target, Target::Desktop),
	}
}

/// Reports whether an input request takes the desktop over rather than posting
/// into one window. Only takeover input arms the physical-Escape stop: a
/// background operation leaves the user's keyboard alone, so an Escape they
/// press in their own app cancels nothing and the host interrupt still does.
pub(crate) const fn is_takeover(mode: DeliveryMode) -> bool {
	matches!(mode, DeliveryMode::Foreground)
}

#[derive(Default)]
struct CancellationState {
	generation:   AtomicU64,
	state:        Mutex<Option<Arc<ControlLease>>>,
	wake:         Condvar,
	/// Takeover input stopped by the user's physical Escape. Host cancels,
	/// retirement and release never count, so the host can tell the user's stop
	/// from its own. Shared with every session under the same key.
	escape_stops: Arc<AtomicU32>,
	/// When the current computer run ends. Input waiting for a Wayland
	/// permission prompt stops shortly before it.
	#[cfg(target_os = "linux")]
	deadline:     Mutex<Option<Instant>>,
}

#[derive(Clone, Default)]
pub(crate) struct CancellationSource(Arc<CancellationState>);

impl CancellationSource {
	/// A source whose physical-Escape stops count into `stops`.
	pub(crate) fn counting_escapes(stops: Arc<AtomicU32>) -> Self {
		Self(Arc::new(CancellationState { escape_stops: stops, ..CancellationState::default() }))
	}

	pub(crate) fn token(&self) -> OperationToken {
		OperationToken {
			source:     self.clone(),
			generation: self.0.generation.load(Ordering::Acquire),
		}
	}

	/// Ends a successful run without surrendering an explicitly granted task
	/// lease.
	pub(crate) fn retire(&self) {
		let _state = self.0.state.lock();
		self.0.generation.fetch_add(1, Ordering::AcqRel);
		self.0.wake.notify_all();
	}

	/// Aborts current/queued work and revokes any explicit task ownership.
	pub(crate) fn cancel(&self) {
		let lease = {
			let mut state = self.0.state.lock();
			self.0.generation.fetch_add(1, Ordering::AcqRel);
			self.0.wake.notify_all();
			state.take()
		};
		drop(lease);
	}

	pub(crate) fn acquire_control(&self, token: &OperationToken) -> CoreResult<()> {
		let mut state = self.0.state.lock();
		token.check()?;
		if !Arc::ptr_eq(&self.0, &token.source.0) {
			return Err(busy());
		}
		if state.is_none() {
			*state = Some(Arc::new(ControlLease::acquire(self, true)?));
		}
		Ok(())
	}

	pub(crate) fn release_control(&self) {
		// A release is also a generation boundary: queued work authorized by the
		// relinquished grant must never execute under a later acquisition.
		self.cancel();
	}

	#[cfg(test)]
	pub(crate) fn control_active(&self) -> bool {
		self.0.state.lock().is_some()
	}

	/// Whether a lease is held and what its physical-Escape stop has.
	pub(crate) fn control_state(&self) -> (bool, EscapeStop) {
		let state = self.0.state.lock();
		state
			.as_ref()
			.map_or((false, EscapeStop::NotRequested), |lease| (true, lease.escape_stop))
	}

	/// How many times the user's physical Escape has stopped this session.
	pub(crate) fn escape_stops(&self) -> u32 {
		self.0.escape_stops.load(Ordering::Acquire)
	}

	/// Sets when the current computer run ends, `None` for no deadline. Each
	/// run sets it before its first call.
	#[cfg(target_os = "linux")]
	pub(crate) fn set_deadline(&self, deadline: Option<Instant>) {
		*self.0.deadline.lock() = deadline;
	}
}

/// What a held lease armed for the user's physical-Escape stop. A monitor
/// that cannot start never refuses ownership, so the host has to be able to
/// read whether the safety net is actually there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EscapeStop {
	/// The platform monitor is running under this lease.
	Armed,
	/// The platform offers a monitor but starting it failed.
	Unavailable,
	/// No monitor exists on this platform or display server.
	#[cfg_attr(
		any(windows, target_os = "macos"),
		allow(
			dead_code,
			reason = "Windows and macOS always offer a monitor; Wayland and test leases report \
			          Unsupported"
		)
	)]
	Unsupported,
	/// No lease is held.
	NotRequested,
}

impl EscapeStop {
	pub(crate) const fn as_str(self) -> &'static str {
		match self {
			Self::Armed => "armed",
			Self::Unavailable => "unavailable",
			Self::Unsupported => "unsupported",
			Self::NotRequested => "not_requested",
		}
	}
}

/// Weak callback ownership avoids a lease -> monitor -> source -> lease cycle.
#[derive(Clone)]
pub(super) struct EmergencyStop(Weak<CancellationState>);

impl EmergencyStop {
	fn cancel(&self) {
		if let Some(source) = self.0.upgrade() {
			CancellationSource(source).cancel();
		}
	}

	/// The user's physical Escape: counted before the cancel, so a host that
	/// sees the cancelled operation already sees the stop that caused it.
	fn escape(&self) {
		if let Some(source) = self.0.upgrade() {
			source.escape_stops.fetch_add(1, Ordering::AcqRel);
			CancellationSource(source).cancel();
		}
	}
}

#[derive(Clone)]
pub(crate) struct OperationToken {
	source:     CancellationSource,
	generation: u64,
}

impl OperationToken {
	/// When this operation must have answered: the current run's end, if the
	/// host set one.
	#[cfg(target_os = "linux")]
	pub(crate) fn deadline(&self) -> Option<Instant> {
		*self.source.0.deadline.lock()
	}

	pub(crate) fn enter(&self) -> OperationScope {
		let previous = CURRENT.with_borrow_mut(|current| current.replace(self.clone()));
		OperationScope { previous, _thread: PhantomData }
	}

	pub(crate) fn check(&self) -> CoreResult<()> {
		(self.source.0.generation.load(Ordering::Acquire) == self.generation).ok_or_else(|| {
			DesktopError::cancelled(
				"desktop operation cancelled; input may be partial; inspect before retrying",
			)
		})
	}

	pub(crate) fn wait(&self, duration: Duration) -> CoreResult<()> {
		let deadline = Instant::now() + duration;
		let mut state = self.source.0.state.lock();
		loop {
			self.check()?;
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(());
			}
			self.source.0.wake.wait_for(&mut state, remaining);
		}
	}
}

thread_local! {
	static CURRENT: RefCell<Option<OperationToken>> = const { RefCell::new(None) };
	static CLEANUP: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct OperationScope {
	previous: Option<OperationToken>,
	_thread:  PhantomData<Rc<()>>,
}

impl Drop for OperationScope {
	fn drop(&mut self) {
		CURRENT.with_borrow_mut(|current| *current = self.previous.take());
	}
}

/// The token of the operation running on this thread, `None` in cleanup.
#[cfg(target_os = "linux")]
pub(crate) fn current_token() -> Option<OperationToken> {
	if CLEANUP.get() {
		None
	} else {
		CURRENT.with_borrow(Clone::clone)
	}
}

pub(crate) fn check() -> CoreResult<()> {
	if CLEANUP.get() {
		return Ok(());
	}
	CURRENT.with_borrow(|token| token.as_ref().map_or(Ok(()), OperationToken::check))
}

/// Waits between steps of an input gesture, ending early when the operation is
/// cancelled.
pub(crate) fn wait(duration: Duration) -> CoreResult<()> {
	if CLEANUP.get() {
		thread::sleep(duration);
		return Ok(());
	}
	CURRENT.with_borrow(|token| {
		if let Some(token) = token {
			token.wait(duration)
		} else {
			thread::sleep(duration);
			Ok(())
		}
	})
}

/// Cleanup must release already-held input even after cancellation. This does
/// not clear a token or authorize any later operation. Nested cleanup is safe.
pub(crate) fn cleanup<T>(action: impl FnOnce() -> T) -> T {
	struct Restore(bool);
	impl Drop for Restore {
		fn drop(&mut self) {
			CLEANUP.set(self.0);
		}
	}
	let _restore = Restore(CLEANUP.replace(true));
	action()
}

static ESCAPE_STOPS: LazyLock<Mutex<HashMap<String, Arc<AtomicU32>>>> =
	LazyLock::new(Mutex::default);

/// The shared count for `key`; a session without a key counts alone.
pub(crate) fn escape_stop_counter(key: Option<&str>) -> Arc<AtomicU32> {
	key.map_or_default(|key| Arc::clone(ESCAPE_STOPS.lock().entry(key.to_owned()).or_default()))
}

/// Physical-Escape stop counts by host-chosen key. A count outlives the session
/// that observed it, so a host that replaces a hung worker's session still sees
/// a stop the old session never reported.
pub(crate) fn escape_stops(key: &str) -> u32 {
	ESCAPE_STOPS
		.lock()
		.get(key)
		.map_or(0, |stops| stops.load(Ordering::Acquire))
}

pub(crate) fn forget_escape_stops(key: &str) {
	ESCAPE_STOPS.lock().remove(key);
}

static OWNED: AtomicBool = AtomicBool::new(false);

/// Serializes tests that take this process's input ownership, which is one per
/// process: the ownership tests here and worker tests that send input.
#[cfg(test)]
pub(crate) static OWNERSHIP_TEST: Mutex<()> = Mutex::new(());

struct ProcessLease;
impl ProcessLease {
	fn acquire() -> CoreResult<Self> {
		OWNED
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		Ok(Self)
	}
}
impl Drop for ProcessLease {
	fn drop(&mut self) {
		OWNED.store(false, Ordering::Release);
	}
}

fn busy() -> DesktopError {
	DesktopError::input_busy("another desktop operation owns input/focus control; no input was sent")
}

/// The platform's Escape monitor handle, or an empty slot where none exists.
/// Only this type varies by platform: `ControlLease` keeps the field
/// unconditionally so every platform builds the same literal.
#[cfg(windows)]
type EscapeSlot = Option<windows::EscapeMonitor>;
#[cfg(target_os = "linux")]
type EscapeSlot = Option<linux::EscapeMonitor>;
#[cfg(target_os = "macos")]
type EscapeSlot = Option<macos::EscapeMonitor>;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
type EscapeSlot = ();

/// The kernel owner lives on its own thread: Windows mutex release must happen
/// on the same thread that acquired it, even when the session is disposed from
/// another host thread. Closing/crashing the process releases the OS resource.
struct ControlLease {
	_escape:     EscapeSlot,
	escape_stop: EscapeStop,
	_kernel:     KernelOwner,
	running:     AtomicBool,
}

impl ControlLease {
	/// `takeover` arms the physical-Escape stop; background input keeps the
	/// user's keyboard untouched.
	///
	/// A monitor that cannot start never refuses `takeover`: the platforms that
	/// offer it need no special permission on Windows, X11 input monitoring can
	/// be unavailable, and macOS has no monitor yet. Refusing would let a
	/// missing safety net disable input that works without one, so ownership is
	/// still granted and `escape_stops` simply never rises. The lease records
	/// `EscapeStop::Unavailable` instead of dropping the failure, so
	/// `controlState().escapeStop` reports the missing net to the host.
	fn acquire(source: &CancellationSource, takeover: bool) -> CoreResult<Self> {
		let kernel = KernelOwner::acquire()?;
		let stop = || EmergencyStop(Arc::downgrade(&source.0));
		#[cfg(windows)]
		let (escape, escape_stop) = if takeover {
			match windows::EscapeMonitor::start(stop()) {
				Ok(monitor) => (Some(monitor), EscapeStop::Armed),
				Err(_) => (None, EscapeStop::Unavailable),
			}
		} else {
			(None, EscapeStop::NotRequested)
		};
		#[cfg(target_os = "linux")]
		let (escape, escape_stop) = if takeover {
			match linux::EscapeMonitor::start(stop()) {
				Ok(Some(monitor)) => (Some(monitor), EscapeStop::Armed),
				Ok(None) => (None, EscapeStop::Unsupported),
				Err(_) => (None, EscapeStop::Unavailable),
			}
		} else {
			(None, EscapeStop::NotRequested)
		};
		#[cfg(target_os = "macos")]
		let (escape, escape_stop) = if takeover {
			match macos::EscapeMonitor::start(stop()) {
				Ok(monitor) => (Some(monitor), EscapeStop::Armed),
				Err(_) => (None, EscapeStop::Unavailable),
			}
		} else {
			(None, EscapeStop::NotRequested)
		};
		#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
		let (escape, escape_stop) = {
			let _ = (source, takeover, stop);
			((), EscapeStop::Unsupported)
		};
		Ok(Self { _escape: escape, escape_stop, _kernel: kernel, running: AtomicBool::new(false) })
	}
}

struct KernelOwner {
	stop:   Option<flume::Sender<()>>,
	thread: Option<thread::JoinHandle<()>>,
}

impl KernelOwner {
	fn acquire() -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let (stop, stopped) = flume::bounded(1);
		let thread = thread::Builder::new()
			.name("desktop-owner".into())
			.spawn(move || {
				let leases = ProcessLease::acquire()
					.and_then(|process| KernelLease::acquire().map(|kernel| (kernel, process)));
				match leases {
					Ok((kernel, process)) => {
						let _ = ready.send(Ok(()));
						let _ = stopped.recv();
						drop(kernel);
						drop(process);
					},
					Err(error) => {
						let _ = ready.send(Err(error));
					},
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start desktop owner: {error}"))
			})?;
		let owner = Self { stop: Some(stop), thread: Some(thread) };
		receive.recv().map_err(|_| {
			DesktopError::input_failed("desktop owner stopped before acquiring input")
		})??;
		Ok(owner)
	}
}

impl Drop for KernelOwner {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

/// Owns input/focus control for one operation: exclusive against other
/// operations in this process and other sessions on the machine.
pub(crate) struct InputLease {
	_scope:  OperationScope,
	owner:   Arc<ControlLease>,
	_thread: PhantomData<Rc<()>>,
}

impl InputLease {
	/// `takeover` arms the physical-Escape stop for this operation; held control
	/// keeps the stop it armed when it was granted.
	pub(crate) fn acquire(token: &OperationToken, takeover: bool) -> CoreResult<Self> {
		token.check()?;
		let owner = {
			let state = token.source.0.state.lock();
			token.check()?;
			match state.as_ref() {
				Some(owner) => owner.clone(),
				None => Arc::new(ControlLease::acquire(&token.source, takeover)?),
			}
		};
		owner
			.running
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		let lease = Self { _scope: token.enter(), owner, _thread: PhantomData };
		token.check()?;
		Ok(lease)
	}
}

impl Drop for InputLease {
	fn drop(&mut self) {
		self.owner.running.store(false, Ordering::Release);
	}
}

/// The `flock` belongs to the open file: every descriptor of it holds the lock
/// until all of them close, or until one unlocks it for all.
#[cfg(unix)]
struct KernelLease {
	file: std::fs::File,
}

#[cfg(unix)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		Self::at(&Self::path())
	}

	/// A fixed per-login-user inode coordinates independently launched hosts.
	/// Never unlink it: unlinking a locked inode would create two lock domains.
	#[cfg(not(test))]
	fn path() -> std::path::PathBuf {
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		std::path::PathBuf::from(format!("/tmp/pi-desktop-input-{uid}.lock"))
	}

	/// Test binaries run in their own process; a per-process inode keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn path() -> std::path::PathBuf {
		std::env::temp_dir().join(format!("pi-desktop-input-test-{}.lock", std::process::id()))
	}

	fn at(path: &std::path::Path) -> CoreResult<Self> {
		use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
		let file = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.mode(0o600)
			.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
			.open(path)
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot acquire desktop ownership: {error}"))
			})?;
		let metadata = file.metadata().map_err(|error| {
			DesktopError::input_failed(format!("cannot inspect desktop ownership: {error}"))
		})?;
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		if !metadata.is_file()
			|| metadata.uid() != uid
			|| metadata.nlink() != 1
			|| metadata.mode() & 0o077 != 0
		{
			return Err(DesktopError::input_failed(
				"desktop ownership file is not a private regular file",
			));
		}
		match file.try_lock() {
			Ok(()) => Ok(Self { file }),
			Err(std::fs::TryLockError::WouldBlock) => Err(busy()),
			Err(std::fs::TryLockError::Error(error)) => {
				Err(DesktopError::input_failed(format!("cannot lock desktop ownership: {error}")))
			},
		}
	}
}

#[cfg(unix)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		// Unlocked rather than closed: a process another thread is spawning keeps
		// a copy of the descriptor until it execs.
		let _ = self.file.unlock();
	}
}

#[cfg(windows)]
struct KernelLease(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		use windows_sys::Win32::{
			Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
			System::Threading::{CreateMutexW, WaitForSingleObject},
		};
		let name = Self::name();
		// SAFETY: nul-terminated name and default security descriptor are valid.
		let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
		if handle.is_null() {
			return Err(DesktopError::input_failed("cannot open desktop ownership mutex"));
		}
		// SAFETY: handle is live; zero timeout never queues or retries input.
		let status = unsafe { WaitForSingleObject(handle, 0) };
		if status == WAIT_OBJECT_0 || status == WAIT_ABANDONED {
			return Ok(Self(handle));
		}
		// SAFETY: the failed acquisition still owns its opened handle.
		unsafe {
			CloseHandle(handle);
		}
		if status == WAIT_TIMEOUT {
			return Err(busy());
		}
		Err(DesktopError::input_failed("cannot acquire desktop ownership mutex"))
	}

	/// Nul-terminated mutex name shared by every host in the login session.
	#[cfg(not(test))]
	fn name() -> Vec<u16> {
		"Local\\PiDesktopInput-v1\0".encode_utf16().collect()
	}

	/// Test binaries run in their own process; a per-process mutex keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn name() -> Vec<u16> {
		format!("Local\\PiDesktopInput-test-{}\0", std::process::id())
			.encode_utf16()
			.collect()
	}
}

#[cfg(windows)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		// SAFETY: this thread owns both the mutex and its handle.
		unsafe {
			windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
			windows_sys::Win32::Foundation::CloseHandle(self.0);
		}
	}
}

/// Real ownership without OS event monitoring: lifecycle regressions must not
/// depend on an interactive desktop or Accessibility permissions.
///
/// Under a runner that runs every test in one process the previous test can
/// still be dropping a source that holds the process's one lease after it
/// released `OWNERSHIP_TEST`, as a test's locals outlive the worker that held
/// the lock. Waiting for that release keeps the grant from failing on a
/// neighbour's teardown.
#[cfg(test)]
pub(crate) fn grant_for_test(source: &CancellationSource) {
	let deadline = Instant::now() + Duration::from_secs(10);
	let kernel = loop {
		match KernelOwner::acquire() {
			Ok(kernel) => break kernel,
			Err(error)
				if error.code == super::error::ErrorCode::InputBusy && Instant::now() < deadline =>
			{
				thread::sleep(Duration::from_millis(5));
			},
			Err(error) => panic!("test kernel owner: {error:?}"),
		}
	};
	let owner = ControlLease {
		_escape:     EscapeSlot::default(),
		escape_stop: EscapeStop::Unsupported,
		_kernel:     kernel,
		running:     AtomicBool::new(false),
	};
	*source.0.state.lock() = Some(Arc::new(owner));
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Removes this process's private kernel lock (see `KernelLease::path`).
	fn remove_test_lock() {
		#[cfg(unix)]
		let _ = std::fs::remove_file(KernelLease::path());
	}

	#[test]
	fn foreground_always_needs_the_lease() {
		assert!(needs_lease(&Target::Desktop, DeliveryMode::Foreground));
		assert!(needs_lease(&Target::Window("7".into()), DeliveryMode::Foreground));
	}

	#[test]
	fn background_needs_the_lease_only_for_desktop_targets() {
		assert!(needs_lease(&Target::Desktop, DeliveryMode::Background));
		assert!(!needs_lease(&Target::Window("7".into()), DeliveryMode::Background));
	}

	#[test]
	fn only_foreground_input_takes_the_desktop_over() {
		assert!(is_takeover(DeliveryMode::Foreground));
		assert!(!is_takeover(DeliveryMode::Background));
	}

	#[test]
	fn task_lease_survives_retirement_but_abort_and_release_revoke_it() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		source
			.acquire_control(&source.token())
			.expect("idempotent acquisition");
		let old = source.token();
		{
			let _operation = InputLease::acquire(&old, false).expect("reuse task ownership");
			assert!(InputLease::acquire(&source.token(), false).is_err());
			assert!(InputLease::acquire(&CancellationSource::default().token(), false).is_err());
		}
		source.retire();
		assert!(source.control_active());
		assert!(old.check().is_err());
		let fresh = source.token();
		let running = InputLease::acquire(&fresh, false).expect("fresh run reuses ownership");
		source.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		assert!(KernelOwner::acquire().is_err(), "cleanup still owns the kernel");
		drop(running);
		drop(KernelOwner::acquire().expect("cleanup releases ownership"));
		grant_for_test(&source);
		let queued = source.token();
		source.release_control();
		assert!(!source.control_active());
		assert!(queued.check().is_err());
		assert!(source.acquire_control(&queued).is_err(), "stale acquisition cannot grant ownership");
		assert!(!source.control_active());
		grant_for_test(&source);
		assert!(queued.check().is_err(), "reacquiring cannot revive queued input");
		drop((old, fresh, queued));
		drop(source);
		drop(KernelOwner::acquire().expect("session destruction releases ownership"));
		remove_test_lock();
	}

	#[test]
	fn emergency_stop_revokes_idle_task_control_after_retirement() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		let emergency = EmergencyStop(Arc::downgrade(&source.0));
		source.retire();
		let fresh = source.token();
		emergency.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		drop(KernelOwner::acquire().expect("idle Escape releases kernel ownership"));
		remove_test_lock();
	}

	#[test]
	fn only_the_users_escape_counts_as_an_escape_stop() {
		let source = CancellationSource::default();
		let emergency = EmergencyStop(Arc::downgrade(&source.0));
		source.retire();
		source.cancel();
		source.release_control();
		emergency.cancel();
		assert_eq!(source.escape_stops(), 0, "host and monitor-failure stops are not the user's");
		let running = source.token();
		emergency.escape();
		assert_eq!(source.escape_stops(), 1);
		assert!(running.check().is_err(), "the user's Escape cancels running input");
		source.cancel();
		assert_eq!(source.escape_stops(), 1);
	}

	#[test]
	fn escape_stops_outlive_the_session_under_its_key() {
		let key = format!("escape-key-test-{}", std::process::id());
		let first = CancellationSource::counting_escapes(escape_stop_counter(Some(&key)));
		EmergencyStop(Arc::downgrade(&first.0)).escape();
		drop(first);
		assert_eq!(escape_stops(&key), 1, "the host reads a stop after its session is gone");
		let replacement = CancellationSource::counting_escapes(escape_stop_counter(Some(&key)));
		assert_eq!(replacement.escape_stops(), 1, "a replacement session keeps the count");
		let keyless = CancellationSource::counting_escapes(escape_stop_counter(None));
		EmergencyStop(Arc::downgrade(&keyless.0)).escape();
		assert_eq!(escape_stops(&key), 1, "a session without the key counts alone");
		forget_escape_stops(&key);
		assert_eq!(escape_stops(&key), 0);
	}

	#[test]
	fn the_host_interrupt_still_cancels_background_input() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		let token = source.token();
		let lease =
			InputLease::acquire(&token, false).expect("background input needs no Escape stop");
		source.cancel();
		assert!(token.check().is_err(), "the host interrupt still cancels background input");
		drop(lease);
		drop(KernelOwner::acquire().expect("background input releases kernel ownership"));
		remove_test_lock();
	}

	#[test]
	fn a_held_lease_reports_what_its_escape_stop_armed() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		let (active, escape_stop) = source.control_state();
		assert!(active, "the test grant installs a lease");
		assert_eq!(
			escape_stop,
			EscapeStop::Unsupported,
			"the test lease arms no platform monitor, and says so"
		);
		source
			.acquire_control(&source.token())
			.expect("idempotent acquisition");
		assert_eq!(source.control_state(), (true, EscapeStop::Unsupported));
		source.release_control();
		assert_eq!(source.control_state(), (false, EscapeStop::NotRequested));
		drop(source);
		drop(KernelOwner::acquire().expect("released ownership"));
		remove_test_lock();
	}

	#[test]
	fn escape_stop_states_have_stable_labels() {
		assert_eq!(EscapeStop::Armed.as_str(), "armed");
		assert_eq!(EscapeStop::Unavailable.as_str(), "unavailable");
		assert_eq!(EscapeStop::Unsupported.as_str(), "unsupported");
		assert_eq!(EscapeStop::NotRequested.as_str(), "not_requested");
	}

	#[test]
	fn a_wait_between_steps_ends_as_soon_as_the_operation_is_cancelled() {
		let source = CancellationSource::default();
		let token = source.token();
		let _scope = token.enter();
		source.cancel();
		let started = Instant::now();
		assert!(wait(Duration::from_secs(30)).is_err());
		assert!(started.elapsed() < Duration::from_secs(5), "cancel must not wait out the pause");
	}

	#[test]
	fn cleanup_releases_held_input_after_cancellation() {
		let source = CancellationSource::default();
		let token = source.token();
		let _scope = token.enter();
		source.cancel();
		assert!(check().is_err());
		assert!(cleanup(check).is_ok(), "releasing held input must survive cancellation");
		assert!(check().is_err(), "cleanup does not revive the operation");
	}
}
