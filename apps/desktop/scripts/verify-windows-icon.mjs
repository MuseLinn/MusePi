#!/usr/bin/env node
/**
 * Windows-only regression check for the MusePi taskbar/window icon.
 *
 * Three things can silently bring back the Electron default icon:
 *   1. build/icon.png or build/icon.ico loses its brand frames;
 *   2. electron-builder's `files` stops shipping build/icon.png, so the
 *      packaged window icon path resolves to nothing;
 *   3. the executable's own resource icon stops matching build/icon.ico.
 *
 * Usage:
 *   bun run verify:taskbar-icon                 # source assets + installed app, when found
 *   bun run verify:taskbar-icon -- --package apps/desktop/release/win-unpacked
 *   bun run verify:taskbar-icon -- --exe path/to/MusePi.exe --require-package
 *
 * `--package` takes the electron-builder app directory (the one holding
 * MusePi.exe and resources/app.asar). Without it the script looks for
 * release/win-unpacked and then the per-user installation.
 *
 * Only the executable's 32x32 frame is compared: Windows asks for that size
 * for the taskbar, and Electron's default icon is distinguishable there. The
 * PNG frame directory checks every ICO size the packaged window icon may be
 * asked to draw.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_PNG = path.join(APP_DIR, "build", "icon.png");
const ICON_ICO = path.join(APP_DIR, "build", "icon.ico");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function flag(name) {
	return process.argv.includes(name);
}

function option(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : process.argv[index + 1] ?? null;
}

function pngSize(file) {
	const header = Buffer.alloc(24);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, header, 0, header.length, 0);
	} finally {
		fs.closeSync(fd);
	}
	if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString("ascii", 12, 16) !== "IHDR") {
		return null;
	}
	return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function icoFrames(file) {
	const buf = fs.readFileSync(file);
	if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
	const count = buf.readUInt16LE(4);
	const frames = [];
	for (let i = 0; i < count; i += 1) {
		const entry = 6 + i * 16;
		const width = buf[entry] === 0 ? 256 : buf[entry];
		const height = buf[entry + 1] === 0 ? 256 : buf[entry + 1];
		const byteLength = buf.readUInt32LE(entry + 8);
		const offset = buf.readUInt32LE(entry + 12);
		const isPng = offset + 8 <= buf.length && buf.subarray(offset, offset + 8).equals(PNG_SIGNATURE);
		frames.push({ width, height, byteLength, offset, isPng, offsetInFile: offset + byteLength <= buf.length });
	}
	return frames;
}

function asarTree(asarPath) {
	const fd = fs.openSync(asarPath, "r");
	try {
		const header = Buffer.alloc(16);
		fs.readSync(fd, header, 0, header.length, 0);
		const pickleSize = header.readUInt32LE(4);
		const stringLength = header.readUInt32LE(12);
		if (stringLength <= 0 || stringLength > pickleSize) return null;
		const payload = Buffer.alloc(stringLength);
		fs.readSync(fd, payload, 0, stringLength, 16);
		return JSON.parse(payload.toString("utf8"));
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

function asarPathExists(tree, relativePath) {
	let node = tree;
	for (const segment of relativePath.split("/")) {
		node = node?.files?.[segment];
		if (!node) return false;
	}
	return Boolean(node);
}

function exeIconDiff(exePath) {
	// Load the exact 32x32 frame bytes: System.Drawing.Icon(ico, 32, 32) picks
	// a scaled variant instead of the embedded frame, which turns a correct
	// icon into a pixel-wise mismatch.
	const frames = icoFrames(ICON_ICO);
	const frame = frames?.find(candidate => candidate.width === 32 && candidate.height === 32);
	if (!frame) throw new Error("build/icon.ico has no 32x32 frame");
	const icoBytes = fs.readFileSync(ICON_ICO);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-icon-check-"));
	const framePng = path.join(tempDir, "frame-32.png");
	fs.writeFileSync(framePng, icoBytes.subarray(frame.offset, frame.offset + frame.byteLength));
	const script = `
Add-Type -AssemblyName System.Drawing
$exe = '${exePath.replaceAll("'", "''")}'
$frame = '${framePng.replaceAll("'", "''")}'
$a = [System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap()
$b = [System.Drawing.Image]::FromFile($frame)
$width = $a.Width
$height = $a.Height
$diff = 0
for ($y = 0; $y -lt [Math]::Min(32, $a.Height); $y++) {
  for ($x = 0; $x -lt [Math]::Min(32, $a.Width); $x++) {
    if ($a.GetPixel($x, $y).ToArgb() -ne $b.GetPixel($x, $y).ToArgb()) { $diff++ }
  }
}
$a.Dispose()
$b.Dispose()
Write-Output ("size=" + $width + "x" + $height + ";diff=" + $diff)
`;
	try {
		const output = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
		});
		const size = /size=(\d+)x(\d+)/.exec(output);
		const diff = /diff=(\d+)/.exec(output);
		if (!size || !diff) throw new Error(`unexpected PowerShell output: ${output.trim()}`);
		return { width: Number(size[1]), height: Number(size[2]), diff: Number(diff[1]) };
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

/** Resolve a CLI path against the cwd first, then the app directory. */
function resolveCliPath(value) {
	const fromCwd = path.resolve(value);
	return fs.existsSync(fromCwd) ? fromCwd : path.resolve(APP_DIR, value);
}

