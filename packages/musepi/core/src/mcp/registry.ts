// ============================================================
// MusePi MCP — server registry: lazy connect, failure backoff,
// idle reaping, graceful per-server degradation.
//
// Servers are configured up front but NOT connected at session start;
// ensureConnected() spawns/connects on first use. A deterministic
// init failure is negative-cached for a backoff window so a broken
// server cannot thrash the session, and `reconnect` clears it
// explicitly. Clients idle longer than the configured timeout are
// reaped by a periodic sweep. One server's failure never affects the
// others — every error carries the server name.
// ============================================================

import { McpClient, type McpClientOptions } from "./client.ts";
import type { McpSpawnFn } from "./transport-stdio.ts";
import type { McpServerStatusInfo, McpTool, ResolvedMcpServer } from "./types.ts";

const CONNECT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;

export interface McpRegistryOptions {
	cwd: string;
	spawnFn?: McpSpawnFn;
	fetchFn?: typeof fetch;
	/** Reaper sweep cadence (defaults to 60s; tests pass something small). */
	idleCheckIntervalMs?: number;
}

interface ServerEntry {
	config: ResolvedMcpServer;
	client: McpClient | null;
	/** Sticky error from the last failed connect; cleared on success. */
	lastError?: string;
}

export class McpRegistry {
	#entries = new Map<string, ServerEntry>();
	#locks = new Map<string, Promise<McpClient>>();
	#connectFailures = new Map<string, { at: number; message: string }>();
	#idleTimeoutMs: number | null = null;
	#idleTimer: NodeJS.Timeout | null = null;
	#toolsChangedListeners = new Set<(serverName: string, tools: McpTool[]) => void>();
	#clientOptions: Pick<McpClientOptions, "cwd" | "spawnFn" | "fetchFn">;
	readonly #idleCheckIntervalMs: number;

	constructor(options: McpRegistryOptions) {
		this.#clientOptions = { cwd: options.cwd, spawnFn: options.spawnFn, fetchFn: options.fetchFn };
		this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? 60_000;
	}

