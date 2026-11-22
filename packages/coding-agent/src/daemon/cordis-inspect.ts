/**
 * Read-only runtime API registry for the Cordis creation tools.
 *
 * Providers register methods that answer contracts or live read-only facts.
 * `register` is the injection seam: host services and plugin packages may add
 * their own provider; the built-ins below cover the sandbox façade, the Track A
 * package entry, declared slots and the tool vocabulary. A method marked
 * `query` is executed on demand against current state; a method without one is
 * a static signature. Nothing here invokes business behaviour.
 */
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import { BUILTIN_TOOL_NAMES, PLUGIN_TOOL_NAMES } from "../tools/builtin-names";

export type InspectPlatform = "host" | "client";

/** Facts the caller can supply to a query (session-scoped, not process-wide). */
export interface InspectLiveContext {
	/** Wire names of the session's registered extension/dynamic tools. */
	toolNames?: readonly string[];
}

export interface InspectMethodRegistration {
	/** One line: what the method does and what it returns. */
	description: string;
	/** JSON-shaped arguments, when the method takes any. */
	input?: Record<string, string>;
	/** Read-only query; omit for a pure signature. */
	query?: (input: Record<string, unknown> | undefined, live: InspectLiveContext) => unknown | Promise<unknown>;
}

export interface InspectProviderRegistration {
	platform: InspectPlatform;
	provider: string;
	summary: string;
	methods: Record<string, InspectMethodRegistration>;
}

export interface InspectQuery {
	platform?: string;
	provider: string;
	method: string;
	input?: Record<string, unknown>;
}

/**
 * Provider registry: one map keyed by `${platform}:${provider}`. Registering an
 * existing key replaces it (single semantics), and the returned disposer
 * restores the previous registration.
 */
export class CordisInspectRegistry {
	readonly #providers = new Map<string, InspectProviderRegistration>();

	register(provider: InspectProviderRegistration): () => void {
		const key = `${provider.platform}:${provider.provider}`;
		const previous = this.#providers.get(key);
		this.#providers.set(key, provider);
		return () => {
			if (previous === undefined) this.#providers.delete(key);
			else this.#providers.set(key, previous);
		};
	}

	list(platform?: string): Array<{ platform: string; provider: string; summary: string; methods: string[] }> {
		return [...this.#providers.values()]
			.filter(provider => platform === undefined || provider.platform === platform)
			.map(provider => ({
				platform: provider.platform,
				provider: provider.provider,
				summary: provider.summary,
				methods: Object.keys(provider.methods),
			}));
	}

	async query(query: InspectQuery, live: InspectLiveContext = {}): Promise<Record<string, unknown>> {
		const provider = [...this.#providers.values()].find(
			entry =>
				entry.provider === query.provider && (query.platform === undefined || entry.platform === query.platform),
		);
		if (provider === undefined) {
			return {
				ok: false,
				error: `unknown provider: ${query.provider}`,
				providers: this.list().map(entry => entry.provider),
			};
		}
		const method = provider.methods[query.method];
		if (method === undefined) {
			return {
				ok: false,
				error: `unknown method: ${provider.provider}.${query.method}`,
				methods: Object.keys(provider.methods),
			};
		}
		const base = { ok: true, platform: provider.platform, provider: provider.provider, method: query.method };
		if (method.query === undefined) {
			return { ...base, data: { description: method.description, input: method.input ?? null } };
		}
		return { ...base, data: await method.query(query.input, live) };
	}
}

/** Host-wide registry: daemon built-ins register here; plugins may add providers. */
export const cordisInspectRegistry = new CordisInspectRegistry();

/** Register a provider on the host-wide registry. */
export function registerInspectProvider(provider: InspectProviderRegistration): () => void {
	return cordisInspectRegistry.register(provider);
}

cordisInspectRegistry.register({
	platform: "host",
	provider: "runtime",
	summary: "The `cordis_*` hostCode sandbox. Plain JavaScript only; no import/require/TypeScript/JSX.",
	methods: {
		defineTool: {
			description:
				"Register one model tool. `parameters` accepts scalar fields only; `run` returns a string or Promise<string>.",
			input: {
				name: "string — tool name (registered as extdyn__<name>)",
				description: "string? — one line shown in the tool catalog",
				parameters: '{ [key]: "string" | "number" | "boolean" }?',
				run: "(params) => string | Promise<string>",
			},
		},
		setTimeout: {
			description: "Schedule a callback; the handle goes to clearTimeout.",
			input: { handler: "() => void", ms: "number" },
		},
		clearTimeout: { description: "Cancel a sandbox timer.", input: { handle: "unknown" } },
		console: { description: "log / info / warn / error / debug, forwarded to the daemon log." },
		pluginId: { description: "The current plugin id (a string), for logs and tool naming." },
	},
});

cordisInspectRegistry.register({
	platform: "host",
	provider: "package",
	summary: "The Track A plugin entry (`apply(ctx)`): capabilities a persisted plugin registers.",
	methods: {
		"ctx.tools.register": { description: "Register a model tool from the plugin package." },
		"ctx.slots.register": {
			description: "Register a UI component into a declared slot.",
			input: {
				slot: "string — one of the slots provider's names",
				moduleUrl: "string — relative module",
				label: "string?",
			},
		},
		"ctx.commands.register": { description: "Register a slash command and its handler." },
		"ctx.settings.register": { description: "Declare this plugin's settings namespace and fields." },
		"ctx.prompts.register": { description: "Contribute a prompt section." },
		"ctx.rpc.register": { description: "Register a daemon JSON-RPC method owned by this plugin." },
		"ctx.memory.registerBackendProvider": { description: "Register or replace a memory backend provider." },
		"ctx.on": {
			description: "Listen to a host event; returns a disposer.",
			input: { event: "string", handler: "(payload) => void" },
		},
		"ctx.effect": {
			description: "Register a cleanup function; runs in reverse order on unload.",
			input: { dispose: "() => void", label: "string?" },
		},
		"ctx.hmr.onChange": { description: "React to HMR file changes for this plugin graph." },
	},
});

cordisInspectRegistry.register({
	platform: "host",
	provider: "slots",
	summary: "Declared extension slots. `list` returns every seat and its capacity.",
	methods: {
		list: {
			description: "Every exact slot name with kind (single | list | hoc), plus prefix families.",
			query: () => ({
				exact: Object.entries(EXTENSION_SLOT_DECLARATION.exact).map(([name, declaration]) => ({
					name,
					kind: declaration.kind,
				})),
				prefixes: [...EXTENSION_SLOT_DECLARATION.prefixes],
			}),
		},
	},
});

cordisInspectRegistry.register({
	platform: "host",
	provider: "tools",
	summary: "Built-in tool vocabulary plus the session's registered extension/dynamic tools.",
	methods: {
		list: {
			description: "Current tool names: built-ins, first-party plugin tools, and the session's registered tools.",
			query: (_input, live) => ({
				tools: [...new Set([...BUILTIN_TOOL_NAMES, ...PLUGIN_TOOL_NAMES, ...(live.toolNames ?? [])])],
			}),
		},
	},
});

/** The provider directory (platform, provider, methods) without contracts. */
export function inspectProviderDirectory(platform?: string): ReturnType<CordisInspectRegistry["list"]> {
	return cordisInspectRegistry.list(platform);
}

/** Resolve one exact query against the host registry. */
export function inspectQuery(query: InspectQuery, live: InspectLiveContext = {}): Promise<Record<string, unknown>> {
	return cordisInspectRegistry.query(query, live);
}
