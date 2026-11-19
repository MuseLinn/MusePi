//! Installed application discovery and launching.
//!
//! Windows answers from the Start Menu catalogue and Linux from the XDG
//! desktop entries; both read the running state from the process list. macOS
//! reports `ApplicationsUnsupported`, and so does any other platform; the
//! coding agent keeps its own catalogue there so a desktop session is never
//! required just to launch an app.

use napi_derive::napi;

use super::error::CoreResult;
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
use super::error::DesktopError;

/// One launch target the platform advertises.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct Application {
	/// Absolute path (shortcut, bundle or desktop entry).
	pub id:      String,
	/// Human-facing name.
	pub name:    String,
	/// Same value as `id`, kept so callers can treat identity and location
	/// uniformly with windows.
	pub path:    String,
	/// A window of this application exists right now.
	pub running: bool,
	/// Owning process of that window, when the platform exposes it.
	pub pid:     Option<u32>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ApplicationQuery {
	pub query:        Option<String>,
	pub running_only: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ApplicationOpenOptions {
	/// Bring the application forward. Defaults to false: the app opens behind
	/// whatever the user is doing.
	pub activate: Option<bool>,
}

#[cfg(target_os = "windows")]
#[path = "win32/applications.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux/applications.rs"]
mod platform;

// Windows answers from the Start Menu and cannot fail; Linux reads the
// installed desktop entries, which can. Other platforms return an explicit
// unsupported error, so callers keep one return shape.
#[cfg(target_os = "windows")]
#[allow(
	clippy::unnecessary_wraps,
	reason = "the unsupported variant returns an error; callers keep one shape"
)]
pub fn list(options: ApplicationQuery) -> CoreResult<Vec<Application>> {
	Ok(platform::list(options))
}

#[cfg(target_os = "linux")]
pub fn list(options: ApplicationQuery) -> CoreResult<Vec<Application>> {
	platform::list(options)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn list(_options: ApplicationQuery) -> CoreResult<Vec<Application>> {
	Err(DesktopError::invalid_target(
		"installed application discovery is unsupported on this platform",
	))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn open(target: &str, options: ApplicationOpenOptions) -> CoreResult<Application> {
	platform::open(target, options)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn open(_target: &str, _options: ApplicationOpenOptions) -> CoreResult<Application> {
	Err(DesktopError::invalid_target(
		"installed application launching is unsupported on this platform",
	))
}
