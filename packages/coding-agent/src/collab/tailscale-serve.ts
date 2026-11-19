/**
 * Tailscale Serve: expose the LAN relay over the tailnet's MagicDNS name with
 * a real Let's Encrypt certificate, so tailnet devices (phones on cellular,
 * other machines) get a browser link with NO certificate warning.
 *
 * Serve holds one node-level proxy tree, so this module treats the user's
 * configuration as data to preserve, not an obstacle:
 *
 * 1. `tailscale serve get-config <file> --all` backs the current config up.
 * 2. The relay mounts on 443; when 443 is already served it mounts on 8443 and
 *    the port is carried into the link.
 * 3. `stop()` removes exactly its own entry (`serve --https=<port> off`) and,
 *    when there was a config to begin with, restores the backup with
 *    `serve set-config`. `serve reset` is never used.
 *
 * MusePi never runs `tailscale up`, never signs in, and stores no credential;
 * an unauthenticated or unconfigured node degrades to a LAN link with a hint
 * describing the one command or admin-console toggle the user must do.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "@musepi/pi-utils/nodespawn";
import {
	BaseExposure,
	type ExposureCapabilities,
	type ExposureInstallHint,
	type ExposureStartOptions,
	type ExposureStartResult,
	type ExposureStatus,
} from "./exposure";

// <machine>.<tailnet>.ts.net — the tailnet label is a second dotted segment.
const TS_NET_URL_RE = /https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/;
const RUN_TIMEOUT_MS = 15_000;
const DEFAULT_HTTPS_PORT = 443;
const FALLBACK_HTTPS_PORT = 8443;

const TAILSCALE_INSTALL: ExposureInstallHint = {
	url: "https://tailscale.com/download",
	commands: {
		darwin: "brew install --cask tailscale",
		linux: "curl -fsSL https://tailscale.com/install.sh | sh",
		win32: "winget install --id Tailscale.Tailscale",
	},
	note: "Guests also need Tailscale installed and signed in to the same tailnet; MusePi never signs in for you.",
};

export interface TailscaleServeHandle {
	/** https://<machine>.<tailnet>.ts.net[:port] */
	baseUrl: string;
	/** HTTPS port Serve is listening on (443, or the 8443 fallback). */
	httpsPort: number;
	stop: () => Promise<void>;
}

export interface TailscaleServeOptions {
	/** Local plaintext relay port the serve proxy points at. */
	port: number;
	onStatus?: (line: string) => void;
	/** tailscale binary; defaults to "tailscale" resolved via PATH. */
	binary?: string;
	/** Directory for the config backup; defaults to the OS temp dir. */
	backupDir?: string;
	/** Force a port instead of picking 443/8443 (tests, unusual setups). */
	httpsPort?: number;
}

export interface TailscaleProbe {
	available: boolean;
	detail: string;
	hint?: string;
	install?: ExposureInstallHint;
	/** MagicDNS name of this machine, when known. */
	dnsName?: string;
}

export interface TailscaleServeFailure {
	detail: string;
	hint?: string;
	install?: ExposureInstallHint;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	missing: boolean;
}

function runTailscale(binary: string, args: string[]): Promise<RunResult> {
	return new Promise(resolve => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: RunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr: `${stderr}\ntimed out`, missing: false });
		}, RUN_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", c => (stdout += c));
		child.stderr.on("data", c => (stderr += c));
		child.on("error", err => {
			const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
			finish({ code: null, stdout, stderr: err.message, missing });
		});
		child.on("exit", code => finish({ code, stdout, stderr, missing: false }));
	});
}

function lastLine(text: string): string {
	return (
		text
			.trim()
			.split("\n")
			.filter(line => line.trim())
			.at(-1)
			?.trim() ?? "unknown error"
	);
}

interface TailscaleStatus {
	backendState?: string;
	dnsName?: string;
	magicDnsEnabled?: boolean;
}

