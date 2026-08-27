// ============================================================
// Assembly manifest — musepi.assembly.toml loading & validation
//
// Discovery order (project wins):
//   1. <cwd>/.musepi/assembly.toml  (walking up from cwd)
//   2. <agentDir>/assembly.toml      (active profile agent dir)
//   3. ~/.musepi/assembly.toml       (global user)
//
// Project-level manifests are the primary control surface; global
// provides defaults. Both are deep-merged with project-first precedence
// per-key (arrays concatenate, primitives override).
//
// Validation is strict: unknown sections/keys throw AssemblyManifestError
// so that a typo is always visible rather than silently booting a broken
// product.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { isCompactionMethod } from "../session/compaction-methods.ts";
import type {
	AssemblyManifest,
	AssemblyManifestValidateResult,
	ManifestExtensionItem,
	Surface,
	TerminalProvider,
} from "./types.ts";

export class AssemblyManifestError extends Error {
	constructor(message: string) {
		super(`[assembly] ${message}`);
		this.name = "AssemblyManifestError";
	}
}

// ------------------------------------------------------------
// Parsing
// ------------------------------------------------------------

/** Parse a TOML file via Bun.TOML; returns null if the file doesn't exist. */
async function loadTomlFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const content = await fs.promises.readFile(filePath, "utf8");
		return Bun.TOML.parse(content) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new AssemblyManifestError(`TOML parse failed for ${filePath}: ${String(err)}`);
	}
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

const KNOWN_SURFACES: Surface[] = ["tui", "daemon", "headless", "acp"];
const KNOWN_TERMINAL_PROVIDERS: TerminalProvider[] = ["auto", "bun-pty", "node-pty"];

function isSurface(value: unknown): value is Surface {
	return typeof value === "string" && (KNOWN_SURFACES as string[]).includes(value);
}

function isTerminalProvider(value: unknown): value is TerminalProvider {
	return typeof value === "string" && (KNOWN_TERMINAL_PROVIDERS as string[]).includes(value);
}

function normalizeManifest(raw: Record<string, unknown>): AssemblyManifestValidateResult {
	const errors: AssemblyManifestValidateResult["errors"] = [];
	const validate = (key: string, message: string) => {
		errors.push({ key, message });
	};

	const assembly = (raw.assembly ?? {}) as Record<string, unknown>;
	const extensions = (raw.extensions ?? {}) as Record<string, unknown>;
	const seams = (raw.seams ?? {}) as Record<string, unknown>;

	// [assembly] surface
	const rawSurface = assembly.surface;
	let surface: Surface | null = null;
	if (rawSurface !== undefined) {
		if (isSurface(rawSurface)) {
			surface = rawSurface;
		} else {
			validate(
				"assembly.surface",
				`expected one of ${KNOWN_SURFACES.join(", ")}, got ${JSON.stringify(rawSurface)}`,
			);
		}
	}

	// [assembly] degraded_ok
	const degradedOk = assembly.degraded_ok === true;

	// [assembly] unknown keys
	for (const key of Object.keys(assembly)) {
		if (!["surface", "degraded_ok"].includes(key)) {
			validate(`assembly.${key}`, `unknown key — expected surface or degraded_ok`);
		}
	}

	// [extensions]
	const include: string[] = [];
	const exclude: string[] = [];
	const items: Record<string, ManifestExtensionItem> = {};
	const patterns: string[] = [];

	if (Array.isArray(extensions.include)) {
		for (const v of extensions.include) {
			if (typeof v === "string") include.push(v);
		}
	}
	if (Array.isArray(extensions.exclude)) {
		for (const v of extensions.exclude) {
			if (typeof v === "string") exclude.push(v);
		}
	}
	if (typeof extensions.items === "object" && extensions.items !== null) {
		for (const [k, v] of Object.entries(extensions.items)) {
			if (typeof k === "string" && typeof v === "object" && v !== null) {
				items[k] = v as ManifestExtensionItem;
			}
		}
	}
	if (Array.isArray(extensions.patterns)) {
		for (const v of extensions.patterns) {
			if (typeof v === "string") patterns.push(v);
		}
	}
	for (const key of Object.keys(extensions)) {
		if (!["include", "exclude", "items", "patterns"].includes(key)) {
			validate(`extensions.${key}`, `unknown key — expected include, exclude, items, or patterns`);
		}
	}

	// [seams.terminal]
	const rawTerminal = (seams.terminal ?? {}) as Record<string, unknown>;
	let terminalProvider: TerminalProvider | undefined;
	if (rawTerminal.provider !== undefined) {
		if (isTerminalProvider(rawTerminal.provider)) {
			terminalProvider = rawTerminal.provider;
		} else {
			validate(
				"seams.terminal.provider",
				`expected one of ${KNOWN_TERMINAL_PROVIDERS.join(", ")}, got ${JSON.stringify(rawTerminal.provider)}`,
			);
		}
	}
	for (const key of Object.keys(rawTerminal)) {
		if (!["provider"].includes(key)) {
			validate(`seams.terminal.${key}`, `unknown key — expected provider`);
		}
	}

	// [seams.compaction]
	const rawCompaction = (seams.compaction ?? {}) as Record<string, unknown>;
	let compactionMethod: "handoff" | "remote" | "shake" | "snapcompact" | "soft" | undefined;
	if (rawCompaction.method !== undefined) {
		if (isCompactionMethod(rawCompaction.method)) {
			compactionMethod = rawCompaction.method;
		} else {
			validate(
				"seams.compaction.method",
				`unknown compaction method — call musepi assembly status to see valid methods`,
			);
		}
	}
	for (const key of Object.keys(rawCompaction)) {
		if (!["method"].includes(key)) {
			validate(`seams.compaction.${key}`, `unknown key — expected method`);
		}
	}
	for (const key of Object.keys(seams)) {
		if (!["terminal", "compaction"].includes(key)) {
			validate(`seams.${key}`, `unknown seam — supported: terminal, compaction`);
		}
	}

	const manifest: AssemblyManifest = {
		surface,
		degradedOk,
		extensions: { include, exclude, items, patterns },
		seams: {
			terminal: terminalProvider !== undefined ? { provider: terminalProvider } : undefined,
			compaction: compactionMethod !== undefined ? { method: compactionMethod } : undefined,
		},
	};

	return { valid: errors.length === 0, errors, manifest: errors.length === 0 ? manifest : null };
}

