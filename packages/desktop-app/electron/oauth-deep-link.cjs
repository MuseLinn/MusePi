/**
 * Desktop deep-link callback routing for MCP OAuth.
 *
 * Kept out of main.cjs so the queue/flush contract is testable without
 * launching Electron: a callback that arrives before the renderer is ready is
 * held once, then delivered on `flush()`.
 */

const DEEP_LINK_PROTOCOL = "musepi";

function findDeepLink(argv) {
	if (!Array.isArray(argv)) return undefined;
	return argv.find(arg => typeof arg === "string" && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));
}

/**
 * @param {object} options
 * @param {(url: string) => void} options.send
 * @param {() => boolean} options.isReady
 * @param {() => void} [options.onReceived]
 */
function createOAuthCallbackForwarder({ send, isReady, onReceived }) {
	let pending;
	return {
		deliver(url) {
			if (typeof url !== "string" || !url.startsWith(`${DEEP_LINK_PROTOCOL}://`)) return false;
			onReceived?.();
			if (isReady()) send(url);
			else pending = url;
			return true;
		},
		flush() {
			if (!pending || !isReady()) return false;
			const url = pending;
			pending = undefined;
			send(url);
			return true;
		},
		get pending() {
			return pending;
		},
	};
}

module.exports = { DEEP_LINK_PROTOCOL, createOAuthCallbackForwarder, findDeepLink };
