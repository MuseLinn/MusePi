import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { installCommandHookBridge } from "@musepi/pi-coding-agent/extensibility/hooks/command/bridge";
import { scanScriptHookRoots } from "@musepi/pi-coding-agent/extensibility/hooks/command/scripts";
import { stringArrayFromRow } from "@musepi/pi-coding-agent/extensibility/plugins/row-config";

/**
 * Directory-shaped hooks, mounted as a preset row.
 *
 * MusePi's historical convention (`.claude/hooks/pre|post`, mirrored by the
 * MusePi/Pi providers) is a directory of one script per tool, not an event map.
 * This row makes that convention executable without adding a second protocol:
 * the scan produces the same config the shared engine already runs, so
 * matching, exit-code semantics, context and merging are identical to the
 * Claude Code / Codex bridges.
 */

export const name = "musepi-hooks-scripts";
export const inject = [] as const;
export const provide = [] as const;

interface RowConfig {
	roots?: unknown;
	python?: unknown;
	defaultTimeoutMs?: unknown;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

async function shellForHooks(): Promise<string> {
	try {
		const settings = await Settings.init();
		const shell = settings.getShellConfig().shell;
		if (shell) return shell;
	} catch {
		// Fall through to the platform default.
	}
	return process.env.SHELL || (process.platform === "win32" ? "bash" : "/bin/sh");
}

export async function apply(ctx: PluginAPI, rowConfig?: RowConfig): Promise<void> {
	const roots = stringArrayFromRow(rowConfig?.roots, "roots").map(root => path.resolve(ctx.cwd, root));
	if (roots.length === 0) return;
	const pythonRaw = text(rowConfig?.python);
	const { config, skipped } = await scanScriptHookRoots(roots, {
		shell: await shellForHooks(),
		...(pythonRaw ? { python: path.resolve(ctx.cwd, pythonRaw) } : {}),
	});
	for (const entry of skipped) ctx.logger.warn(`Hook script skipped (${entry.event}): ${entry.reason}`);
	const timeout =
		typeof rowConfig?.defaultTimeoutMs === "number" && rowConfig.defaultTimeoutMs > 0
			? rowConfig.defaultTimeoutMs
			: 600000;
	installCommandHookBridge(ctx, {
		dialect: "claude-code",
		config,
		shell: await shellForHooks(),
		defaultTimeoutMs: timeout,
	});
}
