// ============================================================
// `musepi assembly` CLI — inspect/verify the assembly manifest and
// surface resolution. Static-only (no session required), so it can
// be run at any time against the current cwd.
// ============================================================

import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { Command } from "@musepi/pi-utils/cli";
import { AssemblyManifestError, assemblySessionState, filterExtensionPaths } from "../assembly/index.ts";
import { loadAssemblyManifest } from "../assembly/manifest.ts";
import { Settings as SettingsClass } from "../config/settings.ts";
import { discoverSessionExtensionPaths } from "../sdk.ts";

export default class Index extends Command {
	static description = "Inspect the musepi assembly manifest and surface configuration";
	static hidden = false;
	static strict = false;

	async run(): Promise<void> {
		const sub = (this.argv[0] ?? "status").toLowerCase();
		const cwd = process.cwd();
		const home = os.homedir();

		switch (sub) {
			case "status":
				await this.cmdStatus(cwd, home);
				break;
			case "verify":
				await this.cmdVerify(cwd, home);
				break;
			default:
				process.stderr.write(`Unknown subcommand: ${sub}\n`);
				process.stderr.write("Usage: musepi assembly [status|verify]\n");
				process.exitCode = 2;
				return;
		}
	}

	private async cmdStatus(cwd: string, home: string): Promise<void> {
		let manifest: import("../assembly/types.ts").AssemblyManifest | null = null;
		let manifestPath: string | null = null;
		try {
			manifest = await loadAssemblyManifest(cwd, home);
			manifestPath = manifest ? this.findManifestPath(cwd, home) : null;
		} catch (err) {
			const msg = err instanceof AssemblyManifestError ? err.message : String(err);
			process.stderr.write(`[assembly] manifest parse error: ${msg}\n`);
			process.exitCode = 1;
			return;
		}

		const lines: string[] = [];
		lines.push("surface: auto (depends on --mode)");
		lines.push(`manifest: ${manifestPath ?? "(none — defaults apply)"}`);
		if (manifest) {
			lines.push(`degraded_ok: ${manifest.degradedOk}`);
			if (manifest.seams.terminal?.provider) lines.push(`terminal.provider: ${manifest.seams.terminal.provider}`);
			if (manifest.seams.compaction?.method) lines.push(`compaction.method: ${manifest.seams.compaction.method}`);
			if (manifest.extensions.include?.length)
				lines.push(`extensions.include: [${manifest.extensions.include.join(", ")}]`);
			if (manifest.extensions.exclude?.length)
				lines.push(`extensions.exclude: [${manifest.extensions.exclude.join(", ")}]`);
		} else {
			lines.push("no manifest — all extensions unmanaged (soft-fail)");
		}

		const existing = assemblySessionState.lastVerify;
		if (existing) {
			const nFatal = existing.fatalIssues.length;
			const nWarn = existing.warnings.length;
			lines.push(`boot: ${existing.ok ? "OK" : `FAILED (${nFatal} managed errors, ${nWarn} warnings)`}`);
		} else {
			lines.push("boot: not yet verified (this command is static — run musepi launch to verify)");
		}
		process.stdout.write(lines.join("\n") + "\n");
	}

	private async cmdVerify(cwd: string, home: string): Promise<void> {
		let manifest: import("../assembly/types.ts").AssemblyManifest | null = null;
		try {
			manifest = await loadAssemblyManifest(cwd, home);
		} catch (err) {
			const msg = err instanceof AssemblyManifestError ? err.message : String(err);
			process.stderr.write(`[assembly] manifest parse error: ${msg}\n`);
			process.exitCode = 1;
			return;
		}

		// Discover current extension paths to validate manifest selectors.
		const { Settings: S } = await import("../config/settings.ts");
		const resolved = await S.init({ cwd, agentDir: getAgentDir() });
		const paths = await discoverSessionExtensionPaths({}, cwd, resolved);
		const filtered = filterExtensionPaths(paths, manifest, resolved);
		const removed = new Set(paths.filter(p => !filtered.includes(p)));

		const lines: string[] = [];
		lines.push(`discovered: ${paths.length} extensions`);
		lines.push(`filtered:   ${filtered.length} extensions`);
		if (removed.size > 0) {
			lines.push(`excluded:   ${removed.size}`);
		}
		lines.push(`manifest: ${manifest ? "valid" : "(none — using defaults)"}`);
		if (manifest?.seams.terminal?.provider) lines.push(`terminal.provider: ${manifest.seams.terminal.provider}`);
		if (manifest?.seams.compaction?.method) {
			lines.push(`compaction.method: ${manifest.seams.compaction.method} (known)`);
		}
		process.stdout.write(lines.join("\n") + "\n");
	}

	private findManifestPath(cwd: string, home: string): string | null {
		const project = path.join(cwd, ".musepi", "assembly.toml");
		if (fsSync.existsSync(project)) return project;
		const agentDir = getAgentDir();
		if (agentDir) {
			const agentPath = path.join(agentDir, "assembly.toml");
			if (fsSync.existsSync(agentPath)) return agentPath;
		}
		const user = path.join(home, ".musepi", "assembly.toml");
		return fsSync.existsSync(user) ? user : null;
	}
}

import * as fsSync from "node:fs";
