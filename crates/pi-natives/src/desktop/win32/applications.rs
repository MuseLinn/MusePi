//! Installed Windows applications.
//!
//! The catalogue is the Start Menu (per-user and machine-wide shortcuts): it
//! is what a user sees in the Apps list, it needs no COM registration, and a
//! shortcut launched through `ShellExecuteEx` keeps the shortcut's own
//! arguments and working directory. Running state is observed from the process
//! list by executable stem, which is attribution rather than a guarantee: a
//! shortcut can point at an executable whose name differs from its own.

use std::{
	collections::HashMap,
	ffi::c_void,
	fs,
	os::windows::ffi::{OsStrExt, OsStringExt},
	path::{Path, PathBuf},
	ptr::null_mut,
};

use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE},
	System::{
		Com::CoTaskMemFree,
		Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
			TH32CS_SNAPPROCESS,
		},
		Threading::GetProcessId,
	},
	UI::{
		Shell::{
			FOLDERID_CommonPrograms, FOLDERID_Programs, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS,
			SHELLEXECUTEINFOW, SHGetKnownFolderPath, ShellExecuteExW,
		},
		WindowsAndMessaging::{SW_SHOWNOACTIVATE, SW_SHOWNORMAL},
	},
};

use super::{Application, ApplicationOpenOptions, ApplicationQuery};
use crate::desktop::error::{CoreResult, DesktopError};

const MAX_DEPTH: usize = 3;

/// Known folder path, or `None` when the folder does not exist on this system.
fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
	let mut raw: *mut u16 = null_mut();
	// SAFETY: the id is a static known-folder GUID and `raw` is an out-parameter
	// owned by the shell allocator, freed below with CoTaskMemFree.
	let result = unsafe { SHGetKnownFolderPath(id, 0, null_mut(), &mut raw) };
	if result < 0 || raw.is_null() {
		return None;
	}
	// SAFETY: the shell returned a NUL-terminated UTF-16 string; its length is
	// read up to that terminator before the allocation is freed.
	let length = unsafe {
		let mut length = 0usize;
		while *raw.add(length) != 0 {
			length += 1;
		}
		length
	};
	// SAFETY: `raw` points to `length` initialized UTF-16 units; `from_wide`
	// copies them before the allocation is freed.
	let path = unsafe { std::ffi::OsString::from_wide(std::slice::from_raw_parts(raw, length)) };
	// SAFETY: `raw` came from SHGetKnownFolderPath and is freed exactly once.
	unsafe { CoTaskMemFree(raw as *const c_void) };
	let path = PathBuf::from(path);
	path.is_dir().then_some(path)
}

/// Normalized comparison key: case and separators do not distinguish names.
fn normalize(value: &str) -> String {
	value
		.chars()
		.filter(|c| c.is_alphanumeric())
		.flat_map(char::to_lowercase)
		.collect()
}

fn collect_shortcuts(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
	if depth > MAX_DEPTH {
		return;
	}
	let Ok(entries) = fs::read_dir(root) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		match entry.file_type() {
			Ok(kind) if kind.is_dir() => collect_shortcuts(&path, depth + 1, out),
			Ok(kind)
				if kind.is_file()
					&& path
						.extension()
						.is_some_and(|extension| extension.eq_ignore_ascii_case("lnk")) =>
			{
				out.push(path);
			},
			_ => {},
		}
	}
}

/// Running process executable stems → the first pid seen, so an app that is
/// already up is reported instead of launched twice.
fn running_processes() -> HashMap<String, Option<u32>> {
	let mut running = HashMap::new();
	// SAFETY: the snapshot handle is owned here and closed below; the entry is
	// a plain out-parameter with its size initialized as the API requires.
	unsafe {
		let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE || snapshot.is_null() {
			return running;
		}
		let mut entry: PROCESSENTRY32W = std::mem::zeroed();
		entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
		let mut more = Process32FirstW(snapshot, &mut entry) != 0;
		while more {
			let end = entry
				.szExeFile
				.iter()
				.position(|unit| *unit == 0)
				.unwrap_or(entry.szExeFile.len());
			let exe = String::from_utf16_lossy(&entry.szExeFile[..end]);
			let stem = exe
				.strip_suffix(".exe")
				.or_else(|| exe.strip_suffix(".EXE"))
				.unwrap_or(&exe);
			let key = normalize(stem);
			if !key.is_empty() && !running.contains_key(&key) {
				running.insert(key, Some(entry.th32ProcessID));
			}
			more = Process32NextW(snapshot, &mut entry) != 0;
		}
		CloseHandle(snapshot);
	}
	running
}

fn catalogue() -> Vec<Application> {
	let mut shortcuts = Vec::new();
	for id in [&FOLDERID_Programs, &FOLDERID_CommonPrograms] {
		if let Some(root) = known_folder(id) {
			collect_shortcuts(&root, 0, &mut shortcuts);
		}
	}
	let running = running_processes();
	let mut apps: Vec<Application> = shortcuts
		.into_iter()
		.map(|path| {
			let name = path
				.file_stem()
				.map_or_else(|| "Application".to_string(), |stem| stem.to_string_lossy().into_owned());
			let key = normalize(&name);
			let pid = running.get(&key).copied().flatten();
			Application {
				id: path.to_string_lossy().into_owned(),
				name,
				path: path.to_string_lossy().into_owned(),
				running: pid.is_some(),
				pid,
			}
		})
		.collect();
	apps.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
	apps
}

