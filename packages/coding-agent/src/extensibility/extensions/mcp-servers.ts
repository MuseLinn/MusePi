/**
 * Extension-owned MCP servers (`ctx.registerMcpServer`, dsh
 * one-plugin-per-server parity at session scope).
 *
 * The runner never touches the `MCPManager` class: it talks to the session's
 * manager through {@link ExtensionMcpHost}, a structural seam the host fills
 * (the sdk passes its session manager; hosts without MCP leave it unset).
 * Tools from registered servers flow through the manager's normal
 * `onToolsChanged` refresh, so they inherit the session's MCP approval
 * machinery with no extra wiring here.
 *
 * Ownership rules ( Runner-scoped, documented on the context methods):
 *
 * - Names must be non-empty; configs pass the manager's own
 *   `validateServerConfig`, so extension servers can never be more malformed
 *   than config-file ones.
 * - A name already connected with an identical config re-registers as a
 *   no-op (hot reload re-runs factories; it must not fight itself). A name
 *   connected with a different config — by config files or another party —
 *   fails as a conflict instead of hijacking it.
 * - A `connecting` server fails fast with "retry" rather than waiting: the
 *   call never blocks on another party's handshake.
 * - Unload is explicit (`unregisterMcpServer`) plus best-effort release of
 *   everything this runner still owns on session shutdown. A reload keeps
 *   live connections (see above for why re-registration is safe).
 */

import type { SourceMeta } from "../../capability/types";
import { validateServerConfig } from "../../mcp/config";
import type { MCPLoadResult } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";

/** Structural slice of `MCPManager` an extension host provides. */
export interface ExtensionMcpHost {
	connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
	): Promise<MCPLoadResult>;
	disconnectServer(name: string): Promise<void>;
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
}

function extensionSource(): SourceMeta {
	return { provider: "extension", providerName: "Extensions", path: "", level: "project" };
}

/** Runner-scoped ownership record: server name → canonical config JSON. */
export class ExtensionMcpRegistry {
	readonly #servers = new Map<string, string>();

	constructor(private readonly resolveHost: () => ExtensionMcpHost | undefined) {}

	owned(): string[] {
		return [...this.#servers.keys()];
	}

	async register(name: string, config: MCPServerConfig): Promise<{ name: string }> {
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (trimmed === "") throw new Error("registerMcpServer requires a non-empty server name");
		if (typeof config !== "object" || config === null || Array.isArray(config)) {
			throw new Error(`registerMcpServer "${trimmed}": config must be an object`);
		}
		const problems = validateServerConfig(trimmed, config);
		if (problems.length > 0) {
			throw new Error(`registerMcpServer "${trimmed}" has an invalid config: ${problems.join("; ")}`);
		}
		const host = this.resolveHost();
		if (!host) {
			throw new Error(`registerMcpServer "${trimmed}": MCP is not available in this session`);
		}
		const canonical = JSON.stringify(config);
		const status = host.getConnectionStatus(trimmed);
		if (status === "connecting") {
			throw new Error(`registerMcpServer "${trimmed}": connection already in progress, retry shortly`);
		}
		if (status === "connected") {
			if (this.#servers.get(trimmed) === canonical) return { name: trimmed };
			throw new Error(
				`registerMcpServer "${trimmed}": already connected with a different config (by config files or another party)`,
			);
		}
		const result = await host.connectServers({ [trimmed]: config }, { [trimmed]: extensionSource() });
		const failure = result.errors.get(trimmed);
		if (failure !== undefined) {
			throw new Error(`registerMcpServer "${trimmed}" failed to connect: ${failure}`);
		}
		this.#servers.set(trimmed, canonical);
		return { name: trimmed };
	}

	async unregister(name: string): Promise<boolean> {
		if (!this.#servers.has(name)) return false;
		this.#servers.delete(name);
		const host = this.resolveHost();
		if (host) await host.disconnectServer(name);
		return true;
	}

	/**
	 * Disconnect everything still owned. Best-effort per server so one stuck
	 * disconnect cannot block teardown of the rest; never throws.
	 */
	async releaseAll(): Promise<string[]> {
		const released: string[] = [];
		const host = this.resolveHost();
		for (const name of [...this.#servers.keys()]) {
			this.#servers.delete(name);
			if (!host) continue;
			try {
				await host.disconnectServer(name);
			} catch {
				// Teardown path: the connection is already unowned above.
			}
			released.push(name);
		}
		return released;
	}
}