	/** Replace the server set; servers whose config changed are disconnected. */
	setServers(servers: ResolvedMcpServer[]): void {
		const next = new Map<string, ResolvedMcpServer>();
		for (const server of servers) next.set(server.name, server);
		for (const [name, entry] of [...this.#entries.entries()]) {
			const config = next.get(name);
			if (!config || JSON.stringify(config) !== JSON.stringify(entry.config)) {
				void entry.client?.close().catch(() => {});
				this.#entries.delete(name);
			}
		}
		for (const [name, config] of next) {
			if (!this.#entries.has(name)) this.#entries.set(name, { config, client: null });
		}
	}

	/** Tool-list change subscription (initial enumeration + list_changed). */
	onToolsChanged(listener: (serverName: string, tools: McpTool[]) => void): () => void {
		this.#toolsChangedListeners.add(listener);
		return () => this.#toolsChangedListeners.delete(listener);
	}

	/** Configure idle reaping; null/0 disables. Takes effect on the next sweep. */
	setIdleTimeout(ms: number | null | undefined): void {
		this.#idleTimeoutMs = ms && ms > 0 ? ms : null;
		if (this.#idleTimeoutMs !== null && !this.#idleTimer) {
			this.#idleTimer = setInterval(() => void this.reapIdle(), this.#idleCheckIntervalMs);
			this.#idleTimer.unref?.();
		} else if (this.#idleTimeoutMs === null && this.#idleTimer) {
			clearInterval(this.#idleTimer);
			this.#idleTimer = null;
		}
	}

	get idleTimeoutMs(): number | null {
		return this.#idleTimeoutMs;
	}

	/** One reaper pass: close clients idle past the timeout. Exposed for tests. */
	async reapIdle(): Promise<string[]> {
		if (this.#idleTimeoutMs === null) return [];
		const now = Date.now();
		const reaped: string[] = [];
		for (const [name, entry] of [...this.#entries.entries()]) {
			const client = entry.client;
			if (client && now - client.lastActivity > this.#idleTimeoutMs) {
				entry.client = null;
				reaped.push(name);
				await client.close().catch(() => {});
			}
		}
		return reaped;
	}

	/** Configured server names. */
	serverNames(): string[] {
		return [...this.#entries.keys()];
	}

	/** Live client when connected (does NOT connect). */
	getClient(name: string): McpClient | null {
		return this.#entries.get(name)?.client ?? null;
	}

	/** Cached tool list when connected (does NOT connect). */
	toolsOf(name: string): McpTool[] {
		return this.getClient(name)?.tools ?? [];
	}

	/**
	 * Connect on first use. Concurrent callers share one connect. A recent
	 * deterministic connect failure rejects immediately (negative cache)
	 * instead of re-spawning; `reconnect` clears the failure explicitly.
	 */
	async ensureConnected(name: string, signal?: AbortSignal): Promise<McpClient> {
		const entry = this.#entries.get(name);
		if (!entry) throw new Error(`MCP server "${name}" is not configured`);
		if (entry.client && entry.client.status === "ready") {
			entry.client.lastActivity = Date.now();
			return entry.client;
		}
		const lock = this.#locks.get(name);
		if (lock) return await lock;

		const failure = this.#connectFailures.get(name);
		if (failure) {
			if (Date.now() - failure.at < CONNECT_FAILURE_BACKOFF_MS) {
				throw new Error(`MCP server "${name}" failed to connect recently: ${failure.message}`);
			}
			this.#connectFailures.delete(name);
		}

		const promise = (async (): Promise<McpClient> => {
			// The transport can close before connect() returns (spawn failure),
			// so the onClose closure must not touch the not-yet-assigned client.
			let connected: McpClient | null = null;
			try {
				const client = await McpClient.connect(
					entry.config,
					{
						...this.#clientOptions,
						onToolsChanged: (tools) => {
							for (const listener of this.#toolsChangedListeners) listener(name, tools);
						},
						onClose: () => {
							const current = this.#entries.get(name);
							if (connected !== null && current?.client === connected) current.client = null;
						},
					},
					signal,
				);
				connected = client;
				entry.client = client;
				entry.lastError = undefined;
				this.#connectFailures.delete(name);
				return client;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				entry.lastError = message;
				if (!signal?.aborted) this.#connectFailures.set(name, { at: Date.now(), message });
				throw error;
			} finally {
				this.#locks.delete(name);
			}
		})();
		this.#locks.set(name, promise);
		return await promise;
	}

	/** Call a tool, connecting lazily. Errors always name the server. */
	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	) {
		const client = await this.ensureConnected(serverName, options.signal);
		return await client.callTool(toolName, args, options);
	}

	/** Force a fresh connect: close, clear the failure cache, reconnect. */
	async reconnect(name: string, signal?: AbortSignal): Promise<McpClient> {
		const entry = this.#entries.get(name);
		if (!entry) throw new Error(`MCP server "${name}" is not configured`);
		this.#connectFailures.delete(name);
		const stale = entry.client;
		entry.client = null;
		if (stale) await stale.close().catch(() => {});
		return await this.ensureConnected(name, signal);
	}

	/** Drop a sticky failure so the next use retries (used by /mcp reconnect on error). */
	clearFailure(name: string): void {
		this.#connectFailures.delete(name);
	}

	/** Snapshot of every configured server for status rendering. */
	statuses(): McpServerStatusInfo[] {
		return [...this.#entries.values()].map((entry) => {
			const client = entry.client;
			return {
				name: entry.config.name,
				transport: entry.config.transport,
				endpoint:
					entry.config.transport === "stdio"
						? [entry.config.command, ...(entry.config.args ?? [])].join(" ")
						: entry.config.url,
				status: client ? (client.status === "ready" ? "connected" : client.status === "connecting" ? "connecting" : "error") : entry.lastError ? "error" : "disconnected",
				lastError: client && client.status === "ready" ? undefined : entry.lastError,
				toolCount: client?.tools.length ?? 0,
				uptimeMs: client ? Date.now() - client.createdAt : undefined,
			} satisfies McpServerStatusInfo;
		});
	}

	async shutdownAll(): Promise<void> {
		const clients = [...this.#entries.values()].map((entry) => entry.client).filter((c) => c !== null);
		for (const entry of this.#entries.values()) entry.client = null;
		const pending = [...this.#locks.values()];
		this.#locks.clear();
		await Promise.allSettled([
			...clients.map((client) => client.close()),
			...pending.map((p) => p.then((client) => client.close())),
		]);
		if (this.#idleTimer) {
			clearInterval(this.#idleTimer);
			this.#idleTimer = null;
		}
	}
}
