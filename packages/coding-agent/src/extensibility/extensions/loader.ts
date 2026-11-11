/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { EXTENSION_SLOT_DECLARATION, EXTENSION_SLOT_NAMES } from "@musepi/collab-proto/extension-slots";
import { type } from "@musepi/musepi-type";
import * as zod from "@musepi/musepi-type/zod";
import type { ThinkingLevel } from "@musepi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@musepi/pi-ai";
import { isBuiltinComposerStyle, type KeyId } from "@musepi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@musepi/pi-utils";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { coerceConfigValues } from "@musepi/pi-wire";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isPluginDisabled } from "../../capability/plugin-identity";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { rememberRegisteredWidget } from "../../daemon/registered-widgets";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import { registerMemoryBackendProvider as registerMemoryProvider } from "../../memory-backend/providers";
import type { StoredPluginCredential } from "../../plugin-credentials";
import { getPluginCredentialManager } from "../../plugin-credentials";
import type { PromptHostSurface, ScopedPromptHostLedger } from "../../prompts/host";
import { scopePromptHostToOwner } from "../../prompts/host";
import type { CustomMessagePayload } from "../../session/messages";
import { normalizeSubagentDefinition, type SubagentDefinition } from "../../task/types";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { EventBus } from "../../utils/event-bus";
import { enablementAllowsPath } from "../enablement-manifest";
import { readPluginConfigStore } from "../extensions-center/plugin-config-store";
import * as TypeBox from "../legacy-typebox";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "../plugins/compat/compatibility-store";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/compat/legacy-pi-compat";
import { compatibilityGateForExtensionPath, pluginCompatibilityWarning } from "../plugins/compat/plugin-compatibility";
import type { HmrService } from "../plugins/hmr/service";
import { type PluginEntryModule, resolvePluginEntry, toFactory } from "../plugins/runtime/cordis-entry";
import { registerEffect } from "../plugins/runtime/cordis-primitives";
import { getHostService } from "../plugins/runtime/host-services";
import { getAllPluginExtensionPaths } from "../plugins/runtime/loader";
import { resolvePath, withHostGuard } from "../utils";
import { DynamicExtensionLoadError, type DynamicExtensionLoadErrorCode } from "./dynamic-extension-error";
import { handlerTimeoutForEvent } from "./handler-timeout";
import { readExtensionPluginMeta } from "./plugin-manifest";
import { currentSessionScope, PRESET_SCOPE_TAG } from "./session-dispatch";
import { sessionStopContinues } from "./session-stop-result";
import { applyToolResultPatch } from "./tool-result-patch";
import type {
	AssistantThinkingRenderer,
	ComposerShapeDefinition,
	DesignSystemConfig,
	Extension,
	ExtensionAPI,
	ExtensionComponent,
	ExtensionContext,
	ExtensionCredential,
	ExtensionCredentialStore,
	ExtensionFactory,
	ExtensionMagicKeyword,
	ExtensionModeDefinition,
	ExtensionNotificationMessage,
	ExtensionPromptSection,
	ExtensionRpcHandler,
	ExtensionScrollbarSkin,
	ExtensionService,
	ExtensionSetting,
	ExtensionSkillDeclaration,
	ExtensionWidget,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MediaProviderConfig,
	MessageRenderer,
	PluginContextNamespaces,
	ProviderConfig,
	RegisteredCommand,
	RegisteredDesignSystem,
	RegisteredMagicKeyword,
	RegisteredMediaProvider,
	ToolDefinition,
	ToolInfo,
	ToolResultEvent,
	ToolResultEventResult,
} from "./types";
import { namespaceOf, type PluginWebRouteRequest, scopeRoute } from "./web-route-scope";

installLegacyPiSpecifierShim();

/** Cancelable pre-events: `cancel: true` stops the chain (serial bail); any
 *  other result is remembered and the chain continues, as the old loop did. */
