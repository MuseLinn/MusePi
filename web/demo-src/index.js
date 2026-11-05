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

function watchRoot() {
	const root = document.getElementById("root");
	if (!root || root.childElementCount > 0) {
		announceReady();
		return;
	}
	const observer = new MutationObserver(() => {
		if (root.childElementCount === 0) return;
		observer.disconnect();
		announceReady();
	});
	observer.observe(root, { childList: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchRoot);
else watchRoot();
