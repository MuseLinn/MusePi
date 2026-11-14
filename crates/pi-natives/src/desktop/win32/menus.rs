//! Exact-window menus through the window's attached HMENU.
//!
//! This route reads and commands the classic Win32 menu without focusing the
//! window and without keyboard input. Windows that draw their own menus (most
//! modern apps) expose no HMENU; they are reported as unavailable rather than
//! guessed at, because a wrong menu label can invoke a destructive command.

use std::{
	mem::size_of,
	ptr::{null_mut, with_exposed_provenance_mut},
};

use uiautomation::{
	UIAutomation, UIElement, UITreeWalker,
	patterns::{
		UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UITogglePattern,
	},
	types::{ControlType, ExpandCollapseState, Handle, ToggleState},
};
use windows_sys::Win32::{
	Foundation::{CloseHandle, E_POINTER, HANDLE},
	Security::{
		GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
		TOKEN_QUERY, TokenIntegrityLevel,
	},
	System::Threading::{
		GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
	},
	UI::{
		Input::KeyboardAndMouse::IsWindowEnabled,
		WindowsAndMessaging::{
			GA_ROOT, GetAncestor, GetMenu, GetMenuInfo, GetMenuItemCount, GetMenuItemInfoW,
			GetWindowThreadProcessId, HMENU, IsWindow, MENUINFO, MENUITEMINFOW, MFS_CHECKED,
			MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU,
			MIM_STYLE, MNS_NOTIFYBYPOS, SMTO_ABORTIFHUNG, SMTO_BLOCK, SMTO_ERRORONEXIT,
			SendMessageTimeoutW, WM_COMMAND, WM_MENUCOMMAND,
		},
	},
};

use super::super::{
	error::{CoreResult, DesktopError},
	menus::{DesktopMenuItem, match_index, require_command, require_enabled, validate_path},
	types::DesktopWindow,
};

const MAX_ITEMS: usize = 512;
const MAX_LABEL_UNITS: usize = 4096;
const MAX_UIA_NODES: usize = 8192;
const MAX_UIA_DEPTH: usize = 8;
// MSAA state flags, also returned by UIA's LegacyIAccessible pattern.
const STATE_UNAVAILABLE: u32 = 0x1;
const STATE_CHECKED: u32 = 0x10;
const STATE_HASPOPUP: u32 = 0x4000_0000;

fn failed(message: impl Into<String>) -> DesktopError {
	DesktopError::ax_failed(message)
}

fn uia_error(error: impl std::fmt::Display) -> DesktopError {
	failed(format!("UI Automation menu query failed: {error}"))
}

fn unexposed_menu() -> DesktopError {
	DesktopError::background_unavailable(
		"the exact window has no attached native menu; apps that draw their own menus expose menu \
		 items through accessibility (`win.ax()` / `win.find({role:'menuitem'})`) instead",
	)
}

/// Top-level window that owns `hwnd`, or `hwnd` itself when it has none.
fn root(hwnd: windows_sys::Win32::Foundation::HWND) -> windows_sys::Win32::Foundation::HWND {
	// SAFETY: GetAncestor validates the handle and returns null for stale ones.
	let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
	if root.is_null() { hwnd } else { root }
}

struct Target {
	hwnd:   windows_sys::Win32::Foundation::HWND,
	pid:    u32,
	thread: u32,
}

impl Target {
	fn new(window: &DesktopWindow) -> CoreResult<Self> {
		let address = window.id.parse::<usize>().map_err(|_| {
			DesktopError::invalid_target(format!("invalid Win32 window id '{}'", window.id))
		})?;
		let hwnd = with_exposed_provenance_mut(address);
		let pid = window
			.pid
			.filter(|pid| *pid != 0)
			.ok_or_else(|| failed("cannot establish the process owning this menu target"))?;
		// SAFETY: Windows validates the opaque HWND; no pointer is dereferenced.
		let thread = unsafe { GetWindowThreadProcessId(hwnd, null_mut()) };
		let target = Self { hwnd, pid, thread };
		target.check()?;
		Ok(target)
	}

