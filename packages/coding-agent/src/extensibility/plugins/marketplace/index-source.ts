/**
 * Reading a market's plugin index from user-configured sources.
 *
 * The market never fetches an address a caller supplies. A source list is
 * configuration (market name + where its index lives); `read(name)` is the
 * only entry point, so an index URL always came from the configuration the
 * person added. Git-hosted indexes are reserved for the next phase: they are
 * part of the configuration type and rejected with a named error, not fetched
 * through a second code path.
 *
 * Fetch hygiene, all enforced here:
 * - `http:` / `https:` only, no URL credentials, no fragment.
 * - Redirects are followed only within the configured URL's origin. A market
 *   cannot bounce a reader to a different host, so the origin the user
 *   configured is the origin that serves the document.
 * - The response body is bounded before JSON parsing.
 * - One request per URL at a time: concurrent reads of the same URL join the
 *   in-flight fetch, and a successful document is cached for `ttlMs`.
 * - Invalid documents are rejected whole by `parsePluginIndexJson`; their
 *   JSON-path diagnostics ride on the error.
 *
 * @module extensibility/plugins/marketplace/index-source
 */

import type { PluginIndex, PluginIndexDiagnostic } from "./index-format";
import { parsePluginIndexJson } from "./index-format";
import { isValidNameSegment } from "./types";

/** Default time a fetched index stays fresh. */
export const DEFAULT_INDEX_TTL_MS = 5 * 60_000;

/** Default cap on an index response body (8 MiB). */
export const DEFAULT_INDEX_MAX_BYTES = 8 * 1024 * 1024;

/** Default request deadline for one index read. */
export const DEFAULT_INDEX_TIMEOUT_MS = 30_000;

/** Redirects followed per read; each hop must stay on the configured origin. */
export const MAX_INDEX_REDIRECTS = 3;

/**
 * Where a market publishes its index.
 *
 * `git` is reserved for the next phase: a repository plus the index path
 * inside it. It exists in the type now so configuration and docs do not change
 * shape when that phase lands.
 */
export type PluginIndexLocation =
	| { readonly kind: "url"; readonly url: string }
	| { readonly kind: "git"; readonly url: string; readonly path?: string };

/**
 * One configured market and where its index JSON lives.
 *
 * The index's own `source` field means something else: where a plugin version
 * installs from (`PluginIndexSource` in `index-format.ts`).
 */
export interface PluginIndexSourceConfig {
	/** Market name; also the marketplace segment in `name@marketplace` plugin IDs. */
	readonly name: string;
	readonly location: PluginIndexLocation;
	/** Freshness window for this source, overriding the reader default. */
	readonly ttlMs?: number;
	/** Body cap for this source, overriding the reader default. */
	readonly maxBytes?: number;
	/** Request deadline for this source, overriding the reader default. */
	readonly timeoutMs?: number;
}

/** Test seams and shared defaults for a reader instance. */
export interface PluginIndexSourceReaderOptions {
	/** Fetch implementation; tests inject one to observe request counts. */
	readonly fetch?: typeof fetch;
	/** Clock in milliseconds since epoch; tests advance it to expire the TTL. */
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly maxBytes?: number;
	readonly timeoutMs?: number;
}

/** One successful read of a market index. */
export interface PluginIndexRead {
	/** Configured market name. */
	readonly name: string;
	/** Configured index URL (not the redirect target). */
	readonly url: string;
	readonly index: PluginIndex;
	/** Milliseconds since epoch when this document was fetched. */
	readonly fetchedAt: number;
	/** True when no network request was made: a TTL hit or a joined in-flight fetch. */
	readonly fromCache: boolean;
	/** Unknown members dropped during validation, each with its JSON path. */
	readonly droppedFields: readonly PluginIndexDiagnostic[];
}

export type PluginIndexSourceErrorCode =
	| "not-configured"
	| "reserved-source"
	| "invalid-url"
	| "redirect"
	| "redirect-origin"
	| "http-error"
	| "body-too-large"
	| "invalid-index"
	| "network";

/** A read failure with a stable machine-readable code. */
export class PluginIndexSourceError extends Error {
	readonly code: PluginIndexSourceErrorCode;
	/** Validation diagnostics when `code` is `invalid-index`. */
	readonly diagnostics: readonly PluginIndexDiagnostic[] | undefined;

	constructor(
		code: PluginIndexSourceErrorCode,
		message: string,
		options: { readonly diagnostics?: readonly PluginIndexDiagnostic[]; readonly cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "PluginIndexSourceError";
		this.code = code;
		this.diagnostics = options.diagnostics;
	}
}

interface CachedIndex {
	readonly index: PluginIndex;
	readonly fetchedAt: number;
	readonly droppedFields: readonly PluginIndexDiagnostic[];
}

/**
 * Reads indexes from a fixed list of configured sources.
 *
 * Construct one per configuration snapshot; a changed source list is a new
 * reader, which also drops the old cache. No method accepts a URL, so the
 * reader cannot be turned into a general-purpose fetcher.
 */
export class PluginIndexSourceReader {
	private readonly sources = new Map<string, PluginIndexSourceConfig>();
	private readonly cache = new Map<string, CachedIndex>();
	private readonly inFlight = new Map<string, Promise<CachedIndex>>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly maxBytes: number;
	private readonly timeoutMs: number;

	constructor(sources: readonly PluginIndexSourceConfig[], options: PluginIndexSourceReaderOptions = {}) {
		for (const source of sources) {
			if (!isValidNameSegment(source.name)) {
				throw new Error(`Invalid market name for a plugin index source: "${source.name}"`);
			}
			if (this.sources.has(source.name)) {
				throw new Error(`Duplicate plugin index source name: "${source.name}"`);
			}
			this.sources.set(source.name, source);
		}
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_INDEX_TTL_MS;
		this.maxBytes = options.maxBytes ?? DEFAULT_INDEX_MAX_BYTES;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
	}

