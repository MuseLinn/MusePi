import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchesModelQuery } from "../lib/fuzzy-model-match";
import { tapFeedback } from "../lib/haptic";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon } from "../vendor/oc-icons";
import { ModelBrandIcon } from "./model-brand-icon";
import { Reveal } from "./Reveal";
import { StateIcon } from "./StateIcon";

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow?: number | null;
	maxTokens?: number | null;
	reasoning?: boolean;
	vision?: boolean;
	video?: boolean;
	imageGen?: boolean;
	videoGen?: boolean;
	text?: boolean;
}

/** Compact context-window label ("128K", "1M", "200K") for the row chip. */
/** Generation endpoints (image/video gen) are not chat models: rows are
 *  grayed, refuse selection, and explain why on hover. */
function isGenerationModel(m: WireModel): boolean {
	return m.imageGen === true || m.videoGen === true;
}

function formatContextWindow(n?: number | null): string | null {
	if (n == null || n <= 0) return null;
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000) {
		const k = n / 1_000;
		return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, "")}K`;
	}
	return String(n);
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

/** Reorder favorites (grip drag, openchamber parity): move `fromKey` to
 *  just before `toKey` in the pin order and persist. Both keys are
 *  provider/id composites; a missing target appends to the end (legacy
 *  bare-id entries reorder only once re-pinned). */
function moveFavModel(fromKey: string, toKey: string): void {
	if (fromKey === toKey) return;
	const cur = readFavModels();
	const from = cur.indexOf(fromKey);
	if (from < 0) return;
	const without = cur.filter((_, i) => i !== from);
	const to = without.indexOf(toKey);
	const at = to < 0 ? without.length : to;
	const next = [...without.slice(0, at), fromKey, ...without.slice(at)];
	try {
		localStorage.setItem(FAV_MODELS_KEY, JSON.stringify(next));
	} catch {
		/* storage unavailable — keep the in-memory order for this session */
	}
	favModelsCache = next;
	for (const l of favListeners) l();
}

// ── Recently used models (openchamber 最近 section) ───────────────────────
// provider/id keys, most-recent-first, capped. Same external-store shape as
// favorites; pushed on every real pick so the menu's 最近 section mirrors
// what the user actually runs.
const RECENT_MODELS_KEY = "musepi-gui-recent-models";
const RECENT_MODELS_CAP = 5;

let recentModelsCache: string[] | null = null;

function readRecentModels(): string[] {
	if (recentModelsCache) return recentModelsCache;
	try {
		const raw = localStorage.getItem(RECENT_MODELS_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		recentModelsCache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		recentModelsCache = [];
	}
	return recentModelsCache;
}

const recentListeners = new Set<() => void>();

function subscribeRecentModels(listener: () => void): () => void {
	recentListeners.add(listener);
	return () => {
		recentListeners.delete(listener);
	};
}

function pushRecentModel(id: string, provider?: string): void {
	const key = provider ? `${provider}/${id}` : id;
	const next = [key, ...readRecentModels().filter(x => x !== key && x !== id)].slice(0, RECENT_MODELS_CAP);
	try {
		localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
	} catch {
		/* storage unavailable */
	}
	recentModelsCache = next;
	for (const l of recentListeners) l();
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
	capsule = false,
	onAddProvider,
	allowNone = false,
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
	/** Compact capsule presentation (ModelThinkingCapsule): switch the
	 *  container/button to the `.gui-model-capsule-seg(-btn)` classes and
	 *  anchor the menu on the button (ThinkingSelector parity). */
	capsule?: boolean;
	/** Top-menu action (openchamber 添加新提供商): opens the settings
	 *  providers page; omitted where no settings opener is reachable. */
	onAddProvider?(): void;
	/** Render the "not selected" clearing row (openchamber
	 *  includeNotSelected parity): a top action that reports the clear via
	 *  onSelect(null). Off by default — the live composer always has a
	 *  model; opt in where "no pick" is a real state (role pickers falling
	 *  back to auto selection). */
	allowNone?: boolean;
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

	// Registry mutations (models.add / models.remove) broadcast models.changed:
	// re-fetch so an ALREADY-MOUNTED selector picks up new/removed custom
	// providers without a session switch. The empty-state composer re-mounts
	// naturally and always looked fresh; the in-session one stays mounted and
	// used to keep its stale list until the user left and re-entered.
	const [catalogSeq, setCatalogSeq] = useState(0);
	useEffect(() => {
		if (!rpc) return;
		return rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "models.changed") setCatalogSeq(s => s + 1);
		});
	}, [rpc]);

	// Refresh the catalog only (no seeding): session mode lists the session's
	// available models, welcome mode the shared registry catalog.
	useEffect(() => {
		let alive = true;
		const method = sessionId ? "models.list" : "models.listAvailable";
		const params = sessionId ? { sessionId } : {};
		void rpc
			.request<WireModel[]>(method, params)
			.then(list => {
				if (!alive) return;
				setModels(list ?? []);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, catalogSeq]);

	// Seeding chain: user pick → the session's live model (authoritative:
	// survives /switch, model_downshift, and a stale global preselect from
	// another session) → explicit preselect (welcome carry-in / history
	// header) → the DEFAULT-role model → first listed. presetId may be a bare
	// id (daemon snapshot) or a provider/id composite — normalize to the
	// composite so the check highlight never lights two providers of the same
	// id. Re-runs after a catalog refresh (models.changed may have added or
	// removed an entry) but the user-pick lock keeps a made selection intact.
	useEffect(() => {
		const items = models;
		const candidate = sessionId ? currentModelId || presetId || defaultRoleModel : presetId || defaultRoleModel;
		setModelId(prev => {
			if (userPicked.current) return prev;
			const match = candidate
				? items.find(m => m.id === candidate || `${m.provider}/${m.id}` === candidate)
				: undefined;
			if (match) return `${match.provider}/${match.id}`;
			const first = items[0];
			return first ? `${first.provider}/${first.id}` : "";
		});
	}, [models, sessionId, currentModelId, presetId, defaultRoleModel]);

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
	const recents = useSyncExternalStore(subscribeRecentModels, readRecentModels);

	// Pure generation endpoints (agnes-image-*, gpt-image-*, dall-e, flux,
	// / agnes-video-*, veo, sora, …) cannot run the agent's chat/messages
	// loop — they respond to /v1/images/generations or /v1/videos, so picking
	// one as the session model ends in a 400 ("… is an image model. Use
	// /v1/images/generations."). They stay VISIBLE in the list (discoverability
	// — the user sees the image/video generation capability) but are disabled:
	// the row is grayed out and select() refuses them. The generate_image /
	// agnes_video_gen tools still target them. This must NOT disable
	// multimodal *understanding* models (e.g. deepseek-v4-flash-vision-exp):
	// those carry vision/video input flags, not imageGen/videoGen.
	// All listing derivation lives in ONE memo: mousemove/keypress re-renders
	// must not re-run the filter + section sort + provider grouping (and the
	// old per-row flatRows.indexOf O(n²)). `recents`/`favs` are stable
	// snapshots from useSyncExternalStore (module-cached), so this only
	// recomputes on a real data change.
	const [secClosed, setSecClosed] = useState<Record<string, boolean>>({});
	const { sections, flatRows, kbdIndexOf, isFav, favKeyOf, favRows, filtered } = useMemo(() => {
		const filtered = query.trim() ? models.filter(m => matchesModelQuery(query, m.provider, m.id, m.name)) : models;
		// Favorites are provider/id keys (legacy bare ids still rank/light up so
		// old pins keep working).
		const favKeyOf = (m: WireModel): string => `${m.provider}/${m.id}`;
		const isFav = (m: WireModel): boolean => favs.includes(favKeyOf(m)) || favs.includes(m.id);
		// Sectioned listing (openchamber 收藏/最近 parity): favorites in pin
		// order, then recents in use order (favorites excluded — a row renders
		// once), then the remaining catalog grouped by provider. Section
		// headers SURVIVE search (openchamber keeps favorites/recent titles over
		// the filtered set): favRows/recentRows are already filtered subsets.
		// Favorites in PIN order (position in the favs store), not catalog
		// order — the grip-drag reorder below writes exactly that order.
		const favRank = new Map(favs.map((key, i) => [key, i] as const));
		const favRows = filtered
			.filter(isFav)
			.sort(
				(a, b) =>
					(favRank.get(favKeyOf(a)) ?? favRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
					(favRank.get(favKeyOf(b)) ?? favRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
			);
		const recentRank = new Map(recents.map((key, i) => [key, i] as const));
		const favSet = new Set(favRows);
		const recentRows = filtered
			.filter(m => !isFav(m) && (recentRank.has(favKeyOf(m)) || recentRank.has(m.id)))
			.sort(
				(a, b) =>
					(recentRank.get(favKeyOf(a)) ?? recentRank.get(a.id) ?? 99) -
					(recentRank.get(favKeyOf(b)) ?? recentRank.get(b.id) ?? 99),
			);
		// Set lookup instead of the old restRows.includes(m) linear scan (O(n²)).
		const recentSet = new Set(recentRows);
		const restRows = filtered.filter(m => !favSet.has(m) && !recentSet.has(m));
		// Rest of the catalog grouped by provider (openchamber provider
		// sections): one collapsible header per provider, first-seen order.
		const providerSections: Array<{ provider: string; rows: WireModel[] }> = [];
		const byProvider = new Map<string, WireModel[]>();
		for (const m of restRows) {
			let rows = byProvider.get(m.provider);
			if (!rows) {
				rows = [];
				byProvider.set(m.provider, rows);
				providerSections.push({ provider: m.provider, rows });
			}
			rows.push(m);
		}
		// Collapsible sections (chevron per header, per-menu session state).
		// Label KEYS ride through the memo (t() resolves at render time so a
		// language switch relabels without a data change); the literal union
		// keeps the t() key-typing intact.
		const nextSections: Array<{
			key: string;
			labelKey: "favorite models" | "recent models" | null;
			label: string;
			rows: WireModel[];
		}> = [];
		if (favRows.length > 0) nextSections.push({ key: "fav", labelKey: "favorite models", label: "", rows: favRows });
		if (recentRows.length > 0)
			nextSections.push({ key: "recent", labelKey: "recent models", label: "", rows: recentRows });
		for (const { provider, rows } of providerSections) {
			nextSections.push({ key: `provider:${provider}`, labelKey: null, label: provider, rows });
		}
		const nextFlat = nextSections.flatMap(s => (secClosed[s.key] ? [] : s.rows));
		const kbdIndexByKey = new Map<string, number>();
		nextFlat.forEach((m, i) => kbdIndexByKey.set(`${m.provider}/${m.id}`, i));
		return {
			sections: nextSections,
			flatRows: nextFlat,
			kbdIndexOf: (m: WireModel): number => kbdIndexByKey.get(`${m.provider}/${m.id}`) ?? -1,
			// Exposed for the row renderers (fav star state) and the drag/items
			// wiring (favKeyOf keys) plus the empty-state check.
			isFav,
			favKeyOf,
			favRows,
			filtered,
		};
	}, [models, query, favs, recents, secClosed]);
	const searching = query.trim().length > 0;
	// Favorite grip-drag (openchamber parity, @dnd-kit — same library every
	// openchamber drag site uses): drag from a small grip handle; the
	// PointerSensor 8px activation threshold keeps clicks from starting a
	// drag. Disabled while searching (openchamber keeps its sensors off over
	// a filtered set) and when there is nothing to swap against.
	const favDragEnabled = !searching && favRows.length > 1;
	const favSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
	const onFavDragEnd = useCallback((e: DragEndEvent): void => {
		const from = String(e.active.id);
		const over = e.over;
		if (!over || from === String(over.id)) return;
		moveFavModel(from, String(over.id));
	}, []);
	const [kbd, setKbd] = useState(-1);
	// Latest select() without re-creating onMenuKeyDown every render (select
	// is declared below; the callback body resolves it at call time).
	const selectRef = useRef<(m: WireModel) => void>(() => {});
	// Hover-vs-keyboard split (openchamber handleMouseActivity parity, made
	// cheap): the POINTER highlight is pure CSS `:hover` — per-row mousemove
	// never sets highlight state. That was the open lag: every row crossing
	// re-rendered this whole multi-hundred-row list. ↑↓ OWNS the highlight
	// instead: while it does, the list carries data-kbd-nav (CSS suppresses
	// row :hover so a cursor parked over the list can't paint a second wash),
	// and the FIRST real pointer move yields ownership back (kbd → -1, one
	// render). Scroll-fueled mousemove at a stationary cursor (same
	// clientX/clientY while rows slide underneath) still can't steal the
	// highlight — the moved guard below (openchamber order).
	const [kbdOwner, setKbdOwner] = useState(false);
	const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
	const onRowMouseMove = useCallback((e: React.MouseEvent): void => {
		const next = { x: e.clientX, y: e.clientY };
		const prev = lastMouseRef.current;
		const moved = !prev || prev.x !== next.x || prev.y !== next.y;
		// Track the position unconditionally — the moved guard decides
		// whether THIS event may take the highlight back (openchamber order).
		lastMouseRef.current = next;
		if (!moved) return;
		// Both setState calls bail out (same value) while the keyboard does
		// NOT own the highlight, so cruising the list costs zero renders.
		setKbd(-1);
		setKbdOwner(false);
	}, []);
	// Keep the keyboard-highlighted row in view (openchamber parity): the
	// roving highlight scrolls with ↑↓ instead of running off-list.
	useEffect(() => {
		if (kbd < 0) return;
		const el = listRef.current?.querySelector<HTMLElement>(`[data-kbd-idx="${kbd}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [kbd]);
	// Pre-highlight the first visible row on open and after every search
	// keystroke (openchamber selectionStore.set(0) parity — Enter without
	// ↑↓ picks the top row). Closing clears the highlight AND the mouse
	// tracking so the next open starts fresh.
	useEffect(() => {
		setKbd(open ? 0 : -1);
		if (!open) {
			lastMouseRef.current = null;
		}
	}, [open, query]);
	const onMenuKeyDown = useCallback(
		(e: React.KeyboardEvent): void => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				if (flatRows.length === 0) return;
				// Keyboard takes ownership: subsequent scroll-driven mousemoves
				// must not steal the highlight back (openchamber moveSelection).
				setKbdOwner(true);
				lastMouseRef.current = null;
				setKbd(prev => {
					const delta = e.key === "ArrowDown" ? 1 : -1;
					return (prev + delta + flatRows.length) % flatRows.length;
				});
			} else if (e.key === "Enter") {
				const row = flatRows[kbd];
				if (row) {
					e.preventDefault();
					selectRef.current(row);
				}
			}
		},
		[flatRows, kbd],
	);

	const select = useCallback(
		(m: WireModel): void => {
			// Generation endpoints can't be the session model — the row is disabled,
			// but guard here too (Enter/Space keys, future callers).
			if (isGenerationModel(m)) {
				tapFeedback(1);
				return;
			}
			// The clicked row IS the model — never re-resolve by bare id: two
			// providers serve the same id (opencode-go vs b-ai
			// deepseek-v4-flash-vision-exp) and a bare-id find would pick the
			// first favorite-ranked one, silently switching providers.
			const selected = m;
			tapFeedback(1);
			// Lock the seeding chain: a real pick always wins from now on.
			userPicked.current = true;
			pushRecentModel(selected.id, selected.provider);
			// Selection state is the provider/id composite: two providers serving
			// the same bare id (opencode-go vs opencode-zen both offer
			// deepseek-v4-flash) must highlight only the picked row.
			setModelId(`${selected.provider}/${selected.id}`);
			setOpen(false);
			if (sessionId) {
				// Notify AFTER the daemon switched the model — consumers re-fetch
				// per-model state (thinkingInfo ceiling/ladder) and would race the
				// in-flight setModel and read the OLD model's data. The provider
				// rides along so the daemon resolves the exact model, not the first
				// provider that happens to serve the same id.
				void rpc
					.request("session.setModel", { sessionId, model: { id: selected.id, provider: selected.provider } })
					.then(() => onSelect?.(selected.id, selected.provider))
					.catch(() => {});
			} else {
				onSelect?.(selected.id, selected.provider);
			}
		},
		[sessionId, onSelect],
	);
	// Published for onMenuKeyDown (declared above): Enter resolves the
	// highlighted row through the latest select.
	selectRef.current = select;

	return (
		<div className={capsule ? "gui-model-capsule-seg" : "gui-model"} ref={capsule ? undefined : anchorRef}>
			<button
				type="button"
				className={capsule ? "gui-model-capsule-seg-btn" : "gui-model-btn"}
				ref={capsule ? anchorRef : undefined}
				onClick={() => setOpen(v => !v)}
				title={current ? `${current.provider}/${current.id} · ${current.name}` : t("model")}
				aria-label={t("select model")}
			>
				{current ? (
					<ModelBrandIcon provider={current.provider} modelId={current.id} size={14} />
				) : (
					<Icon name="ai-agent" className="h-3.5 w-3.5" />
				)}
				<span className="gui-model-capsule-seg-text truncate" style={{ maxWidth: maxLabelWidth }}>
					{label}
				</span>
				<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
			</button>
			{renderMenu(
				<div className="gui-model-menu" onKeyDown={onMenuKeyDown}>
					{onAddProvider && (
						<button type="button" className="gui-model-add" onClick={onAddProvider}>
							<Icon name="add" className="h-3.5 w-3.5" />
							<span>{t("add provider")}</span>
						</button>
					)}
					<div className="gui-model-menu-search">
						<Icon name="search" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder={t("search models…")}
							className="gui-model-menu-input"
							aria-label={t("search models…")}
							/* Focused on open so ↑↓/Enter navigation works without a
							 * pointing-device detour (openchamber menu parity). */
							autoFocus
						/>
					</div>
					<div className="gui-model-list" ref={listRef} data-kbd-nav={kbdOwner || undefined}>
						{/* "not selected" clearing row (openchamber includeNotSelected
						 * parity): lives OUTSIDE the ↑↓/Enter flat list, exactly like
						 * the reference — it's an action, not a model row. */}
						{allowNone && (
							<>
								<button
									type="button"
									className="gui-model-none"
									onClick={() => {
										tapFeedback(1);
										setOpen(false);
										onSelect?.(null);
									}}
								>
									<Icon name="close" className="h-3.5 w-3.5" />
									<span>{t("not selected")}</span>
									{!current && <Icon name="check" className="h-3.5 w-3.5" />}
								</button>
								<div className="gui-model-sep" aria-hidden="true" />
							</>
						)}
						{filtered.length === 0 && <div className="gui-model-empty">{t("no matching models")}</div>}
						{sections.map(sec => {
							const closed = secClosed[sec.key] === true;
							return (
								<div key={sec.key} className="gui-model-sec">
									{sec.label && (
										<button
											type="button"
											className="gui-model-sec-head"
											aria-expanded={!closed}
											onClick={() => setSecClosed(prev => ({ ...prev, [sec.key]: !closed }))}
										>
											<Icon
												name="arrow-down-s"
												className={`h-3 w-3 transition-transform${closed ? " -rotate-90" : ""}`}
											/>
											<span>{sec.labelKey ? t(sec.labelKey) : sec.label}</span>
											<span className="gui-model-sec-count">{sec.rows.length}</span>
										</button>
									)}
									{/* Standard height-collapse (§3 motion): the section body
									 * eases instead of snapping — matches every other fold.
									 * Favorite rows are sortable (@dnd-kit, openchamber
									 * parity) — DndContext lives at the section level so the
									 * sensors only cover favorites. */}
									<Reveal open={!closed}>
										{favDragEnabled && sec.key === "fav" ? (
											<DndContext
												sensors={favSensors}
												collisionDetection={closestCenter}
												onDragEnd={onFavDragEnd}
											>
												<SortableContext
													items={sec.rows.map(m => favKeyOf(m))}
													strategy={verticalListSortingStrategy}
												>
													{sec.rows.map(m => (
														<SortableModelRow
															key={`${m.provider}/${m.id}`}
															m={m}
															fav={isFav(m)}
															sortable
															modelId={modelId}
															defaultRoleModel={defaultRoleModel}
															allowSetDefault={allowSetDefault}
															kbdIndex={kbdIndexOf(m)}
															kbd={kbd}
															onRowMouseMove={onRowMouseMove}
															onSelectRow={select}
															onToggleFav={toggleFavModel}
															onSetDefault={setAsDefault}
														/>
													))}
												</SortableContext>
											</DndContext>
										) : (
											sec.rows.map(m => (
												<ModelRow
													key={`${m.provider}/${m.id}`}
													m={m}
													fav={isFav(m)}
													modelId={modelId}
													defaultRoleModel={defaultRoleModel}
													allowSetDefault={allowSetDefault}
													kbdIndex={kbdIndexOf(m)}
													kbd={kbd}
													onRowMouseMove={onRowMouseMove}
													onSelectRow={select}
													onToggleFav={toggleFavModel}
													onSetDefault={setAsDefault}
												/>
											))
										)}
									</Reveal>
								</div>
							);
						})}
					</div>
					<div className="gui-model-menu-foot">{t("model menu hint")}</div>
				</div>,
			)}
		</div>
	);
}

