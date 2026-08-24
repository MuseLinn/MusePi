import type { CapabilityResult } from "../capability";
import { loadCapability } from "../capability";
import { resolvePath, resolveUniquePaths } from "./utils";

/**
 * Extensibility loader utilities — the shared front half of every
 * capability loader's discover→resolve→import→bind pipeline (DSH
 * unification, extensibility-architecture.md step 3).
 *
 * Before this module each loader (extensions / hooks / custom-tools /
 * custom-commands / plugins) re-implemented its own
 * `loadCapability` → collect paths with metadata → dedupe loop.
 * `discoverCapabilityPaths` extracts the discover+resolve stage; the
 * caller keeps its per-capability import+bind (that part genuinely differs:
 * hooks build a HandlerMap, tools wrap an AgentTool, commands parse a
 * module, extensions validate a factory + slot).
 */

/** How a discovered path was sourced — drives the extensions-center
 *  provider/level labels (mirrors CustomTool's `_source` shape). */
export interface CapabilityPathSource {
	provider: string;
	providerName: string;
	level: "user" | "project" | "global";
}

/** One discovered capability path with its provenance. */
export interface DiscoveredCapabilityPath {
	path: string;
	source: CapabilityPathSource;
}

/** Result of a capability discover+resolve pass. */
export interface DiscoveredCapabilityPaths {
	/** Every unique path in discovery order (first wins on duplicates). */
	paths: string[];
	/** paths + per-path provenance, aligned by index. */
	items: DiscoveredCapabilityPath[];
	/** Build the dedup map if path duplicates must collapse before bind. */
	byPath: Map<string, DiscoveredCapabilityPath>;
}

/**
 * Discover a capability via the provider registry and merge in any
 * explicitly-configured paths (user/project/global), deduped in order.
 *
 * The legacy per-loader `loadCapability` call + `resolveUniquePaths` loop
 * collapse into this one call:
 *
 * ```ts
 * const { items } = await discoverCapabilityPaths("tools", { cwd }, configPaths);
 * for (const { path, source } of items) bind(path, source);
 * ```
 */
export async function discoverCapabilityPaths<T>(
	capabilityId: string,
	options: { cwd?: string } & Record<string, unknown>,
	configPaths: readonly string[] = [],
): Promise<DiscoveredCapabilityPaths> {
	const cwd = options.cwd ?? process.cwd();
	const discovered = await loadCapability<T>(capabilityId, { cwd } as Parameters<typeof loadCapability<T>>[1]);

	const items: DiscoveredCapabilityPath[] = [];
	const byPath = new Map<string, DiscoveredCapabilityPath>();

	const add = (path: string, source: CapabilityPathSource): void => {
		const resolved = resolvePath(path, cwd);
		if (byPath.has(resolved)) return;
		const item = { path: resolved, source };
		byPath.set(resolved, item);
		items.push(item);
	};

	for (const item of discovered.items as unknown as Array<{ path: string; _source?: CapabilityPathSource }>) {
		const src = item._source;
		add(item.path, {
			provider: src?.provider ?? "native",
			providerName: src?.providerName ?? "Native",
			level: src?.level ?? "global",
		});
	}

	// Explicitly configured paths override/append, in order.
	for (const cp of resolveUniquePaths(configPaths, cwd)) {
		add(cp, { provider: "config", providerName: "Config", level: "project" });
	}

	return {
		paths: items.map(i => i.path),
		items,
		byPath,
	};
}
