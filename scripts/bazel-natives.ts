#!/usr/bin/env bun
/**
 * Canonical Bazel driver for the shipping pi_natives addons.
 *
 * Usage: bun scripts/bazel-natives.ts <target>... [--dest <dir>] [--source <dir>] [-- <extra bazel args>]
 *
 * Targets are the //:natives-* names from BUILD.bazel (e.g. linux-x64-baseline,
 * darwin-arm64) plus three pseudo-targets:
 *   - host        the single addon matching this machine (x64 hosts pick
 *                 modern vs baseline via AVX2 detection)
 *   - linux-all   every addon buildable from a linux-x64 host (incl. win32)
 *   - darwin-all  both darwin addons (mac hosts only)
 *
 * One `bazel build` covers all requested targets; outputs are located via
 * `bazel cquery --output=files` (falling back to the bazel-bin path convention)
 * and copied dereferenced into --dest (default packages/natives/native).
 *
 * Extra args after `--` are passed to bazel verbatim (cache configs, endpoints,
 * headers — see .bazelrc for the cache-rw/cache-ro policy configs).
 *
 * Windows hosts: the msvc cc toolchain in bazel/toolchains/msvc only supports
 * linux/mac exec hosts (its clang-cl+xwin wrappers replace the MSVC a Windows
 * box already has), so a win32 host cannot run any bazel addon build. The
 * `host` pseudo-target instead delegates to the local napi build
 * (packages/natives/scripts/build-bindings.ts) against the installed VS Build
 * Tools; every other target on a win32 host fails fast with guidance.
 *
 * Set `OMP_NATIVE_BUILD_BACKEND=cargo` to route the host target through the
 * same local N-API build on systems where Bazel's prebuilt host tools cannot run.
 *
 * Note: musl addons intentionally reuse the plain linux-<arch> filenames, so a
 * `linux-all` copy overwrites the gnu addon with the musl one (and vice versa);
 * CI jobs that ship files always request an explicit disjoint target set.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "./host-detect";

const repoRoot = path.join(import.meta.dir, "..");

/** //:natives-<name> → canonical addon filename (mirrors _ADDONS in BUILD.bazel). */
export const ADDON_OUTPUTS: Record<string, string> = {
	"linux-x64-baseline": "pi_natives.linux-x64-baseline.node",
	"linux-x64-modern": "pi_natives.linux-x64-modern.node",
	"linux-arm64": "pi_natives.linux-arm64.node",
	"linux-musl-x64-baseline": "pi_natives.linux-x64-baseline.node",
	"linux-musl-arm64": "pi_natives.linux-arm64.node",
	"darwin-x64-baseline": "pi_natives.darwin-x64-baseline.node",
	"darwin-arm64": "pi_natives.darwin-arm64.node",
	"win32-x64-baseline": "pi_natives.win32-x64-baseline.node",
};

/** Aggregate filegroups → their member addon targets (mirrors BUILD.bazel). */
export const AGGREGATE_TARGETS: Record<string, string[]> = {
	"linux-all": [
		"linux-arm64",
		"linux-musl-arm64",
		"linux-musl-x64-baseline",
		"linux-x64-baseline",
		"linux-x64-modern",
		"win32-x64-baseline",
	],
	"darwin-all": ["darwin-arm64", "darwin-x64-baseline"],
};

export interface HostInfo {
	platform: string;
	arch: string;
	avx2: boolean;
}

/** The single addon target matching the host CPU (modern iff x64 + AVX2). */
export function hostTargetName(host: HostInfo): string {
	if (host.platform === "darwin") {
		if (host.arch === "arm64") return "darwin-arm64";
		if (host.arch === "x64") return "darwin-x64-baseline";
	}
	if (host.platform === "linux") {
		if (host.arch === "arm64") return "linux-arm64";
		if (host.arch === "x64") return host.avx2 ? "linux-x64-modern" : "linux-x64-baseline";
	}
	if (host.platform === "win32" && host.arch === "x64") return "win32-x64-baseline";
	throw new Error(`No pi_natives addon target for host ${host.platform}-${host.arch}`);
}