interface ModelRowProps {
	m: WireModel;
	fav: boolean;
	sortable?: boolean;
	modelId?: string | null;
	defaultRoleModel?: string | null;
	allowSetDefault?: boolean;
	kbdIndex: number;
	kbd: number;
	onRowMouseMove(e: React.MouseEvent): void;
	onSelectRow(m: WireModel): void;
	onToggleFav(id: string, provider: string): void;
	onSetDefault(id: string, provider: string): void;
}

/** Favorite row with @dnd-kit sortable wiring (openchamber parity): the
 *  transform animates the row as it is dragged, and the grip is the sole
 *  drag activator so the row's own click/star/default buttons stay
 *  clickable. */
function SortableModelRow(props: ModelRowProps): ReactNode {
	const { m } = props;
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: `${m.provider}/${m.id}`,
	});
	return (
		<ModelRow
			{...props}
			rowRef={setNodeRef}
			rowStyle={transform ? { transform: CSS.Transform.toString(transform), transition } : undefined}
			dragging={isDragging}
			gripRef={setActivatorNodeRef}
			gripProps={{ ...attributes, ...listeners }}
		/>
	);
}

// memo'd so a keyboard ↑↓ only re-renders the two rows whose --kbd state
// changed (the highlight owner moved), not the whole multi-hundred-row
// list — with the CSS :hover handoff above this is what keeps the menu
// click-snappy on big catalogs.
const ModelRow = memo(function ModelRow({
	m,
	fav,
	sortable,
	modelId,
	defaultRoleModel,
	allowSetDefault,
	kbdIndex,
	kbd,
	onRowMouseMove,
	onSelectRow,
	onToggleFav,
	onSetDefault,
	rowRef,
	rowStyle,
	dragging,
	gripRef,
	gripProps,
}: ModelRowProps & {
	rowRef?(el: HTMLElement | null): void;
	rowStyle?: React.CSSProperties;
	dragging?: boolean;
	gripRef?(el: HTMLElement | null): void;
	gripProps?: Record<string, unknown>;
}): ReactNode {
	const isDefault = `${m.provider}/${m.id}` === defaultRoleModel || m.id === defaultRoleModel;
	const genModel = isGenerationModel(m);
	const capTitle = [
		m.text !== false ? t("text input") : null,
		m.vision ? t("image understanding") : null,
		m.video ? t("video understanding") : null,
		m.imageGen ? t("image generation") : null,
		m.videoGen ? t("video generation") : null,
		m.reasoning ? t("reasoning") : null,
	]
		.filter((rowLabel): rowLabel is string => rowLabel !== null)
		.join(" · ");
	const genNote = genModel
		? m.imageGen
			? t("image generation model — use the generate_image tool")
			: t("video generation model — use the video generation tool")
		: undefined;
	return (
		// Row is a div (role=button) so the favorite star can be a real
		// <button> inside it — nested buttons are invalid HTML.
		<div
			ref={rowRef}
			role="button"
			tabIndex={genModel ? -1 : 0}
			aria-disabled={genModel || undefined}
			title={genNote}
			data-kbd-idx={kbdIndex}
			style={rowStyle}
			className={`gui-model-opt gui-model-opt--stack${`${m.provider}/${m.id}` === modelId ? " gui-model-opt--active" : ""}${genModel ? " gui-model-opt--gen" : ""}${kbdIndex >= 0 && kbdIndex === kbd ? " gui-model-opt--kbd" : ""}${dragging ? " gui-model-opt--dragging" : ""}`}
			onClick={() => onSelectRow(m)}
			onMouseMove={onRowMouseMove}
			onKeyDown={e => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelectRow(m);
				}
			}}
		>
			<span className="gui-model-opt-line">
				{sortable && (
					<button
						type="button"
						ref={gripRef}
						className="gui-model-grip"
						title={t("drag to reorder favorites")}
						aria-label={t("drag to reorder favorites")}
						onClick={e => e.stopPropagation()}
						{...(gripProps as Record<string, never>)}
					>
						<Icon name="draggable" className="h-3.5 w-3.5" />
					</button>
				)}
				<span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
				<span className="gui-model-cap" title={capTitle || undefined} aria-label={capTitle || undefined}>
					{m.text !== false && <Icon name="text" className="h-3.5 w-3.5" />}
					{m.vision && <Icon name="file-image" className="h-3.5 w-3.5" />}
					{m.video && <Icon name="file-video" className="h-3.5 w-3.5" />}
					{m.imageGen && <Icon name="palette" className="h-3.5 w-3.5" />}
					{m.videoGen && <Icon name="record-circle" className="h-3.5 w-3.5" />}
					{m.reasoning && <Icon name="brain-ai-3" className="h-3.5 w-3.5" />}
				</span>
				<button
					type="button"
					className={`gui-model-fav${fav ? " gui-model-fav--on" : ""}`}
					title={fav ? t("unfavorite model") : t("favorite model")}
					aria-label={fav ? t("unfavorite model") : t("favorite model")}
					onClick={e => {
						e.stopPropagation();
						onToggleFav(m.id, m.provider);
					}}
				>
					<StateIcon on={fav} pair={["star-fill", "star"]} className="h-3.5 w-3.5" />
				</button>
				{allowSetDefault && (
					<button
						type="button"
						className={`gui-model-fav${isDefault ? " gui-model-fav--on" : ""}`}
						title={isDefault ? t("default model") : t("set as default model")}
						aria-label={isDefault ? t("default model") : t("set as default model")}
						onClick={e => {
							e.stopPropagation();
							onSetDefault(m.id, m.provider);
						}}
					>
						<StateIcon on={isDefault} pair={["target-fill", "target"]} className="h-3.5 w-3.5" />
					</button>
				)}
				{`${m.provider}/${m.id}` === modelId && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
			</span>
			<span className="gui-model-opt-meta">
				<span className="gui-provider-chip">{m.provider}</span>
				{formatContextWindow(m.contextWindow) && (
					<span className="gui-model-ctx">{formatContextWindow(m.contextWindow)}</span>
				)}
			</span>
		</div>
	);
});
