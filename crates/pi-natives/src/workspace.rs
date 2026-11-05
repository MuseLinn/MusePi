//! Workspace discovery for startup context and the GUI file tree.
//!
//! Walks a project tree once and returns the bounded entries needed to render
//! the workspace tree plus directory-scoped AGENTS.md files. AGENTS.md files
//! are checked directly in every traversed directory so a file-level gitignore
//! rule cannot hide them, while ignored directories are still pruned by the
//! walker.
//!
//! The scan never follows symbolic-link directories by default. Callers that
//! render an expandable tree opt in with `followDirSymlinks`, which expands
//! only links whose real target stays inside the workspace boundary; links that
//! leave it stay leaf entries.

use std::{
	collections::HashSet,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{
	iofs::{self, FileType, GlobMatch},
	task,
};

const AGENTS_MD_FILENAME: &str = "AGENTS.md";
const AGENTS_MD_MIN_DEPTH: usize = 1;
const AGENTS_MD_MAX_DEPTH: usize = 4;
const AGENTS_MD_LIMIT: usize = 200;
const MAX_ENTRIES: usize = 100_000;

/// Directory names pruned during traversal. The TypeScript caller no longer has
/// to plumb this list through; it lives here so a single source of truth
/// governs what counts as a non-source directory in startup scans.
const EXCLUDED_DIRS: &[&str] = &[
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	".cache",
	".turbo",
	".parcel-cache",
	"coverage",
];

static EXCLUDED_DIR_SET: LazyLock<HashSet<&'static str>> =
	LazyLock::new(|| EXCLUDED_DIRS.iter().copied().collect());

/// Input options for `listWorkspace`, the single-pass workspace startup scan.
#[napi(object)]
pub struct ListWorkspaceOptions<'env> {
	/// Directory to scan.
	pub path:                String,
	/// Maximum depth for returned tree entries. Root children are depth 1.
	pub max_depth:           u32,
	/// Include hidden files and directories. Default: false.
	pub hidden:              Option<bool>,
	/// Respect .gitignore files. Default: true.
	pub gitignore:           Option<bool>,
	/// Also surface AGENTS.md files in directories at depth 1..=4, even when
	/// gitignore would otherwise hide the file. Walks deeper than `maxDepth`
	/// to find them. Default: false.
	pub collect_agents_md:   Option<bool>,
	/// Expand symbolic links whose real target is a directory inside
	/// `symlinkBoundary`. Entries stay marked as symlinks and carry their
	/// target text. Default: false (never follows directory links).
	pub follow_dir_symlinks: Option<bool>,
	/// Directory bounding followed symlink targets. Defaults to `path`, so a
	/// link that leaves the scanned directory stays a leaf entry. Ignored when
	/// `followDirSymlinks` is false.
	pub symlink_boundary:    Option<String>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:          Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:              Option<Unknown<'env>>,
}

/// Result payload returned by a workspace scan.
#[napi(object)]
pub struct ListWorkspaceResult {
	/// Entries within `maxDepth`, with mtime and regular-file size metadata.
	pub entries:         Vec<GlobMatch>,
	/// Directory-scoped AGENTS.md files within depth 1..=4 (capped at 200).
	/// Always empty when `collectAgentsMd` is false.
	pub agents_md_files: Vec<String>,
	/// True when any output cap was hit.
	pub truncated:       bool,
}

/// Boundary for directory symlink following. `boundary` is canonical so the
/// containment test compares real paths rather than link paths.
struct SymlinkFollow {
	boundary: PathBuf,
}

struct WorkspaceConfig {
	root:              PathBuf,
	max_depth:         usize,
	walk_max_depth:    usize,
	include_hidden:    bool,
	use_gitignore:     bool,
	collect_agents_md: bool,
	follow:            Option<SymlinkFollow>,
}

fn build_workspace_walk_request(config: &WorkspaceConfig) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(config.root.clone())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(pi_walker::WalkDetail::Full)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, config.walk_max_depth)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(false)
}

/// Secondary scan rooted at a followed symlink's canonical target. `Roots`
/// follows the operand itself while leaving descendant links alone, so each
/// nested link goes through the same boundary check as the primary scan.
fn build_symlink_dir_walk_request(
	config: &WorkspaceConfig,
	scan_root: &Path,
	max_depth: usize,
) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(scan_root.to_path_buf())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Roots)
		.detail(pi_walker::WalkDetail::Full)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, max_depth)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(false)
}

