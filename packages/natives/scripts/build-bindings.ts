/**
 * Local napi build: regenerates the TypeScript bindings (native/index.d.ts)
 * and the runtime enum exports, then installs the host addon. Release addons
 * come from Bazel (`bun run build` → scripts/bazel-natives.ts); this path also
 * serves hosts Bazel cannot run on (Windows, the Docker image) via
 * `OMP_NATIVE_BUILD_BACKEND=cargo`. Host target only — no cross-compilation.
 *
 * `OMP_NATIVE_CARGO_PROFILE` selects the cargo profile (default `local`:
 * incremental, unstripped). Image builds set `ci` for a stripped addon.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

// pcre2-sys prefers a system libpcre2 when pkg-config finds one. Keep the
// static build so the local addon never retains host Homebrew paths.
process.env.PCRE2_SYS_STATIC ??= "1";

// Windows: cc-rs and rustc auto-locate cl.exe/link.exe through the VS
// registry, but the cmake crate (audiopus_sys' bundled opus) needs cmake —
// and its Ninja generator needs ninja — on PATH. VS Build Tools ships both
// without exposing them, so outside a vcvars prompt the build dies on
// "cmake not found". Resolve the VS install via vswhere and append its
// CMake/Ninja dirs, keeping any user-provided tools ahead.
if (process.platform === "win32" && (!Bun.which("cmake") || !Bun.which("ninja"))) {
	const vswhere = path.join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	const probe = Bun.spawnSync(
		[
			vswhere,
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const vsRoot = probe.exitCode === 0 ? probe.stdout.toString("utf-8").trim() : "";
	if (vsRoot) {
		const cmakeExt = path.join(vsRoot, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
		const extraDirs = [path.join(cmakeExt, "CMake", "bin"), path.join(cmakeExt, "Ninja")].filter(dir =>
			fsSync.existsSync(dir),
		);
		if (extraDirs.length > 0) {
			process.env.PATH = [process.env.PATH ?? "", ...extraDirs].filter(Boolean).join(path.delimiter);
		}
	}
}

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

const localAddon = resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detectHostAvx2Support(),
});
const effectiveVariant = localAddon.x64Variant;
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

// Pin Rust target-cpu so x64 baseline/modern variants get a reproducible ISA floor
// instead of inheriting the host CPU when RUSTFLAGS is unset. Non-x64 builds keep
// the target's default CPU features: `-C target-cpu=native` would bake the build
// host's CPU features into the addon and trips ring 0.17's aarch64-apple
// const assertion (CAPS_STATIC == MIN_STATIC_FEATURES).
if (!Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	}
}
// Statically link the MSVC CRT for the shipped win32 addon, matching the bazel
// release path (crates/pi-natives/BUILD.bazel: -Ctarget-feature=+crt-static +
// static_link_msvcrt cc feature). Without it, a cargo/napi build on win32
// links the dynamic CRT (/MD): the .node imports VCRUNTIME140.dll and
// api-ms-win-crt-* from the Visual C++ Redistributable, which is absent on a
// clean Windows install — the loader's dlopen then fails with error 126 and
// the daemon dies at startup ("daemon exited during startup"). Verified on the
// local modern addon (Aug 15): it imports VCRUNTIME140.dll; the static
// baseline (Aug 12) does not.
//
// Two levers, both required:
//  - `-C target-feature=+crt-static` via RUSTFLAGS moves rustc's own codegen
//    to /MT. Cargo does NOT reflect RUSTFLAGS into CARGO_CFG_TARGET_FEATURE
//    (verified with a probe build script), so this alone leaves the C deps
//    (pcre2-sys/opus/tree-sitter/ring/...) on cc-rs's default /MD.
//  - `CFLAGS`/`CXXFLAGS=/MT` forces every cc-rs and cmake C/C++ compile to
//    /MT: cc-rs appends env flags AFTER its computed /MD (add_default_flags),
//    so /MT wins; cmake builds (audiopus_sys' vendored opus) read CFLAGS too.
//    This is the cargo-side equivalent of the bazel `static_link_msvcrt`
//    feature (which injects /MT into the same toolchain CFLAGS/CXXFLAGS).
// Rustc's final link then binds libcmt (static) instead of libvcruntime, and
// the shipped .node imports no VCRUNTIME140.dll. Inert on non-windows.
// NOTE: cargo does not track CFLAGS/CXXFLAGS changes — a local incremental
// rebuild keeps stale /MD dependency objects. CI (fresh checkout) always
// rebuilds; local dev should clean target/x86_64-pc-windows-msvc/local after
// flipping this (the napi target dir) or the change appears inert.
if (process.platform === "win32") {
	Bun.env.RUSTFLAGS = `${Bun.env.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim();
	Bun.env.CFLAGS = `${Bun.env.CFLAGS ?? ""} /MT`.trim();
	Bun.env.CXXFLAGS = `${Bun.env.CXXFLAGS ?? ""} /MT`.trim();
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// Directory might not exist yet
	}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code === "ENOENT") {
				// target doesn't exist yet — rename will work below
			} else if (process.platform === "win32" && (unlinkErr as NodeJS.ErrnoException).code === "EPERM") {
				// Target is loaded (e.g. this session itself uses pi_natives).
				// Windows cannot unlink a loaded DLL. Keep the old file — the
				// new build is in tempPath and will be picked up on next
				// process restart (or overwritten by the next build).
				console.warn(
					`[natives] ${path.basename(dest)} is in use; keeping old version (new build in ${path.basename(tempPath)})`,
				);
				return;
			} else {
				await fs.unlink(tempPath).catch(() => {});
				throw new Error(`Cannot replace ${path.basename(dest)}: ${(unlinkErr as Error).message}`);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	// napi-rs 3.x emits `${binaryName}.${platformArchABI}.node` where
	// platformArchABI is e.g. `darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc`,
	// `darwin-arm64`. Build into an isolated output dir so only this invocation's
	// outputs are considered fresh candidates.
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(
		entry => entry.startsWith(`pi_natives.${process.platform}-${process.arch}`) && entry.endsWith(".node"),
	);

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${process.platform}-${process.arch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${process.platform}-${process.arch}:\n${formattedCandidates}`,
	);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	const sourcePath = path.join(outputDir, "index.d.ts");
	const destPath = path.join(nativeDir, "index.d.ts");
	try {
		await fs.copyFile(sourcePath, destPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install generated index.d.ts: ${message}`);
	}
}

const canonicalAddonFilename = localAddon.filename;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives bindings for ${process.platform}-${process.arch}${variantSuffix} (local)…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(
	path.join(nativeDir, ".build", `${process.platform}-${process.arch}-${effectiveVariant ?? "default"}-local-`),
);

// Resolve the CLI's JS entry from the package manifest rather than the
// `node_modules/.bin` shim: `bunx @napi-rs/cli` can pick up the wrong bin on
// systems where `cli` exists on PATH (e.g. Mono's /usr/bin/cli on Ubuntu), and
// on Windows the shim is a `napi.exe` launcher that Bun would try to parse as
// JavaScript.
const require_ = createRequire(import.meta.url);
const napiManifestPath = require_.resolve("@napi-rs/cli/package.json");
const napiManifest: unknown = require_(napiManifestPath);
const napiBinEntry =
	typeof napiManifest === "object" &&
	napiManifest !== null &&
	"bin" in napiManifest &&
	typeof napiManifest.bin === "object" &&
	napiManifest.bin !== null &&
	"napi" in napiManifest.bin &&
	typeof napiManifest.bin.napi === "string"
		? napiManifest.bin.napi
		: null;
if (!napiBinEntry) {
	throw new Error(`@napi-rs/cli manifest at ${napiManifestPath} declares no string \`bin.napi\` entry`);
}
const napiBin = path.join(path.dirname(napiManifestPath), napiBinEntry);

// Profiles live in the root Cargo.toml; `local` trades size for iteration
// speed, `ci` strips and drops incremental state.
const cargoProfile = Bun.env.OMP_NATIVE_CARGO_PROFILE?.trim() || "local";

const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	buildOutputDir,
	"--profile",
	cargoProfile,
];

// napi-rs / cargo route much failure detail to stdout (e.g. `cargo metadata`
// errors), so a stderr-only error collapses real failures to a bare message.
const BUILD_LOG_TAIL_LINES = 40;

/** Tail-cap captured build output into a labeled section for the failure report. */
function tailSection(label: string, text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	const capped = lines.length > BUILD_LOG_TAIL_LINES;
	const shown = capped ? lines.slice(-BUILD_LOG_TAIL_LINES) : lines;
	return `\n--- ${label}${capped ? ` (last ${BUILD_LOG_TAIL_LINES} lines)` : ""} ---\n${shown.join("\n")}`;
}

try {
	// The package declares Bun as its build runtime. Invoke napi's JavaScript
	// entry through this Bun process instead of its `#!/usr/bin/env node` shim so
	// an old host Node installation cannot make an otherwise supported Bun build fail.
	// Pin the cargo toolchain: xutf (tree-sitter dep) needs
	// `#![feature(portable_simd)]` (nightly-only). rustup resolves the
	// toolchain from the *cwd*, not --manifest-path, and napi spawns cargo
	// with cwd=this package — so a rust-toolchain.toml here is required.
	// (crates/pi-natives/rust-toolchain.toml covers direct cargo use.)
	const buildResult = await $`${process.execPath} ${napiBin} ${napiArgs}`
		.env({
			RUSTUP_TOOLCHAIN: "nightly",
		})
		.nothrow();
	if (buildResult.exitCode !== 0) {
		const stdout = buildResult.stdout?.toString("utf-8") ?? "";
		const stderr = buildResult.stderr?.toString("utf-8") ?? "";
		const detail = `${tailSection("stdout", stdout)}${tailSection("stderr", stderr)}`;
		throw new Error(`napi build failed (exit ${buildResult.exitCode})${detail}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	await generateEnumExports();

	console.log("Bindings build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
