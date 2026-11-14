/**
 * ModelsService — the model catalog and custom-provider configuration surface.
 *
 * Seam:
 * - Input: `models.*` routes, the shared model registry (`ensureRegistry`), the
 *   live session whose own catalog the picker mirrors, and `models.yml` for
 *   custom providers.
 * - Output: picker rows (`modelDetailRow`), the provider-grouped catalog, and
 *   add/remove acks after the registry reloads.
 * - Lifecycle: stateless. `models.yml` is the durable store; this service
 *   writes it and asks the registry to refresh.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDER_REGISTRY } from "@musepi/pi-ai/registry";
import { resolveModelCapabilities } from "@musepi/pi-catalog/identity";
import { getSupportedEfforts } from "@musepi/pi-catalog/model-thinking";
import YAML from "yaml";
import { resolveProviderModelReference } from "../../config/model-resolver";
import { ModelsConfigFile } from "../../config/models-config";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

export class ModelsService implements DaemonService {
	readonly key = "models";
	readonly routes = {
		"models.list": "list",
		"models.listCustom": "listCustom",
		"models.discover": "discover",
		"models.listAvailable": "listAvailable",
		"models.refreshRuntime": "refreshRuntime",
		"models.catalog": "catalog",
		"models.detail": "detail",
		"models.add": "add",
		"models.remove": "remove",
	} as const;

	constructor(
		private readonly host: Pick<DaemonSessionHost, "get" | "ensureRegistry"> & {
			broadcastModelsChanged(): void;
		},
	) {}

	async list(params: unknown): Promise<unknown> {
		// Available models for a live session (getAvailableModels); a
		// history session has no live AgentSession, so fall back to the
		// registry catalog (models.listAvailable parity) — the GUI model
		// selector must not go empty when opening old sessions.
		const p = (params ?? {}) as { sessionId: string };
		const live = this.host.get(p.sessionId);
		const registry = live ? undefined : await this.host.ensureRegistry();
		const models = live ? live.agentSession.getAvailableModels() : (registry?.getAvailable() ?? []);
		return models.map(model =>
			modelDetailRow(model, (registry ?? live?.agentSession.modelRegistry)?.getProviderLabel(model.provider)),
		);
	}

	async listCustom(params: unknown): Promise<unknown> {
		// Read the current custom-provider block from models.yml (for the
		// settings dialog's custom provider list).
		const filePath = ModelsConfigFile.path();
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			return YAML.parse(raw) as { providers?: Record<string, unknown> };
		} catch {
			return { providers: {} };
		}
	}

	async discover(params: unknown): Promise<unknown> {
		// Interrogate one DRAFT endpoint for the models it advertises —
		// the GUI's "fetch available models" button. Nothing is stored:
		// the request carries the endpoint, protocol, and one-shot
		// credential the form currently shows, and the reply is
		// candidates a surface may offer for adoption. Failures are the
		// user's next move (a wrong endpoint, a rejected key, a protocol
		// with no readable listing all end at hand-entry), so they
		// surface as the RPC error message instead of a stored state.
		const p = (params ?? {}) as {
			baseUrl?: string;
			api?: string;
			apiKey?: string;
			provider?: string;
		};
		if (!p.baseUrl || p.baseUrl.length === 0) {
			throw new Error("baseUrl is required to fetch models");
		}
		const { discoverDraftModels } = await import("../../config/model-discovery");
		const models = await discoverDraftModels({
			provider: p.provider ?? "custom",
			api: p.api ?? "openai-completions",
			baseUrl: p.baseUrl,
			...(p.apiKey && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
		});
		return { models };
	}

	async listAvailable(params: unknown): Promise<unknown> {
		// Session-less model catalog (welcome-composer preselect): the
		// shared registry lists what's available without a live session;
		// the chosen id is applied via session.setModel once the session
		// exists.
		const registry = await this.host.ensureRegistry();
		if (!registry) return [];
		return registry.getAvailable().map(model => modelDetailRow(model, registry.getProviderLabel(model.provider)));
	}

	async refreshRuntime(params: unknown): Promise<unknown> {
		// Force dynamic-provider catalog discovery to re-run ("online"
		// strategy), busting the per-provider TTL cache — the button
		// behind an empty extension-provided model list whose first
		// discovery failed or ran before credentials landed.
		const registry = await this.host.ensureRegistry();
		if (!registry) return { refreshed: false };
		await registry.refreshRuntimeProviders("online");
		return { refreshed: true };
	}

	async catalog(params: unknown): Promise<unknown> {
		// Full bundled catalog grouped by provider (TUI model-hub
		// sidebar parity): every known provider plus its static models,
		// with per-provider availability (auth configured or keyless).
		// The GUI role-config rail renders registered vs unregistered
		// providers from this one call — no per-session scan involved.
		const registry = await this.host.ensureRegistry();
		if (!registry) return [];
		const all = registry.getAll();
		const available = new Set(registry.getAvailable().map(model => model.provider));
		const registryNames = new Map(PROVIDER_REGISTRY.map(def => [def.id, def.name]));
		// Extension-registered providers carry their own display label
		// (`registerProvider({ label })`); it wins over the builtin table,
		// which has no entry for them anyway.
		const labelOf = (provider: string): string =>
			registry.getProviderLabel(provider) ?? registryNames.get(provider) ?? provider;
		const byProvider = new Map<
			string,
			{
				provider: string;
				name: string;
				available: boolean;
				models: {
					id: string;
					name: string;
					reasoning: boolean;
					text: boolean;
					vision: boolean;
					video: boolean;
					imageGen: boolean;
					videoGen: boolean;
				}[];
			}
		>();
		for (const model of all) {
			let group = byProvider.get(model.provider);
			if (!group) {
				group = {
					provider: model.provider,
					name: labelOf(model.provider),
					available: available.has(model.provider),
					models: [],
				};
				byProvider.set(model.provider, group);
			}
			// Same capability mapping the model picker uses (modelDetailRow),
			// so this pane can render the identical icon set per row.
			const capabilities = resolveModelCapabilities(model.id, model.input);
			group.models.push({
				id: model.id,
				name: model.name ?? model.id,
				reasoning: model.reasoning === true,
				text: capabilities.text,
				vision: capabilities.image,
				video: capabilities.video,
				imageGen: capabilities.imageGen,
				videoGen: capabilities.videoGen,
			});
		}
		return [...byProvider.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(group => ({ ...group, modelCount: group.models.length }));
	}

	async detail(params: unknown): Promise<unknown> {
		// One model's detail row (cost/context/efforts) by id, without a
		// live session — the welcome composer's thinking selector reads
		// the current model's ladder from here.
		const p = (params ?? {}) as { id: string };
		if (!p.id) throw new Error("model id required");
		const registry = await this.host.ensureRegistry();
		if (!registry) return null;
		const available = registry.getAvailable();
		// Accept both bare ids ("deepseek-v4-flash") and provider-qualified
		// selectors ("opencode-go/deepseek-v4-flash" — the modelRoles
		// default format the welcome composer preselects from). The old
		// exact-id match never resolved the prefixed form, so the empty
		// state collapsed the thinking ladder to off/auto while the
		// session selector (session.thinkingInfo) showed the real rungs.
		const slash = p.id.indexOf("/");
		const model =
			slash > 0
				? (resolveProviderModelReference(p.id.slice(0, slash), p.id.slice(slash + 1), available) ??
					available.find(m => m.id === p.id))
				: available.find(m => m.id === p.id);
		return model ? modelDetailRow(model, registry.getProviderLabel(model.provider)) : null;
	}

	async add(params: unknown): Promise<unknown> {
		// Append an OpenAI-compatible custom provider to models.yml
		// (the same config the TUI `/login` + custom-model docs target),
		// then reload the registry so the model is selectable at once.
		//
		// Editing an existing provider reuses this RPC: models.yml rows
		// are merged by provider name, so passing the same name with
		// updated per-model capability fields (input/contextWindow/
		// maxTokens) rewrites those rows in place. The GUI edit dialog
		// round-trips models.listCustom → form → models.add.
		const p = (params ?? {}) as {
			provider: {
				name: string;
				baseUrl?: string;
				apiKey?: string;
				api?: string;
				models: {
					id: string;
					name?: string;
					api?: string | null;
					supportsTools?: boolean | null;
					compactionModel?: string;
					input?: string[] | null;
					contextWindow?: number | null;
					maxTokens?: number | null;
				}[];
			};
		};
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.provider?.name || !Array.isArray(p.provider.models) || p.provider.models.length === 0) {
			throw new Error("provider.name and provider.models[] are required");
		}
		const filePath = ModelsConfigFile.path();
		let config: { providers?: Record<string, unknown> } = {};
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			config = YAML.parse(raw) as { providers?: Record<string, unknown> };
		} catch {
			// no file yet — start fresh
		}
		const providers = config.providers ?? {};
		const entry: Record<string, unknown> = {
			...(providers[p.provider.name] as Record<string, unknown> | undefined),
		};
		if (p.provider.baseUrl) entry.baseUrl = p.provider.baseUrl;
		if (p.provider.apiKey) entry.apiKey = p.provider.apiKey;
		const api = p.provider.api ?? "openai-completions";
		entry.api = api;
		// Merge model rows by id: new ids are appended, existing ids get
		// their editable capability fields (input/contextWindow/maxTokens)
		// and name overwritten from the payload. An explicit `null`
		// capability removes the override (restore-to-auto: the model
		// falls back to bundled / models.dev / id-inferred capabilities);
		// an absent field keeps the stored value, so a zoom-level-only
		// edit does not blank other fields.
		const existing = Array.isArray(entry.models) ? (entry.models as Record<string, unknown>[]) : [];
		const byId = new Map(existing.map(m => [m.id as string, m]));
		for (const m of p.provider.models) {
			const row: Record<string, unknown> = { ...(byId.get(m.id) ?? {}), id: m.id };
			if (m.name) row.name = m.name;
			if (m.api === null) delete row.api;
			else if (m.api) row.api = m.api;
			if (m.supportsTools === null) delete row.supportsTools;
			else if (m.supportsTools !== undefined) row.supportsTools = m.supportsTools;
			if (m.compactionModel) row.compactionModel = m.compactionModel;
			if (m.input === null) delete row.input;
			else if (Array.isArray(m.input) && m.input.length > 0) row.input = m.input;
			if (m.contextWindow === null) delete row.contextWindow;
			else if (m.contextWindow !== undefined && m.contextWindow !== null) row.contextWindow = m.contextWindow;
			if (m.maxTokens === null) delete row.maxTokens;
			else if (m.maxTokens !== undefined && m.maxTokens !== null) row.maxTokens = m.maxTokens;
			byId.set(m.id, row);
		}
		entry.models = [...byId.values()];
		providers[p.provider.name] = entry;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, YAML.stringify({ providers }, null, 2));
		// mtime changed → registry reloads the custom models on refresh().
		await registry.refresh();
		this.host.broadcastModelsChanged();
		return { ok: true };
	}

	async remove(params: unknown): Promise<unknown> {
		// Remove a provider (or one model within it) from models.yml.
		const p = (params ?? {}) as { providerName: string; modelId?: string };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerName) throw new Error("providerName required");
		const filePath = ModelsConfigFile.path();
		let config: { providers?: Record<string, unknown> } = {};
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			config = YAML.parse(raw) as { providers?: Record<string, unknown> };
		} catch {
			return { ok: true }; // nothing to remove
		}
		const providers = config.providers ?? {};
		if (!providers[p.providerName]) return { ok: true };
		if (p.modelId) {
			const entry = providers[p.providerName] as { models?: { id: string }[] };
			if (Array.isArray(entry.models)) {
				entry.models = entry.models.filter(m => m.id !== p.modelId);
			}
		} else {
			delete providers[p.providerName];
		}
		fs.writeFileSync(filePath, YAML.stringify({ providers }, null, 2));
		await registry.refresh();
		this.host.broadcastModelsChanged();
		return { ok: true };
	}
}

/**
 * Wire-safe model detail row (TUI model-browser parity): identity plus the
 * detail lines the browser shows — context window, output budget, per-M
 * cost, reasoning flag, vision support, and the thinking efforts the model
 * actually exposes (drives the GUI thinking selector's exact ladder).
 *
 * `providerLabel` is the DISPLAY name for the provider section header; `provider`
 * stays the identity the picker keys on. They differ for extension-registered
 * providers, whose registration id is a namespaced identifier.
 */