	fn check(&self) -> CoreResult<()> {
		let mut pid = 0;
		// SAFETY: the output process ID is writable and Windows validates HWND.
		let thread = unsafe { GetWindowThreadProcessId(self.hwnd, &mut pid) };
		// SAFETY: IsWindow only inspects the opaque handle.
		let live = unsafe { IsWindow(self.hwnd) } != 0;
		if thread == 0
			|| thread != self.thread
			|| pid != self.pid
			|| !live
			|| root(self.hwnd) != self.hwnd
		{
			return Err(DesktopError::window_not_found("the exact menu target no longer exists"));
		}
		// SAFETY: IsWindowEnabled validates the handle.
		if unsafe { IsWindowEnabled(self.hwnd) } == 0 {
			return Err(failed("the menu target is disabled; target its active dialog instead"));
		}
		Ok(())
	}

	/// Re-checks that the window still has no attached menu, so a menu that
	/// appeared mid-read cannot be commanded through the stale UIA route.
	fn still_unattached(&self) -> CoreResult<()> {
		self.check()?;
		// SAFETY: GetMenu validates the window handle.
		if !unsafe { GetMenu(self.hwnd) }.is_null() {
			return Err(failed("the window gained a native menu; no command was dispatched"));
		}
		Ok(())
	}

	fn attached(&self, menu: HMENU) -> CoreResult<()> {
		self.check()?;
		// SAFETY: GetMenu validates the window handle.
		if unsafe { GetMenu(self.hwnd) } != menu {
			return Err(failed("the target's menu changed; no command was dispatched"));
		}
		Ok(())
	}
}

/// Native labels encode mnemonics with '&', literal ampersands with '&&', and
/// accelerator display text after a tab.
fn native_label(label: &str) -> (String, Option<String>) {
	let (label, shortcut) = label
		.split_once('\t')
		.map_or((label, None), |(label, shortcut)| {
			(label, (!shortcut.trim().is_empty()).then(|| shortcut.trim().to_string()))
		});
	let mut title = String::with_capacity(label.len());
	let mut chars = label.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch != '&' || chars.peek().is_none() {
			title.push(ch);
		} else if chars.peek() == Some(&'&') {
			chars.next();
			title.push('&');
		}
	}
	(title, shortcut)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct NativeEntry {
	menu:     HMENU,
	position: u32,
	id:       u32,
	submenu:  HMENU,
}

struct NativeLevel {
	items:   Vec<DesktopMenuItem>,
	entries: Vec<NativeEntry>,
}

struct NativeNode {
	item:  DesktopMenuItem,
	entry: NativeEntry,
	chain: Vec<NativeEntry>,
}

fn native_level(menu: HMENU, path: &[String]) -> CoreResult<NativeLevel> {
	// SAFETY: GetMenuItemCount validates the menu handle.
	let count = unsafe { GetMenuItemCount(menu) };
	if count < 0 || count as usize > MAX_ITEMS {
		return Err(failed("native menu is unavailable or exceeds the bounded item limit"));
	}
	let mut level = NativeLevel {
		items:   Vec::with_capacity(count as usize),
		entries: Vec::with_capacity(count as usize),
	};
	let mut text = [0u16; MAX_LABEL_UNITS + 1];
	for position in 0..count as u32 {
		// SAFETY: MENUITEMINFOW is a C structure whose zero fields are valid.
		let mut info: MENUITEMINFOW = unsafe { std::mem::zeroed() };
		info.cbSize = size_of::<MENUITEMINFOW>() as u32;
		info.fMask = MIIM_STRING | MIIM_FTYPE | MIIM_STATE | MIIM_SUBMENU | MIIM_ID;
		info.dwTypeData = text.as_mut_ptr();
		info.cch = text.len() as u32;
		// SAFETY: info and its text buffer are writable for the advertised sizes.
		if unsafe { GetMenuItemInfoW(menu, position, 1, &mut info) } == 0 {
			return Err(failed("native menu changed or cannot be read"));
		}
		if info.fType & MFT_SEPARATOR != 0 {
			continue;
		}
		if info.cch as usize >= MAX_LABEL_UNITS {
			return Err(failed("native menu label exceeds the bounded text limit"));
		}
		let (title, shortcut) = native_label(&String::from_utf16_lossy(&text[..info.cch as usize]));
		// Owner-drawn entries without text cannot be selected by label.
		if title.trim().is_empty() {
			continue;
		}
		let mut item_path = path.to_vec();
		item_path.push(title.clone());
		level.items.push(DesktopMenuItem {
			title,
			path: item_path,
			enabled: info.fState & MFS_DISABLED == 0,
			checked: info.fState & MFS_CHECKED != 0,
			has_submenu: !info.hSubMenu.is_null(),
			shortcut,
		});
		level
			.entries
			.push(NativeEntry { menu, position, id: info.wID, submenu: info.hSubMenu });
	}
	// SAFETY: GetMenuItemCount validates the menu handle.
	if unsafe { GetMenuItemCount(menu) } != count {
		return Err(failed("native menu changed while it was being read"));
	}
	Ok(level)
}