// ------------------------------------------------------------
// Discovery & loading
// ------------------------------------------------------------

interface LoadedLayer {
	path: string;
	raw: Record<string, unknown>;
}

/** Find the project-level assembly.toml by walking up from cwd. */
async function findProjectManifest(cwd: string): Promise<string | null> {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, ".musepi", "assembly.toml");
		try {
			await fs.promises.access(candidate);
			return candidate;
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}
}

/** User-global assembly.toml under ~/.musepi/assembly.toml. */
function userManifestPath(home: string): string {
	return path.join(home, ".musepi", "assembly.toml");
}

/** Merge two raw manifest objects (project wins over global per-key). */
function mergeRaw(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	// Simple merge: top-level keys from b override a; arrays concat; objects recurse.
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		if (!(k in a)) {
			out[k] = v;
			continue;
		}
		const av = a[k];
		if (Array.isArray(av) && Array.isArray(v)) {
			out[k] = [...av, ...v];
		} else if (typeof av === "object" && av !== null && typeof v === "object" && v !== null && !Array.isArray(v)) {
			out[k] = mergeRaw(av as Record<string, unknown>, v as Record<string, unknown>);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/**
 * Load the effective assembly manifest for a boot. Returns null when no
 * manifest exists anywhere (default behavior = all capabilities enabled,
 * degraded_ok=false, no explicit surface).
 */
export async function loadAssemblyManifest(cwd: string, home: string): Promise<AssemblyManifest | null> {
	const [projectRaw, globalRaw] = await Promise.all([
		loadTomlConfig(await findProjectManifest(cwd)),
		loadTomlConfig(userManifestPath(home)),
	]);
	const raw = projectRaw !== null && globalRaw !== null ? mergeRaw(globalRaw, projectRaw) : (projectRaw ?? globalRaw);
	if (!raw) return null;
	const result = normalizeManifest(raw);
	if (!result.valid) {
		const msg = result.errors.map(e => `[${e.key}] ${e.message}`).join("; ");
		throw new AssemblyManifestError(msg);
	}
	return result.manifest!;
}

async function loadTomlConfig(filePath: string | null): Promise<Record<string, unknown> | null> {
	if (!filePath) return null;
	try {
		const content = await fs.promises.readFile(filePath, "utf8");
		return Bun.TOML.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}
