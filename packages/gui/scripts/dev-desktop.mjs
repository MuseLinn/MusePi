#!/usr/bin/env bun
/**
 * `bun run desktop:dev` — Vite dev server (HMR renderer) + Electron pointed
 * at it via MUSEPI_GUI_DEV=1. Ctrl-C / Electron exit tears both down.
 * Extra args are forwarded to Electron (e.g. --remote-debugging-port=9222).
 */
import { spawn } from "node:child_process";
import net from "node:net";

const VITE_PORT = 5173;
const argv = process.argv.slice(2);

function portOpen(port) {
	return new Promise((res) => {
		const s = net.connect(port, "127.0.0.1");
		s.on("connect", () => { s.destroy(); res(true); });
		s.on("error", () => res(false));
	});
}
async function waitPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await portOpen(port)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

const vite = spawn("node_modules/.bin/vite", ["--port", String(VITE_PORT), "--strictPort"], { stdio: "inherit" });
const ok = await waitPort(VITE_PORT, 15000);
if (!ok) {
	console.error("vite did not start on", VITE_PORT);
	vite.kill();
	process.exit(1);
}

const electron = spawn("node_modules/.bin/electron", [".", ...argv], {
	stdio: "inherit",
	env: { ...process.env, MUSEPI_GUI_DEV: "1" },
});
electron.on("exit", () => {
	vite.kill();
	process.exit(0);
});
