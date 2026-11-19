/**
 * Host-side sharing lifecycle for `/collab lan` and `/collab tunnel`.
 *
 * A LAN share binds the relay server to 0.0.0.0 and points the share link at
 * the machine's routable IPv4, so guests on the same network join without a
 * public relay. A tunnel share adds a pluggable exposure (Cloudflare Tunnel,
 * ngrok, Tailscale Serve, or one a plugin registered) in front of a
 * loopback-bound relay.
 *
 * Both modes serve the client-core `dist/` on the same port so the browser
 * deep link resolves to a real UI (when the build exists). The manager owns
 * the share TTL and reacts to exposure health: a tunnel that dies revokes its
 * link immediately instead of leaving a dead URL on screen.
 */
import * as fs from "node:fs";
import { networkInterfaces } from "node:os";
import * as path from "node:path";
import { settings } from "../config/settings";
import { ensureLanCertificate } from "./cert";
import {
	type ExposureRegistry,
	type ExposureStatus,
	exposureRegistry,
	lanExposureStatus,
	type ShareExposure,
} from "./exposure";
import { NgrokExposure } from "./ngrok";
import { type RelayServerHandle, type Room, startRelayServer } from "./relay-server";
import { startTailscaleServe, TailscaleExposure, type TailscaleServeHandle } from "./tailscale-serve";
import { CloudflaredExposure, type TunnelHandle } from "./tunnel";

const DEFAULT_PORT = 7654;
const COLLAB_WEB_DIST = path.resolve(import.meta.dir, "../../../client-core/dist");

let builtinsRegistered = false;

/**
 * Make the shipped exposures available in the registry. Plugins register
 * their own after this (or replace one by id); the manager never hard-codes a
 * transport list beyond this default set.
 */
export function ensureBuiltinExposures(): void {
	if (builtinsRegistered) return;
	builtinsRegistered = true;
	exposureRegistry.register(
		"cloudflared",
		() => new CloudflaredExposure({ hostname: readSetting("collab.cloudflaredHostname", "") || undefined }),
	);
	exposureRegistry.register("ngrok", () => new NgrokExposure());
	exposureRegistry.register("tailscale", () => new TailscaleExposure());
}

export interface LocalShareOptions {
	port?: number;
	onStatus?: (line: string) => void;
	/** Health transitions of the active share; null once it is torn down. */
	onExposureHealth?: (status: ExposureStatus | null) => void;
	/** Called after the share TTL expired and the manager already stopped. */
	onTtlExpired?: () => void;
	/** Overrides `collab.shareTtlMinutes`; 0 disables the TTL. */
	shareTtlMinutes?: number;
	/** Test seam: registry to resolve exposure ids from. */
	registry?: ExposureRegistry;
}