fn native_resolve(root_menu: HMENU, path: &[String]) -> CoreResult<NativeNode> {
	let mut menu = root_menu;
	let mut canonical = Vec::new();
	let mut chain = Vec::with_capacity(path.len());
	for (depth, label) in path.iter().enumerate() {
		let mut level = native_level(menu, &canonical)?;
		let index = match_index(&level.items, label)?;
		let item = level.items.swap_remove(index);
		require_enabled(&item)?;
		let entry = level.entries[index];
		chain.push(entry);
		if depth + 1 == path.len() {
			return Ok(NativeNode { item, entry, chain });
		}
		if entry.submenu.is_null() {
			return Err(failed(format!("menu item '{}' has no submenu", item.title)));
		}
		canonical = item.path;
		menu = entry.submenu;
	}
	Err(failed("a menu command path is required"))
}

/// `WM_COMMAND` encodes the command ID in `LOWORD(wParam)`. Menus opting into
/// `MNS_NOTIFYBYPOS` instead require `WM_MENUCOMMAND(position, containing
/// HMENU)`.
fn native_message(id: u32, position: u32, style: u32) -> CoreResult<(u32, usize)> {
	if style & MNS_NOTIFYBYPOS != 0 {
		Ok((WM_MENUCOMMAND, position as usize))
	} else if u16::try_from(id).is_ok() {
		Ok((WM_COMMAND, id as usize))
	} else {
		Err(failed("menu command ID cannot be represented by WM_COMMAND; no command was dispatched"))
	}
}

/// Mandatory integrity-level RID of `process`, or `None` when unreadable.
fn integrity_level(process: HANDLE) -> Option<u32> {
	let mut token: HANDLE = null_mut();
	// SAFETY: `token` is writable; `process` is a live handle owned by the caller.
	if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
		return None;
	}
	// A mandatory label is a TOKEN_MANDATORY_LABEL followed by a one-subauthority
	// SID; the u64 array provides the pointer alignment.
	let mut label = [0u64; 16];
	let mut written = 0;
	// SAFETY: `label` is writable for its full byte length and `token` is live.
	let read = unsafe {
		GetTokenInformation(
			token,
			TokenIntegrityLevel,
			label.as_mut_ptr().cast(),
			size_of_val(&label) as u32,
			&mut written,
		)
	} != 0;
	// SAFETY: `token` was opened above and is closed exactly once.
	unsafe { CloseHandle(token) };
	if !read {
		return None;
	}
	// SAFETY: GetTokenInformation filled `label` with a TOKEN_MANDATORY_LABEL
	// whose SID points into the same still-live buffer.
	let sid = unsafe { (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid };
	// SAFETY: `sid` is a valid SID inside `label`.
	let count = unsafe { GetSidSubAuthorityCount(sid) };
	if count.is_null() {
		return None;
	}
	// SAFETY: a non-null count pointer addresses the SID header inside `label`.
	let count = unsafe { *count };
	let last = u32::from(count.checked_sub(1)?);
	// SAFETY: `last` indexes an existing subauthority of `sid`.
	let rid = unsafe { GetSidSubAuthority(sid, last) };
	// SAFETY: a non-null result addresses the subauthority inside `label`.
	(!rid.is_null()).then(|| unsafe { *rid })
}

