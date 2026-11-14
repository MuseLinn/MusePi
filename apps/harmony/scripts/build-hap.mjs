#!/usr/bin/env node
/**
 * Build the HarmonyOS HAP through the official headless CLI (`devecocli`).
 *
 * The CLI is `@deveco/deveco-cli` (npm, `devecocli` on PATH). It drives
 * hvigor/ohpm/hdc from an installed toolchain:
 *
 *   DevEco Studio   → `DEVECO_CLI_STUDIO_PATH` (default: C:\Program Files\Huawei\DevEco Studio)
 *   Command Line Tools → `DEVECO_CLI_CLT_PATH` (headless SDK + hvigor + hdc)
 *
 * Either satisfies it; the Command Line Tools package is the smaller one and
 * needs no IDE. Both are downloaded from the Huawei download center, which
 * requires a signed-in Huawei developer account — there is no anonymous
 * download for this toolchain.
 *
 * Resolution order: DEVECO_CLI_CLT_PATH / DEVECO_CLI_STUDIO_PATH from the
 * environment, then `local.properties` (gitignored: devecocli.clt.path /
 * devecocli.studio.path), then the default Studio location.
 *
 * Usage: node scripts/build-hap.mjs [--build-mode debug|release] [--product name]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const harmonyRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

/** Default Studio install location that `devecocli` also probes. */
const DEFAULT_STUDIO = join("C:", "Program Files", "Huawei", "DevEco Studio");

/**
 * Local toolchain paths from `local.properties` (gitignored — per machine,
 * exactly like the `sdk.dir` that DevEco itself writes there).
 *
 * The environment variable stays the primary input; this file exists because a
 * shell that predates `setx` (a long-lived terminal, a CI process with a clean
 * environment) otherwise reports "no toolchain" while the toolchain is
 * installed and configured.
 */
function readLocalProperties(names) {
	try {
		const text = readFileSync(join(harmonyRoot, "local.properties"), "utf8");
		const values = {};
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*([^#=]+?)\s*=\s*(.+?)\s*$/.exec(line);
			if (match) values[match[1]] = match[2];
		}
		for (const name of names) {
			if (values[name]) return values[name];
		}
		return undefined;
	} catch {
		return undefined;
	}
}

const env = { ...process.env };
if (!env.DEVECO_CLI_CLT_PATH && !env.DEVECO_CLI_STUDIO_PATH) {
	const cltPath = readLocalProperties(["devecocli.clt.path", "DEVECO_CLI_CLT_PATH"]);
	const studioPath = readLocalProperties(["devecocli.studio.path", "DEVECO_CLI_STUDIO_PATH"]);
	if (cltPath) env.DEVECO_CLI_CLT_PATH = cltPath;
	else if (studioPath) env.DEVECO_CLI_STUDIO_PATH = studioPath;
}
if (!env.DEVECO_CLI_CLT_PATH && !env.DEVECO_CLI_STUDIO_PATH && existsSync(DEFAULT_STUDIO)) {
	env.DEVECO_CLI_STUDIO_PATH = DEFAULT_STUDIO;
}

if (!env.DEVECO_CLI_CLT_PATH && !env.DEVECO_CLI_STUDIO_PATH) {
	console.error(
		[
			"[build-hap] No HarmonyOS toolchain found.",
			"  Install one of:",
			"    - Command Line Tools (preferred, headless): set DEVECO_CLI_CLT_PATH to its root",
			"    - DevEco Studio:                            set DEVECO_CLI_STUDIO_PATH to its root",
			"  Both come from https://developer.huawei.com/consumer/cn/download/ (Huawei account required).",
			`  Expected Studio default: ${DEFAULT_STUDIO}`,
			"",
			"  Then rerun: node scripts/build-hap.mjs",
		].join("\n"),
	);
	process.exit(1);
}

const bin = process.platform === "win32" ? "devecocli.cmd" : "devecocli";
const result = spawnSync(bin, ["build", ...(args.length > 0 ? args : [])], {
	cwd: harmonyRoot,
	env,
	stdio: "inherit",
	shell: process.platform === "win32",
});

if (result.error) {
	console.error(
		`[build-hap] could not run devecocli (${result.error.message}).\n` +
			"  Install it with: npm i -g @deveco/deveco-cli",
	);
	process.exit(1);
}
process.exit(result.status ?? 1);