async function readStatus(binary: string): Promise<{ result: RunResult; status?: TailscaleStatus }> {
	const result = await runTailscale(binary, ["status", "--json"]);
	if (result.code !== 0) return { result };
	try {
		const raw: unknown = JSON.parse(result.stdout);
		if (!raw || typeof raw !== "object") return { result };
		const record = raw as Record<string, unknown>;
		const self = record.Self && typeof record.Self === "object" ? (record.Self as Record<string, unknown>) : {};
		const tailnet =
			record.CurrentTailnet && typeof record.CurrentTailnet === "object"
				? (record.CurrentTailnet as Record<string, unknown>)
				: {};
		return {
			result,
			status: {
				...(typeof record.BackendState === "string" ? { backendState: record.BackendState } : {}),
				...(typeof self.DNSName === "string" ? { dnsName: self.DNSName.replace(/\.$/, "") } : {}),
				...(typeof tailnet.MagicDNSEnabled === "boolean" ? { magicDnsEnabled: tailnet.MagicDNSEnabled } : {}),
			},
		};
	} catch {
		return { result };
	}
}

/** Can this machine serve over its tailnet right now, and if not, why? */
export async function probeTailscale(binary = "tailscale"): Promise<TailscaleProbe> {
	const { result, status } = await readStatus(binary);
	if (result.missing) {
		return {
			available: false,
			detail: `${binary} is not installed`,
			hint: TAILSCALE_INSTALL.commands[process.platform] ?? TAILSCALE_INSTALL.url,
			install: TAILSCALE_INSTALL,
		};
	}
	if (result.code !== 0 || !status) {
		return {
			available: false,
			detail: `tailscale status failed: ${lastLine(result.stderr)}`,
			hint: "Start the Tailscale daemon, then run `tailscale up` yourself and sign in.",
			install: TAILSCALE_INSTALL,
		};
	}
	if (status.backendState !== "Running") {
		return {
			available: false,
			detail: `tailscale is not connected (${status.backendState ?? "unknown state"})`,
			hint: "Run `tailscale up` yourself and sign in to the tailnet; MusePi never does this for you.",
		};
	}
	if (status.magicDnsEnabled === false) {
		return {
			available: false,
			detail: "MagicDNS is disabled for this tailnet",
			hint: "Enable MagicDNS in the Tailscale admin console (DNS page) so <machine>.<tailnet>.ts.net resolves.",
		};
	}
	if (!status.dnsName) {
		return {
			available: false,
			detail: "this machine has no MagicDNS name",
			hint: "Enable MagicDNS in the Tailscale admin console (DNS page), then reconnect Tailscale.",
		};
	}
	return { available: true, detail: `tailnet name ${status.dnsName}`, dnsName: status.dnsName };
}

/** Ports that already have a Serve entry (TCP map and Web hosts). */
export async function servedHttpsPorts(binary = "tailscale"): Promise<Set<number> | null> {
	const result = await runTailscale(binary, ["serve", "status", "--json"]);
	if (result.code !== 0) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(result.stdout || "{}");
	} catch {
		return null;
	}
	const ports = new Set<number>();
	if (!raw || typeof raw !== "object") return ports;
	const record = raw as Record<string, unknown>;
	const tcp = record.TCP;
	if (tcp && typeof tcp === "object") {
		for (const key of Object.keys(tcp)) {
			const port = Number(key);
			if (Number.isInteger(port)) ports.add(port);
		}
	}
	const web = record.Web;
	if (web && typeof web === "object") {
		for (const key of Object.keys(web)) {
			const port = Number(key.slice(key.lastIndexOf(":") + 1));
			if (Number.isInteger(port)) ports.add(port);
		}
	}
	return ports;
}

interface ServeBackup {
	path: string;
	text: string;
}

async function backupServeConfig(binary: string, backupDir: string): Promise<ServeBackup | null> {
	const file = path.join(backupDir, `musepi-tailscale-serve-${process.pid}-${Date.now()}.json`);
	await fs.promises.mkdir(backupDir, { recursive: true }).catch(() => {});
	const result = await runTailscale(binary, ["serve", "get-config", file, "--all"]);
	if (result.code !== 0) {
		await fs.promises.rm(file, { force: true }).catch(() => {});
		return null;
	}
	try {
		const text = await fs.promises.readFile(file, "utf8");
		// The backup can name local paths; keep it owner-only like the rest of
		// the machine's config.
		await fs.promises.chmod(file, 0o600).catch(() => {});
		return { path: file, text };
	} catch {
		return null;
	}
}