const fn integrity_name(rid: u32) -> &'static str {
	match rid {
		0x0000..0x1000 => "untrusted",
		0x1000..0x2000 => "low",
		0x2000..0x3000 => "medium",
		0x3000..0x4000 => "high",
		_ => "system",
	}
}

/// Refuses higher-integrity targets: Windows UIPI discards input sent across
/// that boundary, and a menu command that silently never ran is worse than an
/// explicit refusal.
fn uipi_block(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<String> {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	if pid == 0 {
		return Some("the target's owning process is no longer available".to_string());
	}
	// SAFETY: the pseudo-handle for the current process needs no cleanup.
	let Some(own) = integrity_level(unsafe { GetCurrentProcess() }) else {
		return Some(
			"cannot establish this process's integrity level; no input was sent".to_string(),
		);
	};
	// SAFETY: scalar arguments; a null result is handled below.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if process.is_null() {
		return Some(format!("cannot inspect process {pid}'s integrity level; no input was sent"));
	}
	let target = integrity_level(process);
	// SAFETY: `process` was opened above and is closed exactly once.
	unsafe { CloseHandle(process) };
	let Some(target) = target else {
		return Some(format!("cannot read process {pid}'s integrity token; no input was sent"));
	};
	(target > own).then(|| {
		format!(
			"process {pid} runs at {} integrity, above this process's {} integrity, so Windows UIPI \
			 discards menu commands sent to it; run MusePi at the same integrity level to drive it",
			integrity_name(target),
			integrity_name(own)
		)
	})
}

fn native_select(target: &Target, root_menu: HMENU, path: &[String]) -> CoreResult<()> {
	let original = native_resolve(root_menu, path)?;
	require_command(&original.item)?;
	if let Some(reason) = uipi_block(target.hwnd) {
		return Err(DesktopError::permission_denied(format!(
			"cannot dispatch a native menu command: {reason}"
		)));
	}
	// Re-resolve every label and ancestor immediately before dispatch. This
	// catches changed handles/positions/IDs, disabled ancestors and ambiguity.
	let current = native_resolve(root_menu, path)?;
	require_command(&current.item)?;
	if original.chain != current.chain || original.item.path != current.item.path {
		return Err(failed("native menu changed; no command was dispatched"));
	}
	// SAFETY: MENUINFO is a C structure whose zero fields are valid.
	let mut info: MENUINFO = unsafe { std::mem::zeroed() };
	info.cbSize = size_of::<MENUINFO>() as u32;
	info.fMask = MIM_STYLE;
	// SAFETY: info is writable and Windows validates its containing menu.
	if unsafe { GetMenuInfo(current.entry.menu, &mut info) } == 0 {
		return Err(failed("cannot establish native menu command delivery semantics"));
	}
	let (message, wparam) = native_message(current.entry.id, current.entry.position, info.dwStyle)?;
	let lparam = if message == WM_MENUCOMMAND {
		current.entry.menu.expose_provenance() as isize
	} else {
		0
	};
	target.attached(root_menu)?;
	let mut result = 0;
	// SAFETY: only scalar command data is sent to the exact validated HWND.
	// A finite timeout avoids waiting indefinitely on a hung target or modal
	// command handler. A timeout is NOT evidence that dispatch did not occur.
	if unsafe {
		SendMessageTimeoutW(
			target.hwnd,
			message,
			wparam,
			lparam,
			SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
			1500,
			&mut result,
		)
	} == 0
	{
		return Err(failed(
			"native menu command delivery failed or timed out and may already have taken effect; do \
			 not replay automatically",
		));
	}
	Ok(())
}

