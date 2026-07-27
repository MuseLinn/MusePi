#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packages = [
	{ directory: "packages/ai", name: "@musepi/pi-ai" },
	{ directory: "packages/agent", name: "@musepi/pi-agent-core" },
	{ directory: "packages/tui", name: "@musepi/pi-tui" },
	{ directory: "packages/musepi/core", name: "@musepi/core" },
	{ directory: "packages/musepi/transcript", name: "@musepi/transcript" },
	{ directory: "packages/coding-agent", name: "@musepi/coding-agent" },
];

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	const cmd = commandForPlatform(command);
	console.log(`$ ${cmd} ${args.join(" ")}`);
	const isWin = process.platform === "win32";
	const spawnOptions = {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	};
	// Windows: npm.cmd is a batch file; spawnSync needs shell:true to propagate
	// exit codes and stdio correctly, especially for interactive commands (OTP).
	if (isWin) spawnOptions.shell = true;
	const result = spawnSync(cmd, args, spawnOptions);

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${cmd} ${args.join(" ")}\n${output}` : `Command failed: ${cmd} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const cmd = commandForPlatform("npm");
	const args = [`view`, `${name}@${version}`, `version`, `--json`];
	const spawnOpts = {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	};
	if (process.platform === "win32") spawnOpts.shell = true;
	const result = spawnSync(cmd, args, spawnOpts);

	const stdout = result.stdout?.trim() ?? "";
	const stderr = result.stderr?.trim() ?? "";
	const output = [stdout, stderr].filter(Boolean).join("\n");

	// Status 0 + non-empty JSON → published
	if (result.status === 0 && stdout) {
		try {
			const parsed = JSON.parse(stdout);
			if (typeof parsed === "string") return true;
			if (parsed && parsed.error) {
				// npm returns JSON error on 404
				return false;
			}
			return true;
		} catch {}
	}

	// Non-zero status + E404 in output → not published
	if (result.status !== 0 && (output.includes("E404") || output.includes("404"))) {
		return false;
	}

	// On Windows, npm.cmd may exit with null status but still produce output
	if (output.includes("E404") || output.includes("404")) {
		return false;
	}

	// If we got here and have JSON with error, handle gracefully
	if (stdout) {
		try {
			const parsed = JSON.parse(stdout);
			if (parsed?.error?.code === "E404" || parsed?.error?.code === "404") {
				return false;
			}
		} catch {}
	}

	// Treat any other failure as "not published" to avoid blocking publish
	if (result.status !== 0 || result.status === null) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}
	packageVersions.set(pkg.name, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}
