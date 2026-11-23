#!/usr/bin/env bun

/**
 * Compile every bundled plugin package into its own `lib/`.
 *
 * A plugin package declares `main: ./lib/index.js` — the same shape a published
 * plugin has — while the session loader reads its `src/` entry during
 * development. The `lib` output is what makes the manifest true: without it a
 * pack or a publish ships a package whose entry does not exist.
 *
 * Each package is a project that references the host's declaration project
 * (`tsconfig.plugin-host.json`), so `tsgo -b` builds the host once and every
 * package checks only its own sources. Building the host first is therefore not
 * optional bookkeeping: it is what keeps the host's internal graph from being
 * re-checked sixty-three times.
 *
 * `--check` verifies the expected outputs exist without rebuilding.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dir, "..");
const pluginsRoot = join(pkgRoot, "src", "plugins");
const hostProject = join(pkgRoot, "tsconfig.plugin-host.json");

interface PackageInfo {
	domain: string;
	name: string;
	dir: string;
	main?: string;
	types?: string;
}

function readPackageInfo(dir: string, domain: string, name: string): PackageInfo {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
		main?: string;
		types?: string;
	};
	return { domain, name, dir, main: manifest.main, types: manifest.types };
}

/** Every plugin package, whether it sits at `<root>/<pkg>` or `<root>/<domain>/<pkg>`. */
function pluginPackages(root: string): PackageInfo[] {
	const out: PackageInfo[] = [];
	for (const entry of readdirSync(root)) {
		const candidate = join(root, entry);
		if (!statSync(candidate).isDirectory()) continue;
		if (existsSync(join(candidate, "package.json"))) {
			out.push(readPackageInfo(candidate, "", entry));
			continue;
		}
		for (const nested of readdirSync(candidate)) {
			const pkgDir = join(candidate, nested);
			if (statSync(pkgDir).isDirectory() && existsSync(join(pkgDir, "package.json"))) {
				out.push(readPackageInfo(pkgDir, entry, nested));
			}
		}
	}
	return out;
}

const checkOnly = process.argv.includes("--check");
const packages = pluginPackages(pluginsRoot);
if (packages.length === 0) throw new Error(`no plugin packages under ${pluginsRoot}`);

if (!existsSync(hostProject)) throw new Error(`missing host project: ${hostProject}`);

const failures: Array<{ label: string; output: string }> = [];

/** Run one build step, capturing both streams so a failure names its package. */
function build(dir: string, label: string, project?: string): boolean {
	const result = Bun.spawnSync(["bunx", "tsgo", "-b", ...(project ? [project] : [])], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (result.exitCode === 0) return true;
	failures.push({ label, output: output.slice(0, 800) });
	return false;
}

if (!checkOnly) {
	// The host first: every package references it, and an out-of-date host would
	// make each package rebuild it in turn.
	if (!build(pkgRoot, "<host declarations>", hostProject)) {
		report();
		process.exit(1);
	}
	for (const pkg of packages) build(pkg.dir, pkg.domain ? `${pkg.domain}/${pkg.name}` : pkg.name);
	report();
	process.exit(failures.length === 0 ? 0 : 1);
}

// --check: every declared runtime and type entry must exist.
const missing = packages.flatMap(pkg => {
	const entries = [
		{ kind: "main", entry: pkg.main ?? "./lib/index.js" },
		...(pkg.types ? [{ kind: "types", entry: pkg.types }] : []),
	];
	return entries
		.filter(({ entry }) => !existsSync(join(pkg.dir, entry)))
		.map(({ kind, entry }) => ({
			label: pkg.domain ? `${pkg.domain}/${pkg.name}` : pkg.name,
			output: `missing ${kind} entry: ${entry}`,
		}));
});
failures.push(...missing);
report();
process.exit(failures.length === 0 ? 0 : 1);

function report(): void {
	if (failures.length === 0) {
		const mode = checkOnly ? "verified" : "built";
		process.stdout.write(`plugins: ${mode} ${packages.length} package(s)\n`);
		return;
	}
	for (const failure of failures) {
		process.stderr.write(`\nplugin ${failure.label} failed:\n${failure.output}\n`);
	}
	process.stderr.write(
		`\nplugin build failed for ${new Set(failures.map(failure => failure.label)).size} of ${packages.length} package(s)\n`,
	);
}
