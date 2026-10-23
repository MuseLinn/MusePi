/**
 * Track A mount pipeline — the cordis plugin system's own import + bind.
 *
 * musePi has TWO plugin tracks, and this is the one that is musePi's own:
 *
 * - **Track A — `plugins/`**: musePi plugins running on cordis
 *   (`@deepseek-ai/cordis`). Each plugin is a fiber; each registration is an
 *   effect on it. The entry shape is the framework's own
 *   (`name` / `inject` / `Config` / `apply`), see `cordis-entry.ts`.
 * - **Track B — `extensions/`**: forward compatibility for extensions written
 *   for other agents (Pi / omp / Claude Code / Codex). That code is upstream's,
 *   kept byte-for-byte, and speaks the `pi.*` façade.
 *
 * Why this module exists rather than reusing `extensions/loader.ts`: that file
 * is Track B's, and the whole point of keeping it is that it stays identical to
 * upstream so a merge is a no-op. Routing Track A's mounts through it meant
 * every cordis feature (dependency gates, declared config, module identity)
 * landed in the legacy file, and the two tracks' behaviour got coupled through
 * shared code that only one of them owns. So Track A mounts here.
 *
 * What it deliberately still shares: the module loader
 * (`loadLegacyPiModule`) and the API factory (`createConcreteExtensionAPI`).
 * Those are *mechanisms*, not track policy — there is one way to import a
 * user-supplied TS entry in this host, and one façade the whole extension
 * surface speaks. Duplicating them would create two behaviours of the same
 * thing, which is the bug this split exists to avoid.
 *
 * The split is therefore about *policy* (identity, dependency gating, config
 * validation) living on the track that owns it, not about forking mechanisms.
 */

import type { EventBus } from "../../../utils/event-bus";
import type { DynamicExtensionLoadErrorCode } from "../../extensions/dynamic-extension-error";
import { DynamicExtensionLoadError } from "../../extensions/dynamic-extension-error";
import { createConcreteExtensionAPI } from "../../extensions/loader";
import type { Extension, ExtensionAPI } from "../../extensions/types";
// STATIC, not `await import()`: this module holds process-wide state (the source
// graph snapshot the loader records, and the module cache it keys imports on). A
// dynamic import resolved to a second instance in practice — the loader wrote
// into one copy while the runtime read the other and saw no record at all, so
// every plugin looked like a one-file graph and no edit was ever detected.
import { entryNeedsGraphSnapshot, loadLegacyPiModule } from "../compat/legacy-pi-compat";
import {
	type CordisPluginEntry,
	hostOnlyRegistry,
	isCordisPluginEntry,
	missingServiceDependencies,
	type PluginEntryFactory,
	resolvePluginEntry,
	type ServiceRegistry,
	toFactory,
} from "./cordis-entry";
import { registerEffect, stateDelete, stateGet, stateHas, stateKeys, stateSet } from "./cordis-primitives";

/** A mount that could not proceed, with the reason and a stable code. */
export interface MountFailure {
	ok: false;
	/** Machine-readable cause, for the management surface.
	 *
	 *  `entry-missing` / `service-missing` are this pipeline's own; the rest are
	 *  propagated verbatim from a structured error thrown inside the ledger (a
	 *  command collision, a rejected manifest, a plain throw reported as
	 *  `factory-threw`), so the attribution survives instead of being flattened
	 *  into one generic code. */
	code: DynamicExtensionLoadErrorCode;
	message: string;
}

/** A mount that succeeded. `ok` is a literal so callers can narrow on it. */
export interface MountedPlugin {
	ok: true;
	extension: Extension;
	/** The entry as the plugin exported it, in either shape (null when it used the
	 *  bare legacy factory form). A class entry is the class itself. */
	entry: CordisPluginEntry | PluginEntryFactory | null;
	/** The plugin's declared config, already coerced. Empty when none declared. */
	config: Record<string, unknown>;
	/** What `apply` returned: the objects its `provide` names refer to, keyed by
	 *  name. `undefined` for a legacy factory or a cordis entry that returns
	 *  nothing — both mean "publishes no objects", which is legal. */
	published?: Record<string, unknown>;
}

/** Either a mounted plugin or the reason it could not be mounted. */
export type MountResult = MountedPlugin | MountFailure;

