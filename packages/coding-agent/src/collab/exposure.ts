/**
 * Share exposures: the transport that makes a loopback collab relay reachable
 * from outside this machine.
 *
 * A share has two independent halves — the relay room (encrypted frames,
 * pairing, write tokens) and the path guests reach it through. LAN, Cloudflare
 * Tunnel, ngrok and Tailscale Serve only differ in the second half, so they
 * share one interface: `probe()` says whether this machine can use it right
 * now, `start()` puts it in front of a local port, `close()` takes it down and
 * restores anything it changed.
 *
 * The registry is the extension point the user asked for: self-hosted or
 * third-party transports plug in from a module with
 * `exposureRegistry.register(id, factory)` — nothing in the share path needs to
 * know the id in advance.
 */

export type ExposureHealth = "unavailable" | "starting" | "ready" | "degraded" | "stopped";

export interface ExposureCapabilities {
	/** Guests must install an app; a plain browser link is not enough. */
	guestInstall: boolean;
	/** Reachable from the public internet, not only a LAN or a tailnet. */
	publicExposure: boolean;
	/** The URL survives restarts (named tunnel, MagicDNS name). */
	stableUrl: boolean;
	/** Traffic passes through a third-party service. */
	thirdParty: boolean;
}

/** Recovery data for a missing prerequisite, rendered as an install card. */
export interface ExposureInstallHint {
	/** Download or setup documentation. */
	url: string;
	/** One command per platform, shown verbatim. */
	commands: Partial<Record<NodeJS.Platform, string>>;
	/** One sentence about accounts/key material the tool needs. */
	note?: string;
}

export interface ExposureStatus {
	id: string;
	health: ExposureHealth;
	/** Why the exposure is in this state; set for unavailable/degraded. */
	detail?: string;
	/** What the user can do next, in one actionable sentence. */
	hint?: string;
	install?: ExposureInstallHint;
	/** Public base URL while ready. Cleared the moment the link is revoked. */
	url?: string;
}

export interface ExposureStartOptions {
	/** Local loopback port the relay listens on. */
	port: number;
	onStatus?: (line: string) => void;
	signal?: AbortSignal;
	/** Per-start override of the reachability probe (default: on). */
	verifyReachable?: boolean;
}

export interface ExposureStartResult {
	/** Join URL handed to guests (ws:// or wss://). */
	joinUrl: string;
	/** Browser base URL (https origin); empty derives from joinUrl. */
	webUrl: string;
	/** Join URL embedded in the browser deep link. */
	webJoinUrl: string;
}

export interface ShareExposure {
	readonly id: string;
	readonly label: string;
	/** Capabilities of the current configuration (named tunnel vs quick). */
	readonly capabilities: ExposureCapabilities;
	status(): ExposureStatus;
	/** Observe health transitions; returns an unsubscribe function. */
	onChange(listener: (status: ExposureStatus) => void): () => void;
	/** Can this exposure start on this machine, right now? Never throws. */
	probe(): Promise<ExposureStatus>;
	start(options: ExposureStartOptions): Promise<ExposureStartResult>;
	/** Idempotent: stops the transport and restores what start() changed. */
	close(): Promise<void>;
}

/** Shared health state machine for concrete exposures. */
export abstract class BaseExposure implements ShareExposure {
	abstract readonly id: string;
	abstract readonly label: string;
	abstract readonly capabilities: ExposureCapabilities;
	#status: ExposureStatus;
	#listeners = new Set<(status: ExposureStatus) => void>();

	protected constructor(id: string) {
		this.#status = { id, health: "unavailable" };
	}

	status(): ExposureStatus {
		return this.#status;
	}

	onChange(listener: (status: ExposureStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	protected setStatus(next: ExposureStatus): void {
		const previous = this.#status;
		this.#status = { ...next, id: this.id };
		if (
			previous.health === this.#status.health &&
			previous.detail === this.#status.detail &&
			previous.url === this.#status.url
		) {
			return;
		}
		for (const listener of [...this.#listeners]) {
			try {
				listener(this.#status);
			} catch {
				// A UI listener must not break the transport lifecycle.
			}
		}
	}

	abstract probe(): Promise<ExposureStatus>;
	abstract start(options: ExposureStartOptions): Promise<ExposureStartResult>;

	async close(): Promise<void> {
		this.setStatus({ id: this.id, health: "stopped" });
	}
}

export type ExposureFactory = () => ShareExposure;

export class ExposureRegistry {
	#factories = new Map<string, ExposureFactory>();

	/** Register (or replace) an exposure. Returns an unregister function. */
	register(id: string, factory: ExposureFactory): () => void {
		if (!id.trim()) throw new Error("exposure id must not be empty");
		this.#factories.set(id, factory);
		return () => {
			if (this.#factories.get(id) === factory) this.#factories.delete(id);
		};
	}

	unregister(id: string): void {
		this.#factories.delete(id);
	}

	has(id: string): boolean {
		return this.#factories.has(id);
	}

	ids(): string[] {
		return [...this.#factories.keys()].sort();
	}

	create(id: string): ShareExposure | null {
		return this.#factories.get(id)?.() ?? null;
	}

	/** Probe one exposure; unknown ids and throwing probes become unavailable. */
	async probe(id: string): Promise<ExposureStatus> {
		const exposure = this.create(id);
		if (!exposure) {
			return { id, health: "unavailable", detail: `no exposure registered as "${id}"` };
		}
		try {
			return await exposure.probe();
		} catch (error) {
			return {
				id,
				health: "unavailable",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Probe every registered exposure, in id order. */
	async probeAll(): Promise<ExposureStatus[]> {
		return Promise.all(this.ids().map(id => this.probe(id)));
	}
}

/** Process-wide registry; plugins extend it at startup. */
export const exposureRegistry = new ExposureRegistry();

/** The LAN share is always available as a mode, but is not a pluggable transport. */
export const LAN_EXPOSURE = {
	id: "lan",
	label: "Local network",
	capabilities: {
		guestInstall: false,
		publicExposure: false,
		stableUrl: false,
		thirdParty: false,
	} satisfies ExposureCapabilities,
} as const;

export function lanExposureStatus(available: boolean, detail?: string): ExposureStatus {
	return available
		? { id: LAN_EXPOSURE.id, health: "ready", detail: "same network only" }
		: {
				id: LAN_EXPOSURE.id,
				health: "unavailable",
				detail: detail ?? "no routable IPv4 address on this machine",
				hint: "Connect this machine to the network guests are on, or pick an external exposure.",
			};
}
