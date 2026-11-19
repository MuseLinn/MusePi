/**
 * ngrok tunnel lifecycle for collab sharing — an alternative exposure to
 * Cloudflare Tunnel (OpenChamber exposes the same choice).
 *
 * `ngrok http <port> --log stdout --log-format json` prints the public URL as
 * a JSON log line; we scan stdout and stderr. ngrok's free tier requires a
 * one-time `ngrok config add-authtoken <TOKEN>` (see the error message and the
 * install hint), which MusePi never does for the user.
 *
 * The exposure wrapper watches the child and the public host so a tunnel that
 * dies after being advertised is revoked instead of leaving a dead link.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "@musepi/pi-utils/nodespawn";
import {
	BaseExposure,
	type ExposureCapabilities,
	type ExposureInstallHint,
	type ExposureStartOptions,
	type ExposureStartResult,
	type ExposureStatus,
} from "./exposure";
import { probeTunnelReachable, type TunnelHandle } from "./tunnel";

const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/;
const URL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const HEALTH_INTERVAL_MS = 30_000;

const NGROK_INSTALL: ExposureInstallHint = {
	url: "https://ngrok.com/download",
	commands: {
		darwin: "brew install ngrok/ngrok/ngrok",
		linux: "snap install ngrok",
		win32: "choco install ngrok",
	},
	note: "The free tier needs a one-time `ngrok config add-authtoken <TOKEN>`; MusePi never runs it for you.",
};

export interface NgrokTunnelOptions {
	/** Local port the relay server listens on. */
	port: number;
	/** ngrok binary; defaults to "ngrok" resolved via PATH. */
	binary?: string;
	onStatus?: (line: string) => void;
	/** Abort while waiting for the tunnel URL; kills the child and rejects. */
	signal?: AbortSignal;
	/** Verify the public URL is reachable before resolving; see {@link probeTunnelReachable}. */
	verifyReachable?: boolean;
}

/** Extract the ngrok public URL from its JSON log output; null until it appears. */
export function extractNgrokUrl(output: string): string | null {
	return NGROK_URL_RE.exec(output)?.[0] ?? null;
}

/**
 * Start `ngrok http <port>` and wait for the public URL on stdout. Rejects
 * (and kills the child) if the URL does not appear within {@link URL_TIMEOUT_MS},
 * the signal aborts, or the child exits first.
 */
