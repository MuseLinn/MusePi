/**
 * Cloudflare Tunnel lifecycle for collab sharing.
 *
 * Two modes share one binary:
 *
 * - **quick** (zero config) starts `cloudflared tunnel --url ws://localhost:<port>`
 *   and exposes a random `https://<id>.trycloudflare.com` origin. The URL
 *   changes on every start, so it is parsed from `--logformat json` output
 *   (plain-text logs still work) and the public host is probed before the link
 *   is handed out.
 * - **named** starts `cloudflared tunnel run` with the tunnel token in
 *   `TUNNEL_TOKEN` — never in argv or logs — and uses the configured hostname
 *   instead of scraping anything.
 *
 * Both modes monitor the child and the public host. A tunnel that dies after
 * being advertised is revoked immediately: the URL is cleared, health becomes
 * `degraded` with the reason, and the caller tears the relay down rather than
 * leaving a dead link on screen.
 */
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { spawn } from "@musepi/pi-utils/nodespawn";
import { CONNECTOR_DIR_NAME } from "../connectors/types";
import { encryptedStore, listSecretIds, mergeSecret, readSecretValue } from "../secrets/encrypted-store";
import {
	BaseExposure,
	type ExposureCapabilities,
	type ExposureInstallHint,
	type ExposureStartOptions,
	type ExposureStartResult,
	type ExposureStatus,
	type ShareExposure,
} from "./exposure";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const URL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
/** Reachability probe budget; short, since a blocked edge node fails fast. */
const PROBE_TIMEOUT_MS = 8_000;
/** Post-start health cadence: Cloudflare closes an idle tunnel edge eventually. */
const HEALTH_INTERVAL_MS = 30_000;
/** Named tunnels register asynchronously; this is the fallback readiness budget. */
const NAMED_SETTLE_MS = 3_000;

const CLOUDFLARED_INSTALL: ExposureInstallHint = {
	url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
	commands: {
		darwin: "brew install cloudflared",
		linux: "curl -L https://pkg.cloudflare.com/cloudflared/install.sh | sudo bash",
		win32: "winget install --id Cloudflare.cloudflared",
	},
	note: "MusePi never installs it for you; quick tunnels need no account, named tunnels need a tunnel token.",
};

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

/** Extract the quick-tunnel URL from cloudflared output; null until it appears. */
export function extractQuickTunnelUrl(output: string): string | null {
	return QUICK_TUNNEL_URL_RE.exec(output)?.[0] ?? null;
}

/** One cloudflared log line, JSON first with a plain-text fallback. */
export function parseCloudflaredLine(line: string): { url?: string; message?: string } {
	const trimmed = line.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") {
				const record = parsed as Record<string, unknown>;
				const rawUrl = typeof record.url === "string" ? record.url : undefined;
				const message = typeof record.msg === "string" ? record.msg : undefined;
				return {
					...(rawUrl && QUICK_TUNNEL_URL_RE.test(rawUrl) ? { url: rawUrl } : {}),
					...(message ? { message } : {}),
				};
			}
		} catch {
			// A truncated JSON line falls through to the text parser.
		}
	}
	return {
		...(extractQuickTunnelUrl(trimmed) ? { url: extractQuickTunnelUrl(trimmed)! } : {}),
		message: trimmed,
	};
}

export interface TunnelHandle {
	/** Public base URL (https/wss origin). */
	url: string;
	close: () => Promise<void>;
	/** Resolves with a human-readable reason if the child exits on its own. */
	exited: Promise<string>;
}

export type CloudflaredMode = "quick" | "named";

export interface NamedTunnelOptions extends TunnelOptions {
	/** Public hostname routed to this tunnel, e.g. `collab.example.com`. */
	hostname: string;
	/** Tunnel token; passed to the child only through `TUNNEL_TOKEN`. */
	token: string;
}