	/** Read one configured market's index, from cache when it is still fresh. */
	async read(name: string): Promise<PluginIndexRead> {
		const source = this.sources.get(name);
		if (source === undefined) {
			const configured = [...this.sources.keys()].sort().join(", ");
			throw new PluginIndexSourceError(
				"not-configured",
				`No plugin index source named "${name}". Configured sources: ${configured === "" ? "(none)" : configured}`,
			);
		}

		if (source.location.kind === "git") {
			throw new PluginIndexSourceError(
				"reserved-source",
				`Git-hosted plugin indexes are reserved for the next phase; source "${name}" must use a direct JSON URL`,
			);
		}

		const url = parseIndexUrl(source.location.url);
		const key = url.href;
		const ttlMs = source.ttlMs ?? this.ttlMs;

		const cached = this.cache.get(key);
		if (cached !== undefined && this.now() - cached.fetchedAt < ttlMs) {
			return this.toRead(source, url, cached, true);
		}

		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return this.toRead(source, url, await pending, true);
		}

		const request = this.fetchValidated(source, url).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, request);
		return this.toRead(source, url, await request, false);
	}

	private toRead(source: PluginIndexSourceConfig, url: URL, cached: CachedIndex, fromCache: boolean): PluginIndexRead {
		return {
			name: source.name,
			url: url.href,
			index: cached.index,
			fetchedAt: cached.fetchedAt,
			fromCache,
			droppedFields: cached.droppedFields,
		};
	}

	private async fetchValidated(source: PluginIndexSourceConfig, url: URL): Promise<CachedIndex> {
		const maxBytes = source.maxBytes ?? this.maxBytes;
		const timeoutMs = source.timeoutMs ?? this.timeoutMs;
		const text = await this.fetchText(url, maxBytes, timeoutMs);
		const parsed = parsePluginIndexJson(text);
		if (!parsed.ok) {
			const summary = parsed.errors
				.slice(0, 3)
				.map(error => `${error.path}: ${error.message}`)
				.join("; ");
			const more = parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3} more)` : "";
			throw new PluginIndexSourceError("invalid-index", `Invalid plugin index from ${url.href}: ${summary}${more}`, {
				diagnostics: parsed.errors,
			});
		}
		const cached: CachedIndex = {
			index: parsed.index,
			fetchedAt: this.now(),
			droppedFields: parsed.droppedFields,
		};
		this.cache.set(url.href, cached);
		return cached;
	}

	private async fetchText(url: URL, maxBytes: number, timeoutMs: number): Promise<string> {
		let current = url;
		for (let hop = 0; ; hop++) {
			let response: Response;
			try {
				response = await this.fetchImpl(current, {
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
					headers: { accept: "application/json" },
				});
			} catch (error) {
				throw new PluginIndexSourceError("network", `Failed to fetch plugin index from ${current.href}`, {
					cause: error,
				});
			}

			if (isRedirect(response.status)) {
				if (hop >= MAX_INDEX_REDIRECTS) {
					throw new PluginIndexSourceError(
						"redirect",
						`Plugin index ${url.href} exceeded ${MAX_INDEX_REDIRECTS} redirects`,
					);
				}
				const location = response.headers.get("location");
				if (location === null) {
					throw new PluginIndexSourceError(
						"redirect",
						`Plugin index ${current.href} answered ${response.status} without a Location header`,
					);
				}
				await response.body?.cancel().catch(() => {});
				let next: URL;
				try {
					next = new URL(location, current);
				} catch (error) {
					throw new PluginIndexSourceError(
						"redirect",
						`Plugin index ${current.href} redirected to an invalid location "${location}"`,
						{ cause: error },
					);
				}
				if (next.origin !== url.origin) {
					throw new PluginIndexSourceError(
						"redirect-origin",
						`Plugin index ${url.href} redirected to ${next.origin}; only the configured origin may serve it`,
					);
				}
				parseIndexUrl(next.href);
				current = next;
				continue;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new PluginIndexSourceError(
					"http-error",
					`Fetching plugin index ${current.href} failed: HTTP ${response.status} ${response.statusText}`.trim(),
				);
			}

			return readBodyCapped(response, maxBytes, url);
		}
	}
}

// ── URL and body hygiene ──────────────────────────────────────────────

/**
 * Validate an index URL: `http:`/`https:`, no credentials, no fragment.
 *
 * A fragment never reaches the server and would make two different
 * configuration strings look like different documents; a credential in a URL
 * would be sent to the market and would have to be stored in plain text.
 */
function parseIndexUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PluginIndexSourceError("invalid-url", `Plugin index URL is not absolute: "${value}"`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new PluginIndexSourceError(
			"invalid-url",
			`Plugin index URL must use http: or https:, got "${url.protocol}"`,
		);
	}
	if (url.username !== "" || url.password !== "") {
		throw new PluginIndexSourceError("invalid-url", "Plugin index URL must not contain credentials");
	}
	if (url.hash !== "") {
		throw new PluginIndexSourceError("invalid-url", "Plugin index URL must not contain a fragment");
	}
	return url;
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Read a response body, refusing to buffer more than `maxBytes`. */
async function readBodyCapped(response: Response, maxBytes: number, url: URL): Promise<string> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new PluginIndexSourceError(
				"body-too-large",
				`Plugin index ${url.href} declares ${length} bytes; the limit is ${maxBytes}`,
			);
		}
	}
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new PluginIndexSourceError(
				"body-too-large",
				`Plugin index ${url.href} exceeded ${maxBytes} bytes while reading`,
			);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8").decode(bytes);
}
