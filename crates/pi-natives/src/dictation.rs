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
	pub fn parse(accelerator: &str) -> Result<Self, String> {
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

	pub fn key(&self) -> u32 {
		self.key
	}

	pub fn modifiers(&self) -> &[u32] {
		&self.modifiers
	}
}

fn parse_key(token: &str) -> Result<u32, String> {
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
	pub fn new(chord: HoldChord) -> Self {
		Self { chord, active: false }
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