function resolveTarget() {
	const explicitPackage = option("--package");
	if (explicitPackage) {
		const dir = resolveCliPath(explicitPackage);
		return { dir, exe: path.join(dir, "MusePi.exe") };
	}
	const explicitExe = option("--exe");
	if (explicitExe) {
		const exe = resolveCliPath(explicitExe);
		return { dir: path.dirname(exe), exe };
	}
	const candidates = [
		path.join(APP_DIR, "release", "win-unpacked"),
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "MusePi") : null,
	].filter(Boolean);
	for (const dir of candidates) {
		const exe = path.join(dir, "MusePi.exe");
		if (fs.existsSync(exe)) return { dir, exe };
	}
	return null;
}

const results = [];
function check(name, run) {
	try {
		const detail = run();
		results.push({ ok: true, name, detail });
	} catch (error) {
		results.push({ ok: false, name, detail: error?.message ?? String(error) });
	}
}

check("build/icon.png exists and is a 1024x1024 PNG", () => {
	const size = pngSize(ICON_PNG);
	if (!size) throw new Error(`${ICON_PNG} is not a PNG`);
	if (size.width !== 1024 || size.height !== 1024) throw new Error(`unexpected size ${size.width}x${size.height}`);
	return "1024x1024";
});

check("build/icon.ico carries every Windows frame", () => {
	const frames = icoFrames(ICON_ICO);
	if (!frames) throw new Error(`${ICON_ICO} is not an ICO file`);
	const sizes = frames.map(frame => frame.width).sort((a, b) => a - b);
	const missing = ICO_SIZES.filter(size => !sizes.includes(size));
	if (missing.length > 0) throw new Error(`missing frames: ${missing.join(", ")}`);
	const broken = frames.filter(frame => !frame.isPng || !frame.offsetInFile || frame.byteLength < 256);
	if (broken.length > 0) throw new Error(`unreadable frames at ${broken.map(frame => frame.width).join(", ")}px`);
	return sizes.join(", ");
});

if (process.platform !== "win32") {
	results.push({ ok: true, name: "executable and package checks", detail: "skipped: Windows-only" });
} else {
	const target = resolveTarget();
	if (!target || !fs.existsSync(target.exe)) {
		const detail = target
			? `no executable at ${target.exe}`
			: "no packaged app found (run with --package after a build)";
		results.push({ ok: !flag("--require-package"), name: "executable icon", detail: `skipped: ${detail}` });
		results.push({ ok: !flag("--require-package"), name: "packaged app.asar", detail: `skipped: ${detail}` });
	} else {
		check(`${path.basename(target.exe)} icon matches build/icon.ico (${target.exe})`, () => {
			const { width, height, diff } = exeIconDiff(target.exe);
			if (width !== 32 || height !== 32) throw new Error(`extracted ${width}x${height}, expected 32x32`);
			if (diff !== 0) throw new Error(`${diff}/${width * height} pixels differ from build/icon.ico`);
			return `${width}x${height}, 0 differing pixels`;
		});
		check("packaged app.asar ships build/icon.png", () => {
			const asarPath = path.join(target.dir, "resources", "app.asar");
			const tree = asarTree(asarPath);
			if (!tree) throw new Error(`could not read ${asarPath}`);
			if (!asarPathExists(tree, "electron/main.cjs")) throw new Error("sanity: asar tree is unreadable");
			if (!asarPathExists(tree, "build/icon.png")) {
				throw new Error("build/icon.png missing from app.asar (window icon would fall back to the executable icon)");
			}
			return "present";
		});
	}
}

for (const result of results) {
	process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}\n`);
}
const failed = results.filter(result => !result.ok).length;
process.stdout.write(failed === 0 ? "taskbar icon check: PASS\n" : `taskbar icon check: ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);