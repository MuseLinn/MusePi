/**
 * @musepi/sdk — MusePi daemon protocol contract.
 *
 * JSON-RPC 2.0 method table with TypeBox schemas. This package is the single
 * source of truth for what the daemon exposes; GUI/TUI/remote clients compile
 * against `Type.Static` types derived from these schemas.
 *
 * Every method carries a transport auth level (see {@link TransportAuth}) so
 * the tunnel/relay security boundary (architecture decision: tunnel is
 * read-only by default) is enforced by the method table itself, not patched on
 * later.
 */
export { type Static, type TSchema, Type } from "@sinclair/typebox";

/**
 * Transport auth levels, enforced by the daemon's transport layer:
 * - `local`: unix socket / localhost only — writes, settings, terminal, files.
 * - `session`: any authenticated session (relay/tunnel OK) — read-only session
 *   ops plus prompt/approve inside an existing session.
 * - `public`: no session required — handshake/connect/QR only.
 */
export type TransportAuth = "local" | "session" | "public";

export interface MethodEntry<Params = unknown, Result = unknown> {
	/** JSON-RPC method name, namespaced by domain. */
	method: string;
	/** Transport auth level (see {@link TransportAuth}). */
	auth: TransportAuth;
	/** TypeBox schema for params (undefined → no params). */
	params?: Params;
	/** TypeBox schema for result. */
	result?: Result;
	/** Corresponding in-process symbol in coding-agent (sdk.ts / module). */
	impl: string;
}

export * from "./events";
export * from "./materialized-view";
export * from "./methods/index";