/** Expand pseudo-targets and map names to //:natives-* labels (deduplicated). */
export function resolveTargetLabels(names: string[], host: HostInfo): string[] {
	const labels: string[] = [];
	for (const name of names) {
		const resolved = name === "host" ? hostTargetName(host) : name;
		if (!(resolved in AGGREGATE_TARGETS) && !(resolved in ADDON_OUTPUTS)) {
			const known = [...Object.keys(ADDON_OUTPUTS), ...Object.keys(AGGREGATE_TARGETS), "host"].join(", ");
			throw new Error(`Unknown native target "${name}". Known targets: ${known}`);
		}
		const label = `//:natives-${resolved}`;
		if (!labels.includes(label)) labels.push(label);
	}
	return labels;
}

/**
 * Workspace-relative output paths by bazel-bin convention:
 * bazel-bin/natives-<t>/<canonical>.node. Fallback when cquery is unavailable.
 */
export function conventionOutputPaths(names: string[], host: HostInfo): string[] {
	const paths: string[] = [];
	for (const name of names) {
		const resolved = name === "host" ? hostTargetName(host) : name;
		const members = AGGREGATE_TARGETS[resolved] ?? [resolved];
		for (const member of members) {
			const out = ADDON_OUTPUTS[member];
			if (!out) throw new Error(`Unknown native target "${name}"`);
			const p = `bazel-bin/natives-${member}/${out}`;
			if (!paths.includes(p)) paths.push(p);
		}
	}
	return paths;
}

/** Parse `bazel cquery --output=files` stdout into deduplicated .node paths. */
export function parseBazelFilesOutput(output: string): string[] {
	const files: string[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.endsWith(".node")) continue;
		if (!files.includes(trimmed)) files.push(trimmed);
	}
	return files;
}

/**
 * Content hash of the native Rust sources an addon is built from. Covers every
 * source file under `crates/pi-natives/` and `crates/pi-voice/` (the two crates
 * that compile into the pi_natives addon). Deterministic: stable path order,
 * one SHA-256 over `path:size:hash` lines, so irrelevant metadata (mtime,
 * mode) never perturbs it.
 */
