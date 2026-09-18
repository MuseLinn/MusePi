/**
 * Artifact manifest contract — the sidecar file that makes a design-mode
 * product previewable (设计板「Artifact 面板」帧 6/7; docs/gui-design.md §design
 * preset, prompt block `mode:design:artifact`).
 *
 * The design preset teaches agents to emit one manifest per previewable
 * product ("没有 manifest 的产物无法被预览面板识别"). This module is the
 * schema that promise points at: the future preview panel (GUI) and any
 * tooling (export, share) read artifacts THROUGH it, so the contract is
 * validated here, once, instead of re-guessed at every consumer.
 *
 * Shape (v1):
 *   {
 *     "entry":      "index.html",          // relative to the manifest's dir
 *     "kind":       "page",                // page | component | poster | deck
 *     "renderer":   "html",                // html | markdown | react-component | deck-html
 *     "exports":    ["png", "pdf"],        // optional, formats the artifact supports
 *     "title":      "…",                   // optional, panel header (defaults to entry)
 *     "description":"…"                    // optional, one-liner under the title
 *   }
 *
 * File name: `<name>.artifact.json` sitting NEXT TO the entry file (sidecar).
 * Security: entry must be a relative path without `..` — the panel renders
 * from the artifact's directory and must not be able to escape it.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";

export const ARTIFACT_KINDS = ["page", "component", "poster", "deck"] as const;
export const ARTIFACT_RENDERERS = ["html", "markdown", "react-component", "deck-html"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactRenderer = (typeof ARTIFACT_RENDERERS)[number];

export interface ArtifactManifest {
	/** Entry file, relative to the manifest's own directory (no `..`, no absolute). */
	entry: string;
	kind: ArtifactKind;
	renderer: ArtifactRenderer;
	/** Export formats the artifact supports (e.g. ["png", "pdf"]). */
	exports?: string[];
	/** Panel header title; defaults to the entry file name. */
	title?: string;
	/** One-liner shown under the title. */
	description?: string;
}

export interface ValidatedArtifactManifest {
	manifest: ArtifactManifest;
	/** Absolute path of the entry file (manifest dir + entry). */
	entryPath: string;
}

/** Does `dir` hold a sidecar manifest? Returns its path or undefined. */
export function findArtifactManifest(dir: string): string | undefined {
	const sidecar = path.join(dir, "artifact.manifest.json");
	if (existsSync(sidecar)) return sidecar;
	// Also accept the manifest for a single-file artifact: <file>.artifact.json
	// is resolved by callers that know the artifact file; the dir-level scan
	// only needs the canonical name.
	return undefined;
}

/** Read + validate a manifest file. Returns error strings; empty = valid. */
export function validateArtifactManifestFile(manifestPath: string): {
	errors: string[];
	value?: ValidatedArtifactManifest;
} {
	let parsed: unknown;
	try {
		// Lazy require keeps this module importable from the browser-ish side.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		parsed = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { errors: [`manifest is not valid JSON: ${(error as Error).message}`] };
	}
	return validateArtifactManifest(parsed, path.dirname(manifestPath));
}

export function validateArtifactManifest(
	value: unknown,
	dir: string,
): { errors: string[]; value?: ValidatedArtifactManifest } {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null) {
		return { errors: ["manifest must be a JSON object"] };
	}
	const m = value as Record<string, unknown>;

	const entry = m.entry;
	// Normalize backslashes first: on POSIX hosts `path.isAbsolute("C:\\evil")`
	// is false (backslash is not a separator there), but the manifest may be
	// written by a Windows client — treat both separators and both platform
	// absolute forms as absolute.
	const entryNorm = typeof entry === "string" ? entry.replace(/\\/g, "/") : "";
	if (typeof entry !== "string" || entry.length === 0) {
		errors.push("entry is required (relative path to the preview entry file)");
	} else if (
		path.isAbsolute(entryNorm) ||
		path.win32.isAbsolute(entryNorm) ||
		entryNorm.split("/").includes("..")
	) {
		errors.push(`entry must stay inside the artifact directory (got "${entry}")`);
	}
	const entryPath = typeof entry === "string" ? path.join(dir, entry) : "";
	if (typeof entry === "string" && entry.length > 0 && errors.length === 0 && !existsSync(entryPath)) {
		errors.push(`entry file does not exist: ${entry}`);
	}

	if (!ARTIFACT_KINDS.includes(m.kind as ArtifactKind)) {
		errors.push(`kind must be one of ${ARTIFACT_KINDS.join(" | ")} (got ${JSON.stringify(m.kind)})`);
	}
	if (!ARTIFACT_RENDERERS.includes(m.renderer as ArtifactRenderer)) {
		errors.push(`renderer must be one of ${ARTIFACT_RENDERERS.join(" | ")} (got ${JSON.stringify(m.renderer)})`);
	}

	if (m.exports !== undefined) {
		if (!Array.isArray(m.exports) || m.exports.some(e => typeof e !== "string")) {
			errors.push("exports must be an array of strings");
		}
	}
	for (const key of ["title", "description"] as const) {
		if (m[key] !== undefined && typeof m[key] !== "string") {
			errors.push(`${key} must be a string when present`);
		}
	}

	if (errors.length > 0) return { errors };
	return {
		errors: [],
		value: {
			manifest: {
				entry: entry as string,
				kind: m.kind as ArtifactKind,
				renderer: m.renderer as ArtifactRenderer,
				exports: m.exports as string[] | undefined,
				title: m.title as string | undefined,
				description: m.description as string | undefined,
			},
			entryPath,
		},
	};
}