fn is_file_or_file_symlink(path: &Path, file_type: FileType) -> bool {
	match file_type {
		FileType::File => true,
		FileType::Symlink => std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()),
		FileType::Dir => false,
	}
}

fn is_excluded_workspace_entry(relative: &str, file_type: FileType) -> bool {
	let mut components = relative
		.split('/')
		.filter(|component| !component.is_empty())
		.peekable();
	while let Some(component) = components.next() {
		if component == ".DS_Store" {
			return true;
		}
		let is_final_component = components.peek().is_none();
		if EXCLUDED_DIR_SET.contains(component) && (!is_final_component || file_type == FileType::Dir)
		{
			return true;
		}
	}
	false
}

/// Render a link target the way a user typed it: Windows junctions and
/// canonicalized links carry the `\\?\` verbatim prefix, which has no place in
/// a tooltip.
fn display_link_target(target: &Path) -> String {
	let text = target.to_string_lossy();
	#[cfg(windows)]
	{
		for prefix in [r"\\?\UNC\", r"\??\UNC\"] {
			if let Some(rest) = text.strip_prefix(prefix) {
				return format!(r"\\{rest}");
			}
		}
		for prefix in [r"\\?\", r"\??\"] {
			if let Some(rest) = text.strip_prefix(prefix) {
				return rest.to_string();
			}
		}
	}
	text.into_owned()
}

fn is_ancestor(ancestors: &[PathBuf], canonical: &Path) -> bool {
	ancestors.iter().any(|ancestor| ancestor == canonical)
}

/// Resolve one scanned symlink. Returns `(isSymlink, linkTarget, followedDir)`
/// where `followedDir` is the canonical directory target when it resolves
/// inside the configured boundary and may be expanded.
fn inspect_symlink(
	path: &Path,
	raw_type: pi_walker::FileType,
	follow: Option<&SymlinkFollow>,
) -> (bool, Option<String>, Option<PathBuf>) {
	let Some(follow) = follow else {
		return (false, None, None);
	};
	// The walker reports every platform reparse point (Windows junctions
	// included) as `Symlink`, so its classification is the authoritative test.
	if raw_type != pi_walker::FileType::Symlink {
		return (false, None, None);
	}
	let link_target = std::fs::read_link(path)
		.ok()
		.map(|target| display_link_target(&target));
	let followed = std::fs::metadata(path)
		.ok()
		.filter(|metadata| metadata.is_dir())
		.and_then(|_| std::fs::canonicalize(path).ok())
		.filter(|real| real.starts_with(&follow.boundary));
	(true, link_target, followed)
}

fn collect_agents_md_in_directory(
	config: &WorkspaceConfig,
	directory: &Path,
	relative_directory: &str,
	directory_depth: usize,
	entries: &mut Vec<GlobMatch>,
	agents_md_files: &mut Vec<String>,
) {
	if !config.collect_agents_md {
		return;
	}
	let candidate = directory.join(AGENTS_MD_FILENAME);
	let Some((raw_type, mtime, size)) = pi_walker::classify_file_type(&candidate) else {
		return;
	};
	let file_type = iofs::from_walker_file_type(raw_type);
	if !is_file_or_file_symlink(&candidate, file_type) {
		return;
	}
	// Derive the entry path from the tree position rather than from the scan
	// root: expanded link children live under the target, not under the root.
	let path = if relative_directory.is_empty() {
		AGENTS_MD_FILENAME.to_string()
	} else {
		format!("{relative_directory}/{AGENTS_MD_FILENAME}")
	};
	let tree_depth = directory_depth + 1;
	if tree_depth <= config.max_depth {
		entries.push(GlobMatch {
			path: path.clone(),
			file_type,
			is_symlink: (raw_type == pi_walker::FileType::Symlink).then_some(true),
			link_target: None,
			mtime,
			size: size.map(|value| value as f64),
		});
	}
	// AGENTS.md directory depth: root AGENTS.md is depth 0, child dir AGENTS.md
	// is depth 1, and so on. We only surface files in depth 1..=4.
	if (AGENTS_MD_MIN_DEPTH..=AGENTS_MD_MAX_DEPTH).contains(&directory_depth) {
		agents_md_files.push(path);
	}
}

