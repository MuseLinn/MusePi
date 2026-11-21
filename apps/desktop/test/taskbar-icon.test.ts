import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dir, "..");
const iconPng = path.join(appDir, "build", "icon.png");
const iconIco = path.join(appDir, "build", "icon.ico");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));

function pngSize(file: string) {
	const header = Buffer.alloc(24);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, header, 0, header.length, 0);
	} finally {
		fs.closeSync(fd);
	}
	expect(header.subarray(0, 8)).toEqual(PNG_SIGNATURE);
	expect(header.toString("ascii", 12, 16)).toBe("IHDR");
	return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function icoFrames(file: string) {
	const buf = fs.readFileSync(file);
	expect(buf.readUInt16LE(0)).toBe(0);
	expect(buf.readUInt16LE(2)).toBe(1);
	const frames: Array<{ width: number; height: number; png: boolean; inRange: boolean }> = [];
	for (let index = 0; index < buf.readUInt16LE(4); index += 1) {
		const entry = 6 + index * 16;
		const byteLength = buf.readUInt32LE(entry + 8);
		const offset = buf.readUInt32LE(entry + 12);
		frames.push({
			width: buf[entry] === 0 ? 256 : buf[entry],
			height: buf[entry + 1] === 0 ? 256 : buf[entry + 1],
			png: offset + 8 <= buf.length && buf.subarray(offset, offset + 8).equals(PNG_SIGNATURE),
			inRange: offset + byteLength <= buf.length,
		});
	}
	return frames;
}

describe("taskbar icon", () => {
	test("both shipped icon files carry the brand artwork and every Windows frame", () => {
		expect(pngSize(iconPng)).toEqual({ width: 1024, height: 1024 });
		const frames = icoFrames(iconIco);
		expect(frames.map(frame => frame.width).sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256]);
		expect(frames.every(frame => frame.png && frame.inRange)).toBe(true);
	});

	test("the packaged app includes the window icon and keeps the executable icon", () => {
		// `build/` is electron-builder's buildResources directory, which is
		// excluded from the app archive by default — the explicit file entry is
		// what makes the window icon reachable at runtime.
		expect(pkg.build.files).toContain("build/icon.png");
		expect(pkg.build.directories.buildResources).toBe("build");
		expect(pkg.build.win.icon).toBe("build/icon.ico");
	});

	test.skipIf(
		process.platform !== "win32" || !fs.existsSync(path.join(appDir, "release", "win-unpacked", "MusePi.exe")),
	)("a Windows build carries the brand icon in the executable and app.asar", () => {
		const output = execFileSync(
			process.execPath,
			[
				path.join(appDir, "scripts", "verify-windows-icon.mjs"),
				"--package",
				path.join(appDir, "release", "win-unpacked"),
				"--require-package",
			],
			{ encoding: "utf8" },
		);
		expect(output).toContain("taskbar icon check: PASS");
	});
});