function backupIsEmpty(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "" || trimmed === "{}" || trimmed === "null";
}

function httpsHint(detail: string): string | undefined {
	return /https|certificate|cert/i.test(detail)
		? "Enable HTTPS certificates for this tailnet in the Tailscale admin console (DNS page), then retry."
		: undefined;
}

/**
 * Start Serve in front of the relay. Throws with an actionable message when
 * the node cannot serve; {@link startTailscaleServe} keeps the old
 * null-on-failure shape for LAN decoration.
 */
export async function startTailscaleServeDetailed(
	options: TailscaleServeOptions,
): Promise<{ handle: TailscaleServeHandle | null; failure?: TailscaleServeFailure }> {
	const onStatus = options.onStatus;
	const binary = options.binary ?? "tailscale";

	const probe = await probeTailscale(binary);
	if (!probe.available) {
		onStatus?.(`tunnel: tailscale serve unavailable (${probe.detail})`);
		return { handle: null, failure: { detail: probe.detail, hint: probe.hint, install: probe.install } };
	}

	const ports = (await servedHttpsPorts(binary)) ?? new Set<number>();
	let httpsPort: number;
	if (options.httpsPort !== undefined) {
		httpsPort = options.httpsPort;
	} else if (!ports.has(DEFAULT_HTTPS_PORT)) {
		httpsPort = DEFAULT_HTTPS_PORT;
	} else if (!ports.has(FALLBACK_HTTPS_PORT)) {
		httpsPort = FALLBACK_HTTPS_PORT;
	} else {
		const detail = "Tailscale Serve already uses both 443 and 8443 on this machine";
		onStatus?.(`tunnel: ${detail} — using the self-signed LAN link`);
		return {
			handle: null,
			failure: {
				detail,
				hint: "Run `tailscale serve status` to see the existing entries and stop one you no longer need.",
			},
		};
	}

	const backup = await backupServeConfig(binary, options.backupDir ?? os.tmpdir());
	if (!backup)
		onStatus?.("tunnel: could not back up the existing tailscale serve config; only our entry will be removed");

	onStatus?.(`tunnel: starting tailscale serve --https=${httpsPort} → http://localhost:${options.port}`);
	const started = await runTailscale(binary, [
		"serve",
		"--bg",
		`--https=${httpsPort}`,
		`http://localhost:${options.port}`,
	]);
	if (started.code !== 0) {
		const detail = lastLine(started.stderr);
		if (backup) await fs.promises.rm(backup.path, { force: true }).catch(() => {});
		onStatus?.(`tunnel: tailscale serve failed (${detail}) — using the self-signed LAN link`);
		return { handle: null, failure: { detail, hint: httpsHint(detail) } };
	}

	const dnsName = probe.dnsName;
	const printed = TS_NET_URL_RE.exec(started.stdout)?.[0] ?? TS_NET_URL_RE.exec(started.stderr)?.[0];
	const baseUrl =
		printed ?? (dnsName ? `https://${dnsName}${httpsPort === DEFAULT_HTTPS_PORT ? "" : `:${httpsPort}`}` : undefined);
	if (!baseUrl) {
		const detail = "tailscale serve did not report a tailnet URL";
		onStatus?.(`tunnel: ${detail} — using the self-signed LAN link`);
		if (backup) await fs.promises.rm(backup.path, { force: true }).catch(() => {});
		return { handle: null, failure: { detail } };
	}

	onStatus?.(`tunnel: tailnet URL ${baseUrl} (no cert warning)`);
	let stopped = false;
	return {
		handle: {
			baseUrl,
			httpsPort,
			stop: async () => {
				if (stopped) return;
				stopped = true;
				// Remove exactly our entry; `serve reset` would wipe the user's own.
				const off = await runTailscale(binary, ["serve", `--https=${httpsPort}`, "off"]);
				if (off.code !== 0) {
					onStatus?.(`tunnel: could not remove the tailscale serve entry (${lastLine(off.stderr)})`);
				}
				if (backup && !backupIsEmpty(backup.text)) {
					const restored = await runTailscale(binary, ["serve", "set-config", backup.path, "--all"]);
					if (restored.code !== 0) {
						onStatus?.(
							`tunnel: could not restore the previous tailscale serve config (${lastLine(restored.stderr)})`,
						);
					} else {
						onStatus?.("tunnel: previous tailscale serve config restored");
					}
				}
				if (backup) await fs.promises.rm(backup.path, { force: true }).catch(() => {});
			},
		},
	};
}

