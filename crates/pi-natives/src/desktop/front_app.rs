#![allow(clippy::redundant_pub_crate, reason = "crate-visible helpers inside a private desktop module")]
//! The app in front of the user, read before `MusePi`'s own input reaches a
//! background target, so it can be put back if that input brings another app
//! forward.
//!
//! Reading costs one `WindowServer` query and changes nothing. Putting the app
//! back is a decision per poll: any sign that the user is picking an app
//! themselves ends the hold, so a hand-back never fights the user for the
//! front.
//!
//! This module exports the API only: nothing in this build reads the front app
//! before a background click or holds it afterwards. Wiring it into the click
//! path needs macOS runtime evidence — whether the tap can be created, whether
//! `SLSEventPostToPid` round-trips the event tag, and whether
//! `CGEventSourceCounterForEventType` counts posted clicks — before code that
//! moves the user's focus starts running.

use std::time::{Duration, Instant};

use napi_derive::napi;

use crate::task;

/// How long after a read the evidence behind a hand-back still holds. A pick
/// the user made in the gap between the read and the call would have gone
/// unseen, so a later call holds nothing.
const PICK_WATCH: Duration = Duration::from_secs(1);

/// How often the hold checks the front app. A keystroke typed between an
/// activation and the next check goes to the activated app.
const HOLD_POLL: Duration = Duration::from_millis(2);

/// What one poll sees: who is in front, and whether the user is doing
/// something that may pick an app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FrontReading {
	/// The read app is in front itself.
	pub user_in_front: bool,
	/// Identity of the app in front, when another one took it.
	pub taker:         Option<u64>,
	/// A hardware mouse button went down or up since the read.
	pub clicked:       bool,
	/// Command or Control is held: a shortcut may pick an app or a Space.
	pub chord:         bool,
	/// Option is held: a launcher may be opening.
	pub option:        bool,
	/// A process other than the front app holds the keyboard, such as a
	/// launcher's or Spotlight's panel.
	pub panel:         bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HoldStep {
	/// Nothing to do; poll again.
	Wait,
	/// Put the read app back in front, without raising its windows.
	HandBack,
	/// The user is choosing; the hold ends.
	Stop,
}

/// The hand-back rule, one reading at a time.
///
/// A click, a Command/Control chord, a held Option or a panel owning the
/// keyboard is the user picking an app, and ends the hold. Only the first app
/// to take the front is sent back, and again each time it takes the front
/// itself: browsers re-front to show a popup window. A different app coming
/// forward is the user's choice.
#[derive(Default)]
pub(crate) struct FrontHold {
	taker: Option<u64>,
}

impl FrontHold {
	pub(crate) const fn step(&mut self, reading: FrontReading) -> HoldStep {
		if reading.clicked || reading.chord || reading.option || reading.panel {
			return HoldStep::Stop;
		}
		if reading.user_in_front {
			return HoldStep::Wait;
		}
		let Some(taker) = reading.taker else {
			return HoldStep::Wait;
		};
		match self.taker {
			Some(first) if first != taker => HoldStep::Stop,
			_ => {
				self.taker = Some(taker);
				HoldStep::HandBack
			},
		}
	}
}

/// Whether a read at `read_at` may still be acted on at `now`.
pub(crate) fn watch_intact(read_at: Instant, now: Instant) -> bool {
	now.saturating_duration_since(read_at) <= PICK_WATCH
}

/// How long each hand-back check waits; a hold ends early on a stop.
pub(crate) const fn poll_interval() -> Duration {
	HOLD_POLL
}

