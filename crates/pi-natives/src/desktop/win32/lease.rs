//! Cross-process real-input lease backed by a named Windows mutex.
//!
//! The guard is held by `Win32Backend` from the first lease-requiring input
//! until the session closes; dropping it releases the mutex. A second session
//! — same or different process — that acquires while it is held receives
//! `InputBusy` instead of fighting over the shared system cursor. Window-
//! message delivery never acquires: it touches neither the shared cursor nor
//! the system input queue.

use std::os::windows::io::{FromRawHandle, OwnedHandle};

use windows_sys::Win32::{
	Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError},
	System::Threading::CreateMutexW,
};

use super::super::error::{CoreResult, DesktopError};

/// Session-local mutex names; `Local\` keeps them inside this logon session.
/// The second name is the pre-rename lease, held too so an older build of the
/// app cannot drive real input at the same time as this one.
const LEASE_NAMES: [&str; 2] = ["Local\\musepi-cu-input", "Local\\musepi-omp-cu-input"];

/// RAII guard for the real-input lease; dropping releases the mutex.
#[derive(Debug)]
pub(crate) struct Win32Lease {
	#[allow(dead_code, reason = "handles held purely for RAII release on drop")]
	handles: Vec<OwnedHandle>,
}

/// Create one named mutex; `None` means another holder exists.
fn create(name: &str) -> CoreResult<Option<OwnedHandle>> {
	let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
	// SAFETY: the name is null-terminated UTF-16; a zero return means creation
	// failed and carries no handle.
	let handle = unsafe { CreateMutexW(std::ptr::null(), 1, wide.as_ptr()) };
	if handle.is_null() {
		return Err(DesktopError::input_failed("failed to create the real-input lease mutex"));
	}
	// SAFETY: GetLastError is stateless and is read immediately after the call.
	if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
		// SAFETY: we own this handle; closing our reference does not disturb
		// the current owner's hold.
		unsafe { CloseHandle(handle) };
		return Ok(None);
	}
	// SAFETY: handle is non-null and owned by us.
	Ok(Some(unsafe { OwnedHandle::from_raw_handle(handle) }))
}

pub(crate) fn acquire() -> CoreResult<Win32Lease> {
	let mut handles = Vec::with_capacity(LEASE_NAMES.len());
	for name in LEASE_NAMES {
		match create(name)? {
			Some(handle) => handles.push(handle),
			None => {
				// Dropping the handles acquired so far releases them.
				return Err(DesktopError::input_busy(
					"real input is owned by another desktop session; retry after its turn ends",
				));
			},
		}
	}
	Ok(Win32Lease { handles })
}

#[cfg(test)]
mod tests {
	use super::{super::super::error::ErrorCode, *};

	#[test]
	fn second_acquire_reports_busy_until_release() {
		let first = acquire().expect("first lease acquire succeeds");
		let busy = acquire().expect_err("second acquire while held must fail");
		assert_eq!(busy.code, ErrorCode::InputBusy);
		drop(first);
		acquire().expect("acquire succeeds after release");
	}
}
