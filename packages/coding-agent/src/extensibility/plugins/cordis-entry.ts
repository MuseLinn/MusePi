/**
 * The cordis plugin entry triple — `name` / `inject` / `Config` / `apply`.
 *
 * musePi runs plugins on cordis (`@deepseek-ai/cordis`): each user plugin is a
 * fiber under `musepi-dynamic-extensions`, and each registration it makes is an
 * effect on that fiber. So the honest entry shape is the framework's own — the
 * previous `export default function (pi)` shape is the Pi/omp legacy surface
 * (`extensibility/extensions/`), which stays exactly as upstream wrote it.
 *
 * Both shapes load, and the difference is what the host can do for you:
 *
 * | | legacy factory | cordis triple |
 * |---|---|---|
 * | identity | derived from the file path | declared `name` |
 * | dependencies | none — the plugin guesses | `inject`, checked before mount |
 * | config | `pi.config.get()` round-trip | passed to `apply(ctx, config)` |
 * | on missing dep | half-loads, fails at first use | refuses to mount, says why |
 *
 * The triple is *optional* per capability so this can land incrementally: a
 * plugin that only adds `name` gets better diagnostics; one that adds `inject`
 * gets the dependency gate.
 */

import { logger } from "@musepi/pi-utils";

/** A plugin entry in cordis shape. */
export interface CordisPluginEntry {
	/** Diagnostic name for the fiber and `inspect()`. Defaults to the path-derived name. */
	readonly name?: string;
	/** Service names this plugin requires to be mountable. */
	readonly inject?: readonly string[];
	/** Service names this plugin provides to others. */
	readonly provide?: readonly string[];
	/** Declarative config schema. Presence makes `apply` receive the config. */
	readonly Config?: unknown;
	/**
	 * The entry body. May RETURN the objects its `provide` names refer to,
	 * keyed by name — that is what `pi.service(name)` hands to a consumer.
	 *
	 * Returning nothing is fine for a plugin that provides names only as a
	 * declaration (or provides none); those names resolve to `undefined` for a
	 * consumer, which is a question the consumer must handle anyway because a
	 * provider can unload at any time.
	 */
	apply(ctx: unknown, config?: unknown): unknown;
}

/** What a plugin module may export: any accepted entry shape. */
export type PluginEntryModule =
	| CordisPluginEntry
	// Legacy: a bare factory taking the façade API.
	| ((api: never, config?: unknown) => unknown)
	| { default?: CordisPluginEntry | ((api: never, config?: unknown) => unknown) };

/** A factory in the shape the mount pipeline expects.
 *
 *  The second argument is the plugin's declared config, present only for a
 *  cordis entry. A legacy factory ignores it — passing an extra argument to a
 *  function that declares one parameter is indistinguishable from not passing
 *  it, so both shapes can be called through this one type. */
export type PluginEntryFactory = (api: never, config?: unknown) => unknown;

/**
 * What a plugin can `inject`.
 *
 * Resolved in this order:
 *  1. a host service (see {@link HOST_SERVICES});
 *  2. a service another plugin `provide`s — but only once that plugin is
 *     MOUNTED, because a provided name is only real while its provider lives.
 *
 * Anything else is missing, and the plugin is refused rather than half-loaded.
 */
export interface ServiceRegistry {
	/** Names this host provides itself. */
	readonly host: ReadonlySet<string>;
	/** Whether a plugin-provided service is currently available. */
	hasProvided(name: string): boolean;
	/** Who provides `name` (for the refusal message). */
	providerOf(name: string): string | undefined;
	/**
	 * The service object itself, or `undefined` when it is not available.
	 *
	 * This is the delivery half of `inject`: the gate refuses a plugin whose
	 * dependencies nothing provides, and this hands the name over. Both read the
	 * same registry, so a dependency that passed the gate is reachable.
	 */
	resolve<T = unknown>(name: string): T | undefined;
}

/** The host's own services. */
export const HOST_SERVICES: ReadonlySet<string> = new Set([
	"credentials",
	"llm",
	"settings",
	"commands",
	"attachments",
]);

/** A registry that knows only the host (no plugin providers). */
export function hostOnlyRegistry(): ServiceRegistry {
	return {
		host: HOST_SERVICES,
		hasProvided: () => false,
		providerOf: () => undefined,
		resolve: () => undefined,
	};
}

/**
 * A plugin's declared service dependencies, in either entry shape.
 *
 * An object entry carries them as `inject`; a class carries them as
 * `static inject` (the upstream convention, because a class cannot have an
 * instance field before it is constructed). Reading only the object shape made a
 * class-shaped plugin's dependencies invisible, so the gate let it mount and it
 * failed later on first use instead of being refused at load.
 */
export function declaredInject(entry: CordisPluginEntry | PluginEntryFactory | null): readonly string[] {
	if (entry === null) return [];
	const raw = (entry as { inject?: unknown }).inject;
	if (!Array.isArray(raw)) return [];
	return raw.filter((name): name is string => typeof name === "string");
}

