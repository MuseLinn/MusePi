/**
 * Loopback HTTP static server for the renderer bundle — the "runtime serves
 * the web renderer" half of the dsh-desktop-compat chain. The daemon serves
 * the built `desktop-web` SPA at http://127.0.0.1:<webPort>/; the Electron
 * compat shell `loadURL`s it and overlays the desktop frame (the wrapper that
 * leaves the served content authoritative).
 *
 * Plain GET / static assets only. The JSON-RPC WS stays on the existing
 * net.createServer transport (ws-transport.ts) — Bun.serve's http compat
 * layer drops bytes on upgraded sockets, so upgrades must never reach here.
 */
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";

export interface DaemonWebOptions {
	/** Port to bind. 0 picks a free ephemeral port. */
	port: number;
	/** Bind host. Defaults to loopback (local GUI / compat shell). */
	host?: string;
	/** Absolute path to the renderer dist directory (desktop-web/dist). */
	distDir: string;
	/** Daemon JSON-RPC WebSocket port — served to the renderer via
	 *  `/__daemon.json` so the compat shell can connect as a host. */
	wsPort?: number;
	/** Bearer token for the daemon WS (required when remote; the renderer
	 *  passes it as `?token=` — browsers cannot set WS headers). */
	token?: string;
}

export interface DaemonWebHandle {
	/** Actual listening port (useful when port 0 was requested). */
	port: number;
	/** Loopback origin (http://127.0.0.1:<port>). */
	url: string;
	close: () => Promise<void>;
}

const DAEMON_CONFIG_PATH = "/__daemon.json";

/** Injected compat slot host (dsh-desktop plugin parity): served only to
 *  `?shell=1` (the Electron compat shell). The desktop-web bundle stays a
 *  passive renderer — this script is the host that pulls the daemon's
 *  compiled `transcript.node` extension components (extensions.list) and
 *  registers them on `window.MusePiCompatHost`; the bundle's Transcript then
 *  dispatches registered kinds through the same seat it uses for an injected
 *  renderTranscriptNode. Runs entirely outside the React tree; the bundle
 *  exposes window.MusePiReact so blob-imported modules bind to its instance.
 */
export function compatSlotHostScript(): string {
	return `
<script>
(() => {
	const rpc = (() => {
		let ws = null;
		let seq = 0;
		const pending = new Map();
		const open = () =>
			new Promise((resolve, reject) => {
				if (ws && ws.readyState === WebSocket.OPEN) return resolve();
				fetch("/__daemon.json")
					.then(r => r.json())
					.then(cfg => {
						if (!cfg || typeof cfg.wsUrl !== "string") throw new Error("no wsUrl");
						const url = cfg.wsUrl + (typeof cfg.token === "string" ? "?token=" + encodeURIComponent(cfg.token) : "");
						ws = new WebSocket(url);
						ws.onopen = resolve;
						ws.onerror = () => reject(new Error("daemon ws error"));
						ws.onmessage = ev => {
							let msg;
							try {
								msg = JSON.parse(ev.data);
							} catch {
								return;
							}
							if (msg && typeof msg.id === "number") {
								const p = pending.get(msg.id);
								if (p) {
									pending.delete(msg.id);
									msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result);
								}
							}
						};
					})
					.catch(reject);
			});
		return (method, params) =>
			open().then(() =>
				new Promise((resolve, reject) => {
					const id = ++seq;
					pending.set(id, { resolve, reject });
					ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
				}),
			);
	})();
	const load = async () => {
		let registry;
		try {
			registry = await rpc("extensions.list", {});
		} catch {
			return; // daemon unreachable — no extensions to host
		}
		const items = registry && Array.isArray(registry.components)
			? registry.components.filter(c => c && c.slot === "transcript.node" && c.code)
			: [];
		if (items.length === 0) return;
		const host = window.MusePiCompatHost;
		if (!host || typeof host.register !== "function") return;
		for (const item of items) {
			try {
				if (item.css) {
					const style = document.createElement("style");
					style.setAttribute("data-slot-css", item.extensionId + ":" + item.slot);
					style.textContent = item.css;
					document.head.appendChild(style);
				}
				const url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
				const mod = await import(url);
				if (typeof mod.default === "function") {
					host.register(item.slot, item.entryKinds ?? [], mod.default, item.extensionId);
				}
				URL.revokeObjectURL(url);
			} catch {
				// component failed to compile/load — built-in rendering stays
			}
		}
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", load, { once: true });
	} else {
		load();
	}
})();
</script>
`;
}

/** Boot config for the served renderer: where the daemon WS lives and the
 *  bearer token to present. Absent `wsUrl` → no host-mode (ConnectScreen). */
export function daemonWebConfig(options: DaemonWebOptions): string {
	return JSON.stringify({
		wsUrl: options.wsPort ? `ws://127.0.0.1:${options.wsPort}/` : undefined,
		token: options.token,
	});
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
};

function safeDistPath(distDir: string, urlPath: string): string {
	const resolved = path.normalize(path.join(distDir, decodeURIComponent(urlPath)));
	if (!resolved.startsWith(distDir)) return path.join(distDir, "index.html");
	return resolved;
}

/**
 * Serve the renderer bundle over loopback HTTP. SPA fallback: any non-asset
 * path (no extension) returns index.html so client-side routing works.
 */
export async function startDaemonWeb(options: DaemonWebOptions): Promise<DaemonWebHandle> {
	if (!options.distDir || !(await Bun.file(path.join(options.distDir, "index.html")).exists())) {
		throw new Error(`renderer dist not found at ${options.distDir} (build desktop-web first)`);
	}
	const server = Bun.serve({
		hostname: options.host ?? "127.0.0.1",
		port: options.port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === DAEMON_CONFIG_PATH) {
				const config = daemonWebConfig(options);
				return new Response(config, {
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			const isRoot = url.pathname === "/";
			const filePath = isRoot
				? path.join(options.distDir, "index.html")
				: safeDistPath(options.distDir, url.pathname);
			let file = Bun.file(filePath);
			if (!isRoot && !(await file.exists()) && !path.extname(filePath)) {
				// SPA fallback for client-route paths (no extension).
				file = Bun.file(path.join(options.distDir, "index.html"));
			}
			// Compat shell: `?shell=1` (Electron compat) gets the compat slot
			// host injected — the daemon-hosted extension components for
			// transcript.node. Plain browsers (collab guests) never see it.
			if (isRoot && url.searchParams.get("shell") === "1" && filePath.endsWith("index.html")) {
				const html = await file.text();
				const withHost = html.includes("</head>")
					? html.replace("</head>", compatSlotHostScript() + "</head>")
					: html + compatSlotHostScript();
				return new Response(withHost, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			return new Response(file, {
				headers: {
					"content-type":
						MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
				},
			});
		},
	});
	logger.info(`renderer served at http://127.0.0.1:${server.port}/ (compat shell target)`);
	const port = server.port ?? options.port;
	return {
		port,
		url: `http://127.0.0.1:${port}/`,
		close: async () => {
			await server.stop(true);
		},
	};
}