fn sort_dedup_entries(entries: &mut Vec<GlobMatch>) {
	entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	entries.dedup_by(|a, b| a.path == b.path);
}

fn sort_dedup_paths(paths: &mut Vec<String>) {
	paths.sort_unstable();
	paths.dedup();
}

/// Accumulates the primary scan plus the bounded expansion of directory links
/// that stay inside the workspace.
struct WorkspaceScan<'a> {
	config:          &'a WorkspaceConfig,
	ct:              &'a task::CancelToken,
	entries:         Vec<GlobMatch>,
	agents_md_files: Vec<String>,
	truncated:       bool,
}

impl WorkspaceScan<'_> {
	fn visit(&mut self, entry: pi_walker::CollectedEntry) -> Result<()> {
		let depth = entry.depth();
		let absolute = entry.absolute_path(&self.config.root);
		let (is_symlink, link_target, followed) =
			inspect_symlink(&absolute, entry.file_type, self.config.follow.as_ref());
		// The primary scan's ancestor chain is just the scan root.
		let followed = followed.filter(|real| real != &self.config.root);
		let file_type = if followed.is_some() {
			FileType::Dir
		} else {
			iofs::from_walker_file_type(entry.file_type)
		};
		if is_excluded_workspace_entry(&entry.path, file_type) {
			return Ok(());
		}
		if file_type == FileType::Dir {
			collect_agents_md_in_directory(
				self.config,
				&absolute,
				&entry.path,
				depth,
				&mut self.entries,
				&mut self.agents_md_files,
			);
		}
		let path = entry.path;
		if depth <= self.config.max_depth {
			self.entries.push(GlobMatch {
				path: path.clone(),
				file_type,
				is_symlink: is_symlink.then_some(true),
				link_target,
				mtime: entry.mtime,
				size: entry.size,
			});
		}
		if let Some(real) = followed {
			let mut ancestors = vec![self.config.root.clone()];
			self.expand(&path, &real, depth, &mut ancestors)?;
		}
		Ok(())
	}

	/// Expand one followed directory link, guarding against cycles through the
	/// canonical ancestors already on this branch. The scan is rooted at the
	/// canonical target: the walker opens its root with
	/// `FILE_FLAG_OPEN_REPARSE_POINT` on Windows, which reads a junction itself
	/// rather than its children.
	fn expand(
		&mut self,
		workspace_rel: &str,
		canonical: &Path,
		tree_depth: usize,
		ancestors: &mut Vec<PathBuf>,
	) -> Result<()> {
		if tree_depth >= self.config.max_depth || is_ancestor(ancestors, canonical) {
			return Ok(());
		}
		if self.entries.len() >= MAX_ENTRIES {
			self.truncated = true;
			return Ok(());
		}
		ancestors.push(canonical.to_path_buf());
		let result = self.expand_children(workspace_rel, canonical, tree_depth, ancestors);
		ancestors.pop();
		result
	}

	fn expand_children(
		&mut self,
		workspace_rel: &str,
		scan_root: &Path,
		tree_depth: usize,
		ancestors: &mut Vec<PathBuf>,
	) -> Result<()> {
		let remaining_depth = self.config.max_depth - tree_depth;
		let outcome = build_symlink_dir_walk_request(self.config, scan_root, remaining_depth)
			.collect_with_heartbeat(|| self.ct.heartbeat())
			.map_err(iofs::map_walker_error)?;

		for entry in outcome.entries {
			let depth = tree_depth + entry.depth();
			let absolute = entry.absolute_path(scan_root);
			let (is_symlink, link_target, followed) =
				inspect_symlink(&absolute, entry.file_type, self.config.follow.as_ref());
			let followed = followed.filter(|real| !is_ancestor(ancestors, real));
			let file_type = if followed.is_some() {
				FileType::Dir
			} else {
				iofs::from_walker_file_type(entry.file_type)
			};
			let path = format!("{workspace_rel}/{}", entry.path);
			if is_excluded_workspace_entry(&path, file_type) {
				continue;
			}
			if file_type == FileType::Dir {
				collect_agents_md_in_directory(
					self.config,
					&absolute,
					&path,
					depth,
					&mut self.entries,
					&mut self.agents_md_files,
				);
			}
			self.entries.push(GlobMatch {
				path: path.clone(),
				file_type,
				is_symlink: is_symlink.then_some(true),
				link_target,
				mtime: entry.mtime,
				size: entry.size,
			});
			if self.entries.len() >= MAX_ENTRIES {
				self.truncated = true;
				return Ok(());
			}
			if let Some(real) = followed {
				self.expand(&path, &real, depth, ancestors)?;
			}
		}
		Ok(())
	}

	fn finish(mut self) -> ListWorkspaceResult {
		sort_dedup_entries(&mut self.entries);
		sort_dedup_paths(&mut self.agents_md_files);

		let entries_truncated = self.entries.len() > MAX_ENTRIES;
		if entries_truncated {
			self.entries.truncate(MAX_ENTRIES);
		}
		let agents_md_truncated = self.agents_md_files.len() > AGENTS_MD_LIMIT;
		if agents_md_truncated {
			self.agents_md_files.truncate(AGENTS_MD_LIMIT);
		}

		ListWorkspaceResult {
			entries:         self.entries,
			agents_md_files: self.agents_md_files,
			truncated:       self.truncated || entries_truncated || agents_md_truncated,
		}
	}
}