function spawnCloudflared(binary: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
	return spawn(binary, args, {
		stdio: ["ignore", "ignore", "pipe"],
		...(env ? { env } : {}),
	});
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
	const child = spawnCloudflared(binary, [
		"--logformat",
		"json",
		"tunnel",
		"--url",
		`ws://localhost:${options.port}`,
		"--no-autoupdate",
	]);
	let output = "";
	let settled = false;
	let resolveExit: (reason: string) => void = () => {};
	const exited = new Promise<string>(resolvePromise => {
		resolveExit = resolvePromise;
	});
	const finish = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		fn();
	};

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", chunk => {
		output += chunk;
		const url = extractQuickTunnelUrl(output);
		if (url) {
			finish(() => resolve(url));
		} else {
			const line = parseCloudflaredLine(chunk.trim().split("\n").at(-1) ?? "");
			if (line.message) onStatus?.(`tunnel: ${line.message}`);
		}
	});
	child.on("error", err => {
		finish(() => reject(new Error(cloudflaredStartError(binary, err))));
	});
	child.on("exit", code => {
		resolveExit(`${binary} exited with code ${code}`);
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
		exited,
	};
}

/**
 * Start a named tunnel. The token reaches cloudflared only as `TUNNEL_TOKEN`;
 * argv and status lines never carry it. Readiness comes from the connector
 * registration line (or a short settle window), and the public hostname is the
 * configured one, never scraped.
 */
export async function startNamedCloudflaredTunnel(options: NamedTunnelOptions): Promise<TunnelHandle> {
	const binary = options.binary ?? "cloudflared";
	const onStatus = options.onStatus;
	const hostname = options.hostname
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "");
	if (!hostname) throw new Error("named Cloudflare tunnel needs a hostname (collab.cloudflaredHostname)");
	if (!options.token) {
		throw new Error(
			"named Cloudflare tunnel needs a tunnel token — save one from the Cloudflare Zero Trust dashboard first",
		);
	}
	const url = `https://${hostname}`;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let settled = false;
	let resolveExit: (reason: string) => void = () => {};
	const exited = new Promise<string>(resolvePromise => {
		resolveExit = resolvePromise;
	});
	// The token travels only through the child's environment: argv appears in
	// process listings and in the status lines we echo back to the user.
	const child = spawnCloudflared(binary, ["--logformat", "json", "tunnel", "--no-autoupdate", "run"], {
		...process.env,
		TUNNEL_TOKEN: options.token,
	});
	const settle = setTimeout(() => {
		if (!settled) {
			settled = true;
			resolve(url);
		}
	}, NAMED_SETTLE_MS);
	const finishReady = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(settle);
		resolve(url);
	};
	const finishError = (message: string): void => {
		if (settled) return;
		settled = true;
		clearTimeout(settle);
		reject(new Error(message));
	};

	const scan = (chunk: string): void => {
		for (const line of chunk.split("\n")) {
			const parsed = parseCloudflaredLine(line);
			if (parsed.message) onStatus?.(`tunnel: ${parsed.message}`);
			if (parsed.message?.includes("Registered tunnel connection")) finishReady();
		}
	};
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", scan);
	child.on("error", err => finishError(cloudflaredStartError(binary, err)));
	child.on("exit", code => {
		const reason = `${binary} exited with code ${code}`;
		resolveExit(reason);
		finishError(`${reason} before the tunnel registered`);
	});

	const abortHandler = (): void => {
		finishError("tunnel aborted");
		child.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", abortHandler, { once: true });

	await promise;
	options.signal?.removeEventListener("abort", abortHandler);
	onStatus?.(`tunnel: named tunnel ${url}`);

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
		exited,
	};
}

function cloudflaredStartError(binary: string, err: unknown): string {
	const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
	if (missing) {
		return `${binary} is not installed. Install it with \`brew install cloudflared\` (macOS), \`winget install --id Cloudflare.cloudflared\` (Windows) or the package from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`;
	}
	const message = err instanceof Error ? err.message : String(err);
	return `failed to start ${binary}: ${message}`;
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

// ---------------------------------------------------------------------------
// Named-tunnel token storage
// ---------------------------------------------------------------------------

const COLLAB_SECRET_PREFIX = "collab.cloudflared.";

/** The secret id that holds one tunnel's token. */
export function cloudflaredSecretId(tunnelId: string): string {
	return `${COLLAB_SECRET_PREFIX}${tunnelId}`;
}

/** Cloudflare tunnel tokens are base64 JSON; `t` is the tunnel id. */
export function tunnelIdFromToken(token: string): string | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
		if (parsed && typeof parsed === "object" && typeof (parsed as { t?: unknown }).t === "string") {
			return (parsed as { t: string }).t;
		}
	} catch {
		// Opaque token forms have no id we can read; the caller keeps its own.
	}
	return null;
}