pub(crate) fn items(window: &DesktopWindow, path: &[String]) -> CoreResult<Vec<DesktopMenuItem>> {
	validate_path(path, true)?;
	let target = Target::new(window)?;
	// SAFETY: target.check established a live top-level HWND.
	let menu = unsafe { GetMenu(target.hwnd) };
	if menu.is_null() {
		let mut session = UiaMenus::new(&target)?;
		let parent = session.resolve(path)?;
		if let Some(item) = &parent.item {
			require_enabled(item)?;
			if !item.has_submenu {
				return Err(failed("the requested menu path is a leaf command, not a submenu"));
			}
		}
		let level = session.level(&parent.element, &parent.path)?;
		if level.items.is_empty() {
			return Err(unexposed_menu());
		}
		target.check()?;
		return Ok(level.items);
	}
	let level = if path.is_empty() {
		native_level(menu, &[])?
	} else {
		let node = native_resolve(menu, path)?;
		require_enabled(&node.item)?;
		if node.entry.submenu.is_null() {
			return Err(failed("the requested menu path is a leaf command, not a submenu"));
		}
		native_level(node.entry.submenu, &node.item.path)?
	};
	target.attached(menu)?;
	Ok(level.items)
}

pub(crate) fn select(window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	let target = Target::new(window)?;
	// SAFETY: target.check established a live top-level HWND.
	let menu = unsafe { GetMenu(target.hwnd) };
	if menu.is_null() {
		return UiaMenus::new(&target)?.select(path);
	}
	native_select(&target, menu, path)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn decodes_mnemonics_and_accelerators() {
		assert_eq!(native_label("&File"), ("File".to_string(), None));
		assert_eq!(
			native_label("Save && Exit\tCtrl+S"),
			("Save & Exit".to_string(), Some("Ctrl+S".to_string()))
		);
		assert_eq!(native_label("Open...\t"), ("Open...".to_string(), None));
		assert_eq!(native_label("Trailing&"), ("Trailing&".to_string(), None));
	}

	#[test]
	fn command_delivery_follows_the_menu_style() {
		assert_eq!(native_message(7, 3, 0).unwrap(), (WM_COMMAND, 7));
		assert_eq!(native_message(0x1_0000, 3, 0).is_err(), true);
		assert_eq!(native_message(7, 3, MNS_NOTIFYBYPOS).unwrap(), (WM_MENUCOMMAND, 3));
	}
}

struct UiaLevel {
	items:    Vec<DesktopMenuItem>,
	elements: Vec<UIElement>,
}

struct UiaNode {
	element: UIElement,
	item:    Option<DesktopMenuItem>,
	path:    Vec<String>,
}

/// Menu levels read and commanded through UI Automation, for windows that draw
/// their own menus (most modern apps). COM is initialized by
/// `UIAutomation::new` on this thread and released when the session drops.
struct UiaMenus<'a> {
	target:     &'a Target,
	automation: UIAutomation,
	walker:     UITreeWalker,
	remaining:  usize,
}

impl<'a> UiaMenus<'a> {
	fn new(target: &'a Target) -> CoreResult<Self> {
		let automation = UIAutomation::new().map_err(uia_error)?;
		let walker = automation.get_control_view_walker().map_err(uia_error)?;
		Ok(Self { target, automation, walker, remaining: MAX_UIA_NODES })
	}

	/// Refuses an element that the provider places in another window: a menu
	/// command must belong to the exact target, not a sibling or popup host.
	fn owns(&self, element: &UIElement) -> CoreResult<()> {
		self.target.check()?;
		// The traversal starts from the target's own root element, so that is the
		// ownership anchor. A provider that reports a native window handle must
		// still root to the target; Chromium and other HWND-less providers report
		// none, and rejecting those would refuse every menu of a browser window.
		if let Ok(handle) = element.get_native_window_handle() {
			let raw: isize = handle.into();
			if raw != 0 {
				let hwnd: windows_sys::Win32::Foundation::HWND =
					with_exposed_provenance_mut(raw as usize);
				let owned = hwnd == self.target.hwnd || root(hwnd) == self.target.hwnd;
				if !owned {
					return Err(failed("cannot establish exact HWND ownership of the UIA menu element"));
				}
			}
		}
		Ok(())
	}

