//! Cross-session real-input ownership rules.
//!
//! This module is deliberately platform-free so the lease matrix is exercised
//! by the host test suite on every platform. The OS-backed guard lives in the
//! platform backend (`win32/lease.rs`); this file only decides *when* a lease
//! is required: any path that moves the shared system cursor or injects into
//! the system input queue. Window-message delivery (`Background` on a window
//! target) touches neither and bypasses the lease.

use super::{backend::DeliveryMode, types::Target};

/// Reports whether an input request needs the cross-session real-input lease.
pub(crate) const fn needs_lease(target: &Target, mode: DeliveryMode) -> bool {
	match mode {
		DeliveryMode::Foreground => true,
		// `Background` on the desktop target still goes through global input.
		DeliveryMode::Background => matches!(target, Target::Desktop),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

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
}