function collabSecretStore(agentDir: string = getAgentDir()) {
	return encryptedStore(path.join(agentDir, CONNECTOR_DIR_NAME), {
		masterKeyEnv: "MUSEPI_CONNECTOR_MASTER_KEY",
	});
}

/** Persist a tunnel token under its own id, so restarts need no environment. */
export async function storeCloudflaredTunnelToken(token: string, agentDir: string = getAgentDir()): Promise<string> {
	const tunnelId = tunnelIdFromToken(token);
	if (!tunnelId) throw new Error("cannot read the tunnel id from this token (expected Cloudflare's base64 JSON form)");
	const id = cloudflaredSecretId(tunnelId);
	await mergeSecret(collabSecretStore(agentDir), id, { token });
	return id;
}

export async function readCloudflaredTunnelToken(
	tunnelId: string,
	agentDir: string = getAgentDir(),
): Promise<string | undefined> {
	return readSecretValue(collabSecretStore(agentDir), cloudflaredSecretId(tunnelId), "token");
}

/** Explicit token > environment > the single stored token. */
async function resolveNamedToken(
	explicit: string | undefined,
	agentDir: string,
): Promise<{ token?: string; ambiguous?: boolean }> {
	if (explicit) return { token: explicit };
	const env = process.env.MUSEPI_CLOUDFLARE_TUNNEL_TOKEN ?? process.env.TUNNEL_TOKEN;
	if (env?.trim()) return { token: env.trim() };
	const store = collabSecretStore(agentDir);
	const ids = (await listSecretIds(store)).filter(id => id.startsWith(COLLAB_SECRET_PREFIX));
	if (ids.length === 0) return {};
	if (ids.length > 1) return { ambiguous: true };
	return { token: await readSecretValue(store, ids[0]!, "token") };
}

export interface CloudflaredExposureOptions {
	/** Configured hostname; empty selects quick mode. */
	hostname?: string;
	/** Test seam; otherwise env, then the encrypted store. */
	token?: string;
	binary?: string;
	agentDir?: string;
	healthIntervalMs?: number;
	/** Follow-up probes after start; off for tests that fake fetch. */
	verifyReachable?: boolean;
}

/** Cloudflare Tunnel as a pluggable share exposure (quick or named). */
export class CloudflaredExposure extends BaseExposure {
	readonly id = "cloudflared";
	readonly label = "Cloudflare Tunnel";
	#options: CloudflaredExposureOptions;
	#mode: CloudflaredMode = "quick";
	#handle: TunnelHandle | null = null;
	#monitor: ReturnType<typeof setInterval> | null = null;
	#closing = false;

	constructor(options: CloudflaredExposureOptions = {}) {
		super("cloudflared");
		this.#options = options;
	}

	get capabilities(): ExposureCapabilities {
		return {
			guestInstall: false,
			publicExposure: true,
			stableUrl: this.#mode === "named",
			thirdParty: true,
		};
	}

