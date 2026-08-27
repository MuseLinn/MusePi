import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelAdapter, ChannelKind, ChannelRegistryOptions, ChannelStatus } from "./types";

interface PersistedChannel {
	kind: ChannelKind;
	config: Record<string, unknown>;
	enabled: boolean;
}

/** Channel registry: owns config persistence + adapter lifecycle. One adapter
 *  per kind; configure()/start()/stop() are the only mutation surface, so the
 *  GUI and CLI share one consistent state machine. */
export class ChannelRegistry {
	readonly #configPath: string;
	readonly #host: ChannelRegistryOptions["host"];
	readonly #factories: ChannelRegistryOptions["factories"];
	#adapters = new Map<ChannelKind, ChannelAdapter>();

	constructor(options: ChannelRegistryOptions) {
		this.#configPath = options.configPath;
		this.#host = options.host;
		this.#factories = options.factories;
	}

	#load(): PersistedChannel[] {
		try {
			const raw = readFileSync(this.#configPath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? (parsed as PersistedChannel[]) : [];
		} catch {
			return [];
		}
	}

	#save(channels: PersistedChannel[]): void {
		mkdirSync(dirname(this.#configPath), { recursive: true });
		writeFileSync(this.#configPath, JSON.stringify(channels, null, "\t"));
	}

	#adapter(kind: ChannelKind): ChannelAdapter | null {
		const existing = this.#adapters.get(kind);
		if (existing) return existing;
		const factory = this.#factories[kind];
		if (!factory) return null;
		const adapter = factory(this);
		adapter.attach?.(this.host);
		this.#adapters.set(kind, adapter);
		return adapter;
	}

	/** All kinds with their live status (adapters included even when off). */
	list(): ChannelStatus[] {
		const kinds = Object.keys(this.#factories) as ChannelKind[];
		const persisted = new Map(this.#load().map(c => [c.kind, c]));
		return kinds.map(kind => {
			const adapter = this.#adapter(kind);
			if (!adapter) throw new Error(`no adapter factory for ${kind}`);
			return {
				...adapter.status(),
				config: {
					...(persisted.get(kind)?.config ?? {}),
					enabled: persisted.get(kind)?.enabled ?? false,
				},
			};
		});
	}

	/** Register (or replace) a channel factory at runtime — the hot-plug
	 *  path for directory-loaded plugins. */
	register(kind: string, factory: (registry: ChannelRegistryOptions["factories"]) => ChannelAdapter): void {
		const existing = this.#adapters.get(kind as ChannelKind);
		if (existing) {
			void existing.stop().catch(() => {});
			this.#adapters.delete(kind as ChannelKind);
		}
		(this.#factories as Record<string, (registry: ChannelRegistryOptions["factories"]) => ChannelAdapter>)[kind] =
			factory;
	}

	/** Drop a runtime-registered factory (plugin removed from disk). */
	unregister(kind: string): void {
		const existing = this.#adapters.get(kind as ChannelKind);
		if (existing) {
			void existing.stop().catch(() => {});
			this.#adapters.delete(kind as ChannelKind);
		}
		delete (this.#factories as Record<string, unknown>)[kind];
	}

	/** All registered kinds (builtin + hot-plugged). */
	kinds(): string[] {
		return Object.keys(this.#factories);
	}

	/** Persist config for a kind (secrets masked in status, kept raw here). */
	configure(kind: ChannelKind, config: Record<string, unknown>): void {
		const channels = this.#load();
		const existing = channels.find(c => c.kind === kind);
		if (existing) {
			existing.config = { ...existing.config, ...config };
		} else {
			channels.push({ kind, config, enabled: false });
		}
		this.#save(channels);
		// Reconnect if running so the new config takes effect.
		const adapter = this.#adapter(kind);
		if (adapter && this.#isRunning(kind)) {
			void adapter.stop().catch(() => {});
			void adapter
				.configure(config)
				.then(() => adapter.start())
				.catch(() => {});
		}
	}

	#isRunning(kind: ChannelKind): boolean {
		return this.#adapters.get(kind)?.status().state !== "off";
	}

	async start(kind: ChannelKind): Promise<ChannelStatus> {
		const adapter = this.#adapter(kind);
		if (!adapter) throw new Error(`unknown channel kind: ${kind}`);
		const channels = this.#load();
		const persisted = channels.find(c => c.kind === kind);
		if (persisted) await adapter.configure(persisted.config);
		await adapter.start();
		if (persisted) persisted.enabled = true;
		else channels.push({ kind, config: {}, enabled: true });
		this.#save(channels);
		return adapter.status();
	}

	async stop(kind: ChannelKind): Promise<ChannelStatus> {
		const adapter = this.#adapter(kind);
		if (!adapter) throw new Error(`unknown channel kind: ${kind}`);
		await adapter.stop();
		const channels = this.#load();
		const persisted = channels.find(c => c.kind === kind);
		if (persisted) persisted.enabled = false;
		this.#save(channels);
		return adapter.status();
	}

	async startAll(): Promise<void> {
		for (const c of this.#load()) {
			if (!c.enabled) continue;
			const adapter = this.#adapter(c.kind);
			if (!adapter) continue;
			await adapter.configure(c.config).catch(() => {});
			await adapter.start().catch(() => {});
		}
	}

	async stopAll(): Promise<void> {
		for (const adapter of this.#adapters.values()) {
			await adapter.stop().catch(() => {});
		}
	}

	/** Push/send through a running adapter. */
	async send(kind: ChannelKind, payload: Parameters<ChannelAdapter["send"]>[0]): Promise<void> {
		const adapter = this.#adapter(kind);
		if (!adapter) throw new Error(`unknown channel kind: ${kind}`);
		await adapter.send(payload);
	}

	get host(): ChannelRegistryOptions["host"] {
		return this.#host;
	}
}
