import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommandHook, CommandHookConfig, SkippedHook } from "./types";

/**
 * Directory-shaped command hooks (MusePi's own compat surface): a root holds
 * `pre/` and `post/` directories, one script per tool name
 * (`pre/bash.sh`, `post/edit.py`). `pre` maps to PreToolUse, `post` to
 * PostToolUse, and the file stem is the matcher — `*` (or `all`) means every
 * tool.
 *
 * This is NOT a dialect bridge: the reference Claude/Codex formats are JSON
 * event maps, while these directories are MusePi's historical convention. The
 * scan produces the same {@link CommandHookConfig} the shared engine already
 * runs, so both shapes share matching, execution, decoding and merging —
 * adding a third source does not add a third protocol.
 */

export interface ScriptHookOptions {
	/** Shell used to execute `.sh`/`.bash` scripts. */
	shell: string;
	/** Python executable for `.py` scripts; omitted = Python skipped. */
	python?: string;
}

const PRE = "pre";
const POST = "post";

function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Command line for one script, or null when the extension is unsupported. */
export function commandForScript(file: string, options: ScriptHookOptions): string | null {
	const ext = path.extname(file).toLowerCase();
	if (ext === ".sh" || ext === ".bash") return `${quote(options.shell)} ${quote(file)}`;
	if (ext === ".py" && options.python) return `${quote(options.python)} ${quote(file)}`;
	return null;
}

function matcherFor(stem: string): string | undefined {
	return stem === "*" || stem === "all" ? undefined : stem;
}

async function scanDir(
	dir: string,
	point: "PreToolUse" | "PostToolUse",
	options: ScriptHookOptions,
	config: CommandHookConfig,
	skipped: SkippedHook[],
): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names.sort()) {
		const file = path.join(dir, name);
		let isFile = false;
		try {
			isFile = (await fs.stat(file)).isFile();
		} catch {
			continue;
		}
		if (!isFile) continue;
		const command = commandForScript(file, options);
		if (command === null) {
			skipped.push({ event: point, reason: `unsupported script ${path.basename(file)}` });
			continue;
		}
		const hook: CommandHook = { command };
		const matcher = matcherFor(path.basename(name, path.extname(name)));
		const groups = config[point] ?? [];
		config[point] = groups;
		groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: [hook] });
	}
}

/** Scan one root's pre/post directories into the shared config shape. */
export async function scanScriptHookRoot(
	root: string,
	options: ScriptHookOptions,
): Promise<{ config: CommandHookConfig; skipped: SkippedHook[] }> {
	const config: CommandHookConfig = {};
	const skipped: SkippedHook[] = [];
	await scanDir(path.join(root, PRE), "PreToolUse", options, config, skipped);
	await scanDir(path.join(root, POST), "PostToolUse", options, config, skipped);
	return { config, skipped };
}

/** Merge several roots into one config (root order preserved). */
export async function scanScriptHookRoots(
	roots: readonly string[],
	options: ScriptHookOptions,
): Promise<{ config: CommandHookConfig; skipped: SkippedHook[] }> {
	const merged: CommandHookConfig = {};
	const skipped: SkippedHook[] = [];
	for (const root of roots) {
		const result = await scanScriptHookRoot(root, options);
		for (const point of Object.keys(result.config) as Array<keyof CommandHookConfig>) {
			merged[point] = [...(merged[point] ?? []), ...(result.config[point] ?? [])];
		}
		skipped.push(...result.skipped);
	}
	return { config: merged, skipped };
}
