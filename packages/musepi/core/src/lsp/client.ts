// ============================================================
// MusePi LSP — JSON-RPC client and lazy client registry.
//
// LspClient speaks just enough LSP 3.17 for this feature: initialize
// handshake, textDocument sync (didOpen/didChange/didSave), pushed and
// pulled diagnostics, and definition/references/hover/documentSymbol.
// Server-initiated requests (workspace/configuration, progress token
// creation, capability registration, refresh pings) are acknowledged so
// servers that block on them never wedge the session.
//
// LspRegistry owns the client lifecycle: `getOrCreate` spawns lazily on
// first use keyed by `command:cwd`, negative-caches init failures, and
// reaps clients idle longer than the configured timeout.
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { encodeLspMessage, LspMessageFramer } from "./protocol.ts";
import type {
	LspDiagnostic,
	LspJsonRpcId,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspPublishDiagnosticsParams,
	LspServerCapabilities,
	ResolvedLspServer,
} from "./types.ts";
import { detectLanguageId, fileToUri } from "./utils.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PROJECT_LOAD_TIMEOUT_MS = 15_000;
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;

// =============================================================================
// Process abstraction (injectable for tests)
// =============================================================================

export interface LspSpawnedProcess {
	write(chunk: Buffer): void;
	onStdout(listener: (chunk: Buffer) => void): void;
	onStderr?(listener: (chunk: Buffer) => void): void;
	kill(): void;
	readonly exited: Promise<number | null>;
}

export type LspSpawnFn = (command: string, args: string[], cwd: string) => LspSpawnedProcess;

export const nodeSpawn: LspSpawnFn = (command, args, cwd) => {
	// Windows: npm/pip shims resolve to .cmd/.bat launchers, which Node (≥18.20)
	// refuses to spawn without a shell. Quote every token and go through
	// cmd.exe — args are server-config tokens ("--stdio", …), never user input.
	const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
	const proc: ChildProcess = needsShell
		? spawn([command, ...args].map((token) => `"${token.replace(/"/g, '\\"')}"`).join(" "), {
				cwd,
				shell: true,
				stdio: ["pipe", "pipe", "pipe"],
			})
		: spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	// The child (and its pipes) must not keep the parent's event loop alive
	// on their own — a finished `pi -p` run should be able to exit while a
	// warm server stays up. Instead, activity is tracked explicitly:
	// #keepAlive is ref'd only while the client has in-flight operations.
	proc.unref();
	for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
		(stream as { unref?: () => void } | null)?.unref?.();
	}
	const exited = new Promise<number | null>((resolve) => {
		proc.once("exit", (code) => resolve(code));
		proc.once("error", () => resolve(null));
	});
	return {
		write(chunk) {
			proc.stdin?.write(chunk);
		},
		onStdout(listener) {
			proc.stdout?.on("data", listener);
		},
		onStderr(listener) {
			proc.stderr?.on("data", listener);
		},
		kill() {
			proc.kill();
		},
		exited,
	};
};

// =============================================================================
// Client
// =============================================================================

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: false },
		hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
		definition: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			codeDescriptionSupport: true,
		},
		diagnostic: { dynamicRegistration: true },
	},
	window: { workDoneProgress: true },
	workspace: {
		configuration: true,
		workspaceFolders: true,
	},
};

/**
 * Canonical key for diagnostics maps. Servers canonicalize URIs before
 * publishing (typescript-language-server lowercases the Windows drive
 * letter and percent-encodes the colon), so the URI in publishDiagnostics
 * routinely differs from the one we sent in didOpen. Normalize both sides:
 * percent-decode and lowercase a Windows drive letter.
 */
export function normalizeLspUriKey(uri: string): string {
	let decoded = uri;
	try {
		decoded = decodeURIComponent(uri);
	} catch {
		// lax server sent an unencoded path — use as-is
	}
	return decoded.replace(/^file:\/\/\/([A-Za-z]):/, (match, drive: string) => `file:///${drive.toLowerCase()}:`);
}

export interface PublishedDiagnostics {
	diagnostics: LspDiagnostic[];
	version: number | null;
}

export interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Minimum accepted server document version (the one our last didChange sent). */
	minDocumentVersion?: number;
	/** Quiet period after the last publish before accepting unversioned results. */
	settleMs?: number;
}

