/**
 * Auth-broker HTTP server.
 *
 * Wraps a {@link BrokerStore} (backed by SqliteCredentialStore on the host)
 * and exposes a minimal REST API for snapshot pulls, credential operations,
 * and block management.
 *
 * Transport security is delegated to the operator (Tailscale / Wireguard);
 * the server only checks a bearer token against an allow-list per request.
 */

import * as http from "node:http";
import type {
	BrokerStore,
	CredentialBlockRequest,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamRemovedEvent,
	UsageResponse,
	UsageStaleResponse,
} from "./types.ts";

// ─── Options & handle ─────────────────────────────────────────────────────────

export interface AuthBrokerOptions {
	storage: BrokerStore;
	bind?: string;
	bearerTokens?: string[];
	version?: string;
}

export interface AuthBrokerHandle {
	url: string;
	close(): Promise<void>;
}

export async function startAuthBroker(opts: AuthBrokerOptions): Promise<AuthBrokerHandle> {
	const bind = opts.bind ?? "127.0.0.1:8765";
	const tokens = new Set(opts.bearerTokens ?? []);
	const storage = opts.storage;
	const [hostname, portStr] = parseBind(bind);
	const port = Number(portStr);
	const generationGate = new GenerationGate(storage);

	const server = http.createServer((req, res) => {
		handleRequest(req, res, { storage, tokens, version: opts.version, generationGate });
	});

	server.keepAliveTimeout = 255_000;

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(port, hostname, () => {
			resolve({ url: `http://${hostname}:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
		});
	});
}

// ─── Route dispatch ───────────────────────────────────────────────────────────

interface RouteContext {
	storage: BrokerStore;
	tokens: Set<string>;
	version?: string;
	generationGate: GenerationGate;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
	try {
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const pathname = url.pathname;

		// Healthz — unauthenticated
		if (method === "GET" && pathname === "/v1/healthz") {
			const body: HealthzResponse = { ok: true, version: ctx.version };
			json(res, 200, body);
			return;
		}

		if (!isAuthorized(req, ctx.tokens)) {
			json(res, 401, { error: "unauthorized" });
			return;
		}

		// GET /v1/snapshot[?wait=ms&generation=N]
		if (method === "GET" && pathname === "/v1/snapshot") {
			const waitMs = Number(url.searchParams.get("wait")) || 0;
			const ifGenerationGt = Number(url.searchParams.get("generation")) || 0;

			if (waitMs > 0 && ifGenerationGt > 0 && ctx.storage.generation <= ifGenerationGt) {
				const changed = await ctx.generationGate.wait(ifGenerationGt, Math.min(waitMs, 60_000));
				if (changed) {
					const snapshot = await ctx.storage.exportSnapshot();
					json(res, 200, snapshot, { etag: String(snapshot.generation) });
					return;
				}
				json(res, 304, undefined, { etag: String(ctx.storage.generation) });
				return;
			}

			const snapshot = await ctx.storage.exportSnapshot();
			json(res, 200, snapshot, { etag: String(snapshot.generation) });
			return;
		}

		// GET /v1/snapshot/stream — SSE
		if (method === "GET" && pathname === "/v1/snapshot/stream") {
			handleStream(req, res, ctx);
			return;
		}

		// GET /v1/usage
		if (method === "GET" && pathname === "/v1/usage") {
			const reports = ctx.storage.fetchUsageReports();
			const body: UsageResponse = { generatedAt: Date.now(), reports };
			json(res, 200, body);
			return;
		}

		// POST /v1/usage/stale
		if (method === "POST" && pathname === "/v1/usage/stale") {
			ctx.storage.invalidateUsageCache();
			json(res, 200, { ok: true });
			return;
		}

		// POST /v1/credential
		if (method === "POST" && pathname === "/v1/credential") {
			const body = await parseBody<CredentialUploadRequest>(req);
			const entries = await ctx.storage.upsertCredentialForProvider(body.provider, body.credential);
			json(res, 200, { entries } satisfies CredentialUploadResponse);
			return;
		}

		// POST /v1/credential/:id/refresh
		const refreshMatch = pathname.match(/^\/v1\/credential\/(\d+)\/refresh$/);
		if (method === "POST" && refreshMatch) {
			const id = Number(refreshMatch[1]);
			const entry = await ctx.storage.forceRefreshCredentialById(id);
			json(res, 200, { entry } satisfies CredentialRefreshResponse);
			return;
		}

		// POST /v1/credential/:id/disable
		const disableMatch = pathname.match(/^\/v1\/credential\/(\d+)\/disable$/);
		if (method === "POST" && disableMatch) {
			const id = Number(disableMatch[1]);
			const body = await parseBody<{ cause: string }>(req);
			const cause = body.cause?.length > 0 ? body.cause : "disabled via auth-broker";
			if (!(await ctx.storage.disableCredentialById(id, cause))) {
				json(res, 404, { error: `No credential with id=${id}` });
				return;
			}
			json(res, 200, { ok: true });
			return;
		}

		// POST /v1/credential/:id/block
		const blockMatch = pathname.match(/^\/v1\/credential\/(\d+)\/block$/);
		if (method === "POST" && blockMatch) {
			const id = Number(blockMatch[1]);
			const body = await parseBody<CredentialBlockRequest>(req);
			ctx.storage.upsertCredentialBlock(id, body.providerKey, body.blockScope, body.blockedUntilMs);
			json(res, 200, { ok: true });
			return;
		}

		// PATCH /v1/credential/:id/remark
		const remarkMatch = pathname.match(/^\/v1\/credential\/(\d+)\/remark$/);
		if (method === "PATCH" && remarkMatch) {
			const id = Number(remarkMatch[1]);
			const body = await parseBody<{ remark: string }>(req);
			ctx.storage.updateRemarkById(id, body.remark);
			json(res, 200, { ok: true });
			return;
		}

		// DELETE /v1/credential/:id/blocks
		const delBlocksMatch = pathname.match(/^\/v1\/credential\/(\d+)\/blocks$/);
		if (method === "DELETE" && delBlocksMatch) {
			const id = Number(delBlocksMatch[1]);
			ctx.storage.deleteCredentialBlocks(id);
			json(res, 200, { ok: true });
			return;
		}

		json(res, 404, { error: "not_found" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		json(res, 500, { error: message });
	}
}

// ─── SSE stream ───────────────────────────────────────────────────────────────

async function handleStream(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const initial = await ctx.storage.exportSnapshot();
	res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

	const keepalive = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 20_000);

	const unsub = ctx.storage.onGenerationBump(async () => {
		const snapshot = await ctx.storage.exportSnapshot();
		if (snapshot.generation <= initial.generation) return;

		for (const entry of snapshot.credentials) {
			const event: SnapshotStreamEntryEvent = { kind: "entry", entry, generation: snapshot.generation };
			res.write(`event: entry\ndata: ${JSON.stringify(event)}\n\n`);
		}

		for (const prev of initial.credentials) {
			if (!snapshot.credentials.some((c) => c.id === prev.id)) {
				const event: SnapshotStreamRemovedEvent = { kind: "removed", id: prev.id, generation: snapshot.generation };
				res.write(`event: removed\ndata: ${JSON.stringify(event)}\n\n`);
			}
		}
	});

	req.on("close", () => {
		clearInterval(keepalive);
		unsub();
	});
}

// ─── Generation gate ─────────────────────────────────────────────────────────

class GenerationGate {
	#listeners = new Set<() => void>();

	constructor(storage: BrokerStore) {
		storage.onGenerationBump(() => this.#notify());
	}

	#notify(): void {
		for (const cb of this.#listeners) {
			try {
				cb();
			} catch {
				// ignore
			}
		}
	}

	async wait(ifGenerationGt: number, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#listeners.delete(handler);
				resolve(false);
			}, timeoutMs);

			const handler = (): void => {
				clearTimeout(timer);
				this.#listeners.delete(handler);
				resolve(true);
			};

			this.#listeners.add(handler);
		});
	}
}
// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	const data = body !== undefined ? `${JSON.stringify(body)}\n` : "";
	res.writeHead(status, {
		"Content-Type": "application/json",
		...extraHeaders,
	});
	res.end(data);
}

function isAuthorized(req: http.IncomingMessage, tokens: Set<string>): boolean {
	if (tokens.size === 0) return true;
	const auth = req.headers.authorization;
	if (!auth || !auth.startsWith("Bearer ")) return false;
	return tokens.has(auth.slice(7));
}

function parseBind(bind: string): [string, string] {
	const colon = bind.lastIndexOf(":");
	if (colon === -1) return ["127.0.0.1", bind];
	const host = colon === 0 ? "127.0.0.1" : bind.slice(0, colon);
	const port = bind.slice(colon + 1);
	return [host || "127.0.0.1", port];
}

async function parseBody<T>(req: http.IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	return JSON.parse(raw) as T;
}
