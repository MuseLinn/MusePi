//! `diff` builtin: compare files line by line using the `similar` library.
//!
//! Ported from `pi-uu-diff` 0.8.0.

use std::{
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs,
	io::{Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgAction, Parser};
use similar::TextDiff;

use crate::host::{Host, Utility, util};

/// Parsed `diff` invocation.
#[derive(Parser)]
#[command(
	name = "diff",
	version = "diff (pi-uu-diff) 0.8.0",
	about = "Compare files line by line.",
	override_usage = "diff [OPTION]... FILE1 FILE2",
	infer_long_args = true
)]
pub(crate) struct Diff {
	/// Output 3 lines of unified context (the default output format).
	#[arg(short = 'u', action = ArgAction::SetTrue)]
	_unified_flag: bool,

	/// Output NUM lines of unified context.
	#[arg(short = 'U', long = "unified", value_name = "NUM")]
	unified: Option<usize>,

	/// Report only when files differ.
	#[arg(short = 'q', long = "brief", action = ArgAction::SetTrue)]
	brief: bool,

	/// Recursively compare subdirectories (always on for directories).
	#[arg(short = 'r', long = "recursive", action = ArgAction::SetTrue)]
	_recursive: bool,

	/// Treat absent files as empty.
	#[arg(short = 'N', long = "new-file", action = ArgAction::SetTrue)]
	new_file: bool,

	/// Use LABEL instead of a file name in a unified header.
	#[arg(long = "label", value_name = "LABEL", action = ArgAction::Append)]
	labels: Vec<OsString>,

	/// Accepted for compatibility; output is never colorized.
	#[arg(
		long = "color",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto"
	)]
	_color: Option<String>,

	/// Files or directories to compare.
	#[arg(required = true, num_args = 2, value_hint = clap::ValueHint::AnyPath)]
	files: Vec<OsString>,
}

#[derive(Clone, Copy)]
struct Options<'a> {
	context:  usize,
	brief:    bool,
	new_file: bool,
	labels:   &'a [OsString],
}

/// A classified operand and its resolved filesystem path.
enum Operand {
	/// The builtin's standard input (`-`).
	Stdin,
	/// A regular (or other non-directory) file at the resolved path.
	File(PathBuf),
	/// A directory at the resolved path.
	Dir(PathBuf),
	/// A missing file tolerated by `-N` and compared as empty.
	Absent,
}

impl Utility for Diff {
	const NAME: &'static str = "diff";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let opts = Options {
			context:  self.unified.unwrap_or(3),
			brief:    self.brief,
			new_file: self.new_file,
			labels:   &self.labels,
		};
		match diff_main(&self.files, opts, host) {
			Ok(code) => code,
			Err(message) => {
				host.error(message, 2);
				2
			},
		}
	}
}

fn diff_main(files: &[OsString], opts: Options<'_>, host: &mut Host) -> Result<i32, String> {
	let (mut name_a, mut name_b) = (PathBuf::from(&files[0]), PathBuf::from(&files[1]));
	let mut op_a = classify(&name_a, opts.new_file, host)?;
	let mut op_b = classify(&name_b, opts.new_file, host)?;

	// GNU: comparing a directory with a non-directory compares
	// <dir>/<basename-of-other> with the other operand.
	let a_is_dir = matches!(op_a, Operand::Dir(_));
	let b_is_dir = matches!(op_b, Operand::Dir(_));
	if a_is_dir != b_is_dir {
		if matches!(op_a, Operand::Stdin) || matches!(op_b, Operand::Stdin) {
			return Err("cannot compare '-' to a directory".to_string());
		}
		if a_is_dir {
			name_a = descend(&name_a, &name_b)?;
			op_a = classify(&name_a, opts.new_file, host)?;
		} else {
			name_b = descend(&name_b, &name_a)?;
			op_b = classify(&name_b, opts.new_file, host)?;
		}
	}

	let differed = if let (Operand::Dir(res_a), Operand::Dir(res_b)) = (&op_a, &op_b) {
		diff_dirs(&name_a, res_a, &name_b, res_b, opts, host)?
	} else {
		let bytes_a = read_operand(&op_a, &name_a, host)?;
		let bytes_b = read_operand(&op_b, &name_b, host)?;
		diff_pair(&name_a, &bytes_a, &name_b, &bytes_b, opts, None, host)?
	};
	Ok(i32::from(differed))
}