/** A plugin's declared provided services, in either entry shape. */
export function declaredProvide(entry: CordisPluginEntry | PluginEntryFactory | null): readonly string[] {
	if (entry === null) return [];
	const raw = (entry as { provide?: unknown }).provide;
	if (!Array.isArray(raw)) return [];
	return raw.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** Names in `inject` that cannot be satisfied. Empty = mountable. */
export function missingServiceDependencies(
	entry: CordisPluginEntry | PluginEntryFactory | null,
	registry: ServiceRegistry = hostOnlyRegistry(),
): string[] {
	return declaredInject(entry).filter(name => !registry.host.has(name) && !registry.hasProvided(name));
}

/** Names a plugin's `provide` declares, normalized (non-strings dropped). */
export function providedServices(entry: CordisPluginEntry | PluginEntryFactory | null): string[] {
	return [...declaredProvide(entry)];
}

/** Whether a module value is a cordis triple (has `apply`). */
export function isCordisPluginEntry(value: unknown): value is CordisPluginEntry {
	return typeof value === "object" && value !== null && typeof (value as { apply?: unknown }).apply === "function";
}

/** Whether a value is a bare legacy factory. */
export function isBareFactory(value: unknown): value is PluginEntryFactory {
	return typeof value === "function";
}

/**
 * Whether a function value must be invoked with `new` rather than called.
 *
 * The predicate is the CORDIS one, deliberately, so a plugin's shape means the
 * same thing here as in the runtime that specification targets. A plain
 * `function (ctx)` and a `class` both have a `prototype` and are constructed;
 * an arrow function and a generator do not and are called.
 *
 * The distinction matters because plugins are written the class way upstream —
 * `class Foo extends Service { static inject = [...]; constructor(ctx) {
 * super(ctx, 'name') } }` — and calling that without `new` throws
 * "Class constructor cannot be invoked without 'new'" instead of loading.
 */
export function isConstructorPlugin(value: PluginEntryFactory): boolean {
	if (value.prototype === undefined) return false;
	const GeneratorFunction = function* () {}.constructor;
	if (value instanceof GeneratorFunction) return false;
	const AsyncGeneratorFunction = async function* () {}.constructor;
	if (AsyncGeneratorFunction !== Function && value instanceof AsyncGeneratorFunction) return false;
	return true;
}

/**
 * Normalize any accepted module shape to the plugin's entry.
 *
 * Returns `null` when nothing usable is exported — the caller turns that into a
 * structured load error rather than throwing, because one malformed plugin must
 * not take down the rest of the set.
 */
export function resolvePluginEntry(module: PluginEntryModule): CordisPluginEntry | PluginEntryFactory | null {
	// `{ default }` wrapper (TS transpiles `export default` to it).
	const inner =
		typeof module === "object" && module !== null && "default" in module
			? (module as { default?: unknown }).default
			: module;
	if (inner === undefined || inner === null) return null;
	if (isCordisPluginEntry(inner)) return inner;
	if (isBareFactory(inner)) return inner;
	return null;
}

/** The declared name of a plugin entry, for diagnostics. */
export function entryName(entry: CordisPluginEntry | PluginEntryFactory, fallback: string): string {
	if (isBareFactory(entry)) return fallback;
	return entry.name ?? fallback;
}

/**
 * Adapt a resolved entry to the invocation shape the loader pipeline expects.
 *
 * A cordis entry's `apply` is bound so it can be called as a plain factory; the
 * `config` argument is threaded separately by the caller (see
 * `readPluginEntryConfig`).
 *
 * A function entry keeps its CALLING CONVENTION: one that must be constructed is
 * constructed. A plugin written as a class is the upstream default shape, and
 * flattening it to a call throws before any of its code runs — so the adapter
 * preserves `new` instead of assuming every function is a plain factory.
 */
export function toFactory(entry: CordisPluginEntry | PluginEntryFactory): PluginEntryFactory {
	if (isBareFactory(entry)) {
		if (!isConstructorPlugin(entry)) return entry;
		// Wrapped so the pipeline keeps one calling convention; `new` happens here.
		const Ctor = entry as unknown as new (ctx: unknown, config?: unknown) => unknown;
		const constructed: PluginEntryFactory = (ctx, config) => new Ctor(ctx, config);
		return constructed;
	}
	return entry.apply.bind(entry) as PluginEntryFactory;
}

/** Log a plugin's declared shape once, so a mis-shaped entry is diagnosable. */
export function logEntryShape(name: string, entry: CordisPluginEntry | PluginEntryFactory): void {
	if (isBareFactory(entry)) {
		logger.debug("plugin entry (legacy factory)", { name });
		return;
	}
	logger.debug("plugin entry (cordis triple)", {
		name,
		inject: entry.inject ?? [],
		provide: entry.provide ?? [],
		hasConfig: entry.Config !== undefined,
	});
}
