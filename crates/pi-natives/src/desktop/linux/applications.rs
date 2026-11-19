//! XDG application inventory and direct desktop-entry launching.
//!
//! Discovery reads the desktop entries the XDG data directories install and
//! needs no display server, capture or input permission. Running state comes
//! from exact `/proc` executable matches, so wrappers, sandbox brokers and
//! inaccessible processes can hide it.
//!
//! This port launches through the entry's `Exec` command only. D-Bus activation
//! (`DBusActivatable=true`) and compositor-side activation of an already
//! running app are not wired here, so `activate` cannot raise a window that is
//! already open; it only keeps a new launch from asking for the foreground.

use std::{
	collections::{HashMap, HashSet},
	env, fs,
	os::unix::fs::PermissionsExt,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use super::super::{
	Application, ApplicationOpenOptions, ApplicationQuery,
	error::{CoreResult, DesktopError},
};

struct Entry {
	id:                String,
	path:              PathBuf,
	name:              String,
	icon:              Option<String>,
	exec:              Option<String>,
	working_directory: Option<PathBuf>,
	terminal:          bool,
}

fn invalid(message: impl Into<String>) -> DesktopError {
	DesktopError::invalid_target(message)
}

fn data_roots() -> Vec<PathBuf> {
	let mut roots = Vec::new();
	if let Some(home) = env::var_os("XDG_DATA_HOME")
		.filter(|value| !value.is_empty())
		.map(PathBuf::from)
		.filter(|path| path.is_absolute())
		.or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
		&& home.is_absolute()
	{
		roots.push(home.join("applications"));
	}
	let directories = env::var_os("XDG_DATA_DIRS")
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "/usr/local/share:/usr/share".into());
	roots.extend(
		env::split_paths(&directories)
			.filter(|path| path.is_absolute())
			.map(|path| path.join("applications")),
	);
	roots
}

fn desktop_files(directory: &Path, files: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(directory) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let Ok(kind) = entry.file_type() else {
			continue;
		};
		// Do not follow directory symlinks: they can form cycles. File symlinks
		// are ordinary desktop entries, and retain their installed desktop ID.
		if kind.is_dir() {
			desktop_files(&path, files);
		} else if path
			.extension()
			.is_some_and(|extension| extension == "desktop")
			&& path.is_file()
		{
			files.push(path);
		}
	}
}

fn desktop_id(root: &Path, path: &Path) -> String {
	path
		.strip_prefix(root)
		.unwrap_or(path)
		.to_string_lossy()
		.replace('/', "-")
}

/// The locale tags to look for a localized `Name`, most specific first.
fn locale_names() -> Vec<String> {
	let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
		.into_iter()
		.find_map(|key| env::var(key).ok().filter(|value| !value.is_empty()))
		.unwrap_or_default();
	let (base, modifier) = locale
		.split_once('@')
		.map_or((locale.as_str(), None), |(base, modifier)| (base, Some(modifier)));
	let base = base.split('.').next().unwrap_or(base);
	if base.is_empty() || base == "C" || base == "POSIX" {
		return Vec::new();
	}
	let language = base.split('_').next().unwrap_or(base);
	let mut names = Vec::new();
	if let Some(modifier) = modifier {
		names.push(format!("{base}@{modifier}"));
	}
	names.push(base.to_owned());
	if language != base {
		if let Some(modifier) = modifier {
			names.push(format!("{language}@{modifier}"));
		}
		names.push(language.to_owned());
	}
	names
}

fn unescape(value: &str) -> CoreResult<String> {
	let mut output = String::with_capacity(value.len());
	let mut chars = value.chars();
	while let Some(character) = chars.next() {
		if character != '\\' {
			output.push(character);
			continue;
		}
		output.push(match chars.next() {
			Some('s') => ' ',
			Some('n') => '\n',
			Some('t') => '\t',
			Some('r') => '\r',
			Some('\\') => '\\',
			_ => return Err(invalid("invalid desktop-entry escape sequence")),
		});
	}
	Ok(output)
}

fn boolean(values: &HashMap<String, String>, key: &str) -> CoreResult<bool> {
	match values.get(key).map(String::as_str) {
		None | Some("false") => Ok(false),
		Some("true") => Ok(true),
		Some(_) => Err(invalid(format!("desktop-entry {key} must be true or false"))),
	}
}

