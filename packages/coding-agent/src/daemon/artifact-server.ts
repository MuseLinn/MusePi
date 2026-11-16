/**
 * Loopback artifact origin for compiled extension components.
 *
 * Compiled modules used to travel inside the `extensions.list` payload: the
 * desktop composition's 19 components and tens of megabytes were re-sent on
 * every boot, and a slot that mounted one module paid for all of them. Serving
 * each module as its own URL moves that traffic onto HTTP, where the browser
 * revalidates with an ETag (`cache-control: no-cache` + `If-None-Match` → 304)
 * and a slot fetches only the module it is about to mount.
 *
 * The route shape is the same contract the desktop web server gives the
 * renderer bundle: existing file or 404, no cache headers beyond revalidation,
 * content-addressed ETags so a recompiled module always differs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getExtensionArtifactPortFile, logger } from "@musepi/pi-utils";

export interface ArtifactServerHandle {
	/** Origin this handle publishes under, e.g. `http://127.0.0.1:54321`. */
	readonly url: string;
	/**
	 * Serve `body` under `key` and return its absolute URL. Re-publishing a key
	 * replaces the bytes; the ETag follows the content, so a client holding the
	 * old one revalidates into a 200 instead of a 304.
	 */
	publish(key: string, body: string, contentType?: string): string;
	/**
	 * Serve a file under `key` without reading it into the daemon: the body is
	 * streamed on request and the validator comes from the file's size and
	 * mtime. This is how build-time artifacts are delivered — the composition is
	 * tens of megabytes, and reading it to answer a registry call is pure waste.
	 */
	publishFile(key: string, file: string, contentType?: string): string;
	/** Answer one artifact request (mounted on a host's route table). */
	handle(request: Request): Response;
	/** Publish under another origin — the daemon web server's, when it is the
	 *  one serving the renderer, so a module URL is same-origin with the page. */
	setOrigin(origin: string): void;
	/** Drop every published artifact (extension HMR). */
	clear(): void;
	close(): Promise<void>;
}

/** Path prefix every artifact URL carries. */
const ARTIFACT_PATH = "/extensions/artifacts/";
const ARTIFACT_KEY = /^[A-Za-z0-9_.-]+$/;

export function startArtifactServer(
	options: { host?: string; port?: number; portFile?: string; bind?: boolean } = {},
): ArtifactServerHandle {
	const host = options.host ?? "127.0.0.1";
	const entries = new Map<string, { body?: string; file?: string; etag: string; contentType: string }>();
	let origin = `http://${host}:0`;
	const handle = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		if (!pathname.startsWith(ARTIFACT_PATH)) return new Response(null, { status: 404 });
		const key = pathname.slice(ARTIFACT_PATH.length);
		const entry = ARTIFACT_KEY.test(key) ? entries.get(key) : undefined;
		if (!entry) return new Response(null, { status: 404 });
		const headers = {
			"content-type": entry.contentType,
			"cache-control": "no-cache",
			etag: entry.etag,
			// The desktop renderer is a `file://` document; its fetches carry an
			// opaque origin the loopback server must admit explicitly.
			"access-control-allow-origin": "*",
		};
		if (request.headers.get("if-none-match") === entry.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(entry.file === undefined ? entry.body : Bun.file(entry.file), { headers });
	};
	const server =
		options.bind === false
			? null
			: Bun.serve({
					port: options.port ?? 0,
					hostname: host,
					fetch: handle,
				});
	if (server) origin = `http://${host}:${server.port}`;
	return {
		get url() {
			return origin;
		},
		publish(key, body, contentType = "text/javascript; charset=utf-8") {
			const etag = `W/"${createHash("sha1").update(body).digest("hex")}"`;
			entries.set(key, { body, etag, contentType });
			return `${origin}${ARTIFACT_PATH}${key}`;
		},
		publishFile(key, file, contentType = "text/javascript; charset=utf-8") {
			const info = statSync(file);
			// Size and mtime identify a build output: rewriting the artifact
			// changes both, so a client holding the old validator revalidates.
			const etag = `W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;
			entries.set(key, { file, etag, contentType });
			return `${origin}${ARTIFACT_PATH}${key}`;
		},
		handle,
		setOrigin(next) {
			origin = next.replace(/\/+$/, "");
		},
		clear() {
			entries.clear();
		},
		async close() {
			if (server) await server.stop(true);
		},
	};
}

/** Start the server, or `null` when this runtime cannot bind one. */
export async function tryStartArtifactServer(): Promise<ArtifactServerHandle | null> {
	const portFile = getExtensionArtifactPortFile();
	// A stable origin is what makes revalidation pay off: the module URL has to
	// survive the daemon that published it, so the next daemon asks for the
	// same port and the renderer's cached ETag still matches.
	const recorded = readPort(portFile);
	for (const port of recorded === undefined ? [0] : [recorded, 0]) {
		try {
			const handle = startArtifactServer({ port });
			const bound = Number.parseInt(new URL(handle.url).port, 10);
			if (bound !== recorded) writePort(portFile, bound);
			return handle;
		} catch (error) {
			if (port === 0) {
				// Serving artifacts is an optimization: without it the daemon still
				// ships compiled code inline, exactly as before.
				logger.warn("extension artifact server unavailable (inline code delivery)", { error: String(error) });
				return null;
			}
			// The recorded port belongs to another live daemon; take a fresh one.
		}
	}
	return null;
}

function readPort(portFile: string): number | undefined {
	try {
		const port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
	} catch {
		return undefined;
	}
}

function writePort(portFile: string, port: number): void {
	try {
		mkdirSync(path.dirname(portFile), { recursive: true });
		writeFileSync(portFile, String(port), "utf8");
	} catch {
		// Discovery only: another daemon falls back to an ephemeral port.
	}
}