export class LspClient {
	readonly name: string;
	readonly serverName: string;
	readonly cwd: string;
	readonly config: ResolvedLspServer;
	readonly createdAt = Date.now();
	lastActivity = Date.now();
	status: "connecting" | "ready" | "error" | "stopped" = "connecting";
	serverCapabilities: LspServerCapabilities | undefined;
	readonly diagnostics = new Map<string, PublishedDiagnostics>();
	diagnosticsVersion = 0;
	readonly openFiles = new Map<string, { version: number; languageId: string }>();

	#proc: LspSpawnedProcess;
	#framer = new LspMessageFramer();
	#requestId = 0;
	#pending = new Map<LspJsonRpcId, PendingRequest>();
	#writeQueue: Promise<void> = Promise.resolve();
	#activeProgressTokens = new Set<string | number>();
	#projectLoadedResolve!: () => void;
	readonly projectLoaded: Promise<void>;
	#stderrTail = "";
	/** In-flight operations; drives #keepAlive's ref state. */
	#pendingOps = 0;
	#keepAlive: NodeJS.Timeout;

	#trackOpStart(): void {
		this.#pendingOps += 1;
		this.#keepAlive.ref();
	}

	#trackOpEnd(): void {
		this.#pendingOps = Math.max(0, this.#pendingOps - 1);
		if (this.#pendingOps === 0) this.#keepAlive.unref();
	}

	private constructor(serverName: string, config: ResolvedLspServer, cwd: string, proc: LspSpawnedProcess) {
		this.serverName = serverName;
		this.name = `${config.command}:${cwd}`;
		this.config = config;
		this.cwd = cwd;
		this.#proc = proc;
		this.projectLoaded = new Promise<void>((resolve) => {
			this.#projectLoadedResolve = resolve;
		});
		// Servers that never emit $/progress must not block callers forever.
		setTimeout(() => this.#projectLoadedResolve(), PROJECT_LOAD_TIMEOUT_MS).unref();
		// Ref'd only while operations are in flight (see #trackOpStart).
		this.#keepAlive = setInterval(() => {}, 60_000);
		this.#keepAlive.unref();
	}

	/**
	 * Spawn and initialize a client. Throws on handshake failure; the
	 * process is killed before rethrowing so no half-open servers leak.
	 */
	static async start(
		serverName: string,
		config: ResolvedLspServer,
		cwd: string,
		spawnFn: LspSpawnFn,
		signal?: AbortSignal,
	): Promise<LspClient> {
		const proc = spawnFn(config.resolvedCommand, config.args ?? [], cwd);
		const client = new LspClient(serverName, config, cwd, proc);
		proc.onStdout((chunk) => client.#onData(chunk));
		proc.onStderr?.((chunk) => {
			// Keep a short tail for crash diagnostics; servers log here liberally.
			client.#stderrTail = (client.#stderrTail + chunk.toString("utf-8")).slice(-2000);
		});
		proc.exited.then(() => client.#onExit());

		try {
			const result = (await client.request(
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split(/[\\/]/).pop() ?? "workspace" }],
				},
				{ timeoutMs: INIT_TIMEOUT_MS, signal },
			)) as { capabilities?: LspServerCapabilities } | null;
			if (!result) throw new Error("no response to initialize");
			client.serverCapabilities = result.capabilities;
			await client.notify("initialized", {});
			await client.notify("workspace/didChangeConfiguration", { settings: config.settings ?? {} });
			client.status = "ready";
			return client;
		} catch (error) {
			client.status = "error";
			proc.kill();
			throw error;
		}
	}

	// ── Wire I/O ─────────────────────────────────────────────────────

	#onData(chunk: Buffer): void {
		this.#framer.push(chunk);
		for (const body of this.#framer.drain()) {
			let message: LspJsonRpcResponse | LspJsonRpcNotification | LspJsonRpcRequest;
			try {
				message = JSON.parse(body) as typeof message;
			} catch {
				continue; // malformed payload — later frames are still well-framed
			}
			try {
				this.#route(message);
			} catch {
				// A throwing handler must not kill the reader loop.
			}
		}
	}

	#route(message: LspJsonRpcResponse | LspJsonRpcNotification | LspJsonRpcRequest): void {
		// Disambiguate on `method` FIRST: server request ids live in their own
		// id space and collide with our in-flight request ids.
		if ("method" in message) {
			if ("id" in message && message.id !== undefined) {
				this.#handleServerRequest(message as LspJsonRpcRequest);
				return;
			}
			this.#handleNotification(message as LspJsonRpcNotification);
			return;
		}
		if ("id" in message && message.id !== undefined) {
			const response = message as LspJsonRpcResponse;
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			if (response.error) pending.reject(new Error(`LSP error: ${response.error.message}`));
			else pending.resolve(response.result);
		}
	}

	#handleNotification(message: LspJsonRpcNotification): void {
		if (message.method === "textDocument/publishDiagnostics" && message.params) {
			const params = message.params as LspPublishDiagnosticsParams;
			this.diagnostics.set(normalizeLspUriKey(params.uri), {
				diagnostics: params.diagnostics,
				version: params.version ?? null,
			});
			this.diagnosticsVersion += 1;
			return;
		}
		if (message.method === "$/progress" && message.params) {
			const params = message.params as { token: string | number; value?: { kind?: string } };
			if (params.value?.kind === "begin") this.#activeProgressTokens.add(params.token);
			else if (params.value?.kind === "end") {
				this.#activeProgressTokens.delete(params.token);
				if (this.#activeProgressTokens.size === 0) this.#projectLoadedResolve();
			}
		}
	}

	#handleServerRequest(message: LspJsonRpcRequest): void {
		const respond = (result: unknown, error?: { code: number; message: string }): void => {
			const response: LspJsonRpcResponse = { jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) };
			this.#enqueueWrite(response).catch(() => {});
		};
		switch (message.method) {
			case "workspace/configuration": {
				const params = message.params as { items?: Array<{ section?: string }> };
				const items = params?.items ?? [];
				respond(items.map((item) => (item.section ? (this.config.settings?.[item.section] ?? null) : null)));
				return;
			}
			case "workspace/workspaceFolders":
				respond([{ uri: fileToUri(this.cwd), name: this.cwd.split(/[\\/]/).pop() ?? "workspace" }]);
				return;
			case "window/showDocument":
				respond({ success: false });
				return;
			case "window/workDoneProgress/create":
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/showMessageRequest":
			case "workspace/semanticTokens/refresh":
			case "workspace/inlayHint/refresh":
			case "workspace/codeLens/refresh":
			case "workspace/codeAction/refresh":
			case "workspace/inlineValue/refresh":
			case "workspace/foldingRange/refresh":
			case "workspace/diagnostic/refresh":
				respond(null);
				return;
			default:
				respond(undefined, { code: -32601, message: `Method not found: ${message.method}` });
		}
	}

	#onExit(): void {
		const wasReady = this.status === "ready";
		this.status = "stopped";
		this.#projectLoadedResolve();
		const detail = this.#stderrTail.trim();
		const error = new Error(
			detail
				? `LSP server ${this.serverName} exited: ${detail.split("\n").pop()}`
				: `LSP server ${this.serverName} exited unexpectedly`,
		);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (wasReady) this.diagnosticsVersion += 1; // wake diagnostic waiters so they can bail
	}

	#enqueueWrite(message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse): Promise<void> {
		const write = this.#writeQueue.then(() => {
			this.#proc.write(encodeLspMessage(message));
		});
		this.#writeQueue = write.catch(() => {});
		return write;
	}

	// ── Public API ───────────────────────────────────────────────────

	async request(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		if (this.status === "stopped" || this.status === "error") {
			throw new Error(`LSP server ${this.serverName} is not running`);
		}
		const { timeoutMs, signal } = options;
		if (signal?.aborted) throw new Error("aborted");
		const id = ++this.#requestId;
		this.lastActivity = Date.now();
		this.#trackOpStart();

		return await new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const cleanup = (): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#trackOpEnd();
			};
			const onAbort = (): void => {
				this.#pending.delete(id);
				cleanup();
				this.notify("$/cancelRequest", { id }).catch(() => {});
				reject(new Error("aborted"));
			};
			const effectiveTimeout = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
			if (effectiveTimeout !== undefined) {
				timer = setTimeout(() => {
					this.#pending.delete(id);
					cleanup();
					reject(new Error(`LSP request ${method} timed out after ${effectiveTimeout}ms`));
				}, effectiveTimeout);
				timer.unref?.();
			}
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.#pending.set(id, {
				method,
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			this.#enqueueWrite({ jsonrpc: "2.0", id, method, params: params ?? {} }).catch((error: unknown) => {
				this.#pending.delete(id);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async notify(method: string, params: unknown): Promise<void> {
		this.lastActivity = Date.now();
		await this.#enqueueWrite({ jsonrpc: "2.0", method, params });
	}

	/** Open a file with its on-disk content if not already tracked. */
	async ensureFileOpen(filePath: string): Promise<void> {
		this.#trackOpStart();
		try {
			const uri = fileToUri(filePath);
			if (this.openFiles.has(uri)) return;
			let content: string;
			try {
				content = await fs.promises.readFile(filePath, "utf-8");
			} catch {
				return; // file vanished — nothing to open
			}
			const languageId = detectLanguageId(filePath);
			await this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text: content } });
			this.openFiles.set(uri, { version: 1, languageId });
			this.lastActivity = Date.now();
		} finally {
			this.#trackOpEnd();
		}
	}

	/** Push full in-memory content (didOpen when untracked, didChange otherwise). */
	async syncContent(filePath: string, content: string): Promise<number> {
		const uri = fileToUri(filePath);
		const info = this.openFiles.get(uri);
		if (!info) {
			const languageId = detectLanguageId(filePath);
			await this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text: content },
			});
			this.openFiles.set(uri, { version: 1, languageId });
			this.lastActivity = Date.now();
			return 1;
		}
		const version = ++info.version;
		await this.notify("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		this.lastActivity = Date.now();
		return version;
	}

	/** Full sync from disk (post-mutation refresh). Returns the new version, or null when the file is gone. */
	async refreshFile(filePath: string): Promise<number | null> {
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, "utf-8");
		} catch {
			return null;
		}
		const version = await this.syncContent(filePath, content);
		await this.notify("textDocument/didSave", { textDocument: { uri: fileToUri(filePath), text: content } });
		return version;
	}

	async notifySaved(filePath: string): Promise<void> {
		const uri = fileToUri(filePath);
		if (!this.openFiles.has(uri)) return;
		await this.notify("textDocument/didSave", { textDocument: { uri } });
		this.lastActivity = Date.now();
	}

	/**
	 * Wait for diagnostics for `uri`: poll the pushed store until the server's
	 * document version catches up (versioned publish) or the stream goes quiet
	 * (settle window), capped by timeoutMs. Returns the latest batch, empty
	 * when the server publishes nothing in time.
	 */
	/** Whether the server advertised LSP 3.17 pull diagnostics. */
	get supportsPullDiagnostics(): boolean {
		return this.serverCapabilities?.diagnosticProvider !== undefined;
	}

	/** LSP 3.17 pull: textDocument/diagnostic. Returns null when unsupported/failed. */
	async pullDiagnostics(uri: string, signal?: AbortSignal): Promise<LspDiagnostic[] | null> {
		if (!this.supportsPullDiagnostics) return null;
		try {
			const report = (await this.request(
				"textDocument/diagnostic",
				{ textDocument: { uri } },
				{ signal },
			)) as { kind?: string; items?: LspDiagnostic[] } | null;
			if (!report || report.kind === "unchanged") return this.diagnostics.get(normalizeLspUriKey(uri))?.diagnostics ?? [];
			return report.items ?? [];
		} catch {
			return null;
		}
	}

	async waitForDiagnostics(uri: string, options: WaitForDiagnosticsOptions = {}): Promise<LspDiagnostic[]> {
		const { timeoutMs = 3000, signal, minDocumentVersion, settleMs = 250 } = options;
		const deadline = Date.now() + timeoutMs;
		const key = normalizeLspUriKey(uri);
		this.#trackOpStart();
		try {
			// Pull model (LSP 3.17): servers advertising diagnosticProvider (e.g.
			// typescript-language-server) do NOT push; ask explicitly.
			if (this.supportsPullDiagnostics) {
				const pulled = await this.pullDiagnostics(uri, signal);
				if (pulled !== null) return pulled;
			}
			let lastSeen: PublishedDiagnostics | undefined;
			let lastChangeAt = Date.now();
			while (Date.now() < deadline) {
				if (signal?.aborted) break;
				if (this.status === "stopped" || this.status === "error") break;
				const published = this.diagnostics.get(key);
				if (published) {
					if (
						minDocumentVersion !== undefined &&
						published.version !== null &&
						published.version >= minDocumentVersion
					) {
						return published.diagnostics;
					}
					if (published !== lastSeen) {
						lastSeen = published;
						lastChangeAt = Date.now();
					} else if (Date.now() - lastChangeAt >= settleMs) {
						return published.diagnostics;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return this.diagnostics.get(key)?.diagnostics ?? [];
		} finally {
			this.#trackOpEnd();
		}
	}

	/** Process exit (resolves with the exit code, null on spawn error). */
	get exited(): Promise<number | null> {
		return this.#proc.exited;
	}

	/** Graceful shutdown/exit handshake, kill fallback. */
	async shutdown(): Promise<void> {
		if (this.status === "stopped") return;
		try {
			await this.request("shutdown", null, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
			await this.notify("exit", undefined);
		} catch {
			// server already wedged — fall through to kill
		}
		this.status = "stopped";
		for (const pending of this.#pending.values()) pending.reject(new Error("LSP client shutdown"));
		this.#pending.clear();
		const exited = await Promise.race([
			this.#proc.exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
		]);
		if (!exited) this.#proc.kill();
	}
}

// =============================================================================
// Registry — lazy spawn, init-failure backoff, idle reaping
// =============================================================================

export interface LspClientInfo {
	/** Registry key (`command:cwd`) — use with getByKey. */
	key: string;
	serverName: string;
	command: string;
	cwd: string;
	status: LspClient["status"];
	source: ResolvedLspServer["source"];
	uptimeMs: number;
	openFileCount: number;
	diagnosticUriCount: number;
}

export interface LspRegistryOptions {
	spawnFn?: LspSpawnFn;
	/** Reaper sweep cadence (defaults to 60s; tests pass something small). */
	idleCheckIntervalMs?: number;
}

export class LspRegistry {
	#clients = new Map<string, LspClient>();
	#locks = new Map<string, Promise<LspClient>>();
	#initFailures = new Map<string, { at: number; message: string }>();
	#idleTimeoutMs: number | null = null;
	#idleTimer: NodeJS.Timeout | null = null;
	readonly #spawnFn: LspSpawnFn;
	readonly #idleCheckIntervalMs: number;

	constructor(options: LspRegistryOptions = {}) {
		this.#spawnFn = options.spawnFn ?? nodeSpawn;
		this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? 60_000;
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

	/** One reaper pass: shut down clients idle past the timeout. Exposed for tests. */
	async reapIdle(): Promise<string[]> {
		if (this.#idleTimeoutMs === null) return [];
		const now = Date.now();
		const reaped: string[] = [];
		for (const [key, client] of [...this.#clients.entries()]) {
			if (now - client.lastActivity > this.#idleTimeoutMs) {
				this.#clients.delete(key);
				reaped.push(key);
				await client.shutdown().catch(() => {});
			}
		}
		return reaped;
	}

	/**
	 * Get the client for `server` at `cwd`, spawning + initializing on first
	 * use. Concurrent callers share one init. A recent deterministic init
	 * failure rejects immediately (negative cache) instead of re-spawning.
	 */
	async getOrCreate(server: ResolvedLspServer, cwd: string, signal?: AbortSignal): Promise<LspClient> {
		const key = `${server.command}:${cwd}`;
		const existing = this.#clients.get(key);
		if (existing && existing.status === "ready") {
			existing.lastActivity = Date.now();
			return existing;
		}
		const lock = this.#locks.get(key);
		if (lock) return await lock;

		const failure = this.#initFailures.get(key);
		if (failure) {
			if (Date.now() - failure.at < INIT_FAILURE_BACKOFF_MS) {
				throw new Error(`LSP server ${server.command} failed to initialize recently: ${failure.message}`);
			}
			this.#initFailures.delete(key);
		}

		const promise = (async (): Promise<LspClient> => {
			try {
				const client = await LspClient.start(server.name, server, cwd, this.#spawnFn, signal);
				this.#clients.set(key, client);
				this.#initFailures.delete(key);
				// Crash recovery: drop the corpse so the next call respawns.
				void client.exited.then(() => {
					if (this.#clients.get(key) === client) this.#clients.delete(key);
				});
				return client;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!signal?.aborted) this.#initFailures.set(key, { at: Date.now(), message });
				throw error;
			} finally {
				this.#locks.delete(key);
			}
		})();
		this.#locks.set(key, promise);
		return await promise;
	}

	/** Snapshot of live clients for the `status` action. */
	activeClients(): LspClientInfo[] {
		return [...this.#clients.entries()].map(([key, client]) => ({
			key,
			serverName: client.serverName,
			command: client.config.resolvedCommand,
			cwd: client.cwd,
			status: client.status,
			source: client.config.source,
			uptimeMs: Date.now() - client.createdAt,
			openFileCount: client.openFiles.size,
			diagnosticUriCount: client.diagnostics.size,
		}));
	}

	/** Look up a live client by its registry key (`command:cwd`). */
	getByKey(key: string): LspClient | undefined {
		return this.#clients.get(key);
	}

	/** Number of live clients (test helper). */
	get size(): number {
		return this.#clients.size;
	}

	async shutdownAll(): Promise<void> {
		const clients = [...this.#clients.values()];
		this.#clients.clear();
		const pending = [...this.#locks.values()];
		this.#locks.clear();
		await Promise.allSettled([
			...clients.map((client) => client.shutdown()),
			...pending.map((p) => p.then((client) => client.shutdown())),
		]);
	}
}
