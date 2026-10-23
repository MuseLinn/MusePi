#!/usr/bin/env node
/**
 * Build the Windows installer host (WebView2 shell) and stage its runtime files.
 *
 * Why csc.exe and not MSVC: WebView2 needs a native-ish host process, but the
 * .NET Framework compiler ships with Windows itself
 * (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe). That keeps Visual
 * Studio / C++ build tools out of the Windows release job entirely — the CI
 * matrix already runs on windows-2022, so nothing new is required there.
 *
 * What it does
 *   1. Fetch the Microsoft.Web.WebView2 NuGet package (cached under
 *      installer/.cache) — the SDK ships managed assemblies + WebView2Loader.dll.
 *   2. Copy packages/client-core/src/styles/tokens.css next to the UI so the
 *      installer consumes the SAME tokens as the client (single source of truth;
 *      the copy is generated, never edited).
 *   3. Compile InstallerHost.cs -> dist/MusePiInstallerHost.exe (x64).
 *   4. Stage dist/ with the UI, the two managed DLLs and WebView2Loader.dll.
 *
 * Usage:
 *   node packages/desktop-app/scripts/build-installer-host.mjs [--smoke] [--force] [--arch x64|arm64]
 *
 * ⚠ Deployment constraint (matters for the NSIS integration step):
 * WebView2 creates its user-data folder next to the host exe when no explicit
 * folder is given. The host prefers %LOCALAPPDATA%\MusePi\Installer\WebView2 and
 * falls back to the exe-adjacent default if that fails. Since the exe-adjacent
 * path is NOT writable when the installer runs from %ProgramFiles%, the NSIS
 * installer must extract this directory to a writable location (e.g. %TEMP%)
 * and run it from there — the standard approach for WebView2-based installers.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_DIR, "../..");

const INSTALLER_DIR = join(APP_DIR, "installer");
const UI_DIR = join(INSTALLER_DIR, "ui");
const DIST_DIR = join(INSTALLER_DIR, "dist");
const CACHE_DIR = join(INSTALLER_DIR, ".cache");
const HOST_SOURCE = join(INSTALLER_DIR, "InstallerHost.cs");
const MANIFEST = join(INSTALLER_DIR, "InstallerHost.manifest");
const VERSION_SOURCE = join(INSTALLER_DIR, "AutoVersion.cs");

const TOKENS_SOURCE = join(REPO_ROOT, "packages/client-core/src/styles/tokens.css");

/** Pinned so a registry-side change cannot silently alter the shipped host. */
const WEBVIEW2_VERSION = "1.0.3351.48";
const WEBVIEW2_NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg`;

const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

function log(message) {
	console.log(`\x1b[36m[installer-host]\x1b[0m ${message}`);
}

function fail(message) {
	console.error(`\x1b[31m[installer-host]\x1b[0m ${message}`);
	process.exit(1);
}
const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const RUN_SMOKE = args.has("--smoke");

/**
 * Target architecture for the host executable.
 *
 * The release matrix builds Windows on TWO runners: x64 on windows-2022 and
 * arm64 on windows-11-arm. A /platform:x64 host cannot run on ARM64, so the
 * architecture has to follow the matrix. Defaults to the host's own
 * architecture, which is what a developer wants locally.
 *
 *   --arch x64    | --arch arm64
 */
function resolveArch() {
	const explicit = [...args].find(a => a.startsWith("--arch="))?.slice("--arch=".length)
		?? (args.has("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : undefined);
	if (explicit) {
		if (explicit !== "x64" && explicit !== "arm64") {
			fail(`unsupported --arch "${explicit}" (expected x64 or arm64)`);
		}
		return explicit;
	}
	return process.arch === "arm64" ? "arm64" : "x64";
}

const TARGET_ARCH = resolveArch();
/** NuGet runtime folder names: runtimes/win-x64 or runtimes/win-arm64. */
const WEBVIEW2_RUNTIME_ARCH = TARGET_ARCH === "arm64" ? "arm64" : "x64";


async function fetchNuget() {
	const nupkg = join(CACHE_DIR, `webview2-${WEBVIEW2_VERSION}.nupkg`);
	const extracted = join(CACHE_DIR, `webview2-${WEBVIEW2_VERSION}`);

	if (!FORCE && existsSync(join(extracted, "lib/net462/Microsoft.Web.WebView2.Core.dll"))) {
		log(`WebView2 SDK cached (${WEBVIEW2_VERSION})`);
		return extracted;
	}

	mkdirSync(CACHE_DIR, { recursive: true });
	if (!existsSync(nupkg) || FORCE) {
		log(`downloading WebView2 SDK ${WEBVIEW2_VERSION}…`);
		// CI starts with a cold cache, so this runs on every release build. A
		// hung socket would otherwise stall the packaging job silently.
		let response;
		try {
			response = await fetch(WEBVIEW2_NUPKG_URL, { signal: AbortSignal.timeout(120_000) });
		} catch (error) {
			fail(
				`could not reach nuget.org for the WebView2 SDK: ${error?.message ?? error}\n` +
				`  url: ${WEBVIEW2_NUPKG_URL}\n` +
				"  The Windows packaging job needs outbound HTTPS to api.nuget.org.\n" +
				`  Alternatively commit the .nupkg to ${CACHE_DIR} (git-ignored by default).`,
			);
		}
		if (!response.ok) {
			fail(`WebView2 SDK download failed: HTTP ${response.status} ${response.statusText}\n  url: ${WEBVIEW2_NUPKG_URL}`);
		}
		writeFileSync(nupkg, Buffer.from(await response.arrayBuffer()));
	}

	rmSync(extracted, { recursive: true, force: true });
	mkdirSync(extracted, { recursive: true });
	log("extracting…");
	// .nupkg is a zip; `tar` ships with Windows 10+ and avoids a zip dependency.
	// Use System32's bsdtar by absolute path: GNU tar (Git for Windows) shadows
	// `tar` in PATH on CI runners and parses the `D:\…` drive colon as a remote
	// host ("Cannot connect to D: resolve failed"); bsdtar handles it fine.
	const SYSTEM_TAR = join(process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe");
	try {
		execFileSync(SYSTEM_TAR, ["-xf", nupkg, "-C", extracted], { stdio: "inherit" });
	} catch (error) {
		fail(`failed to extract the WebView2 SDK with tar: ${error?.message ?? error}`);
	}
	return extracted;
}

function stageTokens() {
	if (!existsSync(TOKENS_SOURCE)) fail(`tokens.css not found: ${TOKENS_SOURCE}`);
	copyFileSync(TOKENS_SOURCE, join(UI_DIR, "tokens.css"));
	log("staged tokens.css (from client-core — single source of truth)");
}

function compileHost(sdkDir) {
	// The whole "no MSVC" premise rests on this compiler existing. It ships with
	// the .NET Framework runtime (not the SDK), so it is present on every stock
	// Windows image — but fail with a message that says what to do, rather than
	// letting its absence surface as a confusing spawn error.
	if (!existsSync(CSC)) {
		fail(
			`csc.exe not found at ${CSC}\n` +
			"  The installer host is compiled with the in-box .NET Framework compiler\n" +
			"  (no MSVC / Visual Studio required). Enable \".NET Framework 4.8\" in\n" +
			"  Windows Features, or run this step on a Windows runner image.",
		);
	}
	if (!existsSync(HOST_SOURCE)) fail(`host source not found: ${HOST_SOURCE}`);

	mkdirSync(DIST_DIR, { recursive: true });
	const out = join(DIST_DIR, "MusePiInstallerHost.exe");
	const lib = join(sdkDir, "lib/net462");

	const references = [
		join(lib, "Microsoft.Web.WebView2.Core.dll"),
		join(lib, "Microsoft.Web.WebView2.WinForms.dll"),
	];
	for (const reference of references) {
		if (!existsSync(reference)) fail(`missing SDK assembly: ${reference}`);
	}

	// Version resource: the host reports its own ProductVersion, which the page
	// renders in the sidebar. Without it the wizard shows "版本 0.0.0.0".
	// Generating a .res would need rc.exe (Windows SDK) — which we deliberately
	// avoid — so the version travels as an assembly attribute instead and the
	// host falls back to the app's own package.json version when unset.
	const appVersion = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;
	if (!existsSync(MANIFEST)) {
		fail(`DPI/manifest file missing: ${MANIFEST} (the host would render blurry on scaled displays)`);
	}
	writeFileSync(
		join(INSTALLER_DIR, "AutoVersion.cs"),
		[
			"// Generated by build-installer-host.mjs — do not edit.",
			"using System.Reflection;",
			`[assembly: AssemblyVersion("${appVersion}.0")]`,
			`[assembly: AssemblyFileVersion("${appVersion}.0")]`,
			`[assembly: AssemblyInformationalVersion("${appVersion}")]`,
			"",
		].join("\n"),
	);

	// System.Text.Json lives in the .NET Framework 4.8 inbox surface. csc needs
	// the reference assembly explicitly on some SKUs.
	const jsonRef = "C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8\\System.Text.Json.dll";

	const compileArgs = [
		"/nologo",
		"/target:exe",
		`/platform:${TARGET_ARCH}`,
		"/optimize+",
		`/out:${out}`,
		// DPI awareness lives in the manifest. Without it the host is DPI-unaware
		// and Windows bitmap-stretches the window on scaled displays, which is
		// visible as blurry text and a blurry WebView2 surface.
		`/win32manifest:${MANIFEST}`,
		...references.map(r => `/r:${r}`),
		"/r:System.Windows.Forms.dll",
		"/r:System.Drawing.dll",
		HOST_SOURCE,
		VERSION_SOURCE,
	];

	log("compiling InstallerHost.cs (csc.exe, no MSVC)");
	try {
		execFileSync(CSC, compileArgs, { stdio: "inherit" });
	} catch {
		fail("host compilation failed");
	}

	const size = statSync(out).size;
	log(`built ${out} (${(size / 1024).toFixed(1)} KB)`);
	return out;
}

function stageRuntime(sdkDir) {
	const lib = join(sdkDir, "lib/net462");
	const native = join(sdkDir, `runtimes/win-${WEBVIEW2_RUNTIME_ARCH}/native`);

	for (const file of ["Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll"]) {
		copyFileSync(join(lib, file), join(DIST_DIR, file));
	}
	copyFileSync(join(native, "WebView2Loader.dll"), join(DIST_DIR, "WebView2Loader.dll"));

	// Remove WebView2's own user-data directory before staging.
	//
	// When the host runs (smoke test, manual launch) WebView2 creates
	// "<host exe>.WebView2" BESIDE the exe: browser cache, CrashpadMetrics*.pma,
	// and LOCKED files. Leaving it in dist/ breaks packaging — NSIS `File /r`
	// trips over the open lock ("failed opening file ...CrashpadMetrics-active.pma")
	// and would otherwise ship ~14 MB of stale cache in the installer.
	for (const entry of readdirSync(DIST_DIR, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.endsWith(".WebView2")) {
			rmSync(join(DIST_DIR, entry.name), { recursive: true, force: true });
			log(`removed WebView2 runtime profile: ${entry.name}`);
		}
	}

	// UI files: copy the whole tree INCLUDING subdirectories. assets/ holds the
	// brand mark; a flat copy left it behind and the orb rendered as an empty
	// box (caught by looking at the running window, not by the smoke test).
	const uiOut = join(DIST_DIR, "ui");
	rmSync(uiOut, { recursive: true, force: true });
	copyTree(UI_DIR, uiOut);

	const staged = readdirSync(DIST_DIR).sort();
	log(`staged: ${staged.join(", ")}`);
}

/** Recursive copy — `fs.cpSync` is available, this keeps the intent explicit. */
function copyTree(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (entry.isDirectory()) copyTree(source, target);
		else copyFileSync(source, target);
	}
}

function smokeTest() {
	const exe = join(DIST_DIR, "MusePiInstallerHost.exe");
	if (!existsSync(exe)) fail("host not built");
	log("running smoke test (WebView2 bind + backdrop-filter)");
	try {
		const output = execFileSync(exe, ["--smoke-test", "--ui", join(DIST_DIR, "ui", "index.html")], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		process.stdout.write(output);
	} catch (error) {
		if (error.stdout) process.stdout.write(String(error.stdout));
		if (error.stderr) process.stderr.write(String(error.stderr));
		fail("smoke test failed");
	}
}

async function main() {
	const sdkDir = await fetchNuget();
	stageTokens();
	compileHost(sdkDir);
	stageRuntime(sdkDir);
	if (RUN_SMOKE) smokeTest();
	log("done");
}

main().catch(error => fail(error?.stack ?? String(error)));