fn resolve_symlink_follow(
	enabled: bool,
	boundary: Option<&str>,
	root: &Path,
) -> Option<SymlinkFollow> {
	if !enabled {
		return None;
	}
	match boundary.map(str::trim).filter(|value| !value.is_empty()) {
		Some(value) => std::fs::canonicalize(value)
			.ok()
			.filter(|path| path.is_dir())
			.map(|boundary| SymlinkFollow { boundary }),
		None => Some(SymlinkFollow { boundary: root.to_path_buf() }),
	}
}

fn run_list_workspace(
	config: WorkspaceConfig,
	ct: task::CancelToken,
) -> Result<ListWorkspaceResult> {
	let mut scan = WorkspaceScan {
		config:          &config,
		ct:              &ct,
		entries:         Vec::new(),
		agents_md_files: Vec::new(),
		truncated:       false,
	};
	collect_agents_md_in_directory(
		&config,
		&config.root,
		"",
		0,
		&mut scan.entries,
		&mut scan.agents_md_files,
	);

	let outcome = build_workspace_walk_request(&config)
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;

	for entry in outcome.entries {
		scan.visit(entry)?;
	}

	Ok(scan.finish())
}

/// Walk the workspace once and return tree entries plus AGENTS.md candidates.
///
/// File-level ignore rules for AGENTS.md are bypassed by checking each
/// traversed directory directly when `collectAgentsMd` is enabled, but ignored
/// directories are still pruned by the walker and are not searched.
///
/// `followDirSymlinks` expands directory links only while their real target
/// stays inside `symlinkBoundary` (default: the scanned directory). The link
/// entry itself keeps `isSymlink` and its target text, and reported `isDir`
/// consumers see `fileType: Dir`, so the tree can descend into it. Links that
/// leave the boundary remain leaf entries.
#[napi(js_name = "listWorkspace")]
pub fn list_workspace(options: ListWorkspaceOptions<'_>) -> task::Promise<ListWorkspaceResult> {
	let ListWorkspaceOptions {
		path,
		max_depth,
		hidden,
		gitignore,
		collect_agents_md,
		follow_dir_symlinks,
		symlink_boundary,
		timeout_ms,
		signal,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("listWorkspace", ct, move |ct| {
		let max_depth = max_depth as usize;
		let collect_agents_md = collect_agents_md.unwrap_or(false);
		let walk_max_depth = if collect_agents_md {
			max_depth.max(AGENTS_MD_MAX_DEPTH)
		} else {
			max_depth
		};
		let root = pi_walker::resolve_search_path(&path).map_err(crate::iofs::map_walker_error)?;
		let follow = resolve_symlink_follow(
			follow_dir_symlinks.unwrap_or(false),
			symlink_boundary.as_deref(),
			&root,
		);
		run_list_workspace(
			WorkspaceConfig {
				root,
				max_depth,
				walk_max_depth,
				include_hidden: hidden.unwrap_or(false),
				use_gitignore: gitignore.unwrap_or(true),
				collect_agents_md,
				follow,
			},
			ct,
		)
	})
}
