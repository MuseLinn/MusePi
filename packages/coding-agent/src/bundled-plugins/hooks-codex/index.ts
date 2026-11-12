import * as path from "node:path";
import { Settings } from "../../config/settings";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { installCommandHookBridge } from "../../extensibility/hooks/command/bridge";
import { loadHookConfigFile } from "../../extensibility/hooks/command/load";

/**
 * Codex command hooks, mounted as a preset row.
 *
 * Same protocol core as the Claude bridge; only the matcher mode (always
 * unanchored regex) and the absence of `${…}` substitution differ. Codex's five
 * events are the same five this host bridges.
 */

export const name = "musepi-hooks-codex";
export const inject = [] as const;
export const provide = [] as const;

interface RowConfig {
	configPath?: unknown;
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

export async function apply(ctx: ExtensionAPI, rowConfig?: RowConfig): Promise<void> {
	ctx.setLabel("Codex Hooks");
	const configPath = text(rowConfig?.configPath);
	if (configPath === "") return;
	const file = path.resolve(ctx.cwd, configPath);
	const { parsed, error } = await loadHookConfigFile(file, "codex");
	if (error || !parsed) {
		ctx.logger.warn(error ?? `hook config ${file} is empty`);
		return;
	}
	for (const skipped of parsed.skipped) {
		ctx.logger.warn(`Codex hook skipped (${skipped.event}): ${skipped.reason}`);
	}
	const timeout =
		typeof rowConfig?.defaultTimeoutMs === "number" && rowConfig.defaultTimeoutMs > 0
			? rowConfig.defaultTimeoutMs
			: 600000;
	installCommandHookBridge(ctx, {
		dialect: "codex",
		config: parsed.config,
		shell: await shellForHooks(),
		defaultTimeoutMs: timeout,
	});
}
