/**
 * System information collection for debug reports.
 */

import * as os from "node:os";
import { getPackageDir, VERSION } from "../config.ts";
import { formatBytes } from "../extensions/llama/client.ts";

export interface SystemInfo {
	os: string;
	arch: string;
	cpu: string;
	memory: {
		total: string;
		free: string;
		usedPercent: string;
	};
	versions: {
		node: string;
		bun: string | undefined;
		package: string;
	};
	cwd: string;
	shell: string;
	terminal: string | undefined;
}

/** Map Darwin kernel major version to macOS marketing name. */
function macosMarketingName(release: string): string | undefined {
	const major = Number.parseInt(release.split(".")[0] ?? "", 10);
	if (Number.isNaN(major)) return undefined;
	const names: Record<number, string> = {
		24: "Sequoia",
		23: "Sonoma",
		22: "Ventura",
		21: "Monterey",
		20: "Big Sur",
		19: "Catalina",
		18: "Mojave",
	};
	return names[major];
}

/** Collect system information */
export async function collectSystemInfo(): Promise<SystemInfo> {
	let cpuModel = "Unknown CPU";
	try {
		cpuModel = os.cpus()[0]?.model ?? cpuModel;
	} catch {
		// Keep debug report collection best-effort when CPU probing fails.
	}

	// Try to get shell from environment
	const shell = process.env.SHELL ?? process.env.ComSpec ?? "unknown";
	const terminal = process.env.TERM_PROGRAM ?? process.env.TERM ?? undefined;

	const totalMem = os.totalmem();
	const freeMem = os.freemem();
	const usedPercent = totalMem > 0 ? `${((1 - freeMem / totalMem) * 100).toFixed(1)}%` : "?";

	let osStr = `${os.type()} ${os.release()} (${os.platform()})`;
	if (os.platform() === "darwin") {
		const marketing = macosMarketingName(os.release());
		if (marketing) {
			osStr += ` — macOS ${marketing}`;
		}
	}

	return {
		os: osStr,
		arch: os.arch(),
		cpu: cpuModel,
		memory: {
			total: formatBytes(totalMem),
			free: formatBytes(freeMem),
			usedPercent,
		},
		versions: {
			node: process.versions.node,
			bun: process.versions.bun,
			package: VERSION,
		},
		cwd: process.cwd(),
		shell,
		terminal,
	};
}

/** Format system info for display */
export function formatSystemInfo(info: SystemInfo): string {
	const pkgDir = getPackageDir();
	return [
		`OS:      ${info.os}`,
		`Arch:    ${info.arch}`,
		`CPU:     ${info.cpu}`,
		`Memory:  ${info.memory.usedPercent} used (${info.memory.free} free / ${info.memory.total} total)`,
		``,
		`Node:    ${info.versions.node}`,
		`Bun:     ${info.versions.bun ?? "N/A"}`,
		`Package: ${info.versions.package}`,
		``,
		`CWD:     ${info.cwd}`,
		`Shell:   ${info.shell}`,
		`Term:    ${info.terminal ?? "N/A"}`,
		`PkgDir:  ${pkgDir}`,
	].join("\n");
}