pub fn list(options: ApplicationQuery) -> Vec<Application> {
	let mut apps = catalogue();
	if options.running_only.unwrap_or(false) {
		apps.retain(|app| app.running);
	}
	if let Some(query) = options
		.query
		.map(|query| query.trim().to_lowercase())
		.filter(|q| !q.is_empty())
	{
		apps.retain(|app| {
			app.name.to_lowercase().contains(&query) || app.id.to_lowercase().contains(&query)
		});
	}
	apps
}

/// Exact path first, then a unique name. Ambiguity lists candidates instead of
/// launching an arbitrary app.
fn resolve<'a>(apps: &'a [Application], target: &str) -> CoreResult<&'a Application> {
	if let Some(exact) = apps
		.iter()
		.find(|app| app.id == target || app.path == target)
	{
		return Ok(exact);
	}
	let folded = target.to_lowercase();
	let matches: Vec<&Application> = apps
		.iter()
		.filter(|app| app.name.to_lowercase() == folded)
		.collect();
	match matches.len() {
		1 => Ok(matches[0]),
		0 => {
			let prefix: Vec<&str> = apps
				.iter()
				.filter(|app| app.name.to_lowercase().starts_with(&folded))
				.take(8)
				.map(|app| app.name.as_str())
				.collect();
			let hint = if prefix.is_empty() {
				String::new()
			} else {
				format!("; candidates: {}", prefix.join(", "))
			};
			Err(DesktopError::invalid_target(format!("no installed app matches {target:?}{hint}")))
		},
		_ => Err(DesktopError::invalid_target(format!(
			"application {target:?} is ambiguous; use its exact path:\n{}",
			matches
				.iter()
				.map(|app| format!("{} — {}", app.name, app.id))
				.collect::<Vec<_>>()
				.join("\n")
		))),
	}
}

/// `ShellExecute`'s show state is advisory: the application may activate
/// itself even under `SW_SHOWNOACTIVATE`.
fn launch(path: &Path, activate: bool) -> CoreResult<Option<u32>> {
	let file: Vec<u16> = path
		.as_os_str()
		.encode_wide()
		.chain(std::iter::once(0))
		.collect();
	let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
	// SAFETY: a zeroed `SHELLEXECUTEINFOW` is the documented starting state;
	// `cbSize` is set immediately below and the pointer fields stay null until
	// they are assigned.
	let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
	info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
	info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
	info.lpVerb = verb.as_ptr();
	info.lpFile = file.as_ptr();
	info.nShow = if activate {
		SW_SHOWNORMAL
	} else {
		SW_SHOWNOACTIVATE
	};
	// SAFETY: every pointer in `info` refers to a live buffer owned above.
	// SAFETY: `info` is fully initialized and its pointers refer to live
	// buffers owned above.
	let launched = unsafe { ShellExecuteExW(&mut info) };
	if launched == 0 {
		return Err(DesktopError::input_failed(format!(
			"ShellExecuteEx could not open {}",
			path.display()
		)));
	}
	let process: HANDLE = info.hProcess;
	if process.is_null() {
		return Ok(None);
	}
	// SAFETY: the handle was returned by ShellExecuteEx and is closed exactly
	// once; the pid is read before the close.
	let pid = unsafe { GetProcessId(process) };
	// SAFETY: `process` is the handle ShellExecuteEx returned and nothing else
	// owns it, so it is closed exactly once here.
	unsafe { CloseHandle(process) };
	Ok((pid != 0).then_some(pid))
}

pub fn open(target: &str, options: ApplicationOpenOptions) -> CoreResult<Application> {
	let apps = catalogue();
	let app = resolve(&apps, target)?;
	let pid = launch(Path::new(&app.path), options.activate.unwrap_or(false))?.or(app.pid);
	Ok(Application { running: true, pid, ..app.clone() })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn app(name: &str, id: &str) -> Application {
		Application {
			id:      id.to_string(),
			name:    name.to_string(),
			path:    id.to_string(),
			running: false,
			pid:     None,
		}
	}

	#[test]
	fn normalizes_case_and_separators() {
		assert_eq!(normalize("Visual Studio Code"), "visualstudiocode");
		assert_eq!(normalize("7-Zip File Manager"), "7zipfilemanager");
		assert_eq!(normalize("NOTION"), "notion");
	}

	#[test]
	fn resolves_an_exact_path_before_a_name() {
		let apps = [app("Notion", r"C:\Apps\Notion.lnk")];
		let resolved = resolve(&apps, r"C:\Apps\Notion.lnk").expect("exact path resolves");
		assert_eq!(resolved.name, "Notion");
	}

	#[test]
	fn resolves_a_unique_name_case_insensitively() {
		let apps = [app("Notion", r"C:\a\Notion.lnk"), app("Slack", r"C:\a\Slack.lnk")];
		assert_eq!(resolve(&apps, "notion").expect("unique name").name, "Notion");
	}

	#[test]
	fn refuses_an_ambiguous_name_and_reports_prefixes() {
		let apps = [app("Terminal", r"C:\a\Terminal.lnk"), app("Terminal", r"C:\b\Terminal.lnk")];
		let ambiguous = resolve(&apps, "Terminal").expect_err("ambiguous");
		assert!(ambiguous.to_string().contains("ambiguous"));

		let missing = resolve(&apps, "Term").expect_err("no exact match");
		assert!(missing.to_string().contains("candidates: Terminal"));
	}
}