/** RFC 1918 private range check (10/8, 172.16/12, 192.168/16). */
export function isRfc1918(addr: string): boolean {
	const [a, b] = addr.split(".").map(Number);
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

function isLinkLocal(addr: string): boolean {
	const [a, b] = addr.split(".");
	return a === "169" && b === "254";
}

/** Non-routable special-purpose ranges that must never be offered as a link
 *  (RFC 2544 benchmark 198.18/15 used by some VPNs, documentation ranges,
 *  multicast, 0/8). Tailscale's 100.64/10 is deliberately kept — it routes
 *  inside a tailnet. */
function isUnroutable(addr: string): boolean {
	const [a, b] = addr.split(".").map(Number);
	if (a === 0) return true;
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
	if (a === 192 && b === 0) return true; // 192.0.2/24 documentation
	if (a === 198 && b === 51) return true; // 198.51.100/24 documentation
	if (a === 203 && b === 0) return true; // 203.0.113/24 documentation
	if (a >= 224) return true; // multicast + reserved
	return false;
}

export interface LanInterface {
	name: string;
	address: string;
}

/**
 * All routable IPv4 addresses (BitFun-style NIC discovery). Loopback and
 * link-local (169.254/16) are excluded; RFC 1918 private addresses rank
 * first, so VPN/VM/docker NICs that surface a public or odd address do not
 * shadow the real LAN interface.
 */
export function listLanIpv4(): LanInterface[] {
	const entries = Object.entries(networkInterfaces()).flatMap(([name, infos]) =>
		(infos ?? []).map(info => ({ name, address: info.address, family: info.family, internal: info.internal })),
	);
	return entries
		.filter(i => i.family === "IPv4" && !i.internal && !isLinkLocal(i.address) && !isUnroutable(i.address))
		.map(i => ({ name: i.name, address: i.address }))
		.sort((a, b) => Number(isRfc1918(b.address)) - Number(isRfc1918(a.address)));
}

/** First LAN IPv4 (private preferred), or null when the host has none. */
export function findLanIpv4(): string | null {
	return listLanIpv4()[0]?.address ?? null;
}

export interface LanShareUrls {
	/** Terminal join URL (plaintext ws — loopback and same-LAN clients). */
	joinUrl: string;
	/** Browser base URL (https → secure context → WebCrypto available). */
	webUrl: string;
	/** Join URL embedded in the browser deep link (wss, same origin as webUrl). */
	webJoinUrl: string;
	/** Extra reachable addresses (Tailscale CGNAT 100.64/10, second NIC, …)
	 *  with their own URL sets. The TLS cert covers every listed IP. */
	alt?: LanShareUrls[];
	/** https://<machine>.<tailnet>.ts.net — Tailscale Serve with a real
	 *  Let's Encrypt cert, so tailnet browsers get a link with NO warning. */
	tailnetServeUrl?: string;
}

/** Tailscale default CGNAT range 100.64.0.0/10 (RFC 6598). */
export function isTailscaleIpv4(addr: string): boolean {
	const [a, b] = addr.split(".").map(Number);
	return a === 100 && b >= 64 && b <= 127;
}

/**
 * Settings read with a default. `settings` throws until the host app has
 * initialized it, and collab helpers are also used by tests and library
 * callers that never boot the app — a share must not fail because a default
 * was unavailable.
 */
function readSetting<T>(
	key: "collab.cloudflaredHostname" | "collab.shareTtlMinutes" | "collab.exposure" | "collab.webUrl",
	fallback: T,
): T {
	try {
		const value = settings.get(key);
		return (value ?? fallback) as T;
	} catch {
		return fallback;
	}
}

/** Share TTL in minutes as configured; 0 means "keep sharing until stopped". */
export function configuredShareTtlMinutes(): number {
	const value = readSetting<number | string>("collab.shareTtlMinutes", 0);
	const minutes = typeof value === "number" ? value : Number(value);
	return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/** Exposure the daemon/TUI should use when a share asks for a tunnel. */
export function configuredExposure(): string {
	const value = readSetting<string>("collab.exposure", "cloudflared");
	return typeof value === "string" && value.trim() ? value.trim() : "cloudflared";
}

/**
 * Browser origins the in-process relay must accept besides its own pages.
 * `collab.webUrl` hosts the client on a different origin from the websocket
 * relay; the browser's upgrade then carries that origin, which the relay's
 * same-origin check would otherwise reject with 403.
 */
export function configuredWebOrigins(): string[] {
	const value = readSetting<string>("collab.webUrl", "");
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		return [new URL(value.trim()).origin];
	} catch {
		return [];
	}
}

export class LocalShareManager {
	relay: RelayServerHandle | null = null;
	tlsRelay: RelayServerHandle | null = null;
	tunnel: TunnelHandle | null = null;
	serve: TailscaleServeHandle | null = null;
	/** The active pluggable exposure (null for a LAN share). */
	exposure: ShareExposure | null = null;
	#port: number;
	#onStatus?: (line: string) => void;
	#onExposureHealth?: (status: ExposureStatus | null) => void;
	#onTtlExpired?: () => void;
	#shareTtlMinutes?: number;
	#registry: ExposureRegistry;
	#exposureStatus: ExposureStatus | null = null;
	#unsubscribeExposure: (() => void) | null = null;
	#ttlTimer: ReturnType<typeof setTimeout> | null = null;
	/** One room registry shared by the plaintext + TLS relay instances: the
	 *  host joins the plaintext port while browsers join the TLS port, and
	 *  both must see the same rooms or the browser guest is rejected with
	 *  4004 "no such room" (the LAN "会话已结束 房间不存在" report). */
	#rooms = new Map<string, Room>();

	constructor(options: LocalShareOptions = {}) {
		this.#port = options.port ?? DEFAULT_PORT;
		this.#onStatus = options.onStatus;
		this.#onExposureHealth = options.onExposureHealth;
		this.#onTtlExpired = options.onTtlExpired;
		this.#shareTtlMinutes = options.shareTtlMinutes;
		this.#registry = options.registry ?? exposureRegistry;
		if (!options.registry) ensureBuiltinExposures();
	}

	get webDistAvailable(): boolean {
		return fs.existsSync(path.join(COLLAB_WEB_DIST, "index.html"));
	}

	/** Health of the active share (LAN or exposure), null while stopped. */
	get exposureStatus(): ExposureStatus | null {
		return this.#exposureStatus;
	}

	/**
	 * Start the LAN share: a plaintext relay on `port` (terminal joins,
	 * localhost browser) plus a TLS relay on `port + 1` (other devices'
	 * browsers). Browsers only expose WebCrypto in secure contexts, so the
	 * browser deep link must be https/wss — hence the self-signed cert.
	 */
	async startLan(): Promise<LanShareUrls> {
		await this.stop();
		const interfaces = listLanIpv4();
		if (interfaces.length === 0) throw new Error("no routable LAN IPv4 address found");
		const allowedOrigins = configuredWebOrigins();
		this.relay = await startRelayServer({
			port: this.#port,
			host: "0.0.0.0",
			staticDir: this.webDistAvailable ? COLLAB_WEB_DIST : undefined,
			rooms: this.#rooms,
			onStatus: this.#onStatus,
			allowedOrigins,
		});
		// The self-signed cert must cover EVERY current address (LAN + Tailscale)
		// so browsers on any of them match the SAN without re-warning.
		const cert = ensureLanCertificate(interfaces.map(e => e.address));
		this.tlsRelay = await startRelayServer({
			port: this.relay.port + 1,
			host: "0.0.0.0",
			staticDir: this.webDistAvailable ? COLLAB_WEB_DIST : undefined,
			tls: { key: cert.keyPem, cert: cert.certPem },
			rooms: this.#rooms,
			onStatus: this.#onStatus,
			allowedOrigins,
		});
		if (!this.webDistAvailable) {
			this.#onStatus?.("client-core dist not built — browser UI unavailable, terminal join still works");
		}
		const urlsFor = (ip: string): LanShareUrls => ({
			joinUrl: `ws://${ip}:${this.relay!.port}`,
			webUrl: `https://${ip}:${this.tlsRelay!.port}`,
			webJoinUrl: `wss://${ip}:${this.tlsRelay!.port}`,
		});
		// Best-effort: a tailnet URL with a real cert kills the browser warning
		// for tailnet devices. null when serve is unavailable.
		this.serve = await startTailscaleServe({ port: this.relay.port, onStatus: this.#onStatus });
		const urls: LanShareUrls = {
			...urlsFor(interfaces[0]!.address),
			alt: interfaces.slice(1).map(e => urlsFor(e.address)),
			tailnetServeUrl: this.serve?.baseUrl ?? undefined,
		};
		this.#setExposureStatus({ id: "lan", health: "ready", url: urls.webUrl, detail: "same network only" });
		this.#armTtl();
		return urls;
	}

	/**
	 * Start a loopback relay plus a pluggable exposure. `provider` names a
	 * registry id ("cloudflared", "ngrok", "tailscale", or a plugin's id).
	 *
	 * `verifyReachable` is forwarded to the exposure so the tunnel is probed
	 * before the link is handed out (#36); tests driving a fake provider URL
	 * pass false.
	 */
	async startExposure(
		provider: string = configuredExposure(),
		options: { verifyReachable?: boolean } = {},
	): Promise<LanShareUrls> {
		await this.stop();
		const exposure = this.#registry.create(provider);
		if (!exposure) {
			const available = this.#registry.ids().join(", ");
			throw new Error(`unknown exposure "${provider}" — available: ${available}`);
		}
		this.relay = await startRelayServer({
			port: this.#port,
			host: "127.0.0.1",
			staticDir: this.webDistAvailable ? COLLAB_WEB_DIST : undefined,
			onStatus: this.#onStatus,
			allowedOrigins: configuredWebOrigins(),
		});
		this.exposure = exposure;
		this.#unsubscribeExposure = exposure.onChange(status => this.#handleExposureHealth(status));
		try {
			const urls = await exposure.start({
				port: this.relay.port,
				onStatus: this.#onStatus,
				...(options.verifyReachable !== undefined ? { verifyReachable: options.verifyReachable } : {}),
			});
			this.#setExposureStatus(exposure.status());
			this.#armTtl();
			return urls;
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	/**
	 * Public tunnel, defaulting to the configured exposure. Kept as a thin
	 * wrapper so existing call sites and the ngrok choice keep working.
	 */
	async startTunnel(
		provider: string = configuredExposure(),
		options: { verifyReachable?: boolean } = {},
	): Promise<LanShareUrls> {
		return this.startExposure(provider, options);
	}

	/** Health snapshot for the status RPC: LAN state when no exposure is active. */
	lanStatus(): ExposureStatus {
		const available = listLanIpv4().length > 0;
		return lanExposureStatus(available);
	}

	#setExposureStatus(status: ExposureStatus): void {
		this.#exposureStatus = status;
		this.#onExposureHealth?.(status);
	}

	#handleExposureHealth(status: ExposureStatus): void {
		this.#exposureStatus = status;
		this.#onExposureHealth?.(status);
		if (status.health !== "degraded") return;
		// A transport that cannot report through `onStatus` still surfaces the
		// reason here; the manager owns this line for every exposure.
		this.#onStatus?.(`collab: sharing ended — ${status.detail ?? "the tunnel went away"}`);
		// A dead tunnel leaves the relay serving a room nobody can reach; revoke
		// both the relay and the TTL so the UI never shows a working share.
		this.#clearTtl();
		void this.#revokeRelays();
	}

	async #revokeRelays(): Promise<void> {
		const { relay, tlsRelay } = this;
		this.relay = null;
		this.tlsRelay = null;
		if (relay) await relay.close().catch(() => {});
		if (tlsRelay) await tlsRelay.close().catch(() => {});
	}

	#armTtl(): void {
		this.#clearTtl();
		const minutes = this.#shareTtlMinutes ?? configuredShareTtlMinutes();
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		this.#ttlTimer = setTimeout(() => {
			this.#ttlTimer = null;
			const expired = this.#onTtlExpired;
			this.#onTtlExpired = undefined;
			void this.stop().then(() => expired?.());
		}, minutes * 60_000);
		this.#ttlTimer.unref?.();
		this.#onStatus?.(`collab: sharing stops automatically in ${Math.round(minutes)} minute(s)`);
	}

	#clearTtl(): void {
		if (!this.#ttlTimer) return;
		clearTimeout(this.#ttlTimer);
		this.#ttlTimer = null;
	}

	async stop(): Promise<void> {
		this.#clearTtl();
		const { relay, tlsRelay, tunnel, serve, exposure } = this;
		const unsubscribe = this.#unsubscribeExposure;
		this.relay = null;
		this.tlsRelay = null;
		this.tunnel = null;
		this.serve = null;
		this.exposure = null;
		this.#unsubscribeExposure = null;
		unsubscribe?.();
		if (exposure) await exposure.close().catch(() => {});
		if (tunnel) await tunnel.close().catch(() => {});
		if (relay) await relay.close().catch(() => {});
		if (tlsRelay) await tlsRelay.close().catch(() => {});
		if (serve) await serve.stop().catch(() => {});
		if (this.#exposureStatus) {
			this.#exposureStatus = null;
			this.#onExposureHealth?.(null);
		}
	}
}
