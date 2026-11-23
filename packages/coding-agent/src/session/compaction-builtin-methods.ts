/**
 * The five built-in compaction methods, declared as providers so the host and a
 * plugin answer "can this method run?" through one seam
 * (`compaction-method-provider.ts`).
 *
 * `run` here is deliberately thin for the three methods whose execution body
 * still lives in `SessionMaintenance` (remote/handoff/soft share one summarizer
 * call; snapcompact and shake have their own engines). Those methods keep their
 * bodies where the commit path already is, and the host dispatches to them by
 * id. What moved out is the part that used to be duplicated: the availability
 * rule each pass re-implemented inline.
 */
import { shouldUseProviderNativeCompaction } from "@musepi/pi-agent-core/compaction";
import { sendsImageInputOnWire } from "@musepi/pi-ai/providers/vision-guard";
import type { CompactionMethodContext, CompactionMethodProvider } from "./compaction-method-provider";
import { registerCompactionMethodProvider } from "./compaction-method-provider";

const COPY = {
	remote: {
		label: "settings.compaction.method.remote.title",
		description: "settings.compaction.method.remote.desc",
	},
	snapcompact: {
		label: "settings.compaction.method.snapcompact.title",
		description: "settings.compaction.method.snapcompact.desc",
	},
	handoff: {
		label: "settings.compaction.method.handoff.title",
		description: "settings.compaction.method.handoff.desc",
	},
	soft: {
		label: "settings.compaction.method.soft.title",
		description: "settings.compaction.method.soft.desc",
	},
	shake: {
		label: "settings.compaction.method.shake.title",
		description: "settings.compaction.method.shake.desc",
	},
} as const;

/** Server compaction needs a configured endpoint or a provider-native route. */
function remoteAvailable(ctx: CompactionMethodContext): boolean {
	const { model, settings } = ctx;
	if (typeof settings.remoteEndpoint === "string" && settings.remoteEndpoint.length > 0) return true;
	return model !== undefined && shouldUseProviderNativeCompaction(model, settings);
}

/**
 * Snapcompact prints history onto bitmap frames, so it needs a route that
 * actually carries images. A manual pass with focus text is refused too: the
 * frames have no place for user instructions.
 */
function snapcompactAvailable(ctx: CompactionMethodContext): boolean {
	if (ctx.hasFocusInstructions) return false;
	return ctx.model !== undefined && sendsImageInputOnWire(ctx.model);
}

/** Handoff reads the whole prepared context, so an overflow pass cannot use it. */
function handoffAvailable(ctx: CompactionMethodContext): boolean {
	return ctx.trigger !== "overflow";
}

const BUILTIN_PROVIDERS: readonly CompactionMethodProvider[] = [
	{
		id: "remote",
		...COPY.remote,
		available: remoteAvailable,
		// Executed by the shared summarizer path in SessionMaintenance.
		run: async () => ({ decline: "remote compaction runs through the session summarizer" }),
	},
	{
		id: "snapcompact",
		...COPY.snapcompact,
		available: snapcompactAvailable,
		run: async () => ({ decline: "snapcompact runs through its local engine" }),
	},
	{
		id: "handoff",
		...COPY.handoff,
		available: handoffAvailable,
		run: async () => ({ decline: "handoff runs through the session summarizer" }),
	},
	{
		id: "soft",
		...COPY.soft,
		available: () => true,
		run: async () => ({ decline: "summary compaction runs through the session summarizer" }),
	},
	{
		id: "shake",
		...COPY.shake,
		available: () => true,
		run: async () => ({ decline: "shake runs through its local pruner" }),
	},
];

let registered = false;

/**
 * Register the built-in methods once. Idempotent so a host that mounts the
 * module twice (SDK embedding, tests) does not hit the duplicate-id guard.
 */
export function registerBuiltinCompactionMethods(): void {
	if (registered) return;
	registered = true;
	for (const provider of BUILTIN_PROVIDERS) registerCompactionMethodProvider(provider);
}