/// The app the user had in front when `macOSFrontApp()` read it.
#[napi(js_name = "MacOSFrontApp")]
pub struct MacosFrontApp {
	#[cfg(target_os = "macos")]
	app: super::macos::FrontApp,
}
#[napi]
impl MacosFrontApp {
	/// Puts this app back in front, without raising its windows, each time the
	/// app that took the front from it takes it again during the next
	/// `durationMs`. Ends early once the user clicks, holds ⌘/⌃, holds ⌥ or
	/// brings a different app forward: that is the user picking an app.
	/// Typing does not end it. Holds nothing when called over a second after
	/// the read, or when the app is no longer in front when the call starts.
	/// Owns desktop input/focus control only for each hand-back, and rejects if
	/// another operation owns it then. Resolves how many times it put the app
	/// back.
	///
	/// Nothing in this build calls it yet: the click path exports the API but
	/// does not read the front app before a background click or hold it
	/// afterwards.
	#[napi]
	#[cfg_attr(
		not(target_os = "macos"),
		allow(clippy::unused_self, reason = "only macOS holds an app to put back")
	)]
	pub fn keep_in_front(&self, duration_ms: u32) -> task::Promise<u32> {
		#[cfg(target_os = "macos")]
		{
			let app = self.app;
			// From the call, not from when the worker pool gets to it.
			let deadline =
				std::time::Instant::now() + std::time::Duration::from_millis(duration_ms.into());
			task::blocking("desktop.keepInFront", (), move |_| {
				app.keep_in_front(deadline).map_err(Into::into)
			})
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = duration_ms;
			task::blocking("desktop.keepInFront", (), |_| Ok(0))
		}
	}
}

/// The app macOS `WindowServer` has in front. `null` off macOS and when the
/// front-process SPI is unavailable.
#[napi(js_name = "macOSFrontApp")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::missing_const_for_fn, reason = "only macOS reads the front app")
)]
pub fn macos_front_app() -> Option<MacosFrontApp> {
	#[cfg(target_os = "macos")]
	{
		super::macos::front_app().map(|app| MacosFrontApp { app })
	}
	#[cfg(not(target_os = "macos"))]
	{
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn reading(user_in_front: bool, taker: Option<u64>) -> FrontReading {
		FrontReading {
			user_in_front,
			taker,
			clicked: false,
			chord: false,
			option: false,
			panel: false,
		}
	}

	#[test]
	fn the_first_app_to_take_the_front_is_put_back_each_time_it_returns() {
		let mut hold = FrontHold::default();
		assert_eq!(hold.step(reading(true, None)), HoldStep::Wait);
		assert_eq!(hold.step(reading(false, Some(7))), HoldStep::HandBack);
		assert_eq!(hold.step(reading(true, None)), HoldStep::Wait);
		assert_eq!(
			hold.step(reading(false, Some(7))),
			HoldStep::HandBack,
			"a browser that re-fronts itself to show a popup is put back again"
		);
	}

	#[test]
	fn another_app_coming_forward_is_the_users_choice() {
		let mut hold = FrontHold::default();
		assert_eq!(hold.step(reading(false, Some(7))), HoldStep::HandBack);
		assert_eq!(hold.step(reading(false, Some(9))), HoldStep::Stop);
	}

	#[test]
	fn clicks_chords_options_and_panels_all_end_the_hold() {
		for change in [
			|reading: &mut FrontReading| reading.clicked = true,
			|reading: &mut FrontReading| reading.chord = true,
			|reading: &mut FrontReading| reading.option = true,
			|reading: &mut FrontReading| reading.panel = true,
		] {
			let mut hold = FrontHold::default();
			let mut next = reading(false, Some(7));
			change(&mut next);
			assert_eq!(hold.step(next), HoldStep::Stop);
		}
	}

	#[test]
	fn a_reading_without_a_taker_or_the_users_app_waits() {
		let mut hold = FrontHold::default();
		assert_eq!(hold.step(reading(true, None)), HoldStep::Wait);
		assert_eq!(hold.step(reading(false, None)), HoldStep::Wait);
	}

	#[test]
	fn a_read_over_a_second_old_holds_nothing() {
		let read_at = Instant::now();
		assert!(watch_intact(read_at, read_at));
		assert!(watch_intact(read_at, read_at + PICK_WATCH));
		assert!(!watch_intact(read_at, read_at + PICK_WATCH + Duration::from_millis(1)));
		assert!(poll_interval() <= PICK_WATCH);
	}
}
