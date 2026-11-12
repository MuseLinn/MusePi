import * as path from "node:path";
import { Settings } from "../../config/settings";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { installCommandHookBridge } from "../../extensibility/hooks/command/bridge";
import { loadHookConfigFile } from "../../extensibility/hooks/command/load";

/**
 * Claude Code command hooks, mounted as a preset row.
 *
 * The row names a `hooks.json` (or a settings file carrying `hooks`). Hooks run
 * once per session through the shared command engine; the row can be omitted
 * to keep a session hook-free. `configPath` is required — there is no implicit
 * discovery, matching the reference bridge.
 */

export const name = "musepi-hooks-claude-code";
export const inject = [] as const;
export const provide = [] as const;

interface RowConfig {
	configPath?: unknown;
	projectDir?: unknown;
	pluginRoot?: unknown;
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
		// Settings unavailable (early boot): fall through to the platform default.
	}
	return process.env.SHELL || (process.platform === "win32" ? "bash" : "/bin/sh");
}

export async function apply(ctx: ExtensionAPI, rowConfig?: RowConfig): Promise<void> {
	ctx.setLabel("Claude Code Hooks");
	const configPath = text(rowConfig?.configPath);
	if (configPath === "") return;
	const file = path.resolve(ctx.cwd, configPath);
	const projectDirRaw = text(rowConfig?.projectDir);
	const projectDir = projectDirRaw === "" ? undefined : path.resolve(ctx.cwd, projectDirRaw);
	const pluginRootRaw = text(rowConfig?.pluginRoot);
	const { parsed, error } = await loadHookConfigFile(file, "claude-code", {
		...(projectDir ? { projectDir } : {}),
		...(pluginRootRaw ? { pluginRoot: path.resolve(ctx.cwd, pluginRootRaw) } : {}),
	});
	if (error || !parsed) {
		ctx.logger.warn(error ?? `hook config ${file} is empty`);
		return;
	}
	for (const skipped of parsed.skipped) {
		ctx.logger.warn(`Claude Code hook skipped (${skipped.event}): ${skipped.reason}`);
	}
	const timeout =
		typeof rowConfig?.defaultTimeoutMs === "number" && rowConfig.defaultTimeoutMs > 0
			? rowConfig.defaultTimeoutMs
			: 600000;
	installCommandHookBridge(ctx, {
		dialect: "claude-code",
		config: parsed.config,
		shell: await shellForHooks(),
		...(projectDir ? { projectDir } : {}),
		defaultTimeoutMs: timeout,
	});
}
