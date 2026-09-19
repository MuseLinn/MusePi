/**
 * Cloudflare quick-tunnel lifecycle for collab sharing.
 *
 * The relay server binds a local port; a quick tunnel exposes it as a public
 * `wss://<id>.trycloudflare.com` endpoint so guests can join from anywhere
 * without a public relay. The public URL is NOT a secret by itself — collab
 * security is carried by the room key in the link fragment (never sent to the
 * relay) and the write token gating guest writes, so exposing the tunnel URL
 * is no worse than sharing through the default relay.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "@musepi/pi-utils/nodespawn";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const URL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
/** Reachability probe budget; short, since a blocked edge node fails fast. */
const PROBE_TIMEOUT_MS = 8_000;

export interface TunnelOptions {
	/** Local port the relay server listens on. */
	port: number;
	/** cloudflared binary; defaults to "cloudflared" resolved via PATH. */
	binary?: string;
	onStatus?: (line: string) => void;
	/** Abort while waiting for the tunnel URL; kills the child and rejects. */
	signal?: AbortSignal;
	/**
	 * Verify the advertised public URL is actually reachable before resolving.
	 * cloudflared prints the URL it *assigned*, not proof that this machine can
	 * reach that edge node, so on a blocked network the tunnel looks ready and
	 * only fails later at the host WebSocket with a bare `Failed to connect`
	 * (#36). Defaults to true.
	 */
	verifyReachable?: boolean;
}

/**
 * Raised when the tunnel URL was obtained but the public endpoint could not be
 * reached from this machine. Carries an actionable message instead of the
 * driver-level `Failed to connect`, which tells the user nothing they can act on.
 */
export class TunnelUnreachableError extends Error {
	constructor(
		readonly url: string,
		readonly host: string,
		override readonly cause?: unknown,
	) {
		super(
			`Public tunnel is not reachable from this machine (${host}). ` +
				"This network is likely blocking the tunnel edge node — in some regions " +
				"trycloudflare.com is filtered. If the phone and this computer are on the same " +
				"network, use LAN sharing instead of the public tunnel.",
		);
		this.name = "TunnelUnreachableError";
	}
}

/**
 * Confirm the tunnel host answers before we hand the link to the user.
 *
 * Deliberately lenient: ANY HTTP response proves the host is reachable (the
 * relay needs the upgraded WebSocket, so a plain GET legitimately 4xx/5xx).
 * Only a transport-level failure means the tunnel is unusable.
 */
export async function probeTunnelReachable(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
	const host = new URL(url).host;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		// A response at all means the path to the edge node works.
		await fetch(`https://${host}/`, { method: "GET", signal: controller.signal, redirect: "manual" });
	} catch (err) {
		throw new TunnelUnreachableError(url, host, err);
	} finally {
		clearTimeout(timer);
	}
}

/** Extract the quick-tunnel URL from cloudflared's stderr; null until it appears. */
export function extractQuickTunnelUrl(output: string): string | null {
	return QUICK_TUNNEL_URL_RE.exec(output)?.[0] ?? null;
}

export interface TunnelHandle {
	/** Public base URL (https/wss origin), e.g. https://abc123.trycloudflare.com */
	url: string;
	close: () => Promise<void>;
}

/**
 * Start `cloudflared tunnel --url ws://localhost:<port>` and wait for the
 * quick-tunnel URL on stderr. Rejects (and kills the child) if the URL does
 * not appear within {@link URL_TIMEOUT_MS}, the signal aborts, or the child
 * exits first.
 */
export async function startCloudflaredTunnel(options: TunnelOptions): Promise<TunnelHandle> {
	const binary = options.binary ?? "cloudflared";
	const onStatus = options.onStatus;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn(binary, ["tunnel", "--url", `ws://localhost:${options.port}`, "--no-autoupdate"], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	let settled = false;
	const finish = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		fn();
	};

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => {
		stderr += chunk;
		const url = extractQuickTunnelUrl(stderr);
		if (url) {
			finish(() => resolve(url));
		} else {
			const line = chunk.trim().split("\n").at(-1);
			if (line) onStatus?.(`tunnel: ${line}`);
		}
	});
	child.on("error", err => {
		const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
		const detail = missing
			? `${binary} is not installed. Install it with \`brew install cloudflared\` or from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
			: `failed to start ${binary}: ${err.message}`;
		finish(() => reject(new Error(detail)));
	});
	child.on("exit", code => {
		finish(() => reject(new Error(`${binary} exited with code ${code} before providing a tunnel URL`)));
	});

	const abortHandler = (): void => {
		finish(() => reject(new Error("tunnel aborted")));
		child.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", abortHandler, { once: true });

	const url = await Promise.race([promise, delayReject(URL_TIMEOUT_MS)]);
	options.signal?.removeEventListener("abort", abortHandler);
	onStatus?.(`tunnel: public URL ${url}`);

	// The URL existing is not the same as the tunnel working (#36). Probe it so a
	// blocked edge node surfaces here as a diagnosable error, rather than later as
	// a bare WebSocket `Failed to connect` with no way forward.
	if (options.verifyReachable !== false) {
		try {
			onStatus?.(`tunnel: checking ${url} is reachable`);
			await probeTunnelReachable(url);
		} catch (err) {
			await stopChild(child, onStatus);
			throw err;
		}
	}

	return {
		url,
		close: () => stopChild(child, onStatus),
	};
}

function delayReject(ms: number): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error("timed out waiting for tunnel URL")), ms);
	timer.unref?.();
	return promise;
}

async function stopChild(child: ChildProcess, onStatus?: (line: string) => void): Promise<void> {
	if (child.exitCode !== null || child.killed) return;
	onStatus?.("tunnel: stopping cloudflared");
	child.kill("SIGTERM");
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		resolve();
	}, STOP_TIMEOUT_MS);
	timer.unref?.();
	child.on("exit", () => {
		clearTimeout(timer);
		resolve();
	});
	await promise;
	onStatus?.("tunnel: stopped");
}