export async function computeNativeSourceHash(repoRoot: string): Promise<string> {
	const crypto = await import("node:crypto");
	const { glob } = await import("glob");
	const roots = ["crates/pi-natives", "crates/pi-voice"];
	const entries: { rel: string; content: Buffer }[] = [];
	for (const root of roots) {
		// Note: the installed glob@7.2.3 has no promise API (await returns an
		// EventEmitter) and does not expand array patterns (setopts has no
		// array handling → minimatch throws "invalid pattern"); use glob.sync
		// per pattern instead.
		const files: string[] = [];
		for (const pat of [`${root}/**/*.rs`, `${root}/**/Cargo.toml`, `${root}/**/BUILD.bazel`]) {
			const found = glob.sync(pat, {
				cwd: repoRoot,
				absolute: false,
				dot: false,
				ignore: ["**/target/**", "**/bazel-*/**"],
			});
			files.push(...found);
		}
		files.sort();
		for (const rel of files) {
			const content = await fs.readFile(path.join(repoRoot, rel));
			entries.push({ rel, content });
		}
	}
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const hash = crypto.createHash("sha256");
	for (const { rel, content } of entries) {
		hash.update(`${rel}:${content.length}:`);
		hash.update(content);
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * Rebuild the host addon via cargo (musepi-local fallback for bazel's broken
 * macOS link path). Runs `cargo build -p pi-natives --release` with the same
 * nightly the bazel toolchain pins (rustup toolchain must provide it), then
 * copies `target/release/libpi_natives.dylib` into destDir under the addon's
 * canonical name. Returns the installed path, or null on any failure (caller
 * falls through to bazel).
 */
async function tryCargoHostBuild(hostTarget: string, destDir: string): Promise<string | null> {
	try {
		const cargo = Bun.which("cargo");
		if (!cargo) {
			console.warn("cargo not found on PATH; skipping cargo rebuild");
			return null;
		}
		const proc = Bun.spawn([cargo, "build", "-p", "pi-natives", "--release"], {
			cwd: repoRoot,
			stdout: "inherit",
			stderr: "pipe",
			env: { ...Bun.env },
		});
		const decoder = new TextDecoder();
		let stderrTail = "";
		for await (const chunk of proc.stderr) {
			const text = decoder.decode(chunk, { stream: true });
			process.stderr.write(text);
			stderrTail = (stderrTail + text).split("\n").slice(-10).join("\n");
		}
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			console.warn(`cargo build failed (exit ${exitCode}):\n${stderrTail}`);
			return null;
		}
		const dylib = path.join(repoRoot, "target/release/libpi_natives.dylib");
		await fs.stat(dylib);
		const destPath = path.join(destDir, ADDON_OUTPUTS[hostTarget]);
		await installAddon(dylib, destPath);
		console.log(`cargo-built ${hostTarget} → ${destPath}`);
		return destPath;
	} catch (err) {
		console.warn(`cargo rebuild unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Parsed options for the native addon build and artifact install modes. */
export interface CliOptions {
	targets: string[];
	dest: string | null;
	source: string | null;
	bazelArgs: string[];
}

/** Parse target names and the mutually exclusive build or artifact source options. */
export function parseCliArgs(argv: string[]): CliOptions {
	const targets: string[] = [];
	let dest: string | null = null;
	let source: string | null = null;
	const bazelArgs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			bazelArgs.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "--dest" || arg === "--source") {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a directory argument`);
			if (arg === "--dest") {
				dest = value;
			} else {
				source = value;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag ${arg} (extra bazel args go after \`--\`)`);
		}
		targets.push(arg);
	}
	if (targets.length === 0) {
		throw new Error(
			"Usage: bun scripts/bazel-natives.ts <target>... [--dest <dir>] [--source <dir>] [-- <extra bazel args>]",
		);
	}
	if (source && bazelArgs.length > 0) {
		throw new Error("--source cannot be combined with extra bazel arguments");
	}
	return { targets, dest, source, bazelArgs };
}

function resolveBazelBinary(): string {
	const bin = Bun.which("bazelisk") ?? Bun.which("bazel");
	if (!bin) {
		throw new Error(
			"Neither `bazelisk` nor `bazel` found on PATH. Install bazelisk: https://github.com/bazelbuild/bazelisk",
		);
	}
	return bin;
}

const STDERR_TAIL_LINES = 40;

/** Run a bazel command streaming stderr live while keeping a tail for the failure report. */
async function runBazel(
	bin: string,
	args: string[],
	stdout: "inherit" | "pipe",
): Promise<{ exitCode: number; stdout: string; stderrTail: string }> {
	const proc = Bun.spawn([bin, ...args], { cwd: repoRoot, stdout, stderr: "pipe" });
	const decoder = new TextDecoder();
	let tail = "";
	const pumpStderr = (async () => {
		for await (const chunk of proc.stderr) {
			const text = decoder.decode(chunk, { stream: true });
			process.stderr.write(text);
			tail = (tail + text)
				.split("\n")
				.slice(-STDERR_TAIL_LINES - 1)
				.join("\n");
		}
	})();
	const stdoutText = stdout === "pipe" ? await new Response(proc.stdout as ReadableStream).text() : "";
	const exitCode = await proc.exited;
	await pumpStderr;
	return { exitCode, stdout: stdoutText, stderrTail: tail };
}

async function installAddon(sourcePath: string, destPath: string): Promise<void> {
	const realSource = await fs.realpath(sourcePath); // bazel-bin outputs are symlink-reachable; copy the real bytes
	const tempPath = `${destPath}.tmp.${process.pid}`;
	await fs.copyFile(realSource, tempPath);
	await fs.chmod(tempPath, 0o644);
	try {
		await fs.rename(tempPath, destPath); // atomic even if dest is a loaded addon
	} catch (err) {
		await fs.unlink(tempPath).catch(() => {});
		throw err;
	}
	// macOS only: ld64 ≥27036.1 misaligns the __LINKEDIT string pool of large
	// addons (4-byte instead of 8-byte start) and macOS 26+ dyld rejects them
	// at dlopen. Re-align the installed bytes so local rebuilds are loadable.
	if (process.platform === "darwin") {
		const { alignLinkEdit } = await import("./fix-linkedit-align.ts");
		const patched = await alignLinkEdit(destPath);
		if (patched) console.log(`LINKEDIT-aligned ${destPath}`);
	}
}

async function buildWindowsHostAddon(host: HostInfo, destDir: string): Promise<void> {
	const script = path.join(repoRoot, "packages/natives/scripts/build-bindings.ts");
	console.log(`win32 host: bazel msvc toolchain is linux/mac-only; building via ${path.relative(repoRoot, script)}`);
	const proc = Bun.spawn([process.execPath, script], {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.exit(exitCode || 1);

	const filename = `pi_natives.win32-x64-${host.avx2 ? "modern" : "baseline"}.node`;
	const builtPath = path.join(repoRoot, "packages/natives/native", filename);
	if (path.dirname(builtPath) !== destDir) {
		await fs.mkdir(destDir, { recursive: true });
		await installAddon(builtPath, path.join(destDir, filename));
	}
	console.log(`installed ${filename} → ${path.join(destDir, filename)}`);
}

/** Build and install the host addon through the local Cargo/N-API path. */
async function buildLocalHostAddon(host: HostInfo, destDir: string): Promise<void> {
	const script = path.join(repoRoot, "packages/natives/scripts/build-bindings.ts");
	console.log(`local host build: using ${path.relative(repoRoot, script)}`);
	const proc = Bun.spawn([process.execPath, script], {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.exit(exitCode || 1);

	const filename = resolveLocalHostAddon(host).filename;
	const builtPath = path.join(repoRoot, "packages/natives/native", filename);
	if (path.dirname(builtPath) !== destDir) {
		await fs.mkdir(destDir, { recursive: true });
		await installAddon(builtPath, path.join(destDir, filename));
	}
	console.log(`installed ${filename} → ${path.join(destDir, filename)}`);
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const host: HostInfo = { platform: process.platform, arch: process.arch, avx2: detectHostAvx2Support() };
	const destDir = options.dest ? path.resolve(options.dest) : path.join(repoRoot, "packages/natives/native");

	if ((host.platform === "win32" || Bun.env.OMP_NATIVE_BUILD_BACKEND === "cargo") && !options.source) {
		if (options.targets.length !== 1 || options.targets[0] !== "host") {
			if (host.platform === "win32") {
				throw new Error(
					`Cannot bazel-build [${options.targets.join(", ")}] on a Windows host: the msvc cross ` +
						"toolchain (bazel/toolchains/msvc) only runs on linux/mac exec hosts. Use `host` here " +
						"(local napi build via VS Build Tools), or run this script from WSL/linux for cross targets.",
				);
			}
			throw new Error("OMP_NATIVE_BUILD_BACKEND=cargo supports only the host target");
		}
		await buildLocalHostAddon(host, destDir);
		return;
	}
	let outputs: string[] = [];

	// musepi-local build resilience: when the requested target set is exactly
	// the host addon and --dest already contains a loadable copy matching the
	// current version sentinel AND the native sources it was built from, skip
	// bazel entirely. The host toolchain (ld) can produce LINKEDIT-misaligned
	// dylibs that dlopen refuses (macOS 27 / ld-27036.1 regression); an existing
	// working addon (e.g. the upstream-published prebuilt) is preferred over
	// rebuilding a broken one. CI (macOS-14 runners, older ld) and machines
	// without a prebuilt fall through to bazel exactly as upstream.
	//
	// Two independent guards, both must pass to reuse an existing addon:
	//   1. Sentinel — the addon exports `__piNativesV<version>` (catches a
	//      version-mismatched stale prebuilt; matches upstream's loader check).
	//   2. Source fingerprint — the addon records a hash of the native sources
	//      it was built from in `native/.source-hash`. If the sources on disk
	//      hash differently (natives Rust code moved without a version bump),
	//      the guard rebuilds instead of silently shipping a stale addon.
	// `OMP_NATIVES_FORCE_BUILD=1` bypasses both (escape hatch for manual
	// rebuilds, e.g. after upgrading the local toolchain).
	const hostTarget = hostTargetName(host);
	const hostOnly =
		options.targets.length === 1 &&
		(options.targets[0] === "host" || options.targets[0] === hostTarget) &&
		!options.source;
	const forceBuild = Bun.env.OMP_NATIVES_FORCE_BUILD === "1";
	// Hoisted so both the reuse-guard and the cargo-fallback branch share it.
	const sourceHash = await computeNativeSourceHash(repoRoot);
	if (hostOnly && !forceBuild) {
		const existing = path.join(destDir, ADDON_OUTPUTS[hostTarget]);
		const packageJson = JSON.parse(
			await fs.readFile(path.join(repoRoot, "packages/natives/package.json"), "utf8"),
		) as { version: string };
		const expectedSentinel = `__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		const hashFile = path.join(destDir, ".source-hash");
		try {
			const stat = await fs.stat(existing);
			if (stat.isFile() && stat.size > 0) {
				// Node-API modules must load via require()/process.dlopen — bun's
				// import() rejects them, and dlopen failures surface as throws.
				// A script file (not `bun -e`) enforces the failure like upstream
				// CI's smoke-addons.js; `bun -e` would swallow it.
				const { createRequire } = await import("node:module");
				const require = createRequire(import.meta.url);
				const mod = require(existing);
				if (expectedSentinel in (mod as Record<string, unknown>)) {
					let recordedHash: string | null = null;
					try {
						recordedHash = (await fs.readFile(hashFile, "utf8")).trim();
					} catch {
						// No fingerprint on disk.
					}
					if (recordedHash === sourceHash) {
						console.log(
							`using existing loadable addon ${existing} (sentinel ${expectedSentinel}, sources ${sourceHash.slice(0, 8)}); skipping bazel build`,
						);
						return;
					}
					if (recordedHash === null) {
						// First run with an un-fingerprinted prebuilt (e.g. the
						// upstream-published addon dropped into native/). It passes
						// the sentinel check and the sources on disk are the ones it
						// was built from, so adopt it: record the current source hash
						// and reuse. From here on, any source drift rebuilds.
						await fs.writeFile(hashFile, `${sourceHash}\n`, "utf8");
						console.log(
							`adopting existing addon ${existing} (sentinel ${expectedSentinel}); recorded source hash ${sourceHash.slice(0, 8)}; skipping bazel build`,
						);
						return;
					}
					console.warn(
						`existing addon ${existing} sources ${recordedHash.slice(0, 8)} != on-disk ${sourceHash.slice(0, 8)}; rebuilding via bazel`,
					);
				} else {
					console.warn(`existing addon ${existing} lacks sentinel ${expectedSentinel}; rebuilding via bazel`);
				}
			}
		} catch {
			// Missing or unloadable — fall through to a real bazel build.
		}
	}

	// musepi-local: prefer a cargo rebuild over bazel when one is needed and
	// cargo is available. Bazel's rules_rust link path can emit LINKEDIT-
	// misaligned dylibs on macOS (ld-27036.1 + large outputs) that dlopen
	// refuses, while the equivalent cargo build links cleanly (verified).
	// Only the single host addon is rebuilt this way; multi-target/CI builds
	// (linux-all, darwin-all, explicit targets, --source) keep using bazel.
	if (hostOnly && outputs.length === 0) {
		const cargoPath = await tryCargoHostBuild(hostTarget, destDir);
		if (cargoPath) {
			// tryCargoHostBuild already installed the addon into destDir; record
			// the source fingerprint and return — no bazel, no re-install.
			await fs.writeFile(path.join(destDir, ".source-hash"), `${sourceHash}\n`, "utf8").catch(() => {});
			console.log(`cargo rebuild complete; recorded source hash ${sourceHash.slice(0, 8)}`);
			return;
		}
		if (!forceBuild) {
			console.warn("cargo rebuild unavailable or failed; falling through to bazel");
		}
	}

	if (options.source) {
		const sourceDir = path.resolve(options.source);
		outputs = conventionOutputPaths(options.targets, host).map(output =>
			path.join(sourceDir, path.relative("bazel-bin", output)),
		);
	} else {
		const labels = resolveTargetLabels(options.targets, host);
		const bazel = resolveBazelBinary();
		// CI hands cache wiring (remote or disk) through a bazelrc fragment so
		// endpoint composition stays in .github/actions/bazel-cache.
		const rcPath = Bun.env.OMP_BAZEL_RC?.trim();
		const startupArgs = rcPath ? [`--bazelrc=${rcPath}`] : [];

		const buildArgs = [...startupArgs, "build", ...options.bazelArgs, "--", ...labels];
		console.log(`$ ${path.basename(bazel)} ${buildArgs.join(" ")}`);
		const build = await runBazel(bazel, buildArgs, "inherit");
		if (build.exitCode !== 0) {
			console.error(`\nbazel build failed (exit ${build.exitCode}). stderr tail:\n${build.stderrTail}`);
			process.exit(build.exitCode || 1);
		}

		// Same flags as the build so cquery resolves the identical configuration.
		// cquery takes exactly one query expression, so multiple targets join
		// into a single union rather than positional args.
		const cquery = await runBazel(
			bazel,
			[...startupArgs, "cquery", ...options.bazelArgs, "--output=files", labels.join(" + ")],
			"pipe",
		);
		if (cquery.exitCode === 0) {
			outputs = parseBazelFilesOutput(cquery.stdout);
		} else {
			console.warn(`bazel cquery failed (exit ${cquery.exitCode}); falling back to bazel-bin path convention`);
			outputs = conventionOutputPaths(options.targets, host);
		}
		if (outputs.length === 0) {
			console.error("bazel build succeeded but no .node outputs were located");
			process.exit(1);
		}
	}

	const seen = new Map<string, string>();
	for (const output of outputs) {
		const base = path.basename(output);
		const prior = seen.get(base);
		if (prior) {
			// gnu and musl x64/arm64 addons share canonical basenames by design;
			// installing both into one dest would silently clobber.
			console.error(
				`refusing to install ${output}: ${base} already provided by ${prior}. ` +
					"Build gnu and musl targets in separate invocations with separate --dest dirs.",
			);
			process.exit(1);
		}
		seen.set(base, output);
	}
	await fs.mkdir(destDir, { recursive: true });
	for (const output of outputs) {
		const absolute = path.isAbsolute(output) ? output : path.join(repoRoot, output);
		const destPath = path.join(destDir, path.basename(output));
		await installAddon(absolute, destPath);
		console.log(`installed ${path.basename(output)} → ${destPath}`);
	}
	// Record the source fingerprint of what was just installed so the guard in
	// main() can later tell a same-version stale addon from a current one.
	// Best-effort: a hash write failure must not fail the install.
	if (options.dest || options.targets.some(t => t === "host" || t in ADDON_OUTPUTS)) {
		try {
			const sourceHash = await computeNativeSourceHash(repoRoot);
			await fs.writeFile(path.join(destDir, ".source-hash"), `${sourceHash}\n`, "utf8");
		} catch {
			// Ignore — the addon itself is installed; the hash only affects reuse.
		}
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
