#!/usr/bin/env bun
/**
 * Compile electron/haptic-helper.m → electron/haptic-helper (macOS only).
 * Pure clang (Xcode CLT); no Swift runtime. Non-fatal: on non-darwin or
 * when clang is missing the step is skipped and haptics degrade to a
 * no-op (the renderer toggle + main-process guard already handle that).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // packages/gui
const src = path.join(root, "electron", "haptic-helper.m");
const out = path.join(root, "electron", "haptic-helper");

if (process.platform !== "darwin") {
	console.log("build:haptic | skipped (non-darwin)");
	process.exit(0);
}
if (!existsSync(src)) {
	console.warn("build:haptic | source missing:", src);
	process.exit(0);
}
const res = spawnSync(
	"clang",
	["-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-O2", "-o", out, src],
	{ stdio: "inherit" },
);
if (res.status !== 0) {
	console.warn("build:haptic | clang failed — haptics will no-op");
	process.exit(0);
}
console.log("build:haptic |", out);