export async function startNgrokTunnel(options: NgrokTunnelOptions): Promise<TunnelHandle> {
	const binary = options.binary ?? "ngrok";
	const onStatus = options.onStatus;
	const { promise, resolve, reject } = Promise.withResolvers<string>();

	onStatus?.(`tunnel: starting ${binary} http ${options.port}`);
	const child = spawn(binary, ["http", String(options.port), "--log", "stdout", "--log-format", "json"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
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

	const scan = (chunk: string): void => {
		output += chunk;
		const url = extractNgrokUrl(output);
		if (url) {
			finish(() => resolve(url));
			return;
		}
		const line = chunk.trim().split("\n").at(-1);
		if (line) onStatus?.(`tunnel: ${line}`);
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", scan);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", scan);

	child.on("error", err => {
		const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
		const detail = missing ? ngrokMissingMessage(binary) : `failed to start ${binary}: ${err.message}`;
		finish(() => reject(new Error(detail)));
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

function ngrokMissingMessage(binary: string): string {
	return `${binary} is not installed. Install it with \`brew install ngrok/ngrok/ngrok\` (macOS), \`choco install ngrok\` (Windows) or \`snap install ngrok\` (Linux), then run \`ngrok config add-authtoken <TOKEN>\` once (https://dashboard.ngrok.com/get-started/setup)`;
}

function delayReject(ms: number): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error("timed out waiting for tunnel URL")), ms);
	timer.unref?.();
	return promise;
}

async function stopChild(child: ChildProcess, onStatus?: (line: string) => void): Promise<void> {
	if (child.exitCode !== null || child.killed) return;
	onStatus?.("tunnel: stopping ngrok");
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
}

export interface NgrokExposureOptions {
	binary?: string;
	healthIntervalMs?: number;
	verifyReachable?: boolean;
}

/** ngrok as a pluggable share exposure. */
export class NgrokExposure extends BaseExposure {
	readonly id = "ngrok";
	readonly label = "ngrok";
	readonly capabilities: ExposureCapabilities = {
		guestInstall: false,
		publicExposure: true,
		stableUrl: false,
		thirdParty: true,
	};
	#options: NgrokExposureOptions;
	#handle: TunnelHandle | null = null;
	#monitor: ReturnType<typeof setInterval> | null = null;
	#closing = false;

	constructor(options: NgrokExposureOptions = {}) {
		super("ngrok");
		this.#options = options;
	}

	async probe(): Promise<ExposureStatus> {
		const binary = this.#options.binary ?? "ngrok";
		const ok = await probeNgrokBinary(binary);
		const status: ExposureStatus = ok
			? { id: this.id, health: "ready", detail: "public URL changes each start" }
			: {
					id: this.id,
					health: "unavailable",
					detail: `${binary} is not installed`,
					hint: NGROK_INSTALL.commands[process.platform] ?? NGROK_INSTALL.url,
					install: NGROK_INSTALL,
				};
		this.setStatus(status);
		return status;
	}

	async start(options: ExposureStartOptions): Promise<ExposureStartResult> {
		await this.close();
		this.#closing = false;
		this.setStatus({ id: this.id, health: "starting" });
		try {
			const handle = await startNgrokTunnel({
				port: options.port,
				binary: this.#options.binary,
				onStatus: options.onStatus,
				signal: options.signal,
				verifyReachable: options.verifyReachable ?? this.#options.verifyReachable,
			});
			this.#handle = handle;
			this.setStatus({ id: this.id, health: "ready", url: handle.url, detail: "public tunnel" });
			this.#startMonitoring(handle);
			return { joinUrl: handle.url, webUrl: "", webJoinUrl: handle.url };
		} catch (error) {
			this.setStatus({
				id: this.id,
				health: "degraded",
				detail: error instanceof Error ? error.message : String(error),
				hint: NGROK_INSTALL.note,
			});
			throw error;
		}
	}

	#startMonitoring(handle: TunnelHandle): void {
		void handle.exited.then(reason => {
			if (this.#closing || this.status().health !== "ready") return;
			this.#degrade(reason);
		});
		const interval = this.#options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
		if (interval <= 0) return;
		this.#monitor = setInterval(() => {
			if (this.status().health !== "ready") return;
			void probeTunnelReachable(handle.url).catch(err => {
				this.#degrade(err instanceof Error ? err.message : String(err));
			});
		}, interval);
		this.#monitor.unref?.();
	}

	#degrade(detail: string): void {
		clearInterval(this.#monitor ?? undefined);
		this.#monitor = null;
		const handle = this.#handle;
		this.#handle = null;
		this.setStatus({
			id: this.id,
			health: "degraded",
			detail,
			hint: "The public URL stopped working; restart the share.",
		});
		void handle?.close().catch(() => {});
	}

	override async close(): Promise<void> {
		this.#closing = true;
		clearInterval(this.#monitor ?? undefined);
		this.#monitor = null;
		const handle = this.#handle;
		this.#handle = null;
		if (handle) await handle.close().catch(() => {});
		this.setStatus({ id: this.id, health: this.status().health === "degraded" ? "degraded" : "stopped" });
	}
}

async function probeNgrokBinary(binary: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const child = spawn(binary, ["version"], { stdio: ["ignore", "ignore", "ignore"] });
	let settled = false;
	const finish = (ok: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(ok);
	};
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(true);
	}, 5_000);
	timer.unref?.();
	// Only "could not launch" means missing; a non-zero version flag still
	// proves the binary is installed.
	child.on("error", () => finish(false));
	child.on("exit", () => finish(true));
	return promise;
}