/// Replaces a directory operand with `<dir>/<basename of other>` for the GNU
/// dir-vs-file comparison form.
fn descend(dir: &Path, other: &Path) -> Result<PathBuf, String> {
	let base = other
		.file_name()
		.ok_or_else(|| format!("cannot compare {} to a directory", other.display()))?;
	Ok(dir.join(base))
}

fn classify(name: &Path, new_file: bool, host: &Host) -> Result<Operand, String> {
	if name.as_os_str() == OsStr::new("-") {
		return Ok(Operand::Stdin);
	}
	// Keep `name` for diagnostics and headers; only filesystem access uses the
	// path resolved against the shell working directory.
	let resolved = host.resolve(name);
	match fs::metadata(&resolved) {
		Ok(meta) if meta.is_dir() => Ok(Operand::Dir(resolved)),
		Ok(_) => Ok(Operand::File(resolved)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && new_file => Ok(Operand::Absent),
		Err(err) => Err(format!("{}: {}", name.display(), io_msg(&err))),
	}
}

fn read_operand(op: &Operand, name: &Path, host: &mut Host) -> Result<Vec<u8>, String> {
	match op {
		Operand::Stdin => {
			let mut buf = Vec::new();
			host.stdin
				.read_to_end(&mut buf)
				.map_err(|err| format!("-: {}", io_msg(&err)))?;
			Ok(buf)
		},
		Operand::File(resolved) => {
			fs::read(resolved).map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))
		},
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
		Operand::Absent => Ok(Vec::new()),
	}
}