const CANCELABLE_PRE_EVENTS: ReadonlySet<string> = new Set([
	"session_before_switch",
	"session_before_branch",
	"session_before_compact",
	"session_before_tree",
]);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = PluginEntryModule;

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const entry = resolvePluginEntry(module);
	if (entry === null) return null;
	return toFactory(entry) as ExtensionFactory;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	/** Cordis event context for lifecycle events already migrated off the
	 *  hand-written loops (`session_start`, `session_shutdown`). */
	readonly eventBus: IExtensionRuntime["eventBus"] = new Context() as unknown as IExtensionRuntime["eventBus"];
	readonly eventHandlerCounts = new Map<string, number>();
	readonly beforeEventResults = new WeakMap<object, unknown>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];
	readonly promptHostLedgers = new Map<string, ScopedPromptHostLedger>();
	/** Session prompt host; set by the owning session before factories run. */
	promptHost?: PromptHostSurface;
	pendingMediaProviderRegistrations: RegisteredMediaProvider[] = [];
	pendingDesignSystemRegistrations: RegisteredDesignSystem[] = [];
	/**
	 * Magic keywords registered by extensions, pending the host that consumes
	 * them. A queue rather than a per-extension list because the consumer is a
	 * session — several sessions may read the same registration, and an unload
	 * must drop the keyword from all of them at once.
	 */
	pendingMagicKeywordRegistrations: RegisteredMagicKeyword[] = [];
	/** The runner's error channel for migrated lifecycle listeners. */
	eventErrorSink?: (error: { extensionPath: string; event: string; error: string }) => void;

	/**
	 * Bound one lifecycle listener by its per-event budget. A session's
	 * `ExtensionRunner` replaces this with its registration-scope executor, so a
	 * handler's budget also aborts the tool activations it started; runtimes
	 * loaded without a runner keep the plain timeout.
	 */
	handlerExecutor: NonNullable<IExtensionRuntime["handlerExecutor"]> = async (
		handler,
		event,
		ctx,
		extension,
		timeoutMs,
	) => {
		let timer: Timer | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`handler timed out after ${timeoutMs}ms`)), timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([handler(event as never, ctx), timeout]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("handler timed out")) {
				logger.warn("Extension handler timed out", {
					extensionPath: extension.path,
					event: event.type,
					timeoutMs,
				});
			}
			const report = this.eventErrorSink;
			if (report) report({ extensionPath: extension.path, event: event.type, error: message });
			else
				logger.warn("extension lifecycle listener failed", {
					path: extension.path,
					event: event.type,
					error: message,
				});
		} finally {
			if (timer) clearTimeout(timer);
		}
	};

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	registerMediaProvider(config: MediaProviderConfig, sourceId: string): void {
		this.pendingMediaProviderRegistrations.push({ config, sourceId });
	}

	unregisterMediaProvider(id: string, sourceId: string): void {
		const remaining = this.pendingMediaProviderRegistrations.filter(
			registration => registration.config.id !== id || registration.sourceId !== sourceId,
		);
		this.pendingMediaProviderRegistrations.splice(0, this.pendingMediaProviderRegistrations.length, ...remaining);
	}

	registerDesignSystem(config: DesignSystemConfig, sourceId: string): void {
		this.pendingDesignSystemRegistrations.push({ config, sourceId });
	}

	unregisterDesignSystem(id: string, sourceId: string): void {
		const remaining = this.pendingDesignSystemRegistrations.filter(
			registration => registration.config.id !== id || registration.sourceId !== sourceId,
		);
		this.pendingDesignSystemRegistrations.splice(0, this.pendingDesignSystemRegistrations.length, ...remaining);
	}

	registerMagicKeyword(keyword: ExtensionMagicKeyword, sourceId: string): void {
		this.pendingMagicKeywordRegistrations.push({ ...keyword, sourceId });
	}

	unregisterMagicKeyword(name: string, sourceId: string): void {
		const remaining = this.pendingMagicKeywordRegistrations.filter(
			registration => registration.name !== name || registration.sourceId !== sourceId,
		);
		this.pendingMagicKeywordRegistrations.splice(0, this.pendingMagicKeywordRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	emitNotification(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * 同源工厂：ConcreteExtensionAPI 的唯一构造入口（收编第二刀）——会话装载
 * （bindExtension）与 cordis 宿主级动态装载（cordis-dynamic-plugins）
 * 共用同一 API 实例来源，换实现处只此一点，两条加载路径不会漂移。
 */
/**
 * The extension event context, created on first use.
 *
 * Shared by the lazy `on` path and the factory loader that starts the
 * extension's own fiber on the same context.
 */
function ensureExtensionEventBus(runtime: IExtensionRuntime): NonNullable<IExtensionRuntime["eventBus"]> {
	let bus = runtime.eventBus;
	if (!bus) {
		bus = new Context() as unknown as NonNullable<IExtensionRuntime["eventBus"]>;
		runtime.eventBus = bus;
	}
	return bus;
}

export function createConcreteExtensionAPI(
	extension: Extension,
	runtime: IExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
	/** The extension's fiber context; listeners registered through it are owned
	 *  by the fiber (dsh: a plugin is a fiber). Absent for loaders that run the
	 *  factory outside one — the listener ledger still covers those. */
	ownContext?: Context,
): ExtensionAPI {
	return new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus, ownContext);
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
/**
 * The `name` of the nearest `package.json` above an extension entry.
 *
 * Walks up rather than reading one fixed level, because an extension may be a
 * single file dropped into a directory that is not itself a package. Stops at
 * the first manifest that actually declares a name — a `package.json` with no
 * `name` is not the extension's identity and keeps the walk going.
 *
 * Returns `null` when there is none, which is the case for an unpackaged
 * single-file extension; the caller falls back to the directory name.
 */
async function readPackageNameNear(entryPath: string): Promise<string | null> {
	let dir = path.dirname(entryPath);
	// Bounded so a malformed path cannot walk to the filesystem root forever.
	// Eight levels covers a pnpm store layout (`.pnpm/<pkg>@<ver>/node_modules/…`)
	// with room to spare.
	for (let depth = 0; depth < 8; depth++) {
		const manifest = path.join(dir, "package.json");
		if (await Bun.file(manifest).exists()) {
			try {
				const parsed = JSON.parse(await Bun.file(manifest).text()) as { name?: unknown };
				if (typeof parsed.name === "string" && parsed.name.trim() !== "") return parsed.name.trim();
			} catch {
				// An unreadable manifest is not this extension's identity; keep
				// walking rather than failing a credential read over it.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Map a stored credential onto the shape an extension sees. */
function toExtensionCredential(stored: StoredPluginCredential): ExtensionCredential {
	return {
		value: stored.value,
		...(stored.refreshToken === undefined ? {} : { refreshToken: stored.refreshToken }),
		...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
		...(stored.clientId === undefined ? {} : { clientId: stored.clientId }),
		...(stored.clientSecret === undefined ? {} : { clientSecret: stored.clientSecret }),
		...(stored.metadata === undefined ? {} : { metadata: stored.metadata }),
	};
}

/**
 * Owner id a session uses to release/replay one extension's prompt-host
 * contributions (`ext:<id>`), matching the composer source convention and
 * `extensionIdOf` in sdk.ts.
 */
export function extensionHostOwner(extensionPath: string): string {
	return `ext:${getExtensionNameFromPath(extensionPath)}`;
}

/**
 * Bind one cleanup to a Cordis fiber.
 *
 * Cordis settles a fiber teardown asynchronously, so a disposer that only calls
 * `fiber.effect`'s handle can still run the cleanup when a plugin unloads right
 * after `off()`. The wrapper marks the cleanup cancelled synchronously; the
 * fiber dispose then sees the flag and skips it.
 */
function bindFiberEffect(context: Context, cleanup: () => void | Promise<void>, label?: string): () => void {
	let active = true;
	const dispose = context.effect(
		() => () => {
			if (!active) return;
			return cleanup();
		},
		label,
	);
	return () => {
		active = false;
		try {
			void Promise.resolve(dispose()).catch(() => {});
		} catch {
			// A failed teardown must not throw out of a plugin's own disposer.
		}
	};
}

class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];
	readonly pendingMediaProviderRegistrations: RegisteredMediaProvider[] = [];
	readonly pendingDesignSystemRegistrations: RegisteredDesignSystem[] = [];
	/**
	 * Mirrors the runtime's queue, as the other pending lists here do: the API
	 * instance is per-extension, and the runtime queue is what a session drains.
	 * Kept in step with `registerMagicKeyword` so `loadExtensions` can report a
	 * factory's contributions without reaching into the runtime.
	 */
	readonly pendingMagicKeywordRegistrations: RegisteredMagicKeyword[] = [];

	readonly tools: ExtensionAPI["tools"];
	readonly commands: ExtensionAPI["commands"];
	readonly settings: ExtensionAPI["settings"];
	readonly prompts: ExtensionAPI["prompts"];
	readonly slots: ExtensionAPI["slots"];
	readonly rpc: ExtensionAPI["rpc"];
	readonly subagents: ExtensionAPI["subagents"];
	readonly magicKeywords: ExtensionAPI["magicKeywords"];
	readonly memory: ExtensionAPI["memory"];
	readonly skins: ExtensionAPI["skins"];
	readonly hmr: ExtensionAPI["hmr"];

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		public readonly cwd: string,
		public readonly events: EventBus,
		private readonly ownContext?: Context,
	) {
		const self = this;
		this.tools = {
			register: this.registerTool.bind(this),
			registerView: this.registerToolView.bind(this),
		};
		this.commands = {
			register: this.registerCommand.bind(this),
			registerShortcut: this.registerShortcut.bind(this),
		};
		this.settings = { register: this.registerSetting.bind(this) };
		this.prompts = {
			register: this.registerPrompt.bind(this),
			get host() {
				return self.promptHost;
			},
		};
		this.slots = {
			register: this.registerComponent.bind(this),
			registerWidget: this.registerWidget.bind(this),
		};
		this.rpc = {
			register: this.registerRpc.bind(this),
			webRoute: this.registerWebRoute.bind(this),
		};
		this.subagents = { register: this.registerSubagent.bind(this) };
		this.magicKeywords = { register: this.registerMagicKeyword.bind(this) };
		this.memory = { registerBackendProvider: this.registerMemoryBackendProvider.bind(this) };
		this.skins = { register: this.registerScrollbarSkin.bind(this) };
		// `ctx.hmr` is process-level, not per-extension: the host starts one
		// watcher and every plugin subscribes to the same batches. A plugin's
		// disposer is its own; hosts that start no watcher report enabled=false
		// and hand back a no-op disposer rather than forcing a branch.
		this.hmr = {
			get enabled() {
				return getHostService<HmrService>("hmr")?.enabled ?? false;
			},
			on: (event, listener, options?: { prepend?: boolean }) =>
				getHostService<HmrService>("hmr")?.on(event, listener, options) ?? (() => {}),
			onChange: listener => getHostService<HmrService>("hmr")?.onChange(listener) ?? (() => {}),
			reload: async () => {
				await getHostService<HmrService>("hmr")?.reload();
			},
			runExclusive: async transaction =>
				(await getHostService<HmrService>("hmr")?.runExclusive(transaction)) ?? (await transaction()),
			getLinked: file => getHostService<HmrService>("hmr")?.getLinked(file) ?? [],
			getOuterStack: file => getHostService<HmrService>("hmr")?.getOuterStack(file) ?? [],
		};
	}

	/**
	 * The live session's registration scope (dsh's agent-scoped context).
	 * Undefined outside a session, so a listener wired in `session_start` cannot
	 * silently outlive it. Registration goes through the session fiber's
	 * `effect`, so Cordis — not a hand-kept ledger — owns disposal.
	 */
	get session(): PluginContextNamespaces["session"] {
		const scope = currentSessionScope();
		if (!scope) return undefined;
		const on = ((event: string, handler: HandlerFn, options?: { prepend?: boolean }) =>
			scope.context.effect(() =>
				this.#registerListener(
					scope.context as NonNullable<IExtensionRuntime["eventBus"]>,
					event,
					handler,
					options,
				),
			)) as ExtensionAPI["on"];
		return { on };
	}

	/**
	 * Session prompt host scoped to THIS extension: registrations without an
	 * explicit owner record under `ext:<id>`, so a session can release and
	 * replay the extension's contributions on disable/enable/reload without
	 * re-running the factory. Undefined when no session wired a host.
	 */
	get promptHost(): PromptHostSurface | undefined {
		// Session-scoped by design (dsh: prompt contributions register when the
		// agent exists). Reading it in `apply` returns undefined; register in
		// `session_start` instead. This is what lets instances be shared.
		const scope = currentSessionScope();
		if (!scope) {
			// The old contract let a plugin register at apply and capture the
			// host. That silently stops working now, so name the plugin once.
			if (!this.#warnedPromptHostOutsideSession) {
				this.#warnedPromptHostOutsideSession = true;
				logger.warn("promptHost read outside a session; register contributions in session_start", {
					extensionPath: this.extension.path,
				});
			}
			return undefined;
		}
		const host = scope.promptHost;
		if (!host) return undefined;
		const owner = extensionHostOwner(this.extension.path);
		const ledgers = currentSessionScope()?.promptHostLedgers;
		if (!ledgers) return undefined;
		let ledger = ledgers.get(owner);
		if (!ledger) {
			ledger = { entries: [] };
			ledgers.set(owner, ledger);
		}
		return scopePromptHostToOwner(host, owner, ledger);
	}

	/** The owning runtime's per-owner ledgers, shared so sessions replay this API's records. */
	get promptHostLedgers(): Map<string, ScopedPromptHostLedger> {
		return this.runtime.promptHostLedgers;
	}

	/**
	 * Manifest-declared config 的运行时读取(pi.config)。清单 meta 按实例
	 * 缓存(HMR 重载会新建 API 实例,天然刷新);存储值每次现读——写穿透
	 * 更新进程内缓存,restart=none 的"最新写入立即可见"由此成立。
	 */
	readonly config: ExtensionAPI["config"] = {
		get: async <T>(key: string): Promise<T | undefined> => (await this.#configValues())[key] as T | undefined,
		getAll: async (): Promise<Record<string, unknown>> => ({ ...(await this.#configValues()) }),
	};

	#configFieldsPromise: Promise<ConfigFieldDesc[]> | null = null;
	#warnedPromptHostOutsideSession = false;

	#configFields(): Promise<ConfigFieldDesc[]> {
		this.#configFieldsPromise ??= readExtensionPluginMeta(this.extension.path).then(meta => meta?.fields ?? []);
		return this.#configFieldsPromise;
	}

	async #configValues(): Promise<Record<string, unknown>> {
		const [fields, store] = await Promise.all([this.#configFields(), readPluginConfigStore()]);
		const id = `extension-module:${getExtensionNameFromPath(this.extension.path)}`;
		return coerceConfigValues(fields, store[id]);
	}

	/** Register a cleanup owned by this extension (dsh `ctx.effect`); the
	 *  disposer removes just this record. Unloading the plugin runs them all. */
	effect(cleanup: () => void | Promise<void>, label?: string): () => void {
		// Ownership follows the call site, like dsh: an effect registered in
		// `apply` belongs to the extension's fiber, one registered inside a
		// session handler belongs to the session's fiber. No third ledger.
		const scope = currentSessionScope();
		if (scope) return bindFiberEffect(scope.context as unknown as Context, cleanup, label);
		if (this.ownContext) return bindFiberEffect(this.ownContext, cleanup, label);
		return registerEffect(this.extension, cleanup, label);
	}

	/** Register one listener; the return value removes it again (Cordis
	 *  `ctx.on`). The extension unload still clears every listener it owns.
	 *
	 *  Registration goes through the extension's own fiber when it has one, so
	 *  unloading is `fiber.dispose()`; the listener ledger stays as the exact
	 *  count and as the path for factories loaded without a fiber. The runner
	 *  picks `serial` / `parallel` per event; the timeout is wrapped inside the
	 *  listener, leaving bail/serial results intact. */
	on<F extends HandlerFn>(event: string, handler: F, options?: { prepend?: boolean }): () => void {
		// One registry for every event: unknown names still work because the
		// dispatcher only cares about the name at emit time.
		const bus = this.ownContext
			? (this.ownContext as unknown as NonNullable<IExtensionRuntime["eventBus"]>)
			: ensureExtensionEventBus(this.runtime);
		const dispose = this.#registerListener(bus, event, handler, options);
		// Fiber ownership: the disposer becomes an effect of this extension's
		// fiber, so a reload/unload/rollback reclaims it with the instance.
		if (this.ownContext) this.ownContext.effect(() => dispose);
		return dispose;
	}

	/**
	 * The listener body shared by `on` (instance scope) and `ctx.session.on`
	 * (session-fiber scope). Registering on a different Cordis context changes
	 * only who owns the disposer — timeout, result and error contracts stay the
	 * same, because they live in this wrapper.
	 */
	#registerListener(
		bus: NonNullable<IExtensionRuntime["eventBus"]>,
		event: string,
		handler: HandlerFn,
		options?: { prepend?: boolean },
	): () => void {
		const wrapped = async (...args: unknown[]): Promise<unknown> => {
			// `tool_call` is fail-closed: timeout or throw blocks the tool. That
			// gate is the runner's executor (signal, registration drain, error
			// channel), not the generic timeout wrapper below.
			if (event === "tool_call") {
				const options = args[2] as { timeoutMs: number; signal?: AbortSignal } | undefined;
				const timeoutMs = options?.timeoutMs ?? handlerTimeoutForEvent(event);
				const execute = this.runtime.handlerExecutor;
				if (!execute) return undefined;
				const result = await execute(
					handler as (event: unknown, ctx: ExtensionContext) => unknown,
					args[0] as { type: string },
					args[1] as ExtensionContext,
					this.extension,
					timeoutMs,
					(kind, message) => ({
						block: true,
						reason:
							kind === "timeout"
								? `Extension ${this.extension.path} timed out after ${timeoutMs}ms`
								: `Extension ${this.extension.path} failed: ${message}`,
					}),
					options?.signal,
				);
				if ((result as { block?: boolean } | undefined)?.block === true) return result;
				if (result !== undefined) this.runtime.beforeEventResults?.set(args[0] as object, result);
				return undefined;
			}

			// `session_stop` owns a settle signal; the executor composes it with the
			// budget and reports timeout/errors exactly as the legacy path did.
			if (event === "session_stop") {
				const ev = args[0] as { signal?: AbortSignal };
				const execute = this.runtime.handlerExecutor;
				if (!execute) return undefined;
				const result = await execute(
					handler as (event: unknown, ctx: ExtensionContext) => unknown,
					ev as { type: string },
					args[1] as ExtensionContext,
					this.extension,
					handlerTimeoutForEvent(event),
					() => undefined,
					ev.signal,
				);
				if (sessionStopContinues(result as never)) return result;
				if (result !== undefined) this.runtime.beforeEventResults?.set(ev as object, result);
				return undefined;
			}

			// Read the budget at dispatch time: tests and hosts change it after
			// the plugin has loaded.
			const timeoutMs = handlerTimeoutForEvent(event);
			// `context` / `input` handlers receive an event built from the
			// dispatch-scoped state, so each listener sees the previous
			// listener's rewrite (the accumulated value lives in args[2]).
			let callArgs = args;
			if (event === "context") {
				const state = args[2] as { messages: unknown[] };
				callArgs = [{ type: "context", messages: state.messages }, args[1]] as unknown[];
			} else if (event === "input") {
				const state = args[2] as { text: string; images: unknown; source: string };
				callArgs = [
					{ type: "input", text: state.text, images: state.images, source: state.source },
					args[1],
				] as unknown[];
			} else if (event === "before_agent_start") {
				const state = args[2] as { systemPrompt: string[] };
				callArgs = [{ ...(args[0] as object), systemPrompt: state.systemPrompt }, args[1]] as unknown[];
			} else if (event === "before_provider_request") {
				const state = args[2] as { payload: unknown };
				callArgs = [{ type: "before_provider_request", payload: state.payload }, args[1]] as unknown[];
			}
			try {
				const execute = this.runtime.handlerExecutor;
				if (!execute) return undefined;
				const result = await execute(
					handler as (event: unknown, ctx: ExtensionContext) => unknown,
					(callArgs[0] ?? { type: event }) as { type: string },
					callArgs[1] as ExtensionContext,
					this.extension,
					timeoutMs,
					() => undefined,
				);
				if (event === "context") {
					const state = args[2] as { messages: unknown[] };
					const patch = result as { messages?: unknown[] } | undefined;
					if (patch?.messages !== undefined) state.messages = patch.messages;
					return undefined;
				}
				if (event === "input") {
					const state = args[2] as { text: string; images: unknown; source: string };
					const patch = result as { handled?: boolean; text?: string; images?: unknown } | undefined;
					if (patch?.handled) return patch;
					if (patch?.text !== undefined) state.text = patch.text;
					if (patch?.images !== undefined) state.images = patch.images;
					return undefined;
				}
				if (event === "tool_result") {
					// The dispatcher owns the accumulated event; the listener only
					// returns its patch, exactly like the old loop.
					const state = args[2] as { event: ToolResultEvent; modified: boolean } | undefined;
					if (state && applyToolResultPatch(state.event, result as ToolResultEventResult | undefined)) {
						state.modified = true;
					}
					return undefined;
				}
				if (event === "before_agent_start") {
					const state = args[2] as {
						messages: unknown[];
						systemPrompt: string[];
						systemPromptModified: boolean;
					};
					const patch = result as { message?: unknown; systemPrompt?: string | string[] } | undefined;
					if (patch?.message) state.messages.push(patch.message);
					if (patch?.systemPrompt !== undefined) {
						state.systemPrompt =
							typeof patch.systemPrompt === "string" ? [patch.systemPrompt] : patch.systemPrompt;
						state.systemPromptModified = true;
					}
					return undefined;
				}
				if (event === "before_provider_request") {
					const state = args[2] as { payload: unknown };
					if (result !== undefined) state.payload = result;
					return undefined;
				}
				if (event === "cache_warming_decision") {
					const state = args[2] as { action: unknown };
					const patch = result as { action?: unknown } | undefined;
					if (patch?.action !== undefined) state.action = patch.action;
					return undefined;
				}
				if (event === "session.compacting") {
					if (result !== undefined) this.runtime.beforeEventResults?.set(args[0] as object, result);
					return undefined;
				}
				if (event === "user_bash" || event === "user_python") {
					// First non-empty result wins (the old loop's bail).
					return result ?? undefined;
				}
				if (event === "resources_discover") {
					const state = args[2] as {
						skillPaths: Array<{ path: string; extensionPath: string }>;
						promptPaths: Array<{ path: string; extensionPath: string }>;
						themePaths: Array<{ path: string; extensionPath: string }>;
					};
					const patch = result as
						| { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
						| undefined;
					for (const path of patch?.skillPaths ?? []) {
						state.skillPaths.push({ path, extensionPath: this.extension.path });
					}
					for (const path of patch?.promptPaths ?? []) {
						state.promptPaths.push({ path, extensionPath: this.extension.path });
					}
					for (const path of patch?.themePaths ?? []) {
						state.themePaths.push({ path, extensionPath: this.extension.path });
					}
					return undefined;
				}
				if (CANCELABLE_PRE_EVENTS.has(event)) {
					const cancels = (result as { cancel?: unknown } | undefined)?.cancel === true;
					if (cancels) return result;
					if (result !== undefined) this.runtime.beforeEventResults?.set(args[0] as object, result);
				}
				return undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("handler timed out")) {
					logger.warn("Extension handler timed out", {
						extensionPath: this.extension.path,
						event,
						timeoutMs,
					});
				}
				const report = this.runtime.eventErrorSink;
				if (report) report({ extensionPath: this.extension.path, event, error: message });
				else
					logger.warn("extension lifecycle listener failed", {
						path: this.extension.path,
						event,
						error: message,
					});
			}
		};
		const off = bus.on(event, wrapped, options);
		const counts = this.runtime.eventHandlerCounts;
		counts?.set(event, (counts.get(event) ?? 0) + 1);
		let disposed = false;
		const dispose = () => {
			// Session close and plugin unload can both reach one listener; a
			// second decrement would under-count and disable later dispatches.
			if (disposed) return;
			disposed = true;
			off();
			const live = counts?.get(event);
			if (live !== undefined && counts) counts.set(event, Math.max(0, live - 1));
			// Drop the record as well: the list is the exact live-listener count
			// (diagnostics read it), and a fiber disposal must not leave it stale.
			const listeners = this.extension.eventListenerDisposers;
			const index = listeners?.indexOf(dispose) ?? -1;
			if (listeners && index >= 0) listeners.splice(index, 1);
		};
		this.extension.eventListenerDisposers ??= [];
		this.extension.eventListenerDisposers.push(dispose);
		return dispose;
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
		};
		this.extension.tools.set(tool.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(tool.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		this.extension.fileWriteFallbackHandlers.push(handler);
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		this.extension.fileDeleteFallbackHandlers.push(handler);
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	registerSetting(setting: ExtensionSetting): void {
		this.extension.settings.set(setting.key, setting);
	}

	registerMemoryBackendProvider(provider: Parameters<typeof registerMemoryProvider>[0]): () => void {
		const dispose = registerMemoryProvider(provider);
		this.extension.memoryBackendProviders.push(dispose);
		return dispose;
	}

	/**
	 * The extension's own credential slots, namespaced to it.
	 *
	 * The namespace is the extension's label, falling back to its derived name —
	 * never its path. A path would give the same extension a different set of
	 * slots depending on where it happens to be installed, so an account someone
	 * logged into would silently vanish after a move or a reinstall.
	 *
	 * Slots are stored as the id's `scope`, not its `name`. That is what the
	 * store's key format means by a two-part id: `plugin::scope` parses back as
	 * a scope, and `plugin::name` parses back as one too — so a slot written as
	 * a name would be read back under a field nothing here reads, and
	 * `list()` would come back empty while `get()` and `delete()` kept working.
	 *
	 * Filtering happens here rather than in the store, so an extension cannot
	 * enumerate another one's secrets by naming them.
	 */
	readonly credentials: ExtensionCredentialStore = {
		get: async (name: string) => {
			const stored = await getPluginCredentialManager().get({
				pluginId: await this.#credentialNamespace(),
				scope: name,
			});
			return stored ? toExtensionCredential(stored) : null;
		},
		set: async (name: string, credential: ExtensionCredential) => {
			await getPluginCredentialManager().set(
				{ pluginId: await this.#credentialNamespace(), scope: name },
				{
					value: credential.value,
					refreshToken: credential.refreshToken,
					expiresAt: credential.expiresAt,
					clientId: credential.clientId,
					clientSecret: credential.clientSecret,
					metadata: credential.metadata,
				},
			);
		},
		delete: async (name: string) =>
			getPluginCredentialManager().delete({ pluginId: await this.#credentialNamespace(), scope: name }),
		list: async () => {
			const ids = await getPluginCredentialManager().list({ pluginId: await this.#credentialNamespace() });
			return ids.map(id => id.scope).filter((scope): scope is string => typeof scope === "string");
		},
		health: async () => {
			const status = await getPluginCredentialManager().health();
			return { healthy: status.healthy, issues: status.issues.map(issue => ({ message: issue.message })) };
		},
	};

	/**
	 * Stable per-extension namespace for credential slots.
	 *
	 * The package name, read from the nearest `package.json` above the entry —
	 * never the path, and never `label`. A path would hand back an empty store
	 * after the extension is reinstalled somewhere else, and `label` is a
	 * display string a person (or `setLabel`) can change at will, which would
	 * silently orphan every secret the extension owns. The package name is the
	 * one identifier that travels with the code.
	 *
	 * Read once and cached: it is on the credential path, which a login flow
	 * calls several times.
	 */
	#credentialNamespacePromise: Promise<string> | null = null;
	#credentialNamespace(): Promise<string> {
		this.#credentialNamespacePromise ??= readPackageNameNear(this.extension.path).then(
			// A single-file extension with no manifest still needs a namespace
			// that is stable across restarts, and its directory name is.
			name => name ?? getExtensionNameFromPath(this.extension.path),
		);
		return this.#credentialNamespacePromise;
	}

	registerComponent(component: ExtensionComponent): void {
		// 槽位声明校验(注册进未声明 slot 抛错进 load 报告):
		// 未知槽名 → 抛错,扩展整体加载失败且 extension_status 可见 ——
		// 而不是静默注册、GUI 永不挂载。前缀命名空间保持开放
		// (panel.tab.<任意 id> 等永远合法),仅兜住拼写错误/未支持槽位。
		assertKnownComponentSlot(component.slot);
		this.extension.components.push(component);
	}

	registerRpc(method: string, handler: ExtensionRpcHandler): void {
		if (typeof method !== "string" || method.length === 0) {
			throw new TypeError("registerRpc: method must be a non-empty string");
		}
		if (typeof handler !== "function") {
			throw new TypeError(`registerRpc: handler for "${method}" must be a function`);
		}
		this.extension.rpcs.set(method, handler);
	}

	registerWebRoute(route: PluginWebRouteRequest): () => void {
		if (typeof route?.handler !== "function") {
			throw new TypeError("registerWebRoute: handler must be a function");
		}
		if (route.kind !== "exact" && route.kind !== "prefix") {
			throw new TypeError(`registerWebRoute: kind must be "exact" or "prefix", got ${String(route.kind)}`);
		}
		// The namespace is derived from THIS extension's identity, so a plugin
		// physically cannot name a path outside its own subtree. `scopeRoute`
		// rejects the traversal shapes; the namespace makes `/` mean "my root".
		const namespace = namespaceOf(this.extension.path);
		const scoped = scopeRoute(route, namespace);
		this.extension.webRoutes.push(scoped);
		return () => {
			const index = this.extension.webRoutes.indexOf(scoped);
			if (index >= 0) this.extension.webRoutes.splice(index, 1);
		};
	}

	registerSkill(skill: ExtensionSkillDeclaration): void {
		if (!skill || typeof skill.name !== "string" || skill.name.length === 0) {
			throw new TypeError("registerSkill: skill.name is required");
		}
		this.extension.skills.push(skill);
	}

	registerSubagent(def: SubagentDefinition): { name: string } {
		const agent = normalizeSubagentDefinition(def);
		this.extension.subagents.set(agent.name, agent);
		return { name: agent.name };
	}

	unregisterSubagent(name: string): boolean {
		return this.extension.subagents.delete(name);
	}

	registerMagicKeyword(keyword: ExtensionMagicKeyword): void {
		if (!keyword || typeof keyword.name !== "string" || keyword.name.length === 0) {
			throw new TypeError("registerMagicKeyword: keyword.name is required");
		}
		if (typeof keyword.notice !== "string" || keyword.notice.trim().length === 0) {
			throw new TypeError(`registerMagicKeyword: notice required for "${keyword.name}"`);
		}
		this.runtime.registerMagicKeyword(keyword, this.extension.path);
	}

	unregisterMagicKeyword(name: string): void {
		this.runtime.unregisterMagicKeyword(name, this.extension.path);
	}

	registerToolView(tool: string, options: { moduleUrl: string; label?: string }): void {
		if (typeof tool !== "string" || tool.length === 0) {
			throw new TypeError("registerToolView: tool name is required");
		}
		if (!options?.moduleUrl || typeof options.moduleUrl !== "string") {
			throw new TypeError(`registerToolView: moduleUrl required for tool "${tool}"`);
		}
		this.extension.toolViews.push({
			tool,
			moduleUrl: options.moduleUrl,
			...(options.label ? { label: options.label } : {}),
		});
	}

	registerWidget(widget: ExtensionWidget): void {
		if (!widget || typeof widget.type !== "string" || widget.type.length === 0) {
			throw new TypeError("registerWidget: widget.type is required");
		}
		if (typeof widget.label !== "string" || widget.label.trim().length === 0) {
			throw new TypeError(`registerWidget: label required for "${widget.type}"`);
		}
		if (typeof widget.moduleUrl !== "string" || widget.moduleUrl.length === 0) {
			throw new TypeError(`registerWidget: moduleUrl required for "${widget.type}"`);
		}
		if (typeof widget.defaults !== "function") {
			throw new TypeError(`registerWidget: defaults() required for "${widget.type}"`);
		}
		if (!Array.isArray(widget.fields)) {
			throw new TypeError(`registerWidget: fields must be an array for "${widget.type}"`);
		}
		this.extension.widgets.push({
			type: widget.type,
			label: widget.label,
			...(widget.description ? { description: widget.description } : {}),
			fields: widget.fields,
			defaults: widget.defaults,
			...(widget.tone ? { tone: widget.tone } : {}),
			moduleUrl: widget.moduleUrl,
		});
		rememberRegisteredWidget(widget);
	}

	registerPrompt(section: ExtensionPromptSection): void {
		this.extension.promptSections.push(section);
	}

	registerMode(mode: ExtensionModeDefinition): void {
		this.extension.modes.push(mode);
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}
	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		this.extension.composerShapes.set(id, definition);
	}
	registerNotificationChannel(
		channel: string,
		options?: { label?: string },
	): (message: ExtensionNotificationMessage) => void {
		if (typeof channel !== "string" || channel.length === 0) {
			throw new TypeError("registerNotificationChannel: channel must be a non-empty string");
		}
		const send = (message: ExtensionNotificationMessage) => {
			this.runtime.emitNotification?.(channel, message);
		};
		this.extension.notificationChannels.push({
			channel,
			...(options?.label ? { label: options.label } : {}),
			send,
		});
		return send;
	}

	registerService(name: string, service: ExtensionService): void {
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("registerService: name must be a non-empty string");
		}
		if (typeof service !== "object" || service === null) {
			throw new TypeError(`registerService: service for "${name}" must be an object`);
		}
		const start = typeof service.start === "function" ? service.start : undefined;
		const stop = typeof service.stop === "function" ? service.stop : undefined;
		this.extension.services.push({ name, ...(start ? { start } : {}), ...(stop ? { stop } : {}) });
	}

	registerThemeToken(key: string, value: string): void {
		if (typeof key !== "string" || key.length === 0) {
			throw new TypeError("registerThemeToken: key must be a non-empty string");
		}
		if (typeof value !== "string") {
			throw new TypeError(`registerThemeToken: value for "${key}" must be a string`);
		}
		this.extension.themeTokens.push({ key, value });
	}
	registerStatusBarSegment(id: string, options: { label: string; order?: number; renderKey?: string }): void {
		if (typeof id !== "string" || id.length === 0) {
			throw new TypeError("registerStatusBarSegment: id must be a non-empty string");
		}
		if (typeof options?.label !== "string" || options.label.length === 0) {
			throw new TypeError(`registerStatusBarSegment: label for "${id}" must be a non-empty string`);
		}
		this.extension.statusBarSegments.push({
			id,
			label: options.label,
			...(options.order !== undefined ? { order: options.order } : {}),
			...(options.renderKey !== undefined ? { renderKey: options.renderKey } : {}),
		});
	}

	registerScrollbarSkin(skin: ExtensionScrollbarSkin): void {
		if (!skin || typeof skin.id !== "string" || skin.id.length === 0) {
			throw new TypeError("registerScrollbarSkin: id is required");
		}
		if (typeof skin.displayName !== "string" || skin.displayName.trim().length === 0) {
			throw new TypeError(`registerScrollbarSkin: displayName required for "${skin.id}"`);
		}
		if (skin.base !== "gummy" && skin.base !== "pacman") {
			throw new TypeError(`registerScrollbarSkin: base must be "gummy" or "pacman" ("${skin.id}")`);
		}
		const color = (key: "accent" | "track" | "eaten"): string => {
			const value = skin.colors?.[key];
			if (typeof value !== "string" || value.length === 0) {
				throw new TypeError(`registerScrollbarSkin: colors.${key} required for "${skin.id}"`);
			}
			// Skin colours land in CSS custom properties: a value that can fetch
			// is a network/execution surface, not a colour.
			if (/url\s*\(|image[-\w]*\s*\(|expression\s*\(/i.test(value)) {
				throw new TypeError(`registerScrollbarSkin: colors.${key} may not fetch ("${skin.id}")`);
			}
			return value;
		};
		if (typeof skin.size !== "number" || !Number.isFinite(skin.size)) {
			throw new TypeError(`registerScrollbarSkin: numeric size required for "${skin.id}"`);
		}
		const pacGlyph = typeof skin.pacGlyph === "string" && skin.pacGlyph.startsWith("data:") ? skin.pacGlyph : null;
		this.extension.scrollbarSkins.push({
			id: skin.id,
			displayName: skin.displayName,
			base: skin.base,
			colors: { accent: color("accent"), track: color("track"), eaten: color("eaten") },
			size: Math.min(24, Math.max(6, Math.round(skin.size))),
			...(pacGlyph ? { pacGlyph } : {}),
		});
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		this.runtime.unregisterProvider(name, this.extension.path);
	}

	registerMediaProvider(config: MediaProviderConfig): void {
		this.extension.mediaProviders.push({ config, sourceId: this.extension.path });
		this.runtime.registerMediaProvider(config, this.extension.path);
	}

	unregisterMediaProvider(id: string): void {
		this.extension.mediaProviders = this.extension.mediaProviders.filter(entry => entry.config.id !== id);
		this.runtime.unregisterMediaProvider(id, this.extension.path);
	}

	registerDesignSystem(config: DesignSystemConfig): void {
		this.extension.designSystems.push({ config, sourceId: this.extension.path });
		this.runtime.registerDesignSystem(config, this.extension.path);
	}

	unregisterDesignSystem(id: string): void {
		this.extension.designSystems = this.extension.designSystems.filter(entry => entry.config.id !== id);
		this.runtime.unregisterDesignSystem(id, this.extension.path);
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		tools: new Map(),
		toolRegistrationListeners: new Set(),
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
		subagents: new Map(),
		toolViews: [],
		widgets: [],
		notificationChannels: [],
		services: [],
		memoryBackendProviders: [],
		eventListenerDisposers: [],
		themeTokens: [],
		mediaProviders: [],
		designSystems: [],
		statusBarSegments: [],
		scrollbarSkins: [],
	};
}

/**
 * Runs an extension factory with provider registration rollback on failure.
 * Restores the complete registration queue when the factory throws because an
 * extension may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
	config?: Record<string, unknown>,
): Promise<unknown> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];
	const mediaProviderCheckpoint = [...runtime.pendingMediaProviderRegistrations];
	const designSystemCheckpoint = [...runtime.pendingDesignSystemRegistrations];

	try {
		// The factory's return value is the object its `provide` names refer to
		// (Cordis `apply` contract); host-scope loading publishes it.
		return await factory(api, config);
	} catch (error) {
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		runtime.pendingMediaProviderRegistrations.splice(
			0,
			runtime.pendingMediaProviderRegistrations.length,
			...mediaProviderCheckpoint,
		);
		runtime.pendingDesignSystemRegistrations.splice(
			0,
			runtime.pendingDesignSystemRegistrations.length,
			...designSystemCheckpoint,
		);
		throw error;
	}
}

interface ImportedExtensionModule {
	factory: ExtensionFactory | null;
	resolvedPath: string;
	error: string | null;
}

/**
 * Import one extension entry.
 *
 * `fresh` decides module identity. A first load must take the process-wide
 * instance so the session, the `ext.call` compiler and any other consumer all
 * see ONE module object (each holding its own copy splits module-level state —
 * a plugin that captured the session context in one saw `null` through its
 * RPC). A reload must re-evaluate: Bun caches ESM by specifier and will not
 * re-read a cached module, so new bytes only take effect through a query-tagged
 * import. There is no third behaviour available, hence one option.
 */
async function importExtensionModule(
	extensionPath: string,
	cwd: string,
	options?: { fresh?: boolean },
): Promise<ImportedExtensionModule> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		// Bundled plugin packages load through a plain dynamic import. They ship
		// with the host — same repo, same version, replaced as a whole on
		// upgrade — so they never need the legacy source-graph snapshot (a
		// file-by-file walk of the package's ENTIRE import graph, which for a
		// package importing host modules means thousands of files read and
		// parsed per load) nor its per-session cache-bust. Their module identity
		// is the distribution itself.
		if (isBundledPluginPath(resolvedPath)) {
			const module = (await import(resolvedPath)) as LoadedExtensionModule;
			const factory = getExtensionFactory(module);
			if (typeof factory !== "function") {
				return {
					factory: null,
					resolvedPath,
					error: `Extension does not export a valid factory function: ${extensionPath}`,
				};
			}
			return { factory, resolvedPath, error: null };
		}
		const module = (await withHostGuard(() =>
			loadLegacyPiModule(resolvedPath, { fresh: options?.fresh === true }),
		)) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Run one extension factory inside its own Cordis fiber.
 *
 * dsh's plugin instance is a fiber; the extension record stays our bookkeeping
 * object, but every listener registered through `pi.on` belongs to this fiber,
 * so reload, unload and rollback dispose one scope instead of replaying a
 * second ownership ledger. The listener list stays for exact counts and for
 * loaders that run a factory without a fiber.
 */
export async function runFactoryInFiber(
	extension: Extension,
	runtime: IExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
	factory: ExtensionFactory,
	createApi: (ownContext: Context) => ExtensionAPI,
	config?: Record<string, unknown>,
	/** Tag the instance's context as part of one preset generation. */
	scopeTag?: object,
): Promise<unknown> {
	const bus = ensureExtensionEventBus(runtime) as unknown as Context;
	let published: unknown;
	const fiber = bus.inject({}, async scope => {
		const ownContext = scopeTag ? (scope as Context).extend({ [PRESET_SCOPE_TAG]: scopeTag }) : (scope as Context);
		const api = createApi(ownContext);
		published = await runExtensionFactory(factory, api, runtime, config);
	});
	// Errors from the factory reject the fiber; awaiting it keeps the load-time
	// error contract (`Failed to load extension: …`) unchanged. A failed load
	// still disposes the half-started fiber so it cannot linger in the registry.
	try {
		await fiber;
	} catch (error) {
		await fiber.dispose().catch(() => {});
		throw error;
	}
	extension.fiber = { dispose: () => fiber.dispose() };
	return published;
}

/** Whether an extension entry lives under the host's bundled plugin tree. */
function isBundledPluginPath(resolvedPath: string): boolean {
	const normalized = resolvedPath.replaceAll("\\", "/");
	return normalized.includes("/src/bundled-plugins/") || normalized.includes("/bundled-plugins/");
}

async function bindExtension(
	extensionPath: string,
	imported: ImportedExtensionModule,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	/** 收编第二刀：cordis 宿主级动态装载给 API 套效果账本壳的挂点——
	 *  默认恒等，会话装载路径不传，语义不变。 */
	wrapApi: (api: ExtensionAPI, extension: Extension) => ExtensionAPI = (api): ExtensionAPI => api,
): Promise<{ extension: Extension | null; error: string | null; code?: DynamicExtensionLoadErrorCode }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath);
		await withHostGuard(() =>
			runFactoryInFiber(extension, runtime, cwd, eventBus, factory, ownContext =>
				wrapApi(createConcreteExtensionAPI(extension, runtime, cwd, eventBus, ownContext), extension),
			),
		);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			extension: null,
			error: `Failed to load extension: ${message}`,
			// 结构化归因（宿主级 cordis 装载的碰撞守卫等）穿透字符串包装不丢失。
			...(err instanceof DynamicExtensionLoadError ? { code: err.code } : {}),
		};
	}
}

/**
 * 同源装配（收编第二刀）：import + bind 一条路径，供 cordis 宿主级动态
 * 装载复用——与会话装载同一 import 管线（loadLegacyPiModule 兼容层）、
 * 同一 API 工厂，仅 wrapApi 挂点不同。
 */
export async function importAndBindExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	wrapApi?: (api: ExtensionAPI, extension: Extension) => ExtensionAPI,
	options?: { fresh?: boolean },
): Promise<{ extension: Extension | null; error: string | null; code?: DynamicExtensionLoadErrorCode }> {
	const imported = await importExtensionModule(extensionPath, cwd, options);
	return bindExtension(extensionPath, imported, cwd, eventBus, runtime, wrapApi);
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
	/** Optional sink for the factory's return value (the `provide` payload). */
	capture?: { published?: unknown },
	/** Coerced `musepi.config` values, handed to `apply(ctx, config)`. */
	config?: Record<string, unknown>,
): Promise<Extension> {
	const extension = createExtension(name, name);
	const published = await runFactoryInFiber(
		extension,
		runtime,
		cwd,
		eventBus,
		factory,
		ownContext => createConcreteExtensionAPI(extension, runtime, cwd, eventBus, ownContext),
		config,
	);
	if (capture) capture.published = published;
	return extension;
}

/** 已知组件槽位(单一权威 @musepi/collab-proto/extension-slots,与 GUI 侧共用)。
 *  daemon 是校验权威,GUI 按同样规则挂载。 */
const KNOWN_SLOTS = new Set<string>(EXTENSION_SLOT_NAMES);

/** 校验组件槽位是否在已知命名空间内;未知槽名抛错(fail-loud)。
 *  抛错在 factory 执行路径 → bindExtension 捕获 → 进 load errors,
 *  extension_status 可见,与未声明 slot 静默丢失形成对比。 */
export function assertKnownComponentSlot(slot: string): void {
	if (KNOWN_SLOTS.has(slot)) return;
	if (EXTENSION_SLOT_DECLARATION.prefixes.some(prefix => slot.startsWith(prefix))) return;
	throw new Error(
		`unknown component slot "${slot}": known slots are ${[...KNOWN_SLOTS].sort().join(", ")} and the namespaces ${EXTENSION_SLOT_DECLARATION.prefixes.join(", ")}`,
	);
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	options?: { fresh?: boolean; promptHost?: PromptHostSurface; runtime?: IExtensionRuntime },
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = options?.runtime ?? new ExtensionRuntime();
	// The session prompt host travels on the runtime so every factory binding
	// (including cordis mounts reusing this runtime) sees the same host.
	runtime.promptHost = options?.promptHost;

	// 回退保护②：兼容性预检先于任何 import（dsh「只有兼容性冲突拒绝一行」
	// parity——清单缺失/不可读不是兼容性意见,交给下方 import 诊断）。
	// 拒绝的路径不进 imported 清单,errors 带结构化诊断;豁免命中放行但
	// 打警告日志（如实标注）。豁免清单读 agentDir/compatibility.json,
	// fail-safe：坏文件 = 零豁免 + 日志,永不阻塞会话装配。
	let admissible = paths;
	if (paths.length > 0) {
		const { exemptions, warnings } = readCompatibilityExemptions(resolveCompatibilityPath());
		for (const warning of warnings) logger.warn(warning);
		admissible = [];
		for (const extPath of paths) {
			// A plugin whose manifest condition does not hold is skipped, not
			// errored: the condition is how it says "not in this configuration",
			// which is an expected state rather than a failure to report. Both
			// gates are checked before any import, so a gated-out plugin never
			// runs code.
			if (!(await enablementAllowsPath(extPath))) continue;
			const gate = await compatibilityGateForExtensionPath(extPath, exemptions);
			if (gate && gate.status !== "exempted") {
				errors.push({ path: extPath, error: pluginCompatibilityWarning(gate) });
				continue;
			}
			if (gate) logger.warn("compatibility exemption active, loading anyway", { path: extPath });
			admissible.push(extPath);
		}
	}

	const imported = await Promise.all(admissible.map(extPath => importExtensionModule(extPath, cwd, options)));

	for (let i = 0; i < admissible.length; i++) {
		const extPath = admissible[i]!;
		const { extension, error } = await bindExtension(extPath, imported[i]!, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as {
			musepi?: ExtensionManifest;
			omp?: ExtensionManifest;
			pi?: ExtensionManifest;
		};
		// musepi 为权威清单字段；omp/pi 是旧上游兼容遗留（继续可读）。
		const manifest = pkg.musepi ?? pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}
async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected paths via the SDK's
 * `preloadedExtensionPaths` option, then call {@link loadExtensions} themselves
 * so each session rebuilds Extension instances bound to its OWN
 * `ExtensionAPI` (cwd, eventBus, runtime). Forwarding the parent's
 * `LoadExtensionsResult` directly would reuse handlers/tools/commands that
 * closed over the parent's `cwd` and event bus.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	// MusePi package enablement uses only the exact bare package name.
	const isDisabledName = (name: string): boolean => isPluginDisabled(disabled, name);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi
		// + musepi 自有扩展). Scope the load to the two providers whose
		// entries sessions actually consume: the native provider
		// (.omp/.pi extension-module items) and the musepi-extensions
		// provider (~/.musepi/agent/extensions — MusePi 自有扩展,modes v2
		// 白名单/扩展中心的同一数据源)。claude/codex/gemini/opencode 的
		// 外部扩展目录仍被跳过(见 #4198)。
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native", "musepi-extensions"],
		});
		for (const ext of discovered.items) {
			// Through `addPaths`, not `addPath`: the capability does not filter by
			// the user's disable list, so adding directly here started a disabled
			// extension anyway (the row showed disabled while it kept loading).
			addPaths([ext.path]);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
