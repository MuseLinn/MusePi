/**
 * Extension-contributed internal URL schemes (`ctx.registerUrlScheme`).
 *
 * This is the applicable half of dsh's "protocol drivers" surface. dsh's
 * other half — adapting a wire peer into an agent provider (their ACP
 * worked example) — has no musepi counterpart to plug into: ACP here is a
 * full session mode, not a pluggable driver seam, and MCP's resource
 * fallback already serves custom-scheme *resources*. What extensions were
 * actually missing is new `scheme://` namespaces for the internal-URL
 * router (read/write/complete), which this provides.
 *
 * The router is process-global, so ownership is by object identity, never
 * by name alone:
 *
 * - A scheme already handled — by a built-in, or installed by anyone else —
 *   fails as reserved/owned instead of hijacking it. Re-registering our own
 *   installed handler replaces it (hot reload safe).
 * - Unregister and shutdown release remove a handler only while it is still
 *   ours; a slot someone else overwrote is left alone.
 * - The runner talks to the router through {@link ExtensionUrlHost}, a
 *   structural seam filled by the host (the sdk passes the singleton), so
 *   this module never imports the router and cannot form an import cycle.
 */

import type { ProtocolHandler } from "../../internal-urls/types";

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;

/** Structural slice of `InternalUrlRouter` an extension host provides. */
export interface ExtensionUrlHost {
	register(handler: ProtocolHandler): void;
	unregister(scheme: string): boolean;
	getHandler(scheme: string): ProtocolHandler | undefined;
}

export interface UrlSchemeDefinition {
	readonly scheme: string;
	readonly immutable: boolean;
	resolve: ProtocolHandler["resolve"];
	write?: ProtocolHandler["write"];
	complete?: ProtocolHandler["complete"];
}

function checkDefinition(input: UrlSchemeDefinition): { scheme: string; handler: ProtocolHandler } {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("registerUrlScheme requires a definition object");
	}
	const scheme = typeof input.scheme === "string" ? input.scheme.toLowerCase() : "";
	if (!SCHEME_PATTERN.test(scheme)) {
		throw new Error(`registerUrlScheme requires a valid scheme (got ${JSON.stringify(input.scheme)})`);
	}
	if (typeof input.resolve !== "function") {
		throw new Error(`registerUrlScheme "${scheme}" requires a resolve function`);
	}
	if (typeof input.immutable !== "boolean") {
		throw new Error(`registerUrlScheme "${scheme}" requires an immutable boolean`);
	}
	for (const key of ["write", "complete"] as const) {
		const value = input[key];
		if (value !== undefined && typeof value !== "function") {
			throw new Error(`registerUrlScheme "${scheme}" field "${key}" must be a function`);
		}
	}
	const handler: ProtocolHandler = {
		scheme,
		immutable: input.immutable,
		resolve: input.resolve,
		...(input.write !== undefined ? { write: input.write } : {}),
		...(input.complete !== undefined ? { complete: input.complete } : {}),
	};
	return { scheme, handler };
}

/** Runner-scoped ownership record: scheme → our installed handler object. */
export class ExtensionUrlRegistry {
	readonly #handlers = new Map<string, ProtocolHandler>();

	constructor(private readonly resolveHost: () => ExtensionUrlHost | undefined) {}

	owned(): string[] {
		return [...this.#handlers.keys()];
	}

	register(input: UrlSchemeDefinition): { scheme: string } {
		const { scheme, handler } = checkDefinition(input);
		const host = this.resolveHost();
		if (!host) {
			throw new Error(`registerUrlScheme "${scheme}": internal URLs are not available in this session`);
		}
		const current = host.getHandler(scheme);
		if (current !== undefined && current !== this.#handlers.get(scheme)) {
			throw new Error(`registerUrlScheme "${scheme}": already handled (built-in or owned by another party)`);
		}
		host.register(handler);
		this.#handlers.set(scheme, handler);
		return { scheme };
	}

	unregister(scheme: string): boolean {
		const ours = this.#handlers.get(scheme);
		if (!ours) return false;
		this.#handlers.delete(scheme);
		const host = this.resolveHost();
		if (host && host.getHandler(scheme) === ours) host.unregister(scheme);
		return true;
	}

	/**
	 * Remove everything still owned. Best-effort per scheme so one failure
	 * cannot block teardown of the rest; never throws.
	 */
	releaseAll(): string[] {
		const released: string[] = [];
		let host: ExtensionUrlHost | undefined;
		try {
			host = this.resolveHost();
		} catch {
			host = undefined;
		}
		for (const [scheme, handler] of [...this.#handlers.entries()]) {
			this.#handlers.delete(scheme);
			if (!host) continue;
			try {
				if (host.getHandler(scheme) === handler) host.unregister(scheme);
			} catch {
				// Teardown path: ownership already dropped above.
			}
			released.push(scheme);
		}
		return released;
	}
}