/// Diffs one pair of already-read inputs. `prefix` is the `diff -r A/x B/x`
/// line emitted before per-pair output in directory mode.
fn diff_pair(
	name_a: &Path,
	bytes_a: &[u8],
	name_b: &Path,
	bytes_b: &[u8],
	opts: Options<'_>,
	prefix: Option<&str>,
	host: &mut Host,
) -> Result<bool, String> {
	if bytes_a == bytes_b {
		return Ok(false);
	}
	let label_a = display_label(opts.labels.first(), name_a);
	let label_b = display_label(opts.labels.get(1), name_b);
	if opts.brief {
		writeln!(host.stdout, "Files {label_a} and {label_b} differ").map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	if is_binary(bytes_a) || is_binary(bytes_b) {
		writeln!(host.stdout, "Binary files {label_a} and {label_b} differ")
			.map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	if let Some(line) = prefix {
		writeln!(host.stdout, "{line}").map_err(|e| io_msg(&e))?;
	}
	let old = String::from_utf8_lossy(bytes_a);
	let new = String::from_utf8_lossy(bytes_b);
	let diff = TextDiff::from_lines(old.as_ref(), new.as_ref());
	write!(
		host.stdout,
		"{}",
		diff.unified_diff().context_radius(opts.context).header(&label_a, &label_b)
	)
	.map_err(|e| io_msg(&e))?;
	Ok(true)
}

fn display_label(label: Option<&OsString>, name: &Path) -> String {
	label.map_or_else(|| name.display().to_string(), |label| label.to_string_lossy().into_owned())
}

/// Recursively compares two directories over the sorted union of their entries,
/// GNU `diff -r` style.
fn diff_dirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: Options<'_>,
	host: &mut Host,
) -> Result<bool, String> {
	let mut names: BTreeSet<OsString> = BTreeSet::new();
	for (dir_name, dir_res) in [(name_a, res_a), (name_b, res_b)] {
		let entries = fs::read_dir(dir_res)
			.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
		for entry in entries {
			let entry = entry.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
			names.insert(entry.file_name());
		}
	}

	let mut differed = false;
	for name in names {
		if host.is_cancelled() {
			return Err("interrupted".to_string());
		}
		let (child_name_a, child_name_b) = (name_a.join(&name), name_b.join(&name));
		// Resolve every recursively discovered display path through the host too;
		// the process's current directory is unrelated to the shell's.
		let child_res_a = host.resolve(&child_name_a);
		let child_res_b = host.resolve(&child_name_b);
		let meta_a = fs::metadata(&child_res_a).ok();
		let meta_b = fs::metadata(&child_res_b).ok();
		match (meta_a.as_ref(), meta_b.as_ref()) {
			(Some(ma), Some(mb)) if ma.is_dir() && mb.is_dir() => {
				differed |= diff_dirs(
					&child_name_a,
					&child_res_a,
					&child_name_b,
					&child_res_b,
					opts,
					host,
				)?;
			},
			(Some(ma), Some(mb)) if ma.is_dir() != mb.is_dir() => {
				let (dir, file) = if ma.is_dir() {
					(&child_name_a, &child_name_b)
				} else {
					(&child_name_b, &child_name_a)
				};
				writeln!(
					host.stdout,
					"File {} is a directory while file {} is a regular file",
					dir.display(),
					file.display()
				)
				.map_err(|e| io_msg(&e))?;
				differed = true;
			},
			(Some(_), Some(_)) => {
				let bytes_a = fs::read(&child_res_a)
					.map_err(|err| format!("{}: {}", child_name_a.display(), io_msg(&err)))?;
				let bytes_b = fs::read(&child_res_b)
					.map_err(|err| format!("{}: {}", child_name_b.display(), io_msg(&err)))?;
				let prefix = format!("diff -r {} {}", child_name_a.display(), child_name_b.display());
				differed |= diff_pair(
					&child_name_a,
					&bytes_a,
					&child_name_b,
					&bytes_b,
					opts,
					Some(&prefix),
					host,
				)?;
			},
			(Some(meta), None) | (None, Some(meta)) => {
				let in_a = meta_b.is_none();
				if opts.new_file && meta.is_file() {
					let (present_name, present_res) = if in_a {
						(&child_name_a, &child_res_a)
					} else {
						(&child_name_b, &child_res_b)
					};
					let bytes = fs::read(present_res)
						.map_err(|err| format!("{}: {}", present_name.display(), io_msg(&err)))?;
					let prefix =
						format!("diff -r {} {}", child_name_a.display(), child_name_b.display());
					let (ba, bb): (&[u8], &[u8]) = if in_a { (&bytes, &[]) } else { (&[], &bytes) };
					differed |= diff_pair(
						&child_name_a,
						ba,
						&child_name_b,
						bb,
						opts,
						Some(&prefix),
						host,
					)?;
				} else {
					let present_dir = if in_a { name_a } else { name_b };
					writeln!(
						host.stdout,
						"Only in {}: {}",
						present_dir.display(),
						Path::new(&name).display()
					)
					.map_err(|e| io_msg(&e))?;
					differed = true;
				}
			},
			(None, None) => {},
		}
	}
	Ok(differed)
}

/// NUL byte within the first 8 KiB marks the input as binary, matching GNU
/// diff's heuristic for deciding between text and binary output.
fn is_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&byte| byte == 0)
}

/// Renders an I/O error without Rust's ` (os error N)` suffix.
fn io_msg(err: &std::io::Error) -> String {
	let msg = err.to_string();
	match msg.find(" (os error") {
		Some(idx) => msg[..idx].to_string(),
		None => msg,
	}
}