	#set(next: ExposureStatus): void {
		this.setStatus(next);
	}

	async probe(): Promise<ExposureStatus> {
		const binary = this.#options.binary ?? "cloudflared";
		const version = await probeBinary(binary);
		if (!version.ok) {
			this.#set({
				id: this.id,
				health: "unavailable",
				detail: `${binary} is not installed`,
				hint: CLOUDFLARED_INSTALL.commands[process.platform] ?? CLOUDFLARED_INSTALL.url,
				install: CLOUDFLARED_INSTALL,
			});
			return this.status();
		}
		const hostname = this.#options.hostname?.trim();
		if (hostname) {
			this.#mode = "named";
			const resolved = await resolveNamedToken(this.#options.token, this.#options.agentDir ?? getAgentDir());
			if (resolved.ambiguous) {
				this.#set({
					id: this.id,
					health: "degraded",
					detail: "several Cloudflare tunnel tokens are stored and none was selected",
					hint: "Save the token for the tunnel you want to run, or pass it as MUSEPI_CLOUDFLARE_TUNNEL_TOKEN.",
				});
				return this.status();
			}
			if (!resolved.token) {
				this.#set({
					id: this.id,
					health: "degraded",
					detail: `named tunnel ${hostname} has no token`,
					hint: "Create a tunnel in the Cloudflare Zero Trust dashboard, then save its token for this machine.",
				});
				return this.status();
			}
			this.#set({ id: this.id, health: "ready", detail: `named tunnel ${hostname}`, url: `https://${hostname}` });
			return this.status();
		}
		this.#mode = "quick";
		this.#set({ id: this.id, health: "ready", detail: "quick tunnel (URL changes each start)" });
		return this.status();
	}

	async start(options: ExposureStartOptions): Promise<ExposureStartResult> {
		await this.close();
		this.#closing = false;
		this.setStatus({ id: this.id, health: "starting" });
		const hostname = this.#options.hostname?.trim();
		try {
			let handle: TunnelHandle;
			if (hostname) {
				this.#mode = "named";
				const resolved = await resolveNamedToken(this.#options.token, this.#options.agentDir ?? getAgentDir());
				if (!resolved.token) {
					throw new Error(
						resolved.ambiguous
							? "several Cloudflare tunnel tokens are stored and none was selected"
							: `named tunnel ${hostname} has no token — save one from the Cloudflare Zero Trust dashboard`,
					);
				}
				handle = await startNamedCloudflaredTunnel({
					port: options.port,
					hostname,
					token: resolved.token,
					binary: this.#options.binary,
					onStatus: options.onStatus,
					signal: options.signal,
					verifyReachable: options.verifyReachable ?? this.#options.verifyReachable,
				});
			} else {
				this.#mode = "quick";
				handle = await startCloudflaredTunnel({
					port: options.port,
					binary: this.#options.binary,
					onStatus: options.onStatus,
					signal: options.signal,
					verifyReachable: options.verifyReachable ?? this.#options.verifyReachable,
				});
			}
			this.#handle = handle;
			this.#set({
				id: this.id,
				health: "ready",
				url: handle.url,
				detail: this.#mode === "named" ? `named tunnel ${hostname}` : "quick tunnel",
			});
			this.#startMonitoring(handle, options.onStatus);
			return { joinUrl: handle.url, webUrl: "", webJoinUrl: handle.url };
		} catch (error) {
			this.#set({
				id: this.id,
				health: "degraded",
				detail: error instanceof Error ? error.message : String(error),
				hint: "Check that the tunnel host is reachable from this network; LAN sharing needs no tunnel.",
			});
			throw error;
		}
	}

	#startMonitoring(handle: TunnelHandle, onStatus?: (line: string) => void): void {
		void handle.exited.then(reason => {
			// Closing the share kills the child ourselves; that is not a failure.
			if (this.#closing || this.status().health !== "ready") return;
			this.#degrade(reason, "cloudflared stopped unexpectedly; start the share again");
		});
		const interval = this.#options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
		if (interval <= 0) return;
		this.#monitor = setInterval(() => {
			if (this.status().health !== "ready") return;
			void probeTunnelReachable(handle.url).catch(err => {
				this.#degrade(
					err instanceof Error ? err.message : String(err),
					"The public host stopped answering; restart the share or use LAN sharing.",
				);
			});
		}, interval);
		this.#monitor.unref?.();
		onStatus?.(`tunnel: health check every ${Math.round(interval / 1000)}s`);
	}

	#degrade(detail: string, hint: string): void {
		clearInterval(this.#monitor ?? undefined);
		this.#monitor = null;
		const handle = this.#handle;
		this.#handle = null;
		this.#set({ id: this.id, health: "degraded", detail, hint });
		void handle?.close().catch(() => {});
	}

	override async close(): Promise<void> {
		this.#closing = true;
		clearInterval(this.#monitor ?? undefined);
		this.#monitor = null;
		const handle = this.#handle;
		this.#handle = null;
		if (handle) await handle.close().catch(() => {});
		this.#set({ id: this.id, health: this.status().health === "degraded" ? "degraded" : "stopped" });
	}
}

async function probeBinary(binary: string): Promise<{ ok: boolean; detail?: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; detail?: string }>();
	const child = spawn(binary, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	let settled = false;
	const finish = (result: { ok: boolean; detail?: string }): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish({ ok: true, detail: "version probe timed out" });
	}, 5_000);
	timer.unref?.();
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", chunk => (stderr += chunk));
	// Only "could not launch" means missing: a version flag that exits non-zero
	// still proves the binary is there.
	child.on("error", () => finish({ ok: false, detail: stderr }));
	child.on("exit", () => finish({ ok: true }));
	return promise;
}

export function cloudflaredExposure(options: CloudflaredExposureOptions = {}): ShareExposure {
	return new CloudflaredExposure(options);
}
