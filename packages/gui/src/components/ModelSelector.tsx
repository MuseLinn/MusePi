import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { tapFeedback } from "../lib/haptic";
import type { RpcClient } from "../lib/rpc";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

export interface WireModel {
	id: string;
	name: string;
	provider: string;
}

// ── Favorite models (GUI-local pins) ──────────────────────────────────────
// Stored per model id in localStorage; every ModelSelector instance shares
// the same set via useSyncExternalStore, so pinning in the composer is
// immediately reflected in the settings role tab (and vice versa). Pinned
// models sort to the top of the listing, in pin order.
const FAV_MODELS_KEY = "musepi-gui-fav-models";

// Module-level cache: useSyncExternalStore's getSnapshot must return a
// STABLE reference between renders (Object.is), so the parsed array is
// cached and only replaced when a toggle changes it.
let favModelsCache: string[] | null = null;

function readFavModels(): string[] {
	if (favModelsCache) return favModelsCache;
	try {
		const raw = localStorage.getItem(FAV_MODELS_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		favModelsCache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		favModelsCache = [];
	}
	return favModelsCache;
}

const favListeners = new Set<() => void>();

function subscribeFavs(listener: () => void): () => void {
	favListeners.add(listener);
	return () => {
		favListeners.delete(listener);
	};
}

function toggleFavModel(id: string, provider?: string): void {
	// Favorites are keyed by provider/id: the same model id served by two
	// providers (e.g. opencode-go vs opencode-zen both offering
	// "deepseek-v4-flash") must not cross-favorite. Legacy entries stored
	// as bare ids are cleaned up on toggle.
	const key = provider ? `${provider}/${id}` : id;
	const cur = readFavModels();
	const has = cur.includes(key) || cur.includes(id);
	const next = has ? cur.filter(x => x !== key && x !== id) : [...cur.filter(x => x !== id), key];
	try {
		localStorage.setItem(FAV_MODELS_KEY, JSON.stringify(next));
	} catch {
		/* storage unavailable — keep the in-memory flip for this session */
	}
	favModelsCache = next;
	for (const l of favListeners) l();
}

/**
 * Live model selector — with a session it lists the session's available
 * models (daemon models.list) and switches ONLY that session via
 * session.setModel (TUI /switch parity — other sessions keep their own
 * models). Without one (welcome composer) it lists the registry catalog
 * (models.listAvailable) as a preselect-only picker; the parent applies
 * the choice once a session is created. The selected id is also published
 * to the parent via onSelect.
 */
export function ModelSelector({
	rpc,
	sessionId,
	onSelect,
	presetId,
	maxLabelWidth = "150px",
	allowSetDefault = false,
	currentModelId = null,
}: {
	rpc: RpcClient;
	sessionId: string | null;
	onSelect?(modelId: string | null, provider?: string): void;
	/** Preferred initial id (e.g. welcome-composer preselect applied to the
	 *  new session); kept when present in the listing. */
	presetId?: string | null;
	/** Button label cap — tight rows (role presets) pass a wider value so
	 *  long names like "① Gemini 3.5 Flash" don't truncate. */
	maxLabelWidth?: string;
	/** Show the per-row "set as DEFAULT role" target (composer only): pins
	 *  the model as the default for NEW sessions (modelRoles.default, the
	 *  same key the settings 角色模型 DEFAULT row writes). */
	allowSetDefault?: boolean;
	/** Session's live model (daemon contextUsage.model) — the authoritative
	 *  seed in session mode, so a /switch or /mode-chosen model survives
	 *  re-entering the session instead of the selector snapping to the
	 *  list head (or to another session's stale preselect). */
	currentModelId?: string | null;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<WireModel[]>([]);
	const [modelId, setModelId] = useState<string>("");
	// Searchable list (openchamber parity): filter by id/name/provider.
	const [query, setQuery] = useState("");
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	// Content-boundary feather on the scrolling list (sessions-list parity).
	const listRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(listRef);
	// Only a real user pick (select()) wins over re-seeding. The daemon's
	// live model (currentModelId) and the DEFAULT-role model arrive
	// asynchronously AFTER models.list — a naive `prev ||` guard would let
	// the first list head freeze the selection and the correct default
	// could never correct it (new-task shows the list's first model
	// instead of the DEFAULT-configured model).
	const userPicked = useRef(false);
	// The lock is PER-SESSION: the composer stays mounted across session
	// switches (ChatView swaps the store in place), so without a reset a
	// pick made in session A would freeze the selector on A's model for
	// every later session (re-seeding blocked, wrong model displayed —
	// session B's own model never wins). Reset the lock (and re-seed) the
	// moment the target session changes.
	const lastSessionId = useRef(sessionId);
	useEffect(() => {
		if (lastSessionId.current !== sessionId) {
			lastSessionId.current = sessionId;
			userPicked.current = false;
		}
	}, [sessionId]);
	// Current DEFAULT-role model (modelRoles.default) — the row shows a
	// filled target for it; clicking any row's target pins it there. Read
	// once on mount when the affordance is enabled. Declared before the
	// seeding effect: the DEFAULT role is the last fallback in the seed
	// chain (new-task shows it instead of the list head).
	const [defaultRoleModel, setDefaultRoleModel] = useState<string | null>(null);
	useEffect(() => {
		if (!rpc || !allowSetDefault) return;
		let alive = true;
		void rpc
			.request<{ modelRoles?: Record<string, string> }>("settings.get", { keys: ["modelRoles"] })
			.then(res => {
				if (alive) setDefaultRoleModel(res?.modelRoles?.default ?? null);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc, allowSetDefault]);

	useEffect(() => {
		let alive = true;
		const method = sessionId ? "models.list" : "models.listAvailable";
		const params = sessionId ? { sessionId } : {};
		void rpc
			.request<WireModel[]>(method, params)
			.then(list => {
				if (!alive) return;
				setModels(list ?? []);
				const items = list ?? [];
				// Seeding chain: user pick → the session's live model
				// (authoritative: survives /switch, model_downshift, and a
				// stale global preselect from another session) → explicit
				// preselect (welcome carry-in / history header) → the
				// DEFAULT-role model → first listed. presetId may be a bare
				// id (daemon snapshot) or a provider/id composite —
				// normalize to the composite so the check highlight never
				// lights two providers of the same id.
				setModelId(prev => {
					if (userPicked.current) return prev;
					const candidate = sessionId
						? currentModelId || presetId || defaultRoleModel
						: presetId || defaultRoleModel;
					const match = candidate
						? items.find(m => m.id === candidate || `${m.provider}/${m.id}` === candidate)
						: undefined;
					if (match) return `${match.provider}/${match.id}`;
					const first = items[0];
					return first ? `${first.provider}/${first.id}` : "";
				});
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, presetId, currentModelId, defaultRoleModel]);

	// Dismissal is unified in useFloatingMenu (outside mousedown + Escape).

	const setAsDefault = (id: string, provider?: string): void => {
		// Persist the provider-qualified reference ("provider/id") — the
		// daemon resolves it exactly, so pinning opencode-go's
		// deepseek-v4-flash never spills onto opencode-zen's same-id model.
		const ref = provider ? `${provider}/${id}` : id;
		void rpc
			.request<{ modelRoles?: Record<string, string> }>("settings.get", { keys: ["modelRoles"] })
			.then(res => {
				const roles = res?.modelRoles ?? {};
				return rpc.request("settings.set", { key: "modelRoles", value: { ...roles, default: ref } });
			})
			.then(() => {
				setDefaultRoleModel(ref);
				// Keep the app's welcome preselect (presetModelId, a boot-time
				// snapshot) in sync: without this, changing the DEFAULT role
				// while running still shows the OLD default on the next new
				// task (app.tsx listens and refreshes).
				window.dispatchEvent(new CustomEvent("musepi-gui-default-model-changed", { detail: ref }));
			})
			.catch(() => {});
	};

	const current = models.find(m => m.id === modelId || `${m.provider}/${m.id}` === modelId);
	const label = current ? (current.name || current.id).replace(/^[^/]*\//, "") : t("model");

	const favs = useSyncExternalStore(subscribeFavs, readFavModels);

	const q = query.trim().toLowerCase();
	const filtered = q
		? models.filter(
				m =>
					m.id.toLowerCase().includes(q) ||
					m.name.toLowerCase().includes(q) ||
					m.provider.toLowerCase().includes(q),
			)
		: models;
	// Pinned models first, in pin order; the rest keep their listing order.
	// Favorites are provider/id keys (legacy bare ids still rank/light up
	// so old pins keep working).
	const favRank = new Map(favs.map((key, i) => [key, i] as const));
	const favKeyOf = (m: WireModel): string => `${m.provider}/${m.id}`;
	const rankOf = (m: WireModel): number | undefined => favRank.get(favKeyOf(m)) ?? favRank.get(m.id);
	const sorted = [...filtered].sort((a, b) => {
		const ra = rankOf(a);
		const rb = rankOf(b);
		if (ra !== undefined && rb !== undefined) return ra - rb;
		if (ra !== undefined) return -1;
		if (rb !== undefined) return 1;
		return 0;
	});

	const select = (id: string): void => {
		const selected = models.find(m => m.id === id);
		tapFeedback(1);
		// Lock the seeding chain: a real pick always wins from now on.
		userPicked.current = true;
		// Selection state is the provider/id composite: two providers serving
		// the same bare id (opencode-go vs opencode-zen both offer
		// deepseek-v4-flash) must highlight only the picked row.
		setModelId(selected ? `${selected.provider}/${selected.id}` : id);
		setOpen(false);
		if (sessionId) {
			// Notify AFTER the daemon switched the model — consumers re-fetch
			// per-model state (thinkingInfo ceiling/ladder) and would race the
			// in-flight setModel and read the OLD model's data. The provider
			// rides along so the daemon resolves the exact model, not the first
			// provider that happens to serve the same id.
			void rpc
				.request("session.setModel", { sessionId, model: { id, provider: selected?.provider } })
				.then(() => onSelect?.(id, selected?.provider))
				.catch(() => {});
		} else {
			onSelect?.(id, selected?.provider);
		}
	};

	return (
		<div className="gui-model" ref={anchorRef}>
			<button
				type="button"
				className="gui-model-btn"
				onClick={() => setOpen(v => !v)}
				title={current ? `${current.provider}/${current.id} · ${current.name}` : t("model")}
				aria-label={t("select model")}
			>
				<Icon name="ai-agent" className="h-3.5 w-3.5" />
				<span className="truncate" style={{ maxWidth: maxLabelWidth }}>{label}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
			</button>
			{renderMenu(
				<div className="gui-model-menu">
					<div className="gui-model-menu-search">
						<Icon name="search" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder={t("search models…")}
							className="gui-model-menu-input"
							aria-label={t("search models…")}
						/>
					</div>
					<div className="gui-model-list" ref={listRef}>
					{filtered.length === 0 && <div className="gui-model-empty">{t("no matching models")}</div>}
					{sorted.map(m => {
						const favKey = favKeyOf(m);
						const fav = favs.includes(favKey) || favs.includes(m.id);
						return (
							// Row is a div (role=button) so the favorite star can be a
							// real <button> inside it — nested buttons are invalid HTML.
							<div
								key={`${m.provider}/${m.id}`}
								role="button"
								tabIndex={0}
								className={`gui-model-opt${`${m.provider}/${m.id}` === modelId ? " gui-model-opt--active" : ""}`}
								onClick={() => select(m.id)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										select(m.id);
									}
								}}
							>
								<span className="flex min-w-0 flex-1 items-center gap-2">
									<span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
									<span className="gui-provider-chip">{m.provider}</span>
								</span>
								<button
									type="button"
									className={`gui-model-fav${fav ? " gui-model-fav--on" : ""}`}
									title={fav ? t("unfavorite model") : t("favorite model")}
									aria-label={fav ? t("unfavorite model") : t("favorite model")}
									onClick={e => {
										e.stopPropagation();
										toggleFavModel(m.id, m.provider);
									}}
								>
									<Icon name={fav ? "star-fill" : "star"} className="h-3.5 w-3.5" />
								</button>
								{allowSetDefault && (
									<button
										type="button"
										className={`gui-model-fav${`${m.provider}/${m.id}` === defaultRoleModel || m.id === defaultRoleModel ? " gui-model-fav--on" : ""}`}
										title={`${m.provider}/${m.id}` === defaultRoleModel || m.id === defaultRoleModel ? t("default model") : t("set as default model")}
										aria-label={`${m.provider}/${m.id}` === defaultRoleModel || m.id === defaultRoleModel ? t("default model") : t("set as default model")}
										onClick={e => {
											e.stopPropagation();
											setAsDefault(m.id, m.provider);
										}}
									>
										<Icon
											name={`${m.provider}/${m.id}` === defaultRoleModel || m.id === defaultRoleModel ? "target-fill" : "target"}
											className="h-3.5 w-3.5"
										/>
									</button>
								)}
						{`${m.provider}/${m.id}` === modelId && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
						</div>
					);
					})}
					</div>
				</div>,
			)}
		</div>
	);
}