	fn children(&mut self, element: &UIElement) -> CoreResult<Vec<UIElement>> {
		let mut result = Vec::new();
		let mut next = self.walker.get_first_child(element);
		loop {
			let child = match next {
				Ok(child) => child,
				// UIA represents the end of a walker sequence with a null COM
				// interface. Depending on the crate version that surfaces as a
				// failed HRESULT or as this crate's ERR_NONE (0) with the last OS
				// message; both mean "no more siblings".
				Err(error) if error.code() == E_POINTER || error.code() == 0 => break,
				Err(error) => return Err(uia_error(error)),
			};
			if self.remaining == 0 || result.len() == MAX_ITEMS {
				return Err(failed("UIA menu discovery exceeded its bounded node limit"));
			}
			self.remaining -= 1;
			next = self.walker.get_next_sibling(&child);
			result.push(child);
		}
		Ok(result)
	}

	fn menu_bar(&mut self) -> CoreResult<UIElement> {
		let handle = Handle::from(self.target.hwnd as isize);
		let root_element = self
			.automation
			.element_from_handle(handle)
			.map_err(uia_error)?;
		self.owns(&root_element)?;
		let mut pending = vec![(root_element, 0)];
		let mut found = None;
		while let Some((element, depth)) = pending.pop() {
			for child in self.children(&element)? {
				match child.get_control_type().map_err(uia_error)? {
					ControlType::MenuBar => {
						self.owns(&child)?;
						if found.is_some() {
							return Err(failed(
								"the exact window exposes multiple UIA menu bars; refusing ambiguity",
							));
						}
						found = Some(child);
					},
					ControlType::Pane | ControlType::Group | ControlType::Custom => {
						if depth == MAX_UIA_DEPTH {
							return Err(failed("UIA menu-bar discovery exceeded its bounded depth limit"));
						}
						self.owns(&child)?;
						pending.push((child, depth + 1));
					},
					_ => {},
				}
			}
		}
		found.ok_or_else(unexposed_menu)
	}

	/// Only menu containers and their immediate menu items form a path. In
	/// particular, matching a document button or arbitrary descendant's text
	/// cannot substitute for traversing the menu bar.
	fn menu_children(
		&mut self,
		parent: &UIElement,
		depth: usize,
		output: &mut Vec<UIElement>,
	) -> CoreResult<()> {
		if depth > MAX_UIA_DEPTH {
			return Err(failed("UIA submenu nesting exceeds its bounded depth limit"));
		}
		self.owns(parent)?;
		for child in self.children(parent)? {
			match child.get_control_type().map_err(uia_error)? {
				ControlType::MenuItem => {
					self.owns(&child)?;
					if output.len() == MAX_ITEMS {
						return Err(failed("UIA menu exceeds its bounded item limit"));
					}
					output.push(child);
				},
				ControlType::Menu => self.menu_children(&child, depth + 1, output)?,
				_ => {},
			}
		}
		Ok(())
	}

	fn describe(&mut self, element: &UIElement, path: &[String]) -> CoreResult<DesktopMenuItem> {
		self.owns(element)?;
		let title = element.get_name().map_err(uia_error)?;
		if title.len() > MAX_LABEL_UNITS * 4 {
			return Err(failed("UIA menu label exceeds the bounded text limit"));
		}
		let legacy = element.get_pattern::<UILegacyIAccessiblePattern>().ok();
		let state = legacy
			.as_ref()
			.map(|pattern| pattern.get_state().map_err(uia_error))
			.transpose()?
			.unwrap_or(0);
		let expandable = element
			.get_pattern::<UIExpandCollapsePattern>()
			.ok()
			.map(|pattern| pattern.get_state().map_err(uia_error))
			.transpose()?
			.is_some_and(|state| state != ExpandCollapseState::LeafNode);
		let checked = if let Ok(pattern) = element.get_pattern::<UITogglePattern>() {
			pattern.get_toggle_state().map_err(uia_error)? == ToggleState::On
		} else {
			state & STATE_CHECKED != 0
		};
		let mut has_submenu = expandable || state & STATE_HASPOPUP != 0;
		if !has_submenu {
			for child in self.children(element)? {
				if matches!(
					child.get_control_type().map_err(uia_error)?,
					ControlType::Menu | ControlType::MenuItem
				) {
					has_submenu = true;
					break;
				}
			}
		}
		let shortcut = element.get_accelerator_key().map_err(uia_error)?;
		let mut item_path = path.to_vec();
		item_path.push(title.clone());
		Ok(DesktopMenuItem {
			title,
			path: item_path,
			enabled: element.is_enabled().map_err(uia_error)? && state & STATE_UNAVAILABLE == 0,
			checked,
			has_submenu,
			shortcut: (!shortcut.trim().is_empty()).then_some(shortcut),
		})
	}