fn read_entry(path: &Path, id: String) -> CoreResult<Entry> {
	if !path.is_absolute()
		|| path
			.extension()
			.is_none_or(|extension| extension != "desktop")
		|| !path.is_file()
	{
		return Err(invalid("Linux application paths must be absolute .desktop files"));
	}
	let text = fs::read_to_string(path)
		.map_err(|error| invalid(format!("cannot read {}: {error}", path.display())))?;
	let mut values = HashMap::new();
	let mut in_entry = false;
	let mut found_entry = false;
	for line in text.lines() {
		let line = line.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		if line.starts_with('[') && line.ends_with(']') {
			in_entry = line == "[Desktop Entry]";
			if in_entry && found_entry {
				return Err(invalid("duplicate Desktop Entry group"));
			}
			found_entry |= in_entry;
			continue;
		}
		if in_entry && let Some((key, value)) = line.split_once('=') {
			let key = key.trim().to_owned();
			if values.insert(key, value.trim().to_owned()).is_some() {
				return Err(invalid("duplicate desktop-entry key"));
			}
		}
	}
	// `Hidden` is a tombstone: the caller has already claimed the ID, so the
	// lower-precedence entry of the same name stays suppressed either way.
	if boolean(&values, "Hidden")? {
		return Err(invalid("desktop entry is hidden"));
	}
	if values.get("NoDisplay").is_some_and(|value| value == "true") {
		return Err(invalid("desktop entry is not shown"));
	}
	if values.get("Type").map(String::as_str) != Some("Application") {
		return Err(invalid("desktop entry is not Type=Application"));
	}
	let base_name = values
		.get("Name")
		.ok_or_else(|| invalid("desktop entry has no Name"))?;
	let name = locale_names()
		.iter()
		.find_map(|locale| values.get(&format!("Name[{locale}]")))
		.unwrap_or(base_name);
	let name = unescape(name)?;
	if name.is_empty() {
		return Err(invalid("desktop entry has an empty Name"));
	}
	let working_directory = values
		.get("Path")
		.map(|value| unescape(value))
		.transpose()?
		.filter(|value| !value.is_empty())
		.map(PathBuf::from);
	if working_directory
		.as_ref()
		.is_some_and(|path| !path.is_absolute())
	{
		return Err(invalid("desktop-entry Path must be absolute"));
	}
	if let Some(value) = values.get("TryExec") {
		let executable = unescape(value)?;
		resolve_executable(&executable, working_directory.as_deref()).ok_or_else(|| {
			invalid(format!("desktop-entry TryExec is not executable: {executable}"))
		})?;
	}
	Ok(Entry {
		id,
		path: path.to_owned(),
		name,
		icon: values
			.get("Icon")
			.map(|value| unescape(value))
			.transpose()?,
		exec: values.get("Exec").cloned(),
		working_directory,
		terminal: boolean(&values, "Terminal")?,
	})
}

fn resolve_executable(executable: &str, working_directory: Option<&Path>) -> Option<PathBuf> {
	fs::canonicalize(executable_path(executable, working_directory)?).ok()
}

fn executable_path(executable: &str, working_directory: Option<&Path>) -> Option<PathBuf> {
	if executable.is_empty() || executable.contains('\0') {
		return None;
	}
	let executable = Path::new(executable);
	let usable = |path: PathBuf| {
		let metadata = fs::metadata(&path).ok()?;
		(metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then_some(path)
	};
	if executable.is_absolute() {
		return usable(executable.to_owned());
	}
	if executable.components().count() != 1 {
		return None;
	}
	let cwd = working_directory
		.map(Path::to_owned)
		.or_else(|| env::current_dir().ok())?;
	env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
		usable(if directory.is_absolute() {
			directory.join(executable)
		} else {
			cwd.join(directory).join(executable)
		})
	})
}

