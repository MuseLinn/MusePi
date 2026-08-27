// ============================================================
// Assembly verification — turns a LoadExtensionsResult into a
// fail-loud or degraded report based on the assembly manifest.
//
// Managed extensions (those declared in the manifest's include list)
// whose load errors are surfaced as fatal when degraded_ok=false.
// Unmanaged extensions remain soft-fail with a warning visible in
// /assembly status (never silent).
//
// The filter() function prunes the discovered extension path list
// according to manifest include/exclude patterns + settings.disabledExtensions.
// ============================================================

import type { Settings } from "../config/settings.ts";
import type { LoadExtensionsResult } from "../extensibility/extensions/types.ts";
import { extensionIdOf } from "../sdk.ts";
import type { AssemblyExtensionError, AssemblyManifest, AssemblyVerifyReport, Surface } from "./types.ts";

export interface AssemblySessionState {
	manifest: AssemblyManifest | null;
	manifestPath: string | null;
	surface: Surface;
	lastVerify: AssemblyVerifyReport | null;
}

const SESSION_STATE: AssemblySessionState = {
	manifest: null,
	manifestPath: null,
	surface: "headless",
	lastVerify: null,
};

export function getSessionState(): AssemblySessionState {
	return SESSION_STATE;
}

/**
 * Map discovered extension paths → ids with error tracking.
 * Used by verify() and filter().
 */
interface ExtensionEntry {
	id: string;
	path: string;
	error: string | null;
}

function collectEntries(result: LoadExtensionsResult): ExtensionEntry[] {
	const entries: ExtensionEntry[] = [];
	for (const ext of result.extensions ?? []) {
		const id = extensionIdOf(ext.resolvedPath ?? ext.path ?? "");
		entries.push({ id, path: ext.resolvedPath ?? ext.path ?? "", error: null });
	}
	for (const err of result.errors ?? []) {
		entries.push({ id: extensionIdOf(err.path), path: err.path, error: err.error });
	}
	return entries;
}

/**
 * Apply assembly filters to an extension path list:
 *   - disabledExtensions from settings (preserved)
 *   - manifest extensions.exclude (id-based globs)
 *   - manifest extensions.include (if present → whitelist)
 *   - manifest extensions.patterns (path globs)
 */
export function filterExtensionPaths(paths: string[], manifest: AssemblyManifest | null, settings: Settings): string[] {
	if (
		!manifest ||
		((manifest.extensions.include?.length ?? 0) === 0 &&
			(manifest.extensions.exclude?.length ?? 0) === 0 &&
			!manifest.extensions.patterns?.length)
	) {
		// No filters configured — fall back to settings.disabledExtensions only
		const disabled = new Set(settings.get("disabledExtensions") ?? []);
		return paths.filter(p => {
			const id = extensionIdOf(p);
			return !disabled.has(id);
		});
	}

	const disabled = new Set(settings.get("disabledExtensions") ?? []);
	const excludeIds = new Set(manifest.extensions.exclude ?? []);
	const excludeGlobs = (manifest.extensions.exclude ?? []).filter(e => e.includes("*"));
	const excludeMatchers = compileGlobs(excludeGlobs);
	const includeIds = (manifest.extensions.include?.length ?? 0) > 0 ? new Set(manifest.extensions.include) : null;
	const patterns = manifest.extensions.patterns ?? [];
	const matchedPatterns = patterns.length > 0 ? compileGlobs(patterns) : null;

	return paths.filter(p => {
		const id = extensionIdOf(p);
		if (disabled.has(id) || excludeIds.has(id)) return false;
		if (excludeMatchers.length > 0 && excludeMatchers.some(fn => fn(id))) return false;
		if (includeIds !== null && !includeIds.has(id)) return false;
		if (matchedPatterns && !patternsMatch(p, matchedPatterns)) return false;
		return true;
	});
}

/** Compile include/exclude glob patterns into a matcher.
 *  Supports *suffix, prefix*, *suffix* and literal substring (id-based). */
function compileGlobs(patterns: string[]): Array<(p: string) => boolean> {
	const out: Array<(p: string) => boolean> = [];
	for (const pat of patterns) {
		const lower = pat.toLowerCase();
		if (lower.startsWith("*") && lower.endsWith("*") && lower.length > 2) {
			const middle = lower.slice(1, -1);
			out.push((p: string) => p.toLowerCase().includes(middle));
		} else if (lower.endsWith("*") && lower.length > 1) {
			const prefix = lower.slice(0, -1);
			out.push((p: string) => p.toLowerCase().startsWith(prefix));
		} else if (lower.startsWith("*") && lower.length > 1) {
			const suffix = lower.slice(1);
			out.push((p: string) => p.toLowerCase().endsWith(suffix));
		} else {
			out.push((p: string) => p.toLowerCase().includes(lower));
		}
	}
	return out;
}

function patternsMatch(p: string, matchers: Array<(p: string) => boolean>): boolean {
	// Any matcher returning true counts as a match.
	return matchers.some(fn => fn(p));
}

/**
 * Verify a LoadExtensionsResult against the assembly manifest.
 *
 * Returns a report suitable for logging/display. When managed extension
 * errors exist and degraded_ok=false, the caller should throw
 * AssemblyVerifyError so the session refuses to start.
 */
export function verifyExtensionLoad(
	result: LoadExtensionsResult,
	manifest: AssemblyManifest | null,
	surface: Surface,
): AssemblyVerifyReport {
	const entries = collectEntries(result);
	const managedIds = new Set(manifest?.extensions.include ?? []);
	const fatal: AssemblyExtensionError[] = [];
	const warnings: AssemblyExtensionError[] = [];

	for (const entry of entries) {
		if (!entry.error) continue;
		const isManaged = entry.id && managedIds.size > 0 && managedIds.has(entry.id);
		const issue: AssemblyExtensionError = {
			id: entry.id,
			path: entry.path,
			error: entry.error,
		};
		if (isManaged && !manifest?.degradedOk) {
			fatal.push(issue);
		} else {
			warnings.push(issue);
		}
	}

	const ok = manifest === null || fatal.length === 0;
	return {
		ok,
		fatalIssues: fatal,
		warnings,
		manifestPath: null, // filled by caller
		surface,
		managedIds,
	};
}

/** Throw when there are fatal (managed) extension load errors. */
export class AssemblyVerifyError extends Error {
	constructor(report: AssemblyVerifyReport, manifestPath: string | null) {
		super(buildVerifyErrorMessage(report, manifestPath));
		this.name = "AssemblyVerifyError";
		(this as Error).stack = new Error().stack;
	}
}

function buildVerifyErrorMessage(report: AssemblyVerifyReport, manifestPath: string | null): string {
	const lines = [`[assembly] boot failed (${report.fatalIssues.length} managed extension errors)`];
	if (manifestPath) lines.push(`  manifest: ${manifestPath}`);
	lines.push(`  surface: ${report.surface}`);
	for (const issue of report.fatalIssues) {
		lines.push(`  managed error: ${issue.id} @ ${issue.path}`);
		lines.push(`    ${issue.error.split("\n")[0]}`);
	}
	if (report.warnings.length > 0) {
		lines.push(`  ${report.warnings.length} unmanaged warning(s) — run /assembly or musepi assembly status`);
	}
	return lines.join("\n");
}
