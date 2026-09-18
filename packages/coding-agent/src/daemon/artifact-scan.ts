import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifactManifestFile } from "../presets/artifact-manifest";
import { resolveInCwd } from "./fs-ops";

/**
 * Workspace artifact discovery for the GUI Artifacts panel (设计板 W3).
 *
 * The design preset teaches agents to drop an `artifact.manifest.json`
 * sidecar next to every previewable product (mode:design:artifact). This
 * module is the daemon-side consumer: it scans the workspace for those
 * sidecars, validates each one through the shared contract module, and
 * reads the entry file a viewer needs — so the GUI never re-guesses the
 * manifest shape or re-implements the path-escape guards.
 *
 * Security: everything is cwd-relative. Scans never leave the workspace
 * root, entry reads go through resolveInCwd (`..` and absolute paths are
 * rejected), and text reads are capped like fs.read.
 */

/** Manifest file name fixed by the design preset contract. */
const MANIFEST_NAME = "artifact.manifest.json";

/** Directories a workspace scan never descends into. */
const SCAN_SKIP = new Set([
	"node_modules",
	".git",
	".svn",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".turbo",
	"coverage",
]);

/** Text read cap for entry contents (fs.read parity: 512 KiB). */
const ENTRY_READ_MAX_BYTES = 512 * 1024;

/** One discovered artifact: manifest fields flattened for the panel. */
export interface WorkspaceArtifact {
	/** Manifest's directory, relative to the workspace root (`/`-separated). */
	dir: string;
	/** Final path segment of `dir` — the artifact's display name fallback. */
	dirName: string;
	/** Panel header title (manifest.title ?? entry file name). */
	title: string;
	/** Entry file relative to `dir` (verbatim from the manifest). */
	entry: string;
	kind: string;
	renderer: string;
	exports?: string[];
	description?: string;
	/** Manifest validation errors — a broken manifest is LISTED (with its
	 *  errors) instead of silently dropped, so the agent's mistake is
	 *  visible and fixable from the panel. */
	errors?: string[];
}

export interface ArtifactScanResult {
	/** Workspace root the scan ran against. */
	rootPath: string;
	/** `true` when the depth cap cut the walk short. */
	truncated: boolean;
	artifacts: WorkspaceArtifact[];
}

/** Validate `rel` as a cwd-relative, non-escaping path; null on escape. */
function safeRel(cwd: string, rel: string): string | null {
	if (!rel || rel.includes("\0")) return null;
	if (rel.replace(/\\/g, "/").split("/").includes("..")) return null;
	return resolveInCwd(cwd, rel);
}

/**
 * Scan the workspace for artifact manifests. Depth cap 4 mirrors the file
 * pane's tree depth: products live near the project root, and a deep walk
 * over a monorepo is wasted work the panel never shows.
 */
export function scanWorkspaceArtifacts(cwd: string, maxDepth = 4): ArtifactScanResult {
	const rootPath = path.resolve(cwd);
	const artifacts: WorkspaceArtifact[] = [];
	let truncated = false;

	const push = (absDir: string, relDir: string): void => {
		try {
			const { errors, value } = validateArtifactManifestFile(path.join(absDir, MANIFEST_NAME));
			if (!value) {
				artifacts.push({
					dir: relDir,
					dirName: path.basename(absDir),
					title: path.basename(absDir),
					entry: "",
					kind: "",
					renderer: "",
					errors: errors.length > 0 ? errors : ["manifest is invalid"],
				});
				return;
			}
			const { manifest, entryPath } = value;
			artifacts.push({
				dir: relDir,
				dirName: path.basename(absDir),
				title: manifest.title?.trim() || path.basename(entryPath),
				entry: manifest.entry,
				kind: manifest.kind,
				renderer: manifest.renderer,
				exports: manifest.exports,
				description: manifest.description,
			});
		} catch {
			// stat/read race — the manifest vanished mid-scan; skip it
		}
	};

	const walk = (dir: string, rel: string, depth: number): void => {
		if (depth > maxDepth) {
			truncated = true;
			return;
		}
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable / vanished — skip
		}
		if (dirents.some(d => d.isFile() && d.name === MANIFEST_NAME)) {
			push(dir, rel);
		}
		for (const d of dirents) {
			if (!d.isDirectory()) continue;
			if (SCAN_SKIP.has(d.name) || d.name.startsWith(".")) continue;
			const childAbs = path.join(dir, d.name);
			// Symlinked dirs may point outside the workspace — a stat on the
			// target keeps the walk from following escapes.
			try {
				if (!fs.statSync(childAbs).isDirectory()) continue;
			} catch {
				continue;
			}
			walk(childAbs, rel ? `${rel}/${d.name}` : d.name, depth + 1);
		}
	};

	walk(rootPath, "", 1);
	return { rootPath, truncated, artifacts };
}

/**
 * Read an artifact's entry file as UTF-8 text for the panel viewer.
 * `dir` and `entry` both come from (agent-authored) manifest data, so each
 * is re-validated as a cwd-relative path before the join — the manifest
 * declaring `entry: "../../../etc/passwd"` must not resolve.
 */
export function readArtifactEntryText(
	cwd: string,
	dir: string,
	entry: string,
): { text: string; truncated: boolean } | { error: string } {
	const absDir = safeRel(cwd, dir);
	if (!absDir) return { error: "artifact dir escapes workspace" };
	const absEntry = safeRel(absDir, entry);
	if (!absEntry) return { error: "entry escapes artifact directory" };
	try {
		const st = fs.statSync(absEntry);
		if (!st.isFile()) return { error: "entry is not a file" };
		if (st.size > ENTRY_READ_MAX_BYTES) {
			const text = fs.readFileSync(absEntry, "utf8").slice(0, ENTRY_READ_MAX_BYTES);
			return { text, truncated: true };
		}
		return { text: fs.readFileSync(absEntry, "utf8"), truncated: false };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
