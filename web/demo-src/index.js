/**
 * Demo entry: installs the fake daemon, then hands the page to the real
 * renderer bundle that follows it in the document.
 *
 * Everything here runs before the app bundle (the build inserts this script
 * ahead of the renderer's module script), so the renderer's first `new
 * WebSocket(...)` already reaches the fixtures.
 */

import { install, registerAll } from "./transport.js";
import * as agent from "./fixtures/agent.js";
import * as files from "./fixtures/files.js";
import * as plugins from "./fixtures/plugins.js";
import * as sessions from "./fixtures/sessions.js";
import * as shell from "./fixtures/shell.js";

// Seed the preferences the marketing frame expects. The socket URL is a dead
// port on purpose: a demo that fails to install must never reach a daemon
// running on the visitor's machine.
try {
	localStorage.setItem("musepi-gui-onboarding-done", "1");
	localStorage.setItem("omp-collab-theme", "dark");
	localStorage.setItem("musepi-gui-url", "ws://127.0.0.1:9/demo");
} catch {
	/* storage unavailable — the socket swap still applies */
}

registerAll(shell.methods);
// After shell: the plugin fixture extends shell's `extensions.list` answer.
registerAll(plugins.methods);
registerAll(sessions.methods);
registerAll(files.methods);
registerAll(agent.methods);
install();

/**
 * Tell the embedding page the renderer mounted. The host cannot rely on
 * reading this document (a proxy or file:// origin makes it cross-origin), so
 * readiness is announced from inside the frame.
 */
function announceReady() {
	if (window.parent === window) return;
	window.parent.postMessage({ type: "musepi:demo-ready" }, "*");
}

// The first thing React mounts is the splash/connect screen, so "root has
// children" is not readiness — the host would show the shell while the app is
// still connecting. Wait for the real shell and for the splash to leave.
function shellMounted() {
	if (document.querySelector(".gui-splash, .gui-connect-wrap")) return false;
	return Boolean(document.querySelector(".gui-shell, .gui-workspace-keeper, .gui-main"));
}

function watchRoot() {
	if (shellMounted()) {
		announceReady();
		return;
	}
	const timer = setInterval(() => {
		if (!shellMounted()) return;
		clearInterval(timer);
		announceReady();
	}, 100);
	setTimeout(() => {
		clearInterval(timer);
		announceReady();
	}, 30_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchRoot);
else watchRoot();
