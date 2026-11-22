/**
 * Read-only runtime API directory for the Cordis creation tools.
 *
 * A dynamic plugin's host half only sees the sandbox façade, while a Track A
 * package entry receives the host `ExtensionAPI`. Both surfaces are fixed and
 * small enough to describe exactly, so the model can resolve an API before it
 * writes code instead of guessing. Nothing here invokes a method: `query`
 * answers a signature or a directory listing, never business behaviour.
 */
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import { BUILTIN_TOOL_NAMES, PLUGIN_TOOL_NAMES } from "../tools/builtin-names";

export type InspectPlatform = "host";

export interface InspectMethod {
	name: string;
	/** One line: what the method does and what it returns. */
	description: string;
	/** JSON-shaped arguments, when the method takes any. */
	input?: Record<string, string>;
}

export interface InspectProvider {
	platform: InspectPlatform;
	provider: string;
	summary: string;
	methods: InspectMethod[];
}

const RUNTIME_PROVIDER: InspectProvider = {
	platform: "host",
	provider: "runtime",
	summary: "The `cordis_*` hostCode sandbox. Plain JavaScript only; no import/require/TypeScript/JSX.",
	methods: [
		{
			name: "defineTool",
			description:
				"Register one model tool. `parameters` accepts scalar fields only; `run` returns a string or Promise<string>.",
			input: {
				name: "string — tool name (registered as extdyn__<name>)",
				description: "string? — one line shown in the tool catalog",
				parameters: '{ [key]: "string" | "number" | "boolean" }?',
				run: "(params) => string | Promise<string>",
			},
		},
		{
			name: "setTimeout",
			description: "Schedule a callback; the handle goes to clearTimeout.",
			input: { handler: "() => void", ms: "number" },
		},
		{ name: "clearTimeout", description: "Cancel a sandbox timer.", input: { handle: "unknown" } },
		{ name: "console", description: "log / info / warn / error / debug, forwarded to the daemon log." },
		{ name: "pluginId", description: "The current plugin id (a string), for logs and tool naming." },
	],
};

const PACKAGE_PROVIDER: InspectProvider = {
	platform: "host",
	provider: "package",
	summary: "The Track A plugin entry (`apply(ctx)`): capabilities a persisted plugin registers.",
	methods: [
		{ name: "ctx.tools.register", description: "Register a model tool from the plugin package." },
		{
			name: "ctx.slots.register",
			description: "Register a UI component into a declared slot.",
			input: {
				slot: "string — one of the slots provider's names",
				moduleUrl: "string — relative module",
				label: "string?",
			},
		},
		{ name: "ctx.commands.register", description: "Register a slash command and its handler." },
		{ name: "ctx.settings.register", description: "Declare this plugin's settings namespace and fields." },
		{ name: "ctx.prompts.register", description: "Contribute a prompt section." },
		{ name: "ctx.rpc.register", description: "Register a daemon JSON-RPC method owned by this plugin." },
		{ name: "ctx.memory.registerBackendProvider", description: "Register or replace a memory backend provider." },
		{
			name: "ctx.on",
			description: "Listen to a host event; returns a disposer.",
			input: { event: "string", handler: "(payload) => void" },
		},
		{
			name: "ctx.effect",
			description: "Register a cleanup function; runs in reverse order on unload.",
			input: { dispose: "() => void", label: "string?" },
		},
		{ name: "ctx.hmr.onChange", description: "React to HMR file changes for this plugin graph." },
	],
};

const SLOTS_PROVIDER: InspectProvider = {
	platform: "host",
	provider: "slots",
	summary: "Declared extension slots. `list` returns every seat and its capacity.",
	methods: [
		{ name: "list", description: "Every exact slot name with kind (single | list | hoc), plus prefix families." },
	],
};

const TOOLS_PROVIDER: InspectProvider = {
	platform: "host",
	provider: "tools",
	summary: "Built-in tool vocabulary a plugin can delegate to or wrap.",
	methods: [{ name: "list", description: "Built-in tool names, including first-party plugin tools." }],
};

/** Every provider the model may query. */
export const INSPECT_PROVIDERS: readonly InspectProvider[] = [
	RUNTIME_PROVIDER,
	PACKAGE_PROVIDER,
	SLOTS_PROVIDER,
	TOOLS_PROVIDER,
];

/** The provider directory (platform, provider, methods) without contracts. */
export function inspectProviderDirectory(): Array<{
	platform: InspectPlatform;
	provider: string;
	summary: string;
	methods: string[];
}> {
	return INSPECT_PROVIDERS.map(provider => ({
		platform: provider.platform,
		provider: provider.provider,
		summary: provider.summary,
		methods: provider.methods.map(method => method.name),
	}));
}

export interface InspectQuery {
	platform?: string;
	provider: string;
	method: string;
}

/** Resolve one exact query; throws with the closest reason when it does not exist. */
export function inspectQuery(query: InspectQuery): Record<string, unknown> {
	const provider = INSPECT_PROVIDERS.find(
		entry => entry.provider === query.provider && (query.platform === undefined || entry.platform === query.platform),
	);
	if (provider === undefined) {
		return {
			ok: false,
			error: `unknown provider: ${query.provider}`,
			providers: inspectProviderDirectory().map(entry => entry.provider),
		};
	}
	if (provider.provider === "slots" && query.method === "list") {
		return {
			ok: true,
			platform: provider.platform,
			provider: provider.provider,
			method: query.method,
			data: {
				exact: Object.entries(EXTENSION_SLOT_DECLARATION.exact).map(([name, declaration]) => ({
					name,
					kind: declaration.kind,
				})),
				prefixes: [...EXTENSION_SLOT_DECLARATION.prefixes],
			},
		};
	}
	if (provider.provider === "tools" && query.method === "list") {
		return {
			ok: true,
			platform: provider.platform,
			provider: provider.provider,
			method: query.method,
			data: { tools: [...BUILTIN_TOOL_NAMES, ...PLUGIN_TOOL_NAMES] },
		};
	}
	const method = provider.methods.find(entry => entry.name === query.method);
	if (method === undefined) {
		return {
			ok: false,
			error: `unknown method: ${query.provider}.${query.method}`,
			methods: provider.methods.map(entry => entry.name),
		};
	}
	return {
		ok: true,
		platform: provider.platform,
		provider: provider.provider,
		method: method.name,
		data: { description: method.description, input: method.input ?? null },
	};
}
