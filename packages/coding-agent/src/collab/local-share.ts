/**
 * Host-side relay + tunnel lifecycle for `/collab lan` and `/collab tunnel`.
 *
 * A LAN share binds the relay server to 0.0.0.0 and points the share link at
 * the machine's routable IPv4, so guests on the same network join without a
 * public relay. A tunnel share adds a cloudflared quick tunnel in front of a
 * loopback-bound relay, yielding a public `wss://<id>.trycloudflare.com` link.
 *
 * Both modes serve the desktop-web `dist/` on the same port so the browser
 * deep link resolves to a real UI (when the build exists).
 */
import * as fs from "node:fs";
import { networkInterfaces } from "node:os";
import * as path from "node:path";
import { ensureLanCertificate } from "./cert";
import { startNgrokTunnel } from "./ngrok";
import { type RelayServerHandle, type Room, startRelayServer } from "./relay-server";
import { startTailscaleServe, type TailscaleServeHandle } from "./tailscale-serve";
import { startCloudflaredTunnel, type TunnelHandle } from "./tunnel";

const DEFAULT_PORT = 7654;
const COLLAB_WEB_DIST = path.resolve(import.meta.dir, "../../../desktop-web/dist");

export interface LocalShareOptions {
	port?: number;
	onStatus?: (line: string) => void;
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

export class LocalShareManager {
	relay: RelayServerHandle | null = null;
	tlsRelay: RelayServerHandle | null = null;
	tunnel: TunnelHandle | null = null;
	serve: TailscaleServeHandle | null = null;
	#port: number;
	#onStatus?: (line: string) => void;
	/** One room registry shared by the plaintext + TLS relay instances: the
	 *  host joins the plaintext port while browsers join the TLS port, and
	 *  both must see the same rooms or the browser guest is rejected with
	 *  4004 "no such room" (the LAN "会话已结束 房间不存在" report). */
	#rooms = new Map<string, Room>();

	constructor(options: LocalShareOptions = {}) {
		this.#port = options.port ?? DEFAULT_PORT;
		this.#onStatus = options.onStatus;
	}

	get webDistAvailable(): boolean {
		return fs.existsSync(path.join(COLLAB_WEB_DIST, "index.html"));
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
		this.relay = await startRelayServer({
			port: this.#port,
			host: "0.0.0.0",
			staticDir: this.webDistAvailable ? COLLAB_WEB_DIST : undefined,
			rooms: this.#rooms,
			onStatus: this.#onStatus,
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
		});
		if (!this.webDistAvailable) {
			this.#onStatus?.("desktop-web dist not built — browser UI unavailable, terminal join still works");
		}
		const urlsFor = (ip: string): LanShareUrls => ({
			joinUrl: `ws://${ip}:${this.relay!.port}`,
			webUrl: `https://${ip}:${this.tlsRelay!.port}`,
			webJoinUrl: `wss://${ip}:${this.tlsRelay!.port}`,
		});
		// Best-effort: a tailnet URL with a real cert kills the browser warning
		// for tailnet devices. null when serve is unavailable.
		this.serve = await startTailscaleServe({ port: this.relay.port, onStatus: this.#onStatus });
		return {
			...urlsFor(interfaces[0]!.address),
			alt: interfaces.slice(1).map(e => urlsFor(e.address)),
			tailnetServeUrl: this.serve?.baseUrl ?? undefined,
		};
	}

	/**
	 * Start a loopback relay plus a public tunnel. The public https/wss URL
	 * derives the browser base (same origin), so webUrl is left empty here.
	 * Provider mirrors OpenChamber's choice: cloudflared quick tunnel by
	 * default, ngrok as an explicit alternative.
	 */
	async startTunnel(provider: "cloudflared" | "ngrok" = "cloudflared"): Promise<LanShareUrls> {
		await this.stop();
		this.relay = await startRelayServer({
			port: this.#port,
			host: "127.0.0.1",
			staticDir: this.webDistAvailable ? COLLAB_WEB_DIST : undefined,
			onStatus: this.#onStatus,
		});
		try {
			this.tunnel =
				provider === "ngrok"
					? await startNgrokTunnel({
							port: this.relay.port,
							onStatus: this.#onStatus,
						})
					: await startCloudflaredTunnel({
							port: this.relay.port,
							onStatus: this.#onStatus,
						});
		} catch (err) {
			await this.stop();
			throw err;
		}
		const url = this.tunnel.url;
		return { joinUrl: url, webUrl: "", webJoinUrl: url };
	}

	async stop(): Promise<void> {
		const { relay, tlsRelay, tunnel, serve } = this;
		this.relay = null;
		this.tlsRelay = null;
		this.tunnel = null;
		this.serve = null;
		if (tunnel) await tunnel.close().catch(() => {});
		if (relay) await relay.close().catch(() => {});
		if (tlsRelay) await tlsRelay.close().catch(() => {});
		if (serve) await serve.stop().catch(() => {});
	}
}
