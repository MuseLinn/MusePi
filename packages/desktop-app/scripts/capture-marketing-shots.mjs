#!/usr/bin/env bun
/**
 * Capture marketing screenshots of the REAL MusePi renderer.
 *
 * Why puppeteer + system Edge over CDP against Electron:
 *   Electron's own window cannot be CDP-screenshotted on Windows — a
 *   transparent, unfocused window never gets a compositor surface and
 *   Page.captureScreenshot hangs (see verify-desktop-pet.mjs:12-18, which
 *   documents the same limitation for the pet window). The fix that project
 *   already uses is to render the BUILT renderer over file:// with a stub
 *   preload — that exercises the exact same renderer code the window runs.
 *   This script generalises it to the main window so the marketing shots are
 *   real product pixels rather than hand-drawn mockups.
 *
 * The stub: window.electronAPI is injected via evaluateOnNewDocument, which
 * runs before any page script and is not subject to the renderer's CSP
 * (script-src 'self' 'unsafe-inline' blob: would block an inline <script>).
 *
 * Usage:
 *   bun packages/desktop-app/scripts/capture-marketing-shots.mjs
 *   bun packages/desktop-app/scripts/capture-marketing-shots.mjs --out web/assets/shots
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { buildStub, extractApiNames, extractNestedNames } from "./electron-api-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_DIR, "../..");
const DIST = join(APP_DIR, "dist");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_DIR = resolve(REPO_ROOT, flag("--out", "web/assets/shots"));
const EDGE = flag(
	"--edge",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
);

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };

if (!existsSync(join(DIST, "index.html"))) {
	console.error(`[shots] renderer not built: ${join(DIST, "index.html")}`);
	console.error("  run `bun run build` in packages/desktop-app first");
	process.exit(2);
}
if (!existsSync(EDGE)) {
	console.error(`[shots] Edge not found at ${EDGE}`);
	process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

/**
 * electronAPI stub, DERIVED from electron/preload.cjs.
 *
 * The renderer talks to the host through a 100+ method bridge; hand-maintaining
 * a stub beside it was the bug — the first capture attempt threw "ae is not a
 * function" because the handwritten stub lacked methods the shell calls the
 * moment a daemon connects. The stub is now generated from the preload's own
 * object literal, so a preload addition cannot silently break the capture.
 *
 * Daemon-backed calls resolve to undefined rather than real data, so the
 * renderer renders its real shell (sidebar, composer, glass chrome) in the
 * "daemon reachable, empty workspace" state.
 */
const PRELOAD_SOURCE = readFileSync(join(APP_DIR, "electron", "preload.cjs"), "utf8");
const STUB = buildStub(extractApiNames(PRELOAD_SOURCE), extractNestedNames(PRELOAD_SOURCE));

const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: true,
	args: [
		`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
		// Required for the renderer to import its bundled modules over file://
		"--allow-file-access-from-files",
		"--hide-scrollbars",
		"--force-color-profile=srgb",
	],
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);
await page.evaluateOnNewDocument(STUB);

// Surface renderer errors: a silent exception would just yield a blank shot.
const consoleErrors = [];
page.on("pageerror", error => consoleErrors.push(String(error?.message ?? error)));
page.on("console", message => {
	if (message.type() === "error") consoleErrors.push(message.text());
});

const indexPath = join(DIST, "index.html");
const fileUrl = `file:///${indexPath.replace(/\\/g, "/")}`;

// Skip the first-run wizard and pin the brand's dark theme BEFORE the shell
// mounts: the onboarding overlay reads musepi-gui-onboarding-done on mount, and
// the welcome wizard seeds its own (light) palette from the OS appearance.
// evaluateOnNewDocument is the only hook that runs ahead of the bundle.
await page.evaluateOnNewDocument(`
	try {
		localStorage.setItem("musepi-gui-onboarding-done", "1");
		localStorage.setItem("omp-collab-theme", "dark");
		localStorage.setItem("omp-collab-locale", "zh-CN");
	} catch (error) {
		/* storage unavailable — the dataset writes below still apply */
	}
	document.documentElement.dataset.theme = "dark";
	document.documentElement.style.colorScheme = "dark";
`);

console.log(`[shots] loading ${fileUrl}`);
await page.goto(fileUrl, { waitUntil: "load", timeout: 60_000 });
// Let the shell mount, fonts settle and the entrance animations finish.
await new Promise(resolve => setTimeout(resolve, 3500));

const shot = async (name) => {
	const file = join(OUT_DIR, `${name}.png`);
	await page.screenshot({ path: file, captureBeyondViewport: false });
	const size = readFileSync(file).length;
	console.log(`[shots] ${name}.png  ${(size / 1024).toFixed(0)} KB`);
	return file;
};

const written = [];
written.push(await shot("app-session"));

// Web-ready transcode: the site serves these images, and a 2880x1800 PNG is
// ~740 KB while the same frame as 2400x1500 WEBP q82 is ~70 KB. `sharp` is not
// a repo dependency and adding one for a capture script is not worth it, so the
// transcode shells out to Pillow, which the repo's asset tooling already uses.
for (const png of written) {
	const webp = png.replace(/\.png$/, ".webp");
	const transcode = Bun.spawnSync([
		"python",
		"-c",
		[
			`from PIL import Image`,
			`import os, sys`,
			`im = Image.open(sys.argv[1]).convert("RGB")`,
			`im = im.resize((2400, int(2400 * im.height / im.width)), Image.LANCZOS)`,
			`im.save(sys.argv[2], "WEBP", quality=82, method=6)`,
			`print(os.path.getsize(sys.argv[2]))`,
		].join("; "),
		png,
		webp,
	]);
	if (transcode.exitCode !== 0) {
		console.error(`[shots] webp transcode failed for ${png}: ${transcode.stderr.toString().slice(0, 400)}`);
		continue;
	}
	const kb = (Number(transcode.stdout.toString().trim()) / 1024).toFixed(1);
	console.log(`[shots] ${webp.split(/[\\/]/).pop()}  ${kb} KB`);
	// Keep the PNG out of the site bundle: the webp is the deliverable.
	rmSync(png);
}

writeFileSync(
	join(OUT_DIR, "MANIFEST.json"),
	`${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: VIEWPORT, shots: written.map(f => f.split(/[\\/]/).pop()) }, null, 2)}\n`,
);

await browser.close();
console.log(`[shots] done -> ${OUT_DIR}`);