/** Everything a mount needs, supplied by the caller (the cordis runtime). */
export interface MountContext {
	/** Absolute entry path. */
	entryPath: string;
	cwd: string;
	eventBus: EventBus;
	runtime: Parameters<typeof createConcreteExtensionAPI>[1];
	/**
	 * Reads this plugin's config values out of the store, coerced to its fields.
	 *
	 * Called ONLY when the entry is a cordis triple. A legacy factory declares no
	 * config, so it must not pay for the read — and must not be able to fail
	 * because of it.
	 */
	readConfig: (entryPath: string) => Promise<{ fields: readonly unknown[]; values: Record<string, unknown> }>;
	/**
	 * Resolves `inject` names: host services plus services other MOUNTED plugins
	 * `provide`. Omitted = host services only, which is the right default for a
	 * mount that is not part of a running plugin set (tests, one-off loads).
	 */
	serviceRegistry?: ServiceRegistry;
	/**
	 * Wraps the API so registrations become fiber effects (the ledger). The
	 * cordis runtime passes its own; tests can pass identity.
	 */
	wrapApi?: (api: ExtensionAPI, extension: Extension) => ExtensionAPI;
	/** Re-evaluate the module instead of reusing the process-wide instance. */
	fresh?: boolean;
}

/**
 * Add the cordis primitives (`effect` / `state`) to an API instance.
 *
 * The base API is shared with Track B and must stay that way, so the primitives
 * are attached here rather than in `createConcreteExtensionAPI`. Track B does
 * not get them: it has no fiber to scope state to and no ledger to attach
 * cleanups to, so exposing them there would be a lie.
 *
 * Both are keyed by the `Extension`, which is what ties "the plugin's
 * registrations" to "the plugin's side effects" — the same object the ledger
 * uses.
 */
function withCordisPrimitives(api: ExtensionAPI, extension: Extension): ExtensionAPI {
	const primitives = {
		effect(cleanup: () => void | Promise<void>, label?: string): void {
			registerEffect(extension, cleanup, label);
		},
		state: {
			get: <T>(key: string): T | undefined => stateGet<T>(extension, key),
			set: <T>(key: string, value: T): void => stateSet(extension, key, value),
			has: (key: string): boolean => stateHas(extension, key),
			delete: (key: string): boolean => stateDelete(extension, key),
			keys: (): string[] => stateKeys(extension),
		},
	};
	return Object.assign(api, primitives) as ExtensionAPI;
}

/**
 * Add `pi.service(name)` — the delivery half of `inject`.
 *
 * The gate in {@link mountPlugin} refuses a plugin whose `inject` names nothing
 * provides; this is what hands the name over. Both read the SAME registry, so a
 * dependency that passed the gate is reachable at use time.
 *
 * Returns `undefined` rather than throwing for an unknown name: a plugin that
 * declares a service and then loses it mid-session (its provider unloaded) must
 * be able to notice and degrade, not crash. Declaring it in `inject` is what
 * makes a missing service a LOAD-time error; calling for something you never
 * declared is a runtime question, and gets a runtime answer.
 */
function withServiceAccess(api: ExtensionAPI, registry: ServiceRegistry): ExtensionAPI {
	return Object.assign(api, {
		service<T = unknown>(name: string): T | undefined {
			// Host services are not objects this host can hand out per-call —
			// they are capabilities the plugin already has (`pi.credentials`,
			// `pi.logger`, …). Asking for one by name is a declaration error, so
			// it resolves to undefined and the plugin's own `inject` guard is
			// what should have caught it.
			if (registry.host.has(name)) return undefined;
			return registry.resolve<T>(name);
		},
	}) as ExtensionAPI;
}

/**
 * Create an empty `Extension` for a plugin entry.
 *
 * Track B's `createExtension` is module-private, and reaching into it would
 * couple the two tracks again — exactly what this split removes. The shape is
 * declared in `extensions/types.ts` (shared vocabulary, not Track B policy), so
 * Track A builds its own and both tracks agree on the object the rest of the
 * host reads.
 */
function createPluginExtension(entryPath: string, resolvedPath: string): Extension {
	return {
		path: entryPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		settings: new Map(),
		components: [],
		promptSections: [],
		modes: [],
		rpcs: new Map(),
		webRoutes: [],
		skills: [],
		toolViews: [],
		notificationChannels: [],
		services: [],
		themeTokens: [],
		mediaProviders: [],
		designSystems: [],
		statusBarSegments: [],
	};
}

/** Resolve a loaded module to a callable entry body.
 *
 *  Returns `null` when nothing usable is exported, which the caller turns into a
 *  structured load error rather than a throw (one malformed plugin must not take
 *  down the rest of the set). */
function resolveFactory(module: unknown): PluginEntryFactory | null {
	const entry = resolvePluginEntry(module as never);
	if (entry === null) return null;
	// One adapter for both shapes: it preserves the calling convention, so a
	// class is constructed rather than called. Dispatching here on `isBareFactory`
	// and returning the value as-is bypassed that and handed a class to the
	// pipeline as if it were a plain factory.
	return toFactory(entry);
}

/**
 * Import one plugin entry and bind it.
 *
 * The order matters: the entry's SHAPE is read before anything is registered, so
 * a plugin that declares a service the host lacks is refused without having
 * registered a single tool. That is the difference between "this plugin is not
 * installed" and "this plugin is installed but half of it is missing".
 */
