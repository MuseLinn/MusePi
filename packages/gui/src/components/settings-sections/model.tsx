import { type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { usePrompt } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { ChromaGroup } from "../ChromaGroup";
import { DialogFrame } from "../DialogFrame";
import { FadeScroll } from "../FadeScroll";
import { GuiSelect } from "../GuiSelect";
import { HeightMorph } from "../HeightMorph";
import { ModelSelector } from "../ModelSelector";
import { Pop } from "../Pop";
import { SpotlightCard } from "../SpotlightCard";
import { SchemaTabSection } from "./schema";

/**
 * ZCode-parity appearance settings, sectioned like the reference: 本地化
 * (language / time format / week start), then 界面设置 (theme + interface
 * type), 代码设置 (light/dark code themes, line numbers, long-line wrap, code
 * sizes), 代码预览 (live light/dark preview cards with a "currently active"
 * tag), then the effects toggles. All prefs persist to localStorage and
 * apply their CSS variable on <html> immediately.
 */
interface ProviderInfo {
	id: string;
	name: string;
	available: boolean;
	storeCredentialsAs?: string;
	loggedIn: boolean;
}

/** Wire shape of one API-key provider row (daemon providers.list → api). */
interface ApiProviderInfo {
	id: string;
	name: string;
	modelCount: number;
	models: string[];
	configured: boolean;
}

interface CustomProvider {
	name: string;
	models: { id: string; name?: string; input?: string[]; contextWindow?: number; maxTokens?: number }[];
}

/** Wire shape of one models.catalog row (TUI model-hub sidebar parity):
 *  every known provider + its static models + auth availability. */
interface CatalogProvider {
	provider: string;
	name: string;
	available: boolean;
	modelCount: number;
	models: { id: string; name: string }[];
}

/** Cards per provider section before the "show all" expand (bitfun parity). */
const PROVIDER_COLLAPSE_LIMIT = 8;

/** Built-in role display tags (TUI config/model-roles MODEL_ROLES parity). */
const BUILTIN_ROLE_TAGS: Record<string, string> = {
	default: "DEFAULT",
	smol: "SMOL",
	slow: "SLOW",
	vision: "VISION",
	plan: "PLAN",
	designer: "DESIGNER",
	commit: "COMMIT",
	tiny: "TINY",
	task: "TASK",
	advisor: "ADVISOR",
};

/** Thinking levels storable as a role-selector suffix (TUI
 * formatModelSelectorValue parity: `provider/model:id:level`). */
const ROLE_THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Split `provider/model:id:level` into the bare selector + thinking level
 * (or null when no known level suffix is present). Mirrors the daemon's
 * splitThinkingSuffix whitelist (off/minimal..max; `inherit` is accepted
 * for round-tripping but never persisted — joinRoleValue strips it). */
function splitRoleValue(value: string): { model: string; level: string | null } {
	const colon = value.lastIndexOf(":");
	if (colon > 0 && [...ROLE_THINK_LEVELS, "inherit"].includes(value.slice(colon + 1))) {
		return { model: value.slice(0, colon), level: value.slice(colon + 1) };
	}
	return { model: value, level: null };
}

/** Rebuild the selector with a thinking suffix ("inherit" strips it —
 * TUI formatModelSelectorValue parity: only concrete levels persist). */
function joinRoleValue(model: string, level: string | null): string {
	return level && level !== "inherit" ? `${model}:${level}` : model;
}

/** One stored credential row as exposed by the daemon (providers.credentials). */
interface CredentialInfo {
	id: number;
	accountLabel: string;
	note?: string | null;
}
const EMPTY_FORM = {
	name: "",
	baseUrl: "",
	apiKey: "",
	api: "openai-completions",
	modelId: "",
	modelName: "",
	compactionModel: "",
	modelInput: undefined as string[] | undefined,
	modelContextWindow: null as number | null,
	modelMaxTokens: null as number | null,
	adopted: [] as {
		id: string;
		name?: string;
		input?: string[] | null;
		contextWindow?: number | null;
		maxTokens?: number | null;
	}[],
};

export function ModelSection({
	providers,
	apiProviders,
	custom,
	loginState,
	busy,
	pendingLogins,
	onLogin,
	onLogout,
	onSubmitInput,
	onCancelLogin,
	onChanged,
	rpc,
	sessionId,
}: {
	providers: ProviderInfo[] | null;
	apiProviders: ApiProviderInfo[];
	custom: CustomProvider[];
	loginState: {
		providerId: string;
		url?: string;
		launchUrl?: string;
		instructions?: string;
		message?: string;
		waitingInput?: boolean;
	} | null;
	busy: boolean;
	/** Provider ids whose OAuth/API login is in flight — only THOSE provider
	 *  login controls are disabled, so one pending login doesn't freeze every
	 *  other provider's button (user report: "登录按钮有时点击没反应"). */
	pendingLogins: string[];
	onLogin(providerId: string): void;
	onLogout(providerId: string): void;
	onSubmitInput(value: string): void;
	onCancelLogin(): void;
	onChanged(): void;
	rpc: RpcClient | null;
	sessionId: string | null;
}): ReactNode {
	const [form, setForm] = useState(EMPTY_FORM);
	// Candidate models an endpoint reported, while the picker dialog is open.
	const [candidates, setCandidates] = useState<{ id: string; name?: string }[] | null>(null);
	// Model ids checked in the candidate picker.
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	// "Fetch available models" in flight, and its failure reason (shown next
	// to the form so the user can still fill models in by hand).
	const [fetchingModels, setFetchingModels] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	// Section collapse (bitfun parity): show the first few cards, expand on
	// demand — 70 login providers + the full catalog is too much for a grid.
	const [showAll, setShowAll] = useState(false);
	const [providerQuery, setProviderQuery] = useState("");
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	// Adopted-model capability editor: which adopted row's capability
	// override strip is expanded (null = none).
	const [expandedCaps, setExpandedCaps] = useState<string | null>(null);
	// Custom-provider add dialog: the config form lives in a DialogFrame
	// opened from the "custom providers" tab (not a separate tab — user
	// report: 添加自定义供应商应是有设计规范的弹窗). `addedName` is the
	// transient success feedback after a save.
	const [addOpen, setAddOpen] = useState(false);
	const [addedName, setAddedName] = useState<string | null>(null);
	// When non-null, the dialog is editing this EXISTING custom provider:
	// the form is seeded from its models.yml row and submit merges back via
	// models.add (same RPC — daemon merges by provider name).
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	const [inputValue, setInputValue] = useState("");
	const [copied, setCopied] = useState(false);
	// Per-role model presets (TUI /model parity): role -> model selector.
	const [roleModels, setRoleModels] = useState<Record<string, string> | null>(null);
	// Default model for new sessions (daemon settings "model" key).
	// Role cycle order (TUI ctrl+p cycleOrder) — roles render in this order.
	const [cycleOrder, setCycleOrder] = useState<string[] | null>(null);
	// Role assignment storage layer (settings.modelRoleStorage, TUI model-hub
	// parity): when "project", assignments can target the project's
	// .musepi/config.yml; the per-role picker below picks the layer.
	const [roleStorage, setRoleStorage] = useState<"global" | "project">("global");
	// Per-role write target while roleStorage=project ("global" | "project").
	const [roleScope, setRoleScope] = useState<Record<string, "global" | "project">>({});
	// Per-role provenance from the daemon (settings.getModelRoleProvenance):
	// which layer actually supplies each role (runtime/overlay/project/
	// global/default). Badges the scope toggle so a write never lands in an
	// unexpected layer (openchamber "Configured in:" parity).
	const [roleSources, setRoleSources] = useState<Record<string, string>>({});
	// Project-override ledger (settings.projectOverrides): keys the current
	// project layer owns, with the global fallback for comparison. Only
	// meaningful when a workspace is open.
	const [projectOverrides, setProjectOverrides] = useState<
		{ path: string; projectValue: string; effectiveValue?: string; globalValue?: string | null }[]
	>([]);
	const { prompt } = usePrompt();
	// Stored credentials per provider (multi-account logout dropdown).
	const [credentialsByProvider, setCredentialsByProvider] = useState<Record<string, CredentialInfo[]>>({});
	// Side-channel model override (settings.sideChannelModel): "" = follow
	// the session model (TUI parity for /btw /omfg recap, ephemeral ask).
	const [sideChannelModel, setSideChannelModel] = useState<string>("");
	// Catalog for the side-channel/compaction pickers (models.list).
	const [catalogModels, setCatalogModels] = useState<{ id: string; name?: string }[] | null>(null);
	// Provider id whose credential menu is open (single-open dropdown).
	const [credsMenu, setCredsMenu] = useState<string | null>(null);
	// Provider id whose inline actions menu (login / import API key) is open.
	const [actionsMenu, setActionsMenu] = useState<string | null>(null);
	// Anchor elements for the portal-rendered card menus (credential list /
	// actions). Keyed by `p.id` (creds) and `actions-${p.id}` (actions) so the
	// fixed-position popups can pin to their trigger button.
	const cardMenuAnchors = useRef(new Map<string, HTMLElement>());
	// Close the provider card menus on outside click / Escape. The menus are
	// portal-rendered into the root (fixed position) and carry
	// data-header-menu so clicks inside them are ignored here.
	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<{ id: string; name?: string }[]>("models.list", {})
			.then(list => setCatalogModels(list ?? []))
			.catch(() => {});
		void rpc
			.request<CatalogProvider[]>("models.catalog", {})
			.then(list => setCatalog(list ?? null))
			.catch(() => setCatalog(null));
		void rpc
			.request<Record<string, unknown> | null>("settings.get", {
				keys: ["modelRoles", "cycleOrder", "sideChannelModel"],
			})
			.then(v => setSideChannelModel((v?.sideChannelModel as string | undefined) ?? ""))
			.catch(() => {});
	}, [rpc]);

	useEffect(() => {
		if (!credsMenu && !actionsMenu) return;
		const onDown = (e: MouseEvent | KeyboardEvent): void => {
			if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
			const target = e.target as Node | null;
			if (target instanceof Node && (target as Element | null)?.closest?.("[data-header-menu]")) return;
			setCredsMenu(null);
			setActionsMenu(null);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onDown);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onDown);
		};
	}, [credsMenu, actionsMenu]);
	// Provider awaiting an imported API key (/setup parity modal).
	const [apiKeyTarget, setApiKeyTarget] = useState<string | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	// Unified provider list: subscription (OAuth) + API-key providers merged
	// by id — subscription wins login state, API model tags merge in.
	const mergedProviders = useMemo(() => {
		const map = new Map<
			string,
			{
				id: string;
				name: string;
				loggedIn: boolean;
				configured: boolean;
				models: string[];
				modelCount: number;
				available: boolean;
				canLogin: boolean;
				canImport: boolean;
			}
		>();
		for (const p of providers ?? []) {
			map.set(p.id, {
				id: p.id,
				name: p.name,
				loggedIn: p.loggedIn,
				configured: false,
				models: [],
				modelCount: 0,
				available: p.available,
				canLogin: true,
				canImport: false,
			});
		}
		for (const p of apiProviders) {
			const existing = map.get(p.id);
			if (existing) {
				existing.configured = p.configured;
				existing.models = p.models;
				existing.modelCount = p.modelCount;
				existing.canImport = true;
			} else {
				map.set(p.id, {
					id: p.id,
					// API-key providers from the daemon may ship an EMPTY name —
					// fall back to the id so the card header never renders blank
					// (user: bottom cards showed no provider name at all).
					name: p.name || p.id,
					loggedIn: false,
					configured: p.configured,
					models: p.models,
					modelCount: p.modelCount,
					available: true,
					canLogin: false,
					canImport: true,
				});
			}
		}
		// Active (logged-in / configured) first, then name order — connected
		// providers stay visible without scrolling.
		return [...map.values()].sort(
			(a, b) =>
				Number(b.loggedIn || b.configured) - Number(a.loggedIn || a.configured) || a.name.localeCompare(b.name),
		);
	}, [providers, apiProviders]);

	const providerQ = providerQuery.trim().toLowerCase();
	const filteredProviders = providerQ
		? mergedProviders.filter(
				p =>
					p.name.toLowerCase().includes(providerQ) ||
					p.id.toLowerCase().includes(providerQ) ||
					p.models.some(m => m.toLowerCase().includes(providerQ)),
			)
		: mergedProviders;
	const visibleProviders = filteredProviders.slice(0, showAll ? undefined : PROVIDER_COLLAPSE_LIMIT);
	// /model-style split pane: active tab id (default | session | roles |
	// providers | custom | add).
	const [activeTab, setActiveTab] = useState<string>("roles");
	// Canonical role list (built-ins + configured extras) — TUI /model
	// knownRoleIds parity.
	const [knownRoleIds, setKnownRoleIds] = useState<string[] | null>(null);
	// Per-role auto-resolved model (TUI model-hub parity): what each role
	// would select — explicit assignment, or the derived default/priority
	// resolution when unset.
	const [resolvedRoleModels, setResolvedRoleModels] = useState<
		Record<string, { id: string; name: string; efforts: string[] } | null>
	>({});
	// Full bundled catalog grouped by provider (daemon models.catalog) — the
	// TUI-parity rail data: registered (available) vs unregistered providers
	// with their full static model lists.
	const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
	// TUI model-hub rail selection: "roles" | "all" | `provider:${id}`.
	const [railView, setRailView] = useState<string>("roles");
	// Persist a role-assignment change, then re-fetch the daemon's per-role
	// resolution. The "自动选择" lines (SMOL/SLOW/VISION/…) derive from the
	// DEFAULT model — without the re-fetch they keep showing the OLD model
	// until the settings pane remounts.
	const applyRoleModels = (next: Record<string, string>, scope?: "global" | "project"): void => {
		setRoleModels(next);
		if (!rpc) return;
		void rpc
			.request("settings.set", { key: "modelRoles", value: next, ...(scope ? { scope } : {}) })
			.then(() =>
				rpc
					.request<{
						resolvedRoleModels?: Record<string, { id: string; name: string; efforts: string[] } | null>;
					}>("settings.get", { keys: ["resolvedRoleModels"] })
					.then(res => setResolvedRoleModels(res?.resolvedRoleModels ?? {})),
			)
			.catch(() => {});
	};
	// TUI #assignRole parity: when a role's resolved model changes, drop a
	// stored concrete thinking level the new model doesn't support (off is
	// exempt — disabling reasoning is valid for every model; inherit has no
	// suffix to clamp). The daemon clamps at read time too; this keeps the
	// card's select from showing a rung the model would silently downgrade.
	const modelClampKey = JSON.stringify(
		Object.entries(resolvedRoleModels).map(([k, v]) => [k, v?.id ?? null, roleModels?.[k] ?? null]),
	);
	useEffect(() => {
		if (!roleModels || !rpc) return;
		let changed: Record<string, string> | null = null;
		for (const [roleKey, resolved] of Object.entries(resolvedRoleModels)) {
			if (!resolved) continue;
			const raw = roleModels[roleKey];
			if (!raw) continue;
			const { model: bareModel, level } = splitRoleValue(raw);
			if (!level || level === "off" || level === "inherit") continue;
			if (!resolved.efforts.includes(level)) {
				changed = { ...(changed ?? {}), [roleKey]: joinRoleValue(bareModel, "inherit") };
			}
		}
		if (changed) applyRoleModels({ ...roleModels, ...changed });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- re-clamps only when a resolution or value actually changes
	}, [modelClampKey]);
	// Retry fallback chains (TUI /model `f` parity, settings
	// "retry.fallbackChains"): role -> ordered model selectors tried after
	// the assigned model fails.
	const [fallbackChains, setFallbackChains] = useState<Record<string, string[]>>({});
	// Role whose fallback-chain editor is open (inline ModelSelector).
	const [fallbackEditor, setFallbackEditor] = useState<string | null>(null);

	/**
	 * Ask the endpoint the form currently shows which models it serves. The
	 * draft — including a key typed but not yet saved — is sent as-is; the
	 * reply is candidates the user picks from, never configuration written
	 * behind them. A protocol with no readable listing or a dead endpoint is
	 * not a dead end: the failure shows next to the form's rows.
	 */
	const fetchModels = async (): Promise<void> => {
		if (!rpc) return;
		setFetchError(null);
		setFetchingModels(true);
		try {
			const result = await rpc.request<{ models?: { id: string; name?: string }[] }>("models.discover", {
				baseUrl: form.baseUrl,
				api: form.api,
				provider: form.name,
				...(form.apiKey ? { apiKey: form.apiKey } : {}),
			});
			const models = result?.models ?? [];
			if (models.length === 0) {
				setFetchError(t("no models found at this endpoint"));
				return;
			}
			setCandidates(models);
			setPicked(new Set(models.map(m => m.id)));
		} catch (err) {
			setFetchError(err instanceof Error ? err.message : String(err));
		} finally {
			setFetchingModels(false);
		}
	};

	/** Adopt the checked candidates into the form's model list. */
	const adoptSelected = (): void => {
		if (!candidates) return;
		const ids = new Set(form.adopted.map(m => m.id));
		const next = [...form.adopted];
		for (const candidate of candidates) {
			if (picked.has(candidate.id) && !ids.has(candidate.id)) {
				next.push({ id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}) });
			}
		}
		setForm(v => ({ ...v, adopted: next }));
		setCandidates(null);
		setPicked(new Set());
	};

	/** Drop one adopted model row from the form. */
	const removeAdopted = (id: string): void => {
		setForm(v => ({ ...v, adopted: v.adopted.filter(m => m.id !== id) }));
	};

	/** Patch capability overrides on one adopted model row. */
	const patchAdopted = (
		id: string,
		patch: Partial<{ input: string[] | null; contextWindow: number | null; maxTokens: number | null }>,
	): void => {
		setForm(v => ({
			...v,
			adopted: v.adopted.map(m => (m.id === id ? { ...m, ...patch } : m)),
		}));
	};

	const submitModel = async (): Promise<void> => {
		setFormError(null);
		if (!rpc || !sessionId) return;
		// A provider needs at least one model: either the hand-typed single
		// row or rows adopted from the endpoint interrogation.
		if (!form.name || !form.baseUrl || (form.modelId.length === 0 && form.adopted.length === 0)) {
			setFormError(t("provider name, base URL and at least one model are required"));
			return;
		}
		setFormBusy(true);
		try {
			await rpc.request("models.add", {
				sessionId,
				provider: {
					name: form.name,
					baseUrl: form.baseUrl,
					...(form.apiKey ? { apiKey: form.apiKey } : {}),
					...(form.api !== "openai" ? { api: form.api } : {}),
					models: [
						...form.adopted.map(m => ({
							id: m.id,
							...(m.name ? { name: m.name } : {}),
							// input: explicit []/null → restore-to-auto (null deletes
							// the models.yml override); non-empty array writes it;
							// untouched (undefined) omits the field.
							...(Array.isArray(m.input)
								? { input: m.input.length > 0 ? m.input : null }
								: m.input === null
									? { input: null }
									: {}),
							...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
							...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
						})),
						...(form.modelId
							? [
									{
										id: form.modelId,
										...(form.modelName ? { name: form.modelName } : {}),
										...(form.compactionModel.trim() ? { compactionModel: form.compactionModel.trim() } : {}),
										// Capability fields: untouched (undefined) → omit
										// (inherit/keep); "restore to auto" ([]) → null to
										// delete the override; checked → write the array.
										...(form.modelInput !== undefined
											? { input: form.modelInput.length > 0 ? form.modelInput : null }
											: {}),
										...(form.modelContextWindow !== undefined
											? { contextWindow: form.modelContextWindow }
											: {}),
										...(form.modelMaxTokens !== undefined ? { maxTokens: form.modelMaxTokens } : {}),
									},
								]
							: []),
					],
				},
			});
			setForm(EMPTY_FORM);
			// Success feedback: close the dialog and show "provider added / saved"
			// inline where the open button was (the dialog itself can't hold
			// state after closing). The chip fades after a beat.
			const wasEditing = editingProvider !== null;
			setEditingProvider(null);
			setAddOpen(false);
			setAddedName(wasEditing ? `${t("provider saved")} ${form.name}` : form.name);
			window.setTimeout(() => setAddedName(null), 2500);
			onChanged();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setFormBusy(false);
		}
	};

	const removeProvider = async (name: string): Promise<void> => {
		if (!rpc || !sessionId) return;
		try {
			await rpc.request("models.remove", { sessionId, providerName: name });
			onChanged();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	/**
	 * Load one custom provider back into the add/edit form (models.yml row →
	 * form), then open the dialog in edit mode. The API key is intentionally
	 * not echoed back (daemon never returns it on read paths); leaving the
	 * field empty on submit keeps the stored key untouched.
	 */
	const editProvider = async (name: string): Promise<void> => {
		if (!rpc) return;
		try {
			const cfg = await rpc.request<{
				providers?: Record<
					string,
					{
						baseUrl?: string;
						api?: string;
						models?: {
							id: string;
							name?: string;
							input?: string[];
							contextWindow?: number;
							maxTokens?: number;
						}[];
					}
				>;
			}>("models.listCustom", {});
			const row = cfg?.providers?.[name];
			const models = Array.isArray(row?.models) ? row.models : [];
			const hand = models[models.length - 1];
			setForm({
				name,
				baseUrl: row?.baseUrl ?? "",
				apiKey: "",
				api: row?.api ?? "openai-completions",
				modelId: hand?.id ?? "",
				modelName: hand?.name ?? "",
				compactionModel: "",
				modelInput: hand?.input && hand.input.length > 0 ? hand.input : undefined,
				modelContextWindow: hand?.contextWindow ?? null,
				modelMaxTokens: hand?.maxTokens ?? null,
				adopted: models.slice(0, models.length - 1),
			});
			setEditingProvider(name);
			setAddOpen(true);
			setFormError(null);
			setFetchError(null);
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// Role presets only exist on a live session (settings live there).
	useEffect(() => {
		if (!rpc) {
			setRoleModels(null);
			setCycleOrder(null);
			setKnownRoleIds(null);
			setFallbackChains({});
			return;
		}
		void rpc
			.request<{
				modelRoles?: Record<string, string>;
				cycleOrder?: string[];
				knownRoleIds?: string[];
				resolvedRoleModels?: Record<string, { id: string; name: string; efforts: string[] } | null>;
				"retry.fallbackChains"?: Record<string, string[]>;
				modelRoleStorage?: "global" | "project";
				modelRoleSources?: Record<string, "runtime" | "overlay" | "project" | "global" | "default">;
			}>("settings.get", {
				keys: [
					"modelRoles",
					"cycleOrder",
					"knownRoleIds",
					"resolvedRoleModels",
					"retry.fallbackChains",
					"modelRoleStorage",
					"modelRoleSources",
				],
			})
			.then(res => {
				setRoleModels(res?.modelRoles ?? {});
				setCycleOrder(res?.cycleOrder ?? null);
				setKnownRoleIds(res?.knownRoleIds ?? null);
				setResolvedRoleModels(res?.resolvedRoleModels ?? {});
				setFallbackChains(res?.["retry.fallbackChains"] ?? {});
				if (res?.modelRoleStorage === "project") setRoleStorage("project");
				setRoleSources(res?.modelRoleSources ?? {});
			})
			.catch(() => {
				setRoleModels({});
				setCycleOrder(null);
				setKnownRoleIds(null);
				setResolvedRoleModels({});
				setFallbackChains({});
			});
	}, [rpc]);

	// Load the project-override ledger; a no-workspace daemon returns an
	// empty list, which simply hides the section.
	const loadProjectOverrides = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const res = await rpc.request<{
				overrides?: { path: string; projectValue: unknown; globalValue?: unknown }[];
			}>("settings.projectOverrides", { action: "list" });
			setProjectOverrides(
				(res?.overrides ?? []).map(entry => ({
					path: entry.path,
					projectValue: String(entry.projectValue),
					globalValue: entry.globalValue == null ? null : String(entry.globalValue),
				})),
			);
		} catch {
			setProjectOverrides([]);
		}
	}, [rpc]);

	// Revert one key to its inherited layer (only modelRoles.<role> leaves
	// are deletable — the rest of the project file is hand-edited config).
	const deleteProjectOverride = useCallback(
		async (overridePath: string): Promise<void> => {
			if (!rpc) return;
			try {
				await rpc.request("settings.projectOverrides", { action: "delete", path: overridePath });
				if (overridePath.startsWith("modelRoles.")) {
					const role = overridePath.slice("modelRoles.".length);
					setRoleModels(prev => {
						const next = { ...prev };
						delete next[role];
						return next;
					});
				}
				await loadProjectOverrides();
				void rpc
					.request<{ resolvedRoleModels?: typeof resolvedRoleModels }>("settings.get", {
						keys: ["resolvedRoleModels", "modelRoleSources"],
					})
					.then(res => {
						if (res?.resolvedRoleModels) setResolvedRoleModels(res.resolvedRoleModels);
						setRoleSources((res as { modelRoleSources?: Record<string, string> } | null)?.modelRoleSources ?? {});
					})
					.catch(() => {});
			} catch {
				// keep the row; the daemon error is non-fatal for the list
			}
		},
		[rpc, loadProjectOverrides],
	);

	useEffect(() => {
		void loadProjectOverrides();
	}, [loadProjectOverrides]);

	// Stored credentials per logged-in provider — powers the multi-account
	// logout dropdown and the logged-in count. Covers both lists: OAuth
	// accounts (providers) and configured API-key providers (apiProviders).
	const loadCredentials = useCallback(async (): Promise<void> => {
		if (!rpc || !providers) return;
		const ids = [
			...providers.filter(p => p.loggedIn).map(p => p.id),
			...apiProviders.filter(p => p.configured).map(p => p.id),
		];
		const entries = await Promise.all(
			ids.map(async id => {
				try {
					const creds = await rpc.request<CredentialInfo[]>("providers.credentials", { providerId: id });
					return [id, creds ?? []] as [string, CredentialInfo[]];
				} catch {
					return [id, []] as [string, CredentialInfo[]];
				}
			}),
		);
		const next: Record<string, CredentialInfo[]> = {};
		for (const [id, list] of entries) next[id] = list;
		setCredentialsByProvider(next);
	}, [rpc, providers, apiProviders]);

	useEffect(() => {
		void loadCredentials();
	}, [loadCredentials]);

	// Remove exactly one stored credential (daemon providers.logout with
	// credentialId) — the provider stays logged in until the last one goes.
	const logoutCredential = async (providerId: string, credentialId: number): Promise<void> => {
		if (!rpc) return;
		setCredsMenu(null);
		try {
			await rpc.request("providers.logout", { sessionId: sessionId ?? undefined, providerId, credentialId });
			onChanged();
			await loadCredentials();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// Credential note editing (multi-account labeling): prompt for the new
	// note, then persist via providers.setCredentialNote (session-less).
	const editCredentialNote = async (
		providerId: string,
		credentialId: number,
		current: string | null,
	): Promise<void> => {
		if (!rpc) return;
		const note = await prompt({ title: t("credential note"), defaultValue: current ?? "" });
		if (note === null) return; // cancelled
		try {
			await rpc.request("providers.setCredentialNote", {
				sessionId: sessionId ?? undefined,
				providerId,
				credentialId,
				note,
			});
			await loadCredentials();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// /setup parity: import a provider API key without OAuth.
	const submitApiKey = async (): Promise<void> => {
		if (!rpc || !apiKeyTarget || !apiKeyValue.trim()) return;
		const providerId = apiKeyTarget;
		try {
			await rpc.request("providers.importApiKey", { providerId, apiKey: apiKeyValue.trim() });
			setApiKeyTarget(null);
			setApiKeyValue("");
			onChanged();
		} catch {
			// keep the modal open; the daemon error shows nothing fatal
		}
	};

	const modelTabs = [
		{ id: "roles", label: t("role models") },
		{ id: "behavior", label: t("model behavior") },
		{ id: "providers", label: t("providers") },
		{ id: "custom", label: t("custom providers") },
	] as const;

	// One role row (TUI /model roles-panel parity): tag + assignment state,
	// thinking level, cycle membership, model picker + clear; custom roles
	// additionally get a remove button. Fallback chains render as sub-rows
	// with an inline model picker to append.
	const renderRoleRow = (role: string, removable: boolean): ReactNode => {
		if (!rpc) return null;
		const raw = roleModels?.[role] ?? "";
		const { model, level } = splitRoleValue(raw);
		const resolved = resolvedRoleModels[role];
		const chain = fallbackChains[role] ?? [];
		const cycleIndex = cycleOrder?.indexOf(role) ?? -1;
		const editingFallback = fallbackEditor === role;
		const apply = (next: Record<string, string>): void =>
			applyRoleModels(next, roleStorage === "project" ? (roleScope[role] ?? "project") : undefined);
		return (
			<div key={role} className="gui-role-card">
				<div className="gui-role-card-head">
					<div className="gui-settings-row-label">
						<span className="gui-role-tag">{BUILTIN_ROLE_TAGS[role] ?? role}</span>
						{cycleIndex >= 0 && (
							<span className="gui-role-cycle-badge" title={t("cycle order")}>
								⟳{cycleIndex + 1}
							</span>
						)}
						{roleStorage === "project" &&
							(() => {
								// openchamber provenance parity: the badge shows the
								// layer the CURRENT value lives in (dot marker) plus
								// the next write target (label). When they differ —
								// e.g. value inherited from global while the target
								// is project — editing would silently shadow the
								// source, so title spells that out.
								const target = roleScope[role] ?? "project";
								const source = roleSources[role] ?? "default";
								const sourceLabel =
									source === "project"
										? t("scope project")
										: source === "global" || source === "overlay" || source === "runtime"
											? t("scope global")
											: null;
								const shadows = sourceLabel !== null && sourceLabel !== target;
								return (
									<button
										type="button"
										className={`gui-role-scope-badge${shadows ? " gui-role-scope-badge--warn" : ""}`}
										title={
											shadows
												? `${t("role scope shadowed")} (${sourceLabel} → ${target === "project" ? t("scope project") : t("scope global")})`
												: t("role scope toggle")
										}
										aria-label={t("role scope toggle")}
										onClick={() =>
											setRoleScope(prev => ({
												...prev,
												[role]: prev[role] === "global" ? "project" : "global",
											}))
										}
									>
										{sourceLabel && (
											<span className="gui-role-scope-dot" aria-hidden="true">
												●
											</span>
										)}
										{target === "project" ? t("scope project") : t("scope global")}
									</button>
								);
							})()}
					</div>
					<div className="gui-role-status" title={model}>
						{model ? (
							<div className="truncate">{resolved?.name || model}</div>
						) : resolved ? (
							<div className="truncate">
								{t("auto selection")}: {resolved.name || resolved.id}
							</div>
						) : (
							<div className="italic">{t("auto selection applies")}</div>
						)}
					</div>
				</div>
				<div className="gui-role-model-row">
					<ModelSelector
						rpc={rpc}
						sessionId={null}
						presetId={model || undefined}
						maxLabelWidth="230px"
						onSelect={(id, provider) => {
							if (!id) return;
							// Store the provider-qualified reference: the daemon
							// resolves "provider/id" exactly, so assigning
							// opencode-go's deepseek-v4-flash never leaks onto
							// opencode-zen's same-id model.
							const ref = provider ? `${provider}/${id}` : id;
							if (role === "default") {
								// The DEFAULT role IS the default model for new
								// sessions — keep the welcome-composer preselect
								// in sync with the role assignment. The bare ref
								// (no :level suffix) mirrors the daemon's
								// modelRoles.default value.
								try {
									localStorage.setItem("musepi-gui-default-model", ref);
								} catch {
									// storage unavailable
								}
								window.dispatchEvent(new CustomEvent("musepi-gui-default-model-changed", { detail: ref }));
							}
							// Keep the role's thinking suffix when the model
							// changes (TUI assign preserves the level).
							const next = { ...roleModels, [role]: joinRoleValue(ref, level) };
							apply(next);
						}}
					/>
				</div>
				{(chain.length > 0 || editingFallback) && (
					<div className="gui-role-fallbacks">
						{chain.length > 0 && (
							<div className="gui-role-fallbacks-title">
								<Icon name="git-branch" className="h-3 w-3" />
								<span>{t("fallback chain")}</span>
							</div>
						)}
						{chain.map((selector, i) => (
							<div key={selector} className="gui-role-fallback-row">
								<span className="gui-role-fallback-arrow">↳</span>
								<span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]">
									{selector}
								</span>
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									title={t("remove fallback")}
									aria-label={t("remove fallback")}
									onClick={() => {
										const nextChain = chain.filter((_, idx) => idx !== i);
										const next = { ...fallbackChains };
										if (nextChain.length > 0) next[role] = nextChain;
										else delete next[role];
										setFallbackChains(next);
										void rpc
											.request("settings.set", { key: "retry.fallbackChains", value: next })
											.catch(() => {});
									}}
								>
									<Icon name="delete-bin" className="h-3 w-3" />
								</button>
							</div>
						))}
						{editingFallback && (
							<div className="gui-role-fallback-add">
								<ModelSelector
									rpc={rpc}
									sessionId={null}
									onSelect={(id, provider) => {
										setFallbackEditor(null);
										if (!id || !provider) return;
										const selector = `${provider}/${id}`;
										const nextChain = chain.includes(selector) ? chain : [...chain, selector];
										const next = { ...fallbackChains, [role]: nextChain };
										setFallbackChains(next);
										void rpc
											.request("settings.set", { key: "retry.fallbackChains", value: next })
											.catch(() => {});
									}}
								/>
							</div>
						)}
					</div>
				)}
				<div className="gui-role-actions gui-role-actions--pin">
					{/* Per-role thinking level (rides the selector suffix, TUI
					 * formatModelSelectorValue parity). */}
					<GuiSelect
						className="gui-input gui-role-thinking"
						value={level ?? "inherit"}
						onChange={v => {
							const nextLevel = v;
							const next = { ...roleModels, [role]: joinRoleValue(model, nextLevel) };
							apply(next);
						}}
						ariaLabel={t("role thinking level")}
						options={(() => {
							// TUI #thinkingOptionsFor parity: inherit + off always
							// present, then the resolved role model's real effort
							// rungs. `auto` is session-scoped in the TUI and has no
							// per-role selector encoding, so it lives only in the
							// behavior tab's defaultThinkingLevel setting here.
							const efforts = resolvedRoleModels[role]?.efforts ?? [];
							return [
								{ value: "inherit", label: t("inherit") },
								{ value: "off", label: t("thinking off") },
								...efforts.map(lv => ({
									value: lv,
									label: t(`thinking ${lv}` as TranslationKey),
								})),
							];
						})()}
					/>
					{/* Fallback chain editor toggle (TUI `f` parity) — always
					 * available so the FIRST fallback can be added. */}
					<button
						type="button"
						className="gui-btn"
						title={editingFallback ? t("add fallback") : t("fallback chain")}
						aria-label={editingFallback ? t("add fallback") : t("fallback chain")}
						onClick={() => setFallbackEditor(editingFallback ? null : role)}
					>
						<Icon name="git-branch" className="h-3.5 w-3.5" />
						{chain.length > 0 && <span className="gui-role-fallback-count">{chain.length}</span>}
					</button>
					{/* Cycle membership toggle (TUI ctrl+p cycleOrder parity). */}
					<button
						type="button"
						className="gui-btn"
						title={cycleIndex >= 0 ? t("remove from cycle") : t("add to cycle")}
						aria-label={cycleIndex >= 0 ? t("remove from cycle") : t("add to cycle")}
						onClick={() => {
							const next = [...(cycleOrder ?? [])];
							const at = next.indexOf(role);
							if (at >= 0) next.splice(at, 1);
							else next.push(role);
							setCycleOrder(next);
							void rpc.request("settings.set", { key: "cycleOrder", value: next }).catch(() => {});
						}}
					>
						<Icon name="loop-right-ai" className="h-3.5 w-3.5" />
					</button>
					<span className="gui-role-spacer" aria-hidden="true" />
					{model && (
						<button
							type="button"
							className="gui-btn"
							title={t("clear role model")}
							aria-label={t("clear role model")}
							onClick={() => {
								const next = { ...roleModels };
								delete next[role];
								apply(next);
							}}
						>
							<Icon name="refresh" className="h-3.5 w-3.5" />
						</button>
					)}
					{removable && (
						<button
							type="button"
							className="gui-btn"
							title={t("remove role")}
							aria-label={t("remove role")}
							onClick={() => {
								const next = { ...roleModels };
								delete next[role];
								apply(next);
							}}
						>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
			</div>
		);
	};

	// All known roles: the daemon's canonical list, or — while settings are
	// still loading / on old daemons — the built-ins plus any configured
	// extras (TUI getKnownRoleIds parity: built-ins always show, even
	// unassigned).
	const rolesOrder =
		knownRoleIds ??
		[...Object.keys(BUILTIN_ROLE_TAGS), ...(cycleOrder ?? []), ...Object.keys(roleModels ?? {})].filter(
			(role, index, all) => all.indexOf(role) === index,
		);

	// TUI model-hub rail data: every catalog provider with registration
	// status (registry auth OR the GUI's own logged-in/configured state —
	// keyless local runtimes count as available in the registry but show
	// "not logged in" in providers.list) + login/import capability lookup.
	const railProviders = useMemo(() => {
		if (!catalog) return [];
		const byId = new Map(mergedProviders.map(p => [p.id, p]));
		return catalog.map(c => {
			const known = byId.get(c.provider);
			return {
				...c,
				registered: c.available || (known ? known.loggedIn || known.configured : false),
				canLogin: known?.canLogin ?? false,
				canImport: known?.canImport ?? false,
			};
		});
	}, [catalog, mergedProviders]);
	const registeredProviders = railProviders.filter(p => p.registered);
	const unregisteredProviders = railProviders.filter(p => !p.registered);
	const assignedCount = rolesOrder.filter(r => roleModels?.[r]).length;
	const railEntryCls = (id: string): string =>
		`gui-model-rail-entry${railView === id ? " gui-model-rail-entry--active" : ""}`;
	const railProvider = railView.startsWith("provider:")
		? railProviders.find(p => `provider:${p.provider}` === railView)
		: undefined;
	// Cap per-provider rows in the "all models" / provider views — the full
	// bundled catalog is thousands of rows; real browsing lives in the model
	// pickers, this pane is an overview.
	const MODEL_LIST_CAP = 30;
	const renderProviderModels = (p: (typeof railProviders)[number]): ReactNode => {
		const shown = p.models.slice(0, MODEL_LIST_CAP);
		return (
			<div className="gui-model-provider-models">
				{shown.length > 0 ? (
					shown.map(m => (
						<div key={`${p.provider}/${m.id}`} className="gui-model-model-row">
							<span className="gui-model-model-name" title={m.name}>
								{m.name}
							</span>
							<span className="gui-model-model-id">{m.id}</span>
						</div>
					))
				) : (
					<div className="text-[12px] text-[var(--color-text-faint)] italic">{t("no models")}</div>
				)}
				{p.modelCount > shown.length && <div className="gui-model-model-more">+{p.modelCount - shown.length}</div>}
			</div>
		);
	};
	// "All models" view: every provider's catalog models, grouped (TUI model
	// browser parity — display-only; assignment happens in the role rows).
	const renderAllModels = (): ReactNode => (
		<div className="gui-model-all">
			{catalog === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">{t("loading")}…</div>
			) : (
				railProviders.map(p => (
					<div key={p.provider} className="gui-model-provider-block">
						<div className="gui-model-provider-block-head">
							<span
								className={`gui-provider-status-dot${p.registered ? " gui-provider-status-dot--on" : ""}`}
								aria-hidden="true"
							/>
							<span className="gui-model-provider-name" title={p.name}>
								{p.name}
							</span>
							<span className="gui-model-rail-count">{p.modelCount}</span>
						</div>
						{renderProviderModels(p)}
					</div>
				))
			)}
		</div>
	);
	// Provider detail (rail "provider:*" view): models + registration status
	// + enable actions for unregistered providers.
	const renderProviderDetail = (p: (typeof railProviders)[number]): ReactNode => {
		const known = mergedProviders.find(m => m.id === p.provider);
		const status = known
			? known.loggedIn
				? t("logged in")
				: known.configured
					? t("configured")
					: t("not logged in")
			: p.available
				? t("logged in")
				: t("not logged in");
		return (
			<div className="gui-settings-section">
				<div className="gui-settings-row">
					<div className="min-w-0 flex-1">
						<div className="gui-settings-row-label">{p.name}</div>
						<div className="truncate text-[12px] text-[var(--color-text-faint)]">{p.provider}</div>
					</div>
					<span
						className={`gui-provider-status-dot${p.registered ? " gui-provider-status-dot--on" : ""}`}
						aria-hidden="true"
					/>
					<span className="text-[12px] text-[var(--color-text-muted)]">{status}</span>
				</div>
				{renderProviderModels(p)}
				{!p.registered && (p.canLogin || p.canImport) && (
					<div className="gui-model-provider-actions">
						{p.canLogin && (
							<button
								type="button"
								className="gui-btn gui-btn-approve"
								disabled={!known?.available || pendingLogins.includes(p.provider)}
								onClick={() => void onLogin(p.provider)}
							>
								<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
								{t("login")}
							</button>
						)}
						{p.canImport && (
							<button
								type="button"
								className="gui-btn"
								onClick={() => {
									setApiKeyTarget(p.provider);
									setApiKeyValue("");
								}}
							>
								<Icon name="key" className="h-3.5 w-3.5" />
								{t("import api key")}
							</button>
						)}
					</div>
				)}
			</div>
		);
	};
	// Login flow (OAuth device-code): lives at the pane body top so it shows
	// over whichever tab triggered it (providers tab OR a locked-provider
	// action from the roles rail).
	const renderLoginFlow = (): ReactNode => {
		if (!loginState) return null;
		return (
			<div className="gui-github-flow">
				<div className="gui-github-flow-title flex items-center gap-1.5">
					<Icon name="lock" className="h-3.5 w-3.5" />
					{t("login to {name}", { name: loginState.providerId })}
				</div>
				{loginState.url && (
					<div className="gui-github-flow-actions">
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							onClick={() => void openExternalUrl(loginState.launchUrl ?? loginState.url!)}
						>
							<Icon name="external-link" className="h-3.5 w-3.5" />
							{t("open login page")}
						</button>
						<button
							type="button"
							className="gui-link"
							onClick={() => {
								void navigator.clipboard.writeText(loginState.url ?? "").catch(() => {});
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1500);
							}}
						>
							{copied ? t("link copied") : t("copy link")}
						</button>
						{loginState.url && (
							<button type="button" className="gui-link" onClick={() => void onCancelLogin()}>
								{t("cancel")}
							</button>
						)}
					</div>
				)}
				{loginState.instructions && <div className="gui-github-flow-hint">{loginState.instructions}</div>}
				{loginState.message && <div className="gui-github-flow-hint">{loginState.message}</div>}
				{loginState.waitingInput ? (
					<div className="mt-2 flex items-center gap-2">
						<input
							className="gui-input flex-1"
							value={inputValue}
							onChange={e => setInputValue(e.target.value)}
							placeholder={t("paste the code or redirect URL")}
							onKeyDown={e => {
								if (e.key === "Enter") {
									void onSubmitInput(inputValue);
									setInputValue("");
								}
							}}
						/>
						<button
							type="button"
							className="gui-btn gui-btn-approve"
							onClick={() => void onSubmitInput(inputValue)}
						>
							{t("submit")}
						</button>
					</div>
				) : (
					!busy &&
					loginState.url && (
						<div className="gui-github-flow-waiting">
							<span className="gui-flow-spinner" aria-hidden="true" />
							{t("waiting login")}
						</div>
					)
				)}
			</div>
		);
	};
	// API-key import flow: same inline pattern as login — renders at the pane
	// body top wherever the import button was pressed.
	const renderApiKeyImport = (): ReactNode => {
		if (!apiKeyTarget) return null;
		return (
			<div className="gui-github-flow">
				<div className="gui-github-flow-title flex items-center gap-1.5">
					<Icon name="key" className="h-3.5 w-3.5" />
					{t("import api key for {name}", { name: apiKeyTarget })}
				</div>
				<div className="flex items-center gap-2">
					<input
						className="gui-input flex-1"
						type="password"
						value={apiKeyValue}
						placeholder="sk-…"
						autoFocus
						onChange={e => setApiKeyValue(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter" && apiKeyValue.trim()) void submitApiKey();
						}}
					/>
					<button
						type="button"
						className="gui-btn gui-btn-approve"
						disabled={!apiKeyValue.trim()}
						onClick={() => void submitApiKey()}
					>
						{t("import")}
					</button>
					<button type="button" className="gui-btn" onClick={() => setApiKeyTarget(null)}>
						{t("cancel")}
					</button>
				</div>
			</div>
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("model settings")}</h2>
			<p className="gui-settings-page-desc">{t("model settings description")}</p>

			<div className="gui-model-pane">
				{/* Top tabs (extensions-center pill parity): the pane's old left
				 * nav moved up — the roles tab now hosts its own TUI-style rail,
				 * so a second vertical nav would double up. */}
				<div className="gui-model-tabs" role="tablist" aria-label={t("model settings")}>
					{modelTabs.map(tab => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={activeTab === tab.id}
							className={`gui-model-tab${activeTab === tab.id ? " gui-model-tab--active" : ""}`}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>
				{/* Tab body: HeightMorph eases the pane height between tabs and
				 * between rail views (different content heights — no abrupt
				 * jump). */}
				<HeightMorph morphKey={`${activeTab}:${railView}`} className="gui-model-pane-body">
					{loginState && renderLoginFlow()}
					{activeTab === "roles" && rpc && (
						<>
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("role models")}</div>
								<div className="gui-settings-section-desc">{t("role models description")}</div>
							</div>
							{/* TUI /model parity: the roles tab is a split pane — a
							 * rail of Roles / All models / registered providers /
							 * unregistered providers on the left, the selected
							 * view's content on the right. */}
							<div className="gui-model-rail-wrap">
								<nav className="gui-model-rail" aria-label={t("role models")}>
									<button type="button" className={railEntryCls("roles")} onClick={() => setRailView("roles")}>
										<span className="gui-model-rail-label">{t("role models")}</span>
										<span className="gui-model-rail-count">
											{assignedCount}/{rolesOrder.length}
										</span>
									</button>
									<button type="button" className={railEntryCls("all")} onClick={() => setRailView("all")}>
										<span className="gui-model-rail-label">{t("all models")}</span>
										<span className="gui-model-rail-count">{catalogModels?.length ?? 0}</span>
									</button>
									{catalog !== null && (
										<>
											<div className="gui-model-rail-group">{t("registered providers")}</div>
											{registeredProviders.map(p => (
												<button
													key={p.provider}
													type="button"
													className={railEntryCls(`provider:${p.provider}`)}
													onClick={() => setRailView(`provider:${p.provider}`)}
												>
													<span
														className="gui-provider-status-dot gui-provider-status-dot--on"
														aria-hidden="true"
													/>
													<span className="gui-model-rail-label truncate">{p.name}</span>
													<span className="gui-model-rail-count">{p.modelCount}</span>
												</button>
											))}
											<div className="gui-model-rail-group">{t("unregistered providers")}</div>
											{unregisteredProviders.map(p => (
												<button
													key={p.provider}
													type="button"
													className={railEntryCls(`provider:${p.provider}`)}
													onClick={() => setRailView(`provider:${p.provider}`)}
												>
													<span className="gui-provider-status-dot" aria-hidden="true" />
													<span className="gui-model-rail-label truncate">{p.name}</span>
												</button>
											))}
										</>
									)}
								</nav>
								<div className="gui-model-rail-body">
									{railView === "roles" && (
										<>
											{/* No current-session row here: the composer's model
											 * selector already switches the live session's model
											 * (same session.setModel the TUI /switch runs), and
											 * the thinking level sits beside it in the composer —
											 * a per-session override does not belong in global
											 * settings. The DEFAULT role below IS the default
											 * model for new sessions. */}
											{roleModels === null ? (
												<div className="text-[13px] text-[var(--color-text-faint)]">{t("loading")}…</div>
											) : (
												<>
													<div className="gui-role-grid">
														{rolesOrder.map(role =>
															renderRoleRow(role, BUILTIN_ROLE_TAGS[role] === undefined),
														)}
													</div>
													<button
														type="button"
														className="gui-connect-add"
														onClick={() => {
															void prompt({ title: t("new role name") }).then((role: string | null) => {
																if (!role?.trim() || !rpc) return;
																const next = { ...roleModels, [role.trim()]: "" };
																applyRoleModels(next);
															});
														}}
													>
														<Icon name="add-circle" className="h-4 w-4" />
														<span>{t("add role")}</span>
													</button>
													{(cycleOrder?.length ?? 0) > 0 && (
														<div className="gui-role-cycle-track">
															<span className="text-[12px] text-[var(--color-text-faint)]">
																{t("cycle order")}:
															</span>
															{cycleOrder!.map(role => (
																<span key={role} className="gui-role-cycle-chip">
																	{BUILTIN_ROLE_TAGS[role] ?? role}
																</span>
															))}
														</div>
													)}
													{roleStorage === "project" &&
														projectOverrides.length > 0 &&
														(() => {
															// Count only REAL overrides — a project key whose
															// value equals the global value is a no-op echo,
															// not an override.
															const real = projectOverrides.filter(
																e => e.globalValue == null || e.globalValue !== e.projectValue,
															);
															if (real.length === 0) return null;
															return (
																<div className="gui-project-overrides">
																	<div className="gui-project-overrides-title">
																		<span>{t("project overrides")}</span>
																		<span className="text-[12px] text-[var(--color-text-faint)]">
																			{t("overrides count {count}", { count: String(real.length) })}
																		</span>
																	</div>
																	{real.map(entry => (
																		<div key={entry.path} className="gui-project-override-row">
																			<code className="gui-project-override-path">{entry.path}</code>
																			<span
																				className="gui-project-override-value"
																				title={entry.projectValue}
																			>
																				{entry.projectValue}
																			</span>
																			{entry.globalValue != null &&
																				entry.globalValue !== entry.projectValue && (
																					<s
																						className="gui-project-override-global"
																						title={String(entry.globalValue)}
																					>
																						{entry.globalValue}
																					</s>
																				)}
																			{entry.path.startsWith("modelRoles.") ? (
																				<button
																					type="button"
																					className="gui-btn gui-btn--icon"
																					title={t("delete override")}
																					aria-label={t("delete override")}
																					onClick={() => deleteProjectOverride(entry.path)}
																				>
																					<Icon name="delete-bin" className="h-3.5 w-3.5" />
																				</button>
																			) : (
																				<span
																					className="text-[11px] text-[var(--color-text-faint)]"
																					title={t("override read only")}
																				>
																					{t("read only")}
																				</span>
																			)}
																		</div>
																	))}
																</div>
															);
														})()}
												</>
											)}
										</>
									)}
									{railView === "all" && renderAllModels()}
									{railProvider && renderProviderDetail(railProvider)}
								</div>
							</div>
						</>
					)}

					{activeTab === "behavior" && rpc && (
						<>
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("model behavior")}</div>
								<div className="gui-settings-section-desc">{t("model behavior description")}</div>
							</div>
							<div className="gui-schema-card">
								{/* Model behaviour (thinking/sampling/prompt/retry & fallback/
								 * advisor/prewalk/vision) — TUI settings model-tab parity.
								 * Own tab so role assignment stays focused. */}
								<SchemaTabSection rpc={rpc} tabs={["model"]} />
							</div>
							<div className="gui-settings-section mt-4">
								<div className="gui-settings-section-title">{t("side channel model")}</div>
								<div className="gui-settings-section-desc">{t("side channel model description")}</div>
								<div className="gui-settings-row">
									<div>
										<div className="gui-settings-row-label">{t("side channel model")}</div>
										<div className="gui-settings-row-desc">{t("side channel model label desc")}</div>
									</div>
									<GuiSelect
										className="gui-input max-w-[260px]"
										value={sideChannelModel}
										onChange={v => {
											const next = v;
											setSideChannelModel(next);
											void rpc
												.request("settings.set", { key: "sideChannelModel", value: next })
												.catch(() => {});
										}}
										ariaLabel={t("side channel model")}
										options={[
											{ value: "", label: t("follow session model") },
											...(catalogModels ?? []).map(m => ({ value: m.id, label: m.name ?? m.id })),
										]}
									/>
								</div>
							</div>
						</>
					)}

					{activeTab === "providers" && (
						<>
							{/* 模型供应商: subscription (OAuth) + API-key providers merged into
							 * one searchable list — active providers first, model tags on
							 * API-backed cards, floating modal for API-key import. */}
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("providers unified")}</div>
								<div className="gui-settings-section-desc">{t("providers unified hint")}</div>
								{providers === null ? (
									<div className="text-[13px] text-[var(--color-text-faint)]">{t("loading")}…</div>
								) : mergedProviders.length === 0 ? (
									<div className="text-[13px] text-[var(--color-text-faint)]">{t("no providers")}</div>
								) : (
									<>
										<div className="gui-provider-search">
											<Icon name="search" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
											<input
												className="gui-input min-w-0 flex-1"
												value={providerQuery}
												onChange={e => setProviderQuery(e.target.value)}
												placeholder={t("search providers…")}
												aria-label={t("search providers…")}
											/>
										</div>
										<HeightMorph morphKey={`${showAll}:${providerQ}`}>
											<ChromaGroup className="gui-provider-grid">
												{visibleProviders.map(p => {
													const creds = credentialsByProvider[p.id] ?? [];
													const active = p.loggedIn || p.configured;
													return (
														<SpotlightCard
															key={p.id}
															className="gui-provider-card"
															spotlightColor="rgba(255, 255, 255, 0.08)"
														>
															<div className="gui-provider-card-head">
																<div className="min-w-0 flex-1">
																	<div className="gui-provider-card-name" title={p.name}>
																		{p.name}
																	</div>
																	<div
																		className={`gui-provider-card-status${
																			active ? " gui-provider-card-status--ok" : ""
																		}`}
																	>
																		<span
																			className={`gui-provider-status-dot${
																				active ? " gui-provider-status-dot--on" : ""
																			}`}
																			aria-hidden="true"
																		/>
																		{p.loggedIn
																			? creds.length > 1
																				? t("logged in · {count}", { count: String(creds.length) })
																				: t("logged in")
																			: p.configured
																				? t("configured")
																				: p.canImport
																					? `${p.modelCount} ${t("models")}`
																					: t("not logged in")}
																	</div>
																</div>
																{active ? (
																	<div className="relative shrink-0">
																		<button
																			type="button"
																			className="gui-btn gui-btn-stop"
																			ref={el => {
																				if (el) cardMenuAnchors.current.set(p.id, el);
																				else cardMenuAnchors.current.delete(p.id);
																			}}
																			aria-expanded={credsMenu === p.id}
																			onClick={() =>
																				setCredsMenu(menu => (menu === p.id ? null : p.id))
																			}
																		>
																			{t("logout")}
																			<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
																		</button>
																		<Pop
																			open={credsMenu === p.id}
																			className="gui-creds-menu"
																			anchor={cardMenuAnchors.current.get(p.id) ?? null}
																			portal
																			align="right"
																			onOpenChange={open => {
																				if (!open && credsMenu === p.id) setCredsMenu(null);
																			}}
																		>
																			<div className="gui-creds-menu-label">{t("accounts")}</div>
																			{creds.map(c => (
																				<div key={c.id} className="gui-creds-row">
																					<div className="min-w-0 flex-1">
																						<div className="truncate text-[13px] text-[var(--color-text)]">
																							{c.accountLabel}
																						</div>
																						{c.note && (
																							<div className="truncate text-[12px] text-[var(--color-text-faint)]">
																								{c.note}
																							</div>
																						)}
																					</div>
																					<button
																						type="button"
																						className="gui-btn gui-btn--icon"
																						title={t("edit credential note")}
																						aria-label={t("edit credential note")}
																						onClick={() =>
																							void editCredentialNote(p.id, c.id, c.note ?? null)
																						}
																					>
																						<Icon name="pencil" className="h-3 w-3" />
																					</button>
																					<button
																						type="button"
																						className="gui-btn gui-btn--icon"
																						title={t("remove credential")}
																						aria-label={t("remove credential")}
																						onClick={() => void logoutCredential(p.id, c.id)}
																					>
																						<Icon name="delete-bin" className="h-3 w-3" />
																					</button>
																				</div>
																			))}
																			<div className="gui-creds-menu-sep" />
																			<button
																				type="button"
																				className="gui-view-opt"
																				onClick={() => {
																					setCredsMenu(null);
																					if (p.canImport) {
																						setApiKeyTarget(p.id);
																						setApiKeyValue("");
																					} else {
																						void onLogin(p.id);
																					}
																				}}
																			>
																				<Icon name="add-circle" className="h-3.5 w-3.5" />
																				<span className="min-w-0 flex-1">
																					{t("add another credential")}
																				</span>
																			</button>
																			<button
																				type="button"
																				className="gui-view-opt gui-view-opt--danger"
																				onClick={() => {
																					setCredsMenu(null);
																					void onLogout(p.id);
																				}}
																			>
																				<span className="min-w-0 flex-1">{t("logout all")}</span>
																			</button>
																		</Pop>
																	</div>
																) : (
																	<div className="relative shrink-0">
																		<button
																			type="button"
																			className="gui-btn gui-btn--icon"
																			ref={el => {
																				if (el) cardMenuAnchors.current.set(`actions-${p.id}`, el);
																				else cardMenuAnchors.current.delete(`actions-${p.id}`);
																			}}
																			aria-expanded={actionsMenu === p.id}
																			aria-label={t("provider actions")}
																			title={t("provider actions")}
																			onClick={() =>
																				setActionsMenu(menu => (menu === p.id ? null : p.id))
																			}
																		>
																			<Icon name="more" className="h-3.5 w-3.5" />
																		</button>
																		<Pop
																			open={actionsMenu === p.id}
																			className="gui-creds-menu"
																			anchor={cardMenuAnchors.current.get(`actions-${p.id}`) ?? null}
																			portal
																			align="right"
																			onOpenChange={open => {
																				if (!open && actionsMenu === p.id) setActionsMenu(null);
																			}}
																		>
																			{p.canLogin && (
																				<button
																					type="button"
																					className="gui-view-opt"
																					disabled={!p.available || pendingLogins.includes(p.id)}
																					onClick={() => {
																						setActionsMenu(null);
																						void onLogin(p.id);
																					}}
																				>
																					<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
																					<span className="min-w-0 flex-1">{t("login")}</span>
																				</button>
																			)}
																			{p.canImport && (
																				<button
																					type="button"
																					className="gui-view-opt"
																					onClick={() => {
																						setActionsMenu(null);
																						setApiKeyTarget(p.id);
																						setApiKeyValue("");
																					}}
																				>
																					<Icon name="key" className="h-3.5 w-3.5" />
																					<span className="min-w-0 flex-1">
																						{t("import api key")}
																					</span>
																				</button>
																			)}
																		</Pop>
																	</div>
																)}
															</div>
															{p.models.length > 0 && (
																<div className="gui-provider-tags">
																	{p.models.map(m => (
																		<span key={m} className="gui-provider-tag">
																			{m}
																		</span>
																	))}
																	{p.modelCount > p.models.length && (
																		<span className="gui-provider-tag gui-provider-tag--more">
																			+{p.modelCount - p.models.length}
																		</span>
																	)}
																</div>
															)}
														</SpotlightCard>
													);
												})}
											</ChromaGroup>
										</HeightMorph>
										{filteredProviders.length > PROVIDER_COLLAPSE_LIMIT && (
											<button
												type="button"
												className="gui-provider-more"
												onClick={() => setShowAll(v => !v)}
											>
												{showAll
													? t("collapse")
													: t("show all {count}", { count: String(filteredProviders.length) })}
												<Icon name={showAll ? "arrow-up-s" : "arrow-down-s"} className="h-3.5 w-3.5" />
											</button>
										)}
										{providerQ && filteredProviders.length === 0 && (
											<div className="text-[13px] text-[var(--color-text-faint)]">
												{t("no matching providers")}
											</div>
										)}
									</>
								)}
							</div>
							{/* Provider behaviour (services, tiny-model, protocol,
							 * timeouts, privacy) — TUI providers-tab parity. Merged
							 * here (previously a duplicated sidebar 供应商 section /
							 * page-bottom flat block) so the providers tab is the
							 * single home for everything provider-side. */}
							<div className="gui-schema-card">
								<SchemaTabSection rpc={rpc} tabs={["providers"]} />
							</div>
						</>
					)}

					{/* API-key import — INLINE (same pattern as the login flow):
					 * a modal here is inconsistent with provider login, which
					 * stays embedded in the tab (user report). Rendered at the
					 * pane body top via renderApiKeyImport() so it also works
					 * from the roles-rail provider actions. */}
					{apiKeyTarget && renderApiKeyImport()}

					{activeTab === "custom" && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("custom providers")}</div>
							<div className="gui-settings-section-desc">{t("custom providers hint")}</div>
							{custom.length === 0 ? (
								<div className="text-[13px] text-[var(--color-text-faint)]">{t("no custom providers")}</div>
							) : (
								custom.map(c => (
									<div key={c.name} className="gui-settings-row">
										<div className="min-w-0 flex-1">
											<div className="gui-settings-row-label">{c.name}</div>
											<div className="truncate text-[13px] text-[var(--color-text-faint)]">
												{c.models.map(m => m.id).join(", ")}
											</div>
										</div>
										<button
											type="button"
											className="gui-btn"
											title={t("edit custom provider")}
											aria-label={t("edit custom provider")}
											onClick={() => void editProvider(c.name)}
										>
											<Icon name="edit-2" className="h-3.5 w-3.5" />
										</button>
										<button type="button" className="gui-btn" onClick={() => void removeProvider(c.name)}>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
									</div>
								))
							)}
							{addedName ? (
								<div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-accent)]">
									<Icon name="check" className="h-3.5 w-3.5" />
									<span>{t("provider added")}</span>
								</div>
							) : (
								<button
									type="button"
									className="gui-connect-add"
									onClick={() => {
										setAddOpen(true);
										setFormError(null);
									}}
								>
									<Icon name="add-circle" className="h-4 w-4" />
									<span>{t("add custom provider")}</span>
								</button>
							)}
						</div>
					)}

					{/* Custom-provider add dialog (规范弹窗, not a tab — user report:
					 * 添加自定义供应商应是有设计规范的弹窗). The form is the same
					 * state as the old add-tab; the candidates DialogFrame nests
					 * inside it (no conflict — both are portal-to-body). Because
					 * both DialogFrames listen for Escape on document (capture),
					 * closing this one must first (and only) dismiss the nested
					 * candidate picker — otherwise one Escape would nuke a filled
					 * form. On close without candidates, reset the form. */}
					<DialogFrame
						open={addOpen}
						onClose={() => {
							if (candidates !== null) {
								setCandidates(null);
								setPicked(new Set());
								return;
							}
							setAddOpen(false);
							setEditingProvider(null);
							setFormError(null);
							setForm(EMPTY_FORM);
							setFetchError(null);
						}}
						className="gui-dialog--settings"
						label={editingProvider ? t("edit custom provider") : t("add custom provider")}
					>
						<div className="gui-dialog-head">
							<div className="text-[14px] font-medium">
								{editingProvider ? t("edit custom provider") : t("add custom provider")}
							</div>
						</div>
						<div className="flex flex-col gap-2 p-4">
							<input
								className="gui-input"
								placeholder={t("provider name")}
								value={form.name}
								onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
							/>
							<input
								className="gui-input"
								placeholder="https://api.example.com/v1"
								value={form.baseUrl}
								onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))}
							/>
							<input
								className="gui-input"
								placeholder={t("api key (optional)")}
								type="password"
								value={form.apiKey}
								onChange={e => setForm(v => ({ ...v, apiKey: e.target.value }))}
							/>
							{/* Fetch available models: interrogates the endpoint the
							 * form currently shows (including an unsaved key), and
							 * offers the reply as adoptable candidates. */}
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="gui-btn"
									disabled={!form.baseUrl || fetchingModels || formBusy}
									title={form.baseUrl ? undefined : t("enter a base URL to fetch models")}
									onClick={() => void fetchModels()}
								>
									{fetchingModels ? t("fetching models…") : t("fetch available models")}
								</button>
								{form.adopted.length > 0 && (
									<span className="text-[12px] text-[var(--color-text-faint)]">
										{t("adopted models")}: {form.adopted.length}
									</span>
								)}
							</div>
							{fetchError && <div className="text-[13px] text-[var(--color-error)]">{fetchError}</div>}
							{form.adopted.length > 0 && (
								<div className="flex flex-col gap-1">
									{form.adopted.map(m => {
										const capsOpen = expandedCaps === m.id;
										return (
											<div key={m.id} className="flex flex-col gap-1">
												<div className="flex items-center gap-2">
													<span className="flex-1 truncate font-mono text-[13px]">{m.id}</span>
													<button
														type="button"
														className="gui-btn"
														title={t("model capabilities")}
														aria-label={`${t("model capabilities")} ${m.id}`}
														onClick={() => setExpandedCaps(capsOpen ? null : m.id)}
													>
														<Icon name="settings-3" className="h-3.5 w-3.5" />
													</button>
													<button
														type="button"
														className="gui-btn"
														aria-label={`${t("delete")} ${m.id}`}
														onClick={() => removeAdopted(m.id)}
													>
														<Icon name="delete-bin" className="h-3.5 w-3.5" />
													</button>
												</div>
												{capsOpen && (
													<div className="flex flex-col gap-1 rounded-lg border border-[var(--border-strong)] p-2">
														<div className="flex items-center justify-between">
															<div className="text-[12px] font-medium text-[var(--color-text-muted)]">
																{t("model capabilities")}
															</div>
															<button
																type="button"
																className="text-[12px] text-[var(--color-accent)]"
																title={t("restore capabilities to auto")}
																onClick={() =>
																	patchAdopted(m.id, {
																		input: null,
																		contextWindow: null,
																		maxTokens: null,
																	})
																}
															>
																{t("restore to auto")}
															</button>
														</div>
														<div className="flex items-center gap-3">
															{(["text", "image", "video"] as const).map(modality => (
																<label key={modality} className="flex items-center gap-1 text-[12px]">
																	<input
																		type="checkbox"
																		checked={(m.input ?? []).includes(modality)}
																		onChange={() =>
																			patchAdopted(m.id, {
																				input: (m.input ?? []).includes(modality)
																					? (m.input ?? []).filter(x => x !== modality)
																					: [...(m.input ?? []), modality],
																			})
																		}
																	/>
																	{modality}
																</label>
															))}
														</div>
														<div className="flex gap-2">
															<input
																className="gui-input flex-1"
																placeholder={t("context window (optional)")}
																type="number"
																min={0}
																value={m.contextWindow ?? ""}
																onChange={e =>
																	patchAdopted(m.id, {
																		contextWindow: e.target.value ? Number(e.target.value) : null,
																	})
																}
															/>
															<input
																className="gui-input flex-1"
																placeholder={t("max output tokens (optional)")}
																type="number"
																min={0}
																value={m.maxTokens ?? ""}
																onChange={e =>
																	patchAdopted(m.id, {
																		maxTokens: e.target.value ? Number(e.target.value) : null,
																	})
																}
															/>
														</div>
													</div>
												)}
											</div>
										);
									})}
								</div>
							)}
							<div className="flex gap-2">
								<input
									className="gui-input flex-1"
									placeholder={t("model id")}
									value={form.modelId}
									onChange={e => setForm(v => ({ ...v, modelId: e.target.value }))}
								/>
								<input
									className="gui-input flex-1"
									placeholder={t("model name (optional)")}
									value={form.modelName}
									onChange={e => setForm(v => ({ ...v, modelName: e.target.value }))}
								/>
							</div>
							<input
								className="gui-input"
								placeholder={t("compaction model id (optional)")}
								value={form.compactionModel}
								onChange={e => setForm(v => ({ ...v, compactionModel: e.target.value }))}
							/>
							<GuiSelect
								className="gui-input"
								value={form.api}
								onChange={nv => setForm(v => ({ ...v, api: nv }))}
								options={[
									{ value: "openai-completions", label: "openai" },
									{ value: "openai-responses", label: "openai responses" },
									{ value: "anthropic-messages", label: "anthropic" },
									{ value: "google-generative-ai", label: "google" },
								]}
							/>
							{/* Per-model capability overrides for the hand-typed row:
							 * input modalities (text/image/video) plus context window
							 * and max output tokens. These fill models.yml fields that
							 * otherwise inherit from the models.dev/bundled fallback —
							 * the escape hatch when the fallback is wrong or unknown.
							 * "Restore to auto" clears every override so the model
							 * goes back to the auto-fitted capabilities again. */}
							<div className="flex flex-col gap-1 rounded-lg border border-[var(--border-strong)] p-2">
								<div className="flex items-center justify-between">
									<div className="text-[12px] font-medium text-[var(--color-text-muted)]">
										{t("model capabilities")}
									</div>
									<button
										type="button"
										className="text-[12px] text-[var(--color-accent)]"
										title={t("restore capabilities to auto")}
										onClick={() =>
											setForm(v => ({
												...v,
												modelInput: [],
												modelContextWindow: null,
												modelMaxTokens: null,
											}))
										}
									>
										{t("restore to auto")}
									</button>
								</div>
								<div className="flex items-center gap-3">
									{(["text", "image", "video"] as const).map(modality => (
										<label key={modality} className="flex items-center gap-1 text-[12px]">
											<input
												type="checkbox"
												checked={(form.modelInput ?? []).includes(modality)}
												onChange={() =>
													setForm(v => {
														const current = v.modelInput ?? [];
														const next = current.includes(modality)
															? current.filter(m => m !== modality)
															: [...current, modality];
														return { ...v, modelInput: next };
													})
												}
											/>
											{modality}
										</label>
									))}
								</div>
								<div className="flex gap-2">
									<input
										className="gui-input flex-1"
										placeholder={t("context window (optional)")}
										type="number"
										min={0}
										value={form.modelContextWindow ?? ""}
										onChange={e =>
											setForm(v => ({
												...v,
												modelContextWindow: e.target.value ? Number(e.target.value) : null,
											}))
										}
									/>
									<input
										className="gui-input flex-1"
										placeholder={t("max output tokens (optional)")}
										type="number"
										min={0}
										value={form.modelMaxTokens ?? ""}
										onChange={e =>
											setForm(v => ({
												...v,
												modelMaxTokens: e.target.value ? Number(e.target.value) : null,
											}))
										}
									/>
								</div>
							</div>
							{formError && <div className="text-[13px] text-[var(--color-error)]">{formError}</div>}
							<button
								type="button"
								className="gui-btn gui-btn-approve"
								disabled={formBusy}
								onClick={() => void submitModel()}
							>
								{formBusy ? `${t("saving")}…` : editingProvider ? t("save changes") : t("add provider")}
							</button>
						</div>
						{/* Candidate picker for "fetch available models": the endpoint's
						 * reply as a checkbox list the user adopts from. Rendered
						 * inside the dialog frame so it portals to body independently. */}
						<DialogFrame
							open={candidates !== null}
							onClose={() => {
								setCandidates(null);
								setPicked(new Set());
							}}
							className="gui-dialog--confirm"
							label={t("available models")}
						>
							<div className="gui-dialog-head">
								<div className="text-[14px] font-medium">{t("available models")}</div>
								<button type="button" className="gui-btn" onClick={() => void adoptSelected()}>
									{t("adopt selected")}
								</button>
							</div>
							<div className="p-3">
								<div className="mb-2 flex items-center justify-between">
									<span className="text-[13px] text-[var(--color-text-faint)]">
										{t("select models to add")}
									</span>
									<button
										type="button"
										className="text-[12px] text-[var(--color-accent)]"
										onClick={() => {
											if (candidates && picked.size === candidates.length) {
												setPicked(new Set());
											} else if (candidates) {
												setPicked(new Set(candidates.map(m => m.id)));
											}
										}}
									>
										{picked.size > 0 && candidates && picked.size === candidates.length
											? t("deselect all")
											: t("select all")}
									</button>
								</div>
								<FadeScroll className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
									{(candidates ?? []).map(m => (
										<label key={m.id} className="flex cursor-pointer items-center gap-2">
											<input
												type="checkbox"
												checked={picked.has(m.id)}
												onChange={() => {
													const next = new Set(picked);
													if (next.has(m.id)) next.delete(m.id);
													else next.add(m.id);
													setPicked(next);
												}}
											/>
											<span className="flex-1 truncate font-mono text-[13px]">{m.id}</span>
											{m.name && m.name !== m.id && (
												<span className="truncate text-[12px] text-[var(--color-text-faint)]">
													{m.name}
												</span>
											)}
										</label>
									))}
								</FadeScroll>
							</div>
						</DialogFrame>
					</DialogFrame>
				</HeightMorph>
			</div>
		</>
	);
}
