/** Ordered automatic context-maintenance methods and their settings metadata. */

import {
	type CompactionSettings as EngineCompactionSettings,
	shouldUseProviderNativeCompaction,
} from "@musepi/pi-agent-core/compaction";
import type { Model } from "@musepi/pi-ai";
import { sendsImageInputOnWire } from "@musepi/pi-ai/providers/vision-guard";
import type { CompactionSettings } from "../config/settings-schema";
import { registerBuiltinCompactionMethods } from "./compaction-builtin-methods";
import {
	type BuiltinCompactionMethod,
	type CompactionMethod,
	isCompactionMethod,
	listCompactionMethodProviders,
} from "./compaction-method-provider";

// The five shipped methods are registered on first import, so every consumer of
// this module (settings schema, maintenance, status line, SDK) sees them without
// a separate bootstrap step. A plugin registering an extra method runs after.
registerBuiltinCompactionMethods();

export type { BuiltinCompactionMethod, CompactionMethod };

/**
 * Choices presented by the ordered compaction-method setting: the built-in five.
 * A plugin-contributed method is merged in by the daemon's `settings.schema`
 * response (same rule as `memory.backend`), so a late registration still shows
 * up without this module depending on load order.
 */
export const COMPACTION_METHOD_CHOICES: ReadonlyArray<{ value: string; label: string; description: string }> = [
	{
		value: "remote",
		label: "settings.compaction.method.remote.title",
		description: "settings.compaction.method.remote.desc",
	},
	{
		value: "snapcompact",
		label: "settings.compaction.method.snapcompact.title",
		description: "settings.compaction.method.snapcompact.desc",
	},
	{
		value: "handoff",
		label: "settings.compaction.method.handoff.title",
		description: "settings.compaction.method.handoff.desc",
	},
	{
		value: "soft",
		label: "settings.compaction.method.soft.title",
		description: "settings.compaction.method.soft.desc",
	},
	{
		value: "shake",
		label: "settings.compaction.method.shake.title",
		description: "settings.compaction.method.shake.desc",
	},
];

/** Default fallback order: server-native first, portable summary last. */
export const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = [
	"remote",
	"snapcompact",
	"handoff",
	"shake",
	"soft",
];

export { isCompactionMethod };

/**
 * Filter malformed entries and preserve first occurrence order from a configured
 * compaction-method preference list. An id with no registered provider is
 * dropped, so uninstalling a method degrades to the built-in order instead of
 * failing every pass.
 */
export function resolveCompactionMethodOrder(value: unknown): CompactionMethod[] {
	if (!Array.isArray(value)) return [];

	const methods: CompactionMethod[] = [];
	for (const method of value) {
		if (isCompactionMethod(method) && !methods.includes(method)) methods.push(method);
	}
	return methods;
}

const STRATEGY_BY_COMPACTION_METHOD: Record<
	BuiltinCompactionMethod,
	"context-full" | "handoff" | "shake" | "snapcompact"
> = {
	remote: "context-full",
	snapcompact: "snapcompact",
	handoff: "handoff",
	soft: "context-full",
	shake: "shake",
};

/** Whether `method` is one the engine knows how to run with its own strategy. */
export function isBuiltinMethod(method: CompactionMethod): method is BuiltinCompactionMethod {
	return Object.hasOwn(STRATEGY_BY_COMPACTION_METHOD, method);
}

/**
 * Convert the selected preference into the engine's compact operation flags.
 * The engine intentionally remains usable by SDK consumers that do not expose
 * the coding agent's preference list.
 *
 * A plugin-contributed method has no engine strategy of its own: it runs through
 * the portable summary strategy, with remote compaction off unless it is the
 * remote method itself.
 */
export function resolveMethodSettings(
	settings: CompactionSettings,
	method: CompactionMethod,
): EngineCompactionSettings {
	return {
		...settings,
		strategy: isBuiltinMethod(method) ? STRATEGY_BY_COMPACTION_METHOD[method] : "context-full",
		remoteEnabled: method === "remote",
	};
}

/** Whether server compaction has either a configured endpoint or an active native route. */
export function canUseRemoteCompaction(model: Model | null | undefined, settings: EngineCompactionSettings): boolean {
	return (
		(typeof settings.remoteEndpoint === "string" && settings.remoteEndpoint.length > 0) ||
		(model !== null && model !== undefined && shouldUseProviderNativeCompaction(model, settings))
	);
}

/**
 * First configured method a threshold pass would run, or undefined when it is
 * local (snapcompact/shake) — local methods are effectively instant, so there
 * is nothing to speculate. Shared by the maintenance loop's speculation gate
 * and the status line's annotated context gauge (speculation marker).
 */
export function resolveSpeculationMethod(
	model: Model | null | undefined,
	settings: CompactionSettings,
	options: { skipRemote?: boolean } = {},
): CompactionMethod | undefined {
	for (const candidate of resolveCompactionMethodOrder(settings.methodOrder)) {
		const available =
			candidate === "remote"
				? options.skipRemote !== true && canUseRemoteCompaction(model, resolveMethodSettings(settings, candidate))
				: candidate === "snapcompact"
					? !!model && sendsImageInputOnWire(model)
					: true;
		if (!available) continue;
		// Only methods that need a remote LLM call can be speculated on.
		const speculatable =
			candidate === "remote" || candidate === "handoff" || candidate === "soft" || !isBuiltinMethod(candidate);
		return speculatable ? candidate : undefined;
	}
	return undefined;
}

/** Every method id the host currently accepts, in registration order. */
export function listCompactionMethods(): CompactionMethod[] {
	return listCompactionMethodProviders().map(provider => provider.id);
}