/// Creates the `diff` builtin registration.
pub(crate) fn diff_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Diff, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::Diff;
	use crate::host::run_util;

	fn run_in(cwd: &Path, stdin: &str, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Diff>(args, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn identical_files_print_nothing_and_exit_zero() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
		fs::write(dir.path().join("b.txt"), "one\ntwo\n").unwrap();
		assert_eq!(run_in(dir.path(), "", &["a.txt", "b.txt"]), (0, String::new(), String::new()));
	}

	#[test]
	fn differing_files_emit_unified_diff_with_typed_headers() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(dir.path().join("b.txt"), "one\nTWO\nthree\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n@@ "), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
		assert!(stdout.contains("\n one\n"), "got: {stdout}");
		assert!(stdout.contains("\n three\n"), "got: {stdout}");
	}

	#[test]
	fn labels_override_typed_headers() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "old\n").unwrap();
		fs::write(dir.path().join("b.txt"), "new\n").unwrap();
		let (code, stdout, stderr) = run_in(
			dir.path(),
			"",
			&["--label", "before", "--label", "after", "a.txt", "b.txt"],
		);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- before\n+++ after\n"), "got: {stdout}");
	}

	#[test]
	fn unified_zero_drops_context_lines() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(dir.path().join("b.txt"), "one\nTWO\nthree\n").unwrap();
		let (code, stdout, _) = run_in(dir.path(), "", &["-U", "0", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert!(!stdout.contains("\n one\n"), "got: {stdout}");
		assert!(!stdout.contains("\n three\n"), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
	}

	#[test]
	fn brief_reports_one_line_per_differing_pair() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "x\n").unwrap();
		fs::write(dir.path().join("b.txt"), "y\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["-q", "a.txt", "b.txt"]),
			(1, "Files a.txt and b.txt differ\n".to_string(), String::new())
		);
	}

	#[test]
	fn compatibility_flags_are_accepted_and_ignored() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "x\n").unwrap();
		fs::write(dir.path().join("b.txt"), "y\n").unwrap();
		let (code, stdout, stderr) =
			run_in(dir.path(), "", &["-u", "-r", "--color=always", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n"), "got: {stdout}");
		assert!(!stdout.contains('\u{1b}'), "got: {stdout}");
	}

	#[test]
	fn binary_inputs_report_binary_difference() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.bin"), b"aa\x00bb").unwrap();
		fs::write(dir.path().join("b.bin"), b"aa\x00cc").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["a.bin", "b.bin"]),
			(1, "Binary files a.bin and b.bin differ\n".to_string(), String::new())
		);
	}

	#[test]
	fn missing_operand_file_is_trouble() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "x\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["a.txt", "nope.txt"]),
			(2, String::new(), "diff: nope.txt: No such file or directory\n".to_string())
		);
	}

	#[test]
	fn missing_second_operand_is_usage_error() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["only-one"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert!(stderr.contains("required"), "got: {stderr}");
	}

	#[test]
	fn new_file_treats_missing_operand_as_empty() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-N", "nope.txt", "a.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- nope.txt\n+++ a.txt\n"), "got: {stdout}");
		assert!(stdout.contains("\n+one\n"), "got: {stdout}");
	}

	#[test]
	fn dash_reads_builtin_stdin() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "one\ntwo\n", &["a.txt", "-"]),
			(0, String::new(), String::new())
		);
		let (code, stdout, _) = run_in(dir.path(), "one\nTWO\n", &["a.txt", "-"]);
		assert_eq!(code, 1);
		assert!(stdout.starts_with("--- a.txt\n+++ -\n"), "got: {stdout}");
	}

	#[test]
	fn directories_diff_recursively_with_only_in_lines() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(a.join("sub")).unwrap();
		fs::create_dir_all(b.join("sub")).unwrap();
		fs::write(a.join("common.txt"), "same\n").unwrap();
		fs::write(b.join("common.txt"), "same\n").unwrap();
		fs::write(a.join("only.txt"), "left\n").unwrap();
		fs::write(b.join("other.txt"), "right\n").unwrap();
		fs::write(a.join("sub/inner.txt"), "old\n").unwrap();
		fs::write(b.join("sub/inner.txt"), "new\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["a", "b"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.contains("Only in a: only.txt\n"), "got: {stdout}");
		assert!(stdout.contains("Only in b: other.txt\n"), "got: {stdout}");
		assert!(
			stdout.contains(
				"diff -r a/sub/inner.txt b/sub/inner.txt\n--- a/sub/inner.txt\n+++ b/sub/inner.txt\n"
			),
			"got: {stdout}"
		);
		assert!(stdout.contains("\n-old\n"), "got: {stdout}");
		assert!(stdout.contains("\n+new\n"), "got: {stdout}");
		assert!(!stdout.contains("common.txt"), "got: {stdout}");
	}

	#[test]
	fn identical_directories_exit_zero() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(&a).unwrap();
		fs::create_dir_all(&b).unwrap();
		fs::write(a.join("f.txt"), "same\n").unwrap();
		fs::write(b.join("f.txt"), "same\n").unwrap();
		assert_eq!(run_in(dir.path(), "", &["-r", "a", "b"]), (0, String::new(), String::new()));
	}

	#[test]
	fn help_renders_to_builtin_stdout() {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Diff>(&["--help"], "", dir.path());
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("Compare files line by line"));
		assert_eq!(capture.err(), "");
	}
}