/// The two escaping layers the Desktop Entry specification defines — not shell
/// syntax. No environment expansion, globbing or command substitution.
fn exec_argv(raw: &str, name: &str, icon: Option<&str>, path: &Path) -> CoreResult<Vec<String>> {
	let value = unescape(raw)?;
	let mut words: Vec<String> = Vec::new();
	let mut word = String::new();
	let mut quoted = false;
	let mut started = false;
	let mut chars = value.chars();
	while let Some(character) = chars.next() {
		match character {
			'"' => {
				quoted = !quoted;
				started = true;
			},
			'\\' => {
				let next = chars
					.next()
					.ok_or_else(|| invalid("trailing backslash in desktop Exec"))?;
				if quoted && !matches!(next, '"' | '`' | '$' | '\\') {
					return Err(invalid("invalid quoted escape in desktop Exec"));
				}
				word.push(next);
				started = true;
			},
			'%' if quoted => {
				return Err(invalid("desktop Exec field codes cannot appear inside quotes"));
			},
			character if !quoted && character.is_ascii_whitespace() => {
				if started {
					words.push(std::mem::take(&mut word));
					started = false;
				}
			},
			character
				if !quoted
					&& matches!(
						character,
						'\''
							| '>' | '<' | '~'
							| '|' | '&' | ';'
							| '$' | '*' | '?'
							| '#' | '(' | ')'
							| '`'
					) =>
			{
				return Err(invalid("reserved desktop Exec character must be double-quoted"));
			},
			'\0' => return Err(invalid("NUL in desktop Exec")),
			character => {
				word.push(character);
				started = true;
			},
		}
	}
	if quoted {
		return Err(invalid("unterminated quote in desktop Exec"));
	}
	if started {
		words.push(word);
	}
	let mut argv = Vec::with_capacity(words.len());
	let mut file_codes = 0;
	for (index, word) in words.into_iter().enumerate() {
		let mut expanded = String::with_capacity(word.len());
		let mut chars = word.chars();
		let mut removed = false;
		let mut icon_arguments = false;
		while let Some(character) = chars.next() {
			if character != '%' {
				expanded.push(character);
				continue;
			}
			let code = chars
				.next()
				.ok_or_else(|| invalid("incomplete desktop Exec field code"))?;
			if index == 0 && code != '%' {
				return Err(invalid("desktop Exec executable cannot contain field codes"));
			}
			match code {
				'%' => expanded.push('%'),
				'c' => expanded.push_str(name),
				'k' => expanded.push_str(&path.to_string_lossy()),
				'i' if word == "%i" => {
					icon_arguments = true;
				},
				'f' | 'u' => {
					file_codes += 1;
					removed = true;
				},
				'F' | 'U' if word.len() == 2 => {
					file_codes += 1;
					removed = true;
				},
				'd' | 'D' | 'n' | 'N' | 'v' | 'm' => {
					removed = true;
				},
				_ => {
					return Err(invalid(format!(
						"unsupported or misplaced desktop Exec field code %{code}"
					)));
				},
			}
		}
		if icon_arguments {
			if let Some(icon) = icon.filter(|icon| !icon.is_empty()) {
				argv.push("--icon".to_owned());
				argv.push(icon.to_owned());
			}
		} else if !removed || !expanded.is_empty() {
			argv.push(expanded);
		}
	}
	if file_codes > 1 {
		return Err(invalid("desktop Exec has more than one file/URL field code"));
	}
	if argv.first().is_none_or(String::is_empty) {
		return Err(invalid("desktop entry has no executable"));
	}
	Ok(argv)
}

impl Entry {
	fn argv(&self) -> CoreResult<Vec<String>> {
		self
			.exec
			.as_deref()
			.map(|exec| exec_argv(exec, &self.name, self.icon.as_deref(), &self.path))
			.ok_or_else(|| {
				invalid("desktop entry declares no Exec command; D-Bus activation is not wired here")
			})?
	}

	fn executable(&self) -> Option<PathBuf> {
		let argv = self.argv().ok()?;
		resolve_executable(&argv[0], self.working_directory.as_deref())
	}

	fn application(&self, processes: &HashMap<PathBuf, Vec<u32>>) -> Application {
		let pid = self
			.executable()
			.and_then(|exe| processes.get(&exe).and_then(|pids| pids.first()).copied());
		Application {
			id: self.id.clone(),
			name: self.name.clone(),
			path: self.path.to_string_lossy().into_owned(),
			running: pid.is_some(),
			pid,
		}
	}
}

fn processes() -> HashMap<PathBuf, Vec<u32>> {
	let mut processes: HashMap<PathBuf, Vec<u32>> = HashMap::new();
	let Ok(entries) = fs::read_dir("/proc") else {
		return processes;
	};
	for entry in entries.flatten() {
		let Some(pid) = entry
			.file_name()
			.to_str()
			.and_then(|name| name.parse::<u32>().ok())
		else {
			continue;
		};
		if let Ok(exe) = fs::read_link(entry.path().join("exe")) {
			processes.entry(exe).or_default().push(pid);
		}
	}
	for pids in processes.values_mut() {
		pids.sort_unstable();
	}
	processes
}

