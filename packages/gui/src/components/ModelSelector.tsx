import { t } from "@musepi/collab-web";
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
const FAV_MODELS_KEY = "omp-gui-fav-models";

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

function toggleFavModel(id: string): void {
	const cur = readFavModels();
	const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
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
 * models (daemon models.list) and switches via session.setModel. Without
 * one (welcome composer) it lists the registry catalog (models.listAvailable)
 * as a preselect-only picker; the parent applies the choice once a session
 * is created. The selected id is also published to the parent via onSelect.
 */
export function ModelSelector({
	rpc,
	sessionId,
	onSelect,
	presetId,
}: {
	rpc: RpcClient;
	sessionId: string | null;
	onSelect?(modelId: string | null, provider?: string): void;
	/** Preferred initial id (e.g. welcome-composer preselect applied to the
	 *  new session); kept when present in the listing. */
	presetId?: string | null;
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
				// Keep an existing selection (welcome preselect carried into the
				// session, or the presetId) when still available; else first.
				setModelId(prev => {
					const candidate = presetId ?? prev;
					if (candidate && items.some(m => m.id === candidate)) return candidate;
					return items[0]?.id ?? "";
				});
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, presetId]);

	// Dismissal is unified in useFloatingMenu (outside mousedown + Escape).

	const current = models.find(m => m.id === modelId);
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
	const favRank = new Map(favs.map((id, i) => [id, i] as const));
	const sorted = [...filtered].sort((a, b) => {
		const ra = favRank.get(a.id);
		const rb = favRank.get(b.id);
		if (ra !== undefined && rb !== undefined) return ra - rb;
		if (ra !== undefined) return -1;
		if (rb !== undefined) return 1;
		return 0;
	});

	const select = (id: string): void => {
		const selected = models.find(m => m.id === id);
		tapFeedback(1);
		setModelId(id);
		setOpen(false);
		if (sessionId) {
			// Notify AFTER the daemon switched the model — consumers re-fetch
			// per-model state (thinkingInfo ceiling/ladder) and would race the
			// in-flight setModel and read the OLD model's data.
			void rpc
				.request("session.setModel", { sessionId, model: { id } })
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
				title={current ? `${current.provider}/${current.id}` : t("model")}
				aria-label={t("select model")}
			>
				<Icon name="ai-agent" className="h-3.5 w-3.5" />
				<span className="max-w-[150px] truncate">{label}</span>
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
						const fav = favs.includes(m.id);
						return (
							// Row is a div (role=button) so the favorite star can be a
							// real <button> inside it — nested buttons are invalid HTML.
							<div
								key={`${m.provider}/${m.id}`}
								role="button"
								tabIndex={0}
								className={`gui-model-opt${m.id === modelId ? " gui-model-opt--active" : ""}`}
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
										toggleFavModel(m.id);
									}}
								>
									<Icon name={fav ? "star-fill" : "star"} className="h-3.5 w-3.5" />
								</button>
						{m.id === modelId && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
						</div>
					);
					})}
					</div>
				</div>,
			)}
		</div>
	);
}