function modelDetailRow(
	model: {
		id: string;
		name?: string;
		provider?: string;
		contextWindow?: number | null;
		maxTokens?: number | null;
		cost?: { input?: number; output?: number };
		reasoning?: boolean;
		input?: string[];
	},
	providerLabel?: string,
): {
	id: string;
	name: string;
	provider: string;
	providerLabel: string;
	contextWindow: number | null;
	maxTokens: number | null;
	costInput: number;
	costOutput: number;
	reasoning: boolean;
	text: boolean;
	vision: boolean;
	video: boolean;
	imageGen: boolean;
	videoGen: boolean;
	efforts: string[];
} {
	const capabilities = resolveModelCapabilities(model.id, model.input);
	const provider = model.provider ?? "";
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider,
		// The picker falls back to the id when the label is empty, so an
		// extension that declares none keeps the previous behavior.
		providerLabel: providerLabel ?? provider,
		contextWindow: model.contextWindow ?? null,
		maxTokens: model.maxTokens ?? null,
		costInput: model.cost?.input ?? 0,
		costOutput: model.cost?.output ?? 0,
		reasoning: model.reasoning === true,
		text: capabilities.text,
		vision: capabilities.image,
		video: capabilities.video,
		imageGen: capabilities.imageGen,
		videoGen: capabilities.videoGen,
		efforts: getSupportedEfforts(model as never).map(e => String(e)),
	};
}