/**
 * Start `tailscale serve --bg http://localhost:<port>` and return the tailnet
 * base URL, or null when serve cannot be used. Kept for the LAN share, which
 * only decorates its link and must never fail because Serve is unavailable.
 */
export async function startTailscaleServe(options: TailscaleServeOptions): Promise<TailscaleServeHandle | null> {
	const { handle } = await startTailscaleServeDetailed(options);
	return handle;
}

export interface TailscaleExposureOptions {
	binary?: string;
	backupDir?: string;
	httpsPort?: number;
}

/** Tailscale Serve as a pluggable share exposure. */
export class TailscaleExposure extends BaseExposure {
	readonly id = "tailscale";
	readonly label = "Tailscale Serve";
	readonly capabilities: ExposureCapabilities = {
		guestInstall: true,
		publicExposure: false,
		stableUrl: true,
		thirdParty: true,
	};
	#options: TailscaleExposureOptions;
	#handle: TailscaleServeHandle | null = null;

	constructor(options: TailscaleExposureOptions = {}) {
		super("tailscale");
		this.#options = options;
	}

	async probe(): Promise<ExposureStatus> {
		const probe = await probeTailscale(this.#options.binary);
		if (!probe.available) {
			this.setStatus({
				id: this.id,
				health: "unavailable",
				detail: probe.detail,
				...(probe.hint ? { hint: probe.hint } : {}),
				...(probe.install ? { install: probe.install } : {}),
			});
			return this.status();
		}
		const ports = await servedHttpsPorts(this.#options.binary);
		if (ports?.has(DEFAULT_HTTPS_PORT) && ports.has(FALLBACK_HTTPS_PORT)) {
			this.setStatus({
				id: this.id,
				health: "degraded",
				detail: "Tailscale Serve already uses both 443 and 8443 on this machine",
				hint: "Run `tailscale serve status` and stop an entry you no longer need.",
			});
			return this.status();
		}
		const httpsPort =
			this.#options.httpsPort ?? (ports?.has(DEFAULT_HTTPS_PORT) ? FALLBACK_HTTPS_PORT : DEFAULT_HTTPS_PORT);
		this.setStatus({
			id: this.id,
			health: "ready",
			detail: probe.detail,
			url: probe.dnsName
				? `https://${probe.dnsName}${httpsPort === DEFAULT_HTTPS_PORT ? "" : `:${httpsPort}`}`
				: undefined,
		});
		return this.status();
	}

	async start(options: ExposureStartOptions): Promise<ExposureStartResult> {
		await this.close();
		this.setStatus({ id: this.id, health: "starting" });
		const { handle, failure } = await startTailscaleServeDetailed({
			port: options.port,
			onStatus: options.onStatus,
			binary: this.#options.binary,
			backupDir: this.#options.backupDir,
			httpsPort: this.#options.httpsPort,
		});
		if (!handle) {
			this.setStatus({
				id: this.id,
				health: failure?.install ? "unavailable" : "degraded",
				detail: failure?.detail ?? "tailscale serve failed",
				...(failure?.hint ? { hint: failure.hint } : {}),
				...(failure?.install ? { install: failure.install } : {}),
			});
			throw new Error(failure?.detail ?? "tailscale serve failed");
		}
		this.#handle = handle;
		this.setStatus({ id: this.id, health: "ready", url: handle.baseUrl, detail: `tailnet port ${handle.httpsPort}` });
		const wsUrl = handle.baseUrl.replace(/^https:/, "wss:");
		return { joinUrl: wsUrl, webUrl: handle.baseUrl, webJoinUrl: wsUrl };
	}

	override async close(): Promise<void> {
		const handle = this.#handle;
		this.#handle = null;
		if (handle) await handle.stop().catch(() => {});
		this.setStatus({ id: this.id, health: this.status().health === "degraded" ? "degraded" : "stopped" });
	}
}