export async function mountPlugin(ctx: MountContext): Promise<MountResult> {
	let module: unknown;
	try {
		// The graph snapshot rewrites `@(scope)/pi-*` shims in the entry's own
		// source. An entry compiled as part of the host already resolves those,
		// and snapshotting it reads the host's whole graph (~55s measured for the
		// bundled keyword package), so it is skipped when it cannot help.
		module = await loadLegacyPiModule(ctx.entryPath, {
			fresh: ctx.fresh === true,
			snapshot: await entryNeedsGraphSnapshot(ctx.entryPath),
		});
	} catch (err) {
		return {
			ok: false,
			code: "entry-missing",
			message: `failed to import plugin entry: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const inner =
		typeof module === "object" && module !== null && "default" in module
			? (module as { default?: unknown }).default
			: module;
	// Either shape can DECLARE dependencies (`inject` on an object, `static inject`
	// on a class), so the gate reads the resolved entry rather than only the
	// object form — otherwise a class plugin bypassed the gate entirely and failed
	// later, on first use, with no mention of the missing service.
	const entry = resolvePluginEntry(module as never);
	const declared = isCordisPluginEntry(inner) ? inner : null;
	const factory = resolveFactory(module);
	if (factory === null) {
		return {
			ok: false,
			code: "entry-missing",
			message: `plugin entry exports nothing loadable (expected \`export default function\` or a cordis \`{ name, inject, apply }\`): ${ctx.entryPath}`,
		};
	}

	// Declared dependencies are checked BEFORE binding (see the doc above).
	{
		const missing = missingServiceDependencies(entry, ctx.serviceRegistry ?? hostOnlyRegistry());
		if (missing.length > 0) {
			const providers = missing.map(name => {
				const who = ctx.serviceRegistry?.providerOf(name);
				return who === undefined ? name : `${name} (provided by ${who}, not mounted)`;
			});
			return {
				ok: false,
				code: "service-missing",
				message: `plugin requires service(s) this host does not provide: ${providers.join(", ")}`,
			};
		}
	}

	// Read the declared config ONLY for an entry that declares one. A bare legacy
	// factory has none, so it skips the read entirely — no extra I/O on its mount
	// path, and no way for an unreadable config store to break a plugin that never
	// asked for one. Both declared shapes are read: `Config` on the object form and
	// `static Config` on the class form.
	const declaresConfig = (entry as { Config?: unknown } | null)?.Config !== undefined;
	const values = declaresConfig ? (await ctx.readConfig(ctx.entryPath).catch(() => ({ values: {} }))).values : {};
	const extension = createPluginExtension(ctx.entryPath, ctx.entryPath);
	const base = createConcreteExtensionAPI(extension, ctx.runtime, ctx.cwd, ctx.eventBus);
	// Primitives first, then the ledger: the ledger wraps registrations into
	// effects, and it must see the primitives too so a `register*` call made
	// through the wrapped API is still recorded.
	const primitives = withCordisPrimitives(base, extension);
	// The service handle comes last so a plugin holds ONE api object: asking
	// `pi.service("name")` in `apply` must resolve through the same registry the
	// gate consulted, or a dependency could pass the check and still be
	// unreachable at use time.
	const withServices =
		ctx.serviceRegistry === undefined ? primitives : withServiceAccess(primitives, ctx.serviceRegistry);
	const api = ctx.wrapApi === undefined ? withServices : ctx.wrapApi(withServices, extension);

	try {
		// A cordis entry receives its declared config; the legacy factory keeps
		// the single-argument call (passing a second arg is indistinguishable
		// from not passing it, but the types are clearer this way).
		//
		// A cordis entry's RETURN value is what it publishes: an object keyed by
		// the names in its `provide`, handed to consumers through
		// `pi.service(name)`. A legacy factory's return is ignored — it predates
		// the contract and returning something there is not a publish.
		const returned = await factory(api as never, values);
		// Only a plain object is a publish. A string/number/array returned by a
		// cordis entry is not one, and treating it as such would hand a consumer
		// nonsense under a name it trusts.
		const published =
			typeof returned === "object" && returned !== null && !Array.isArray(returned)
				? (returned as Record<string, unknown>)
				: undefined;
		return { ok: true, extension, entry, config: values, published };
	} catch (err) {
		// A structured error thrown from inside the ledger (a command-name
		// collision, a manifest rejection) already carries the right code.
		// Wrapping it as a generic failure would bury the attribution — the
		// whole reason those errors are structured.
		if (err instanceof DynamicExtensionLoadError) {
			return { ok: false, code: err.code, message: err.message };
		}
		return {
			ok: false,
			code: "factory-threw",
			message: `plugin failed during apply: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