	fn level(&mut self, parent: &UIElement, path: &[String]) -> CoreResult<UiaLevel> {
		let mut elements = Vec::new();
		self.menu_children(parent, 0, &mut elements)?;
		let mut items = Vec::with_capacity(elements.len());
		for element in &elements {
			items.push(self.describe(element, path)?);
		}
		Ok(UiaLevel { items, elements })
	}

	fn resolve(&mut self, path: &[String]) -> CoreResult<UiaNode> {
		let mut node = UiaNode { element: self.menu_bar()?, item: None, path: Vec::new() };
		for (depth, label) in path.iter().enumerate() {
			let mut level = self.level(&node.element, &node.path)?;
			if level.items.is_empty() {
				return Err(unexposed_menu());
			}
			let index = match_index(&level.items, label)?;
			let item = level.items.swap_remove(index);
			require_enabled(&item)?;
			if depth + 1 < path.len() && !item.has_submenu {
				return Err(failed(format!("menu item '{}' has no submenu", item.title)));
			}
			node = UiaNode {
				element: level.elements.swap_remove(index),
				path:    item.path.clone(),
				item:    Some(item),
			};
		}
		Ok(node)
	}

	fn select(&mut self, path: &[String]) -> CoreResult<()> {
		let original = self.resolve(path)?;
		let original_item = original
			.item
			.as_ref()
			.ok_or_else(|| failed("a menu command path is required"))?;
		require_command(original_item)?;
		let current = self.resolve(path)?;
		let item = current
			.item
			.as_ref()
			.ok_or_else(|| failed("a menu command path is required"))?;
		require_command(item)?;
		if original.path != current.path
			|| !self
				.automation
				.compare_elements(&original.element, &current.element)
				.map_err(uia_error)?
		{
			return Err(failed("UIA menu changed; no command was dispatched"));
		}
		let command = if let Ok(pattern) = current.element.get_pattern::<UIInvokePattern>() {
			UiaCommand::Invoke(pattern)
		} else if let Ok(pattern) = current.element.get_pattern::<UILegacyIAccessiblePattern>() {
			if pattern
				.get_default_action()
				.map_err(uia_error)?
				.trim()
				.is_empty()
			{
				return Err(failed("UIA menu command has no invokable default action"));
			}
			UiaCommand::Legacy(pattern)
		} else if let Ok(pattern) = current.element.get_pattern::<UITogglePattern>() {
			UiaCommand::Toggle(pattern)
		} else {
			return Err(failed("UIA menu command has no supported command pattern"));
		};
		// Repeat ownership, menu attachment, leaf and enabled checks after
		// querying patterns. Never use SelectionItem: it may only highlight.
		let fresh = self.describe(&current.element, &current.path[..current.path.len() - 1])?;
		require_command(&fresh)?;
		if fresh.path != current.path {
			return Err(failed("UIA menu command changed; no command was dispatched"));
		}
		self.owns(&current.element)?;
		self.target.still_unattached()?;
		if let Some(reason) = uipi_block(self.target.hwnd) {
			return Err(DesktopError::permission_denied(format!(
				"cannot invoke a UIA menu command: {reason}"
			)));
		}
		command.run().map_err(|error| {
			failed(format!(
				"UIA menu command failed and may already have taken effect; do not replay \
				 automatically: {error}"
			))
		})
	}
}

enum UiaCommand {
	Invoke(UIInvokePattern),
	Legacy(UILegacyIAccessiblePattern),
	Toggle(UITogglePattern),
}

impl UiaCommand {
	fn run(self) -> Result<(), uiautomation::Error> {
		match self {
			Self::Invoke(pattern) => pattern.invoke(),
			Self::Legacy(pattern) => pattern.do_default_action(),
			Self::Toggle(pattern) => pattern.toggle(),
		}
	}
}