pub(super) fn list(options: ApplicationQuery) -> CoreResult<Vec<Application>> {
	let processes = processes();
	let mut seen = HashSet::new();
	let mut applications = Vec::new();
	for root in data_roots() {
		let mut files = Vec::new();
		desktop_files(&root, &mut files);
		files.sort();
		for path in files {
			let id = desktop_id(&root, &path);
			// Reserve IDs before parsing: a hidden entry is a tombstone, not a
			// reason to rediscover the lower-precedence system entry.
			if !seen.insert(id.clone()) {
				continue;
			}
			if let Ok(entry) = read_entry(&path, id) {
				applications.push(entry.application(&processes));
			}
		}
	}
	applications.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
	let query = options.query.unwrap_or_default().to_lowercase();
	applications.retain(|app| {
		(!options.running_only.unwrap_or(false) || app.running)
			&& (query.is_empty()
				|| app.name.to_lowercase().contains(&query)
				|| app.id.to_lowercase().contains(&query)
				|| app.path.to_lowercase().contains(&query))
	});
	Ok(applications)
}

pub(super) fn open(target: &str, options: ApplicationOpenOptions) -> CoreResult<Application> {
	let path = Path::new(target);
	if !path.is_absolute() {
		return Err(DesktopError::invalid_target(
			"launching a Linux application needs its absolute .desktop path",
		));
	}
	let id = data_roots()
		.iter()
		.find(|root| path.starts_with(root))
		.map_or_else(|| path.to_string_lossy().into_owned(), |root| desktop_id(root, path));
	let entry = read_entry(path, id)?;
	let current = entry.application(&processes());
	// An already running app is reported, not launched again. Raising its window
	// needs compositor activation, which this port does not implement.
	if current.running {
		return Ok(current);
	}
	let mut argv = entry.argv()?;
	let program = argv.remove(0);
	let mut command = Command::new(program);
	command
		.args(argv)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	if let Some(directory) = entry.working_directory.as_ref() {
		command.current_dir(directory);
	}
	// The launch is MinePi's, not a user gesture in a terminal: drop any
	// inherited activation token so the app does not claim the user's focus.
	command.env_remove("XDG_ACTIVATION_TOKEN");
	if options.activate.unwrap_or(false) {
		command.env_remove("DESKTOP_STARTUP_ID");
	} else {
		command.env("DESKTOP_STARTUP_ID", "0");
	}
	if entry.terminal {
		// A terminal entry needs a terminal this non-interactive launch does not
		// have; refuse rather than spawning an app with no window.
		return Err(DesktopError::unsupported(format!(
			"'{}' runs in a terminal, which this non-interactive launch cannot provide",
			entry.name
		)));
	}
	command.spawn().map_err(|error| {
		DesktopError::input_failed(format!("cannot launch {}: {error}", entry.name))
	})?;
	Ok(entry.application(&processes()))
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::exec_argv;

	fn parse(value: &str) -> super::CoreResult<Vec<String>> {
		exec_argv(
			value,
			"Display Name",
			Some("icon with spaces"),
			Path::new("/apps/test app.desktop"),
		)
	}

	#[test]
	fn expands_desktop_fields_without_splitting_values() {
		assert_eq!(parse("/usr/bin/example %c %i %k %U %%").unwrap(), [
			"/usr/bin/example",
			"Display Name",
			"--icon",
			"icon with spaces",
			"/apps/test app.desktop",
			"%",
		]);
	}

	#[test]
	fn preserves_quoted_arguments_and_empty_arguments() {
		assert_eq!(parse(r#""/opt/App Suite/app" "two words" """#).unwrap(), [
			"/opt/App Suite/app",
			"two words",
			""
		]);
	}

	#[test]
	fn applies_desktop_and_exec_backslash_layers() {
		assert_eq!(parse(r#"app "a\\"b" "c\\\\d" "\\$HOME""#).unwrap(), [
			"app", "a\"b", "c\\d", "$HOME"
		]);
	}

	#[test]
	fn rejects_shell_operators_and_malformed_fields() {
		for value in [
			"app ; touch /tmp/file",
			"app $(command)",
			"app 'single quoted'",
			"app %Z",
			"app %",
			"app prefix%F",
			"app %f %U",
			"app \"%c\"",
			"app \"unterminated",
			r"app \q",
		] {
			assert!(parse(value).is_err(), "{value}");
		}
	}

	#[test]
	fn shell_text_is_only_a_literal_argument() {
		assert_eq!(parse(r#"app "$(touch /tmp/file); * | >""#).unwrap(), [
			"app",
			"$(touch /tmp/file); * | >"
		]);
	}

	#[test]
	fn removes_absent_inputs_and_deprecated_codes() {
		assert_eq!(parse("app %f %d %D %n %N %v %m").unwrap(), ["app"]);
		assert_eq!(exec_argv("app %i", "Name", None, Path::new("/app.desktop")).unwrap(), ["app"]);
	}
}
