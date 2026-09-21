import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type TranslationKey, t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { RIGHT_RAIL_SLOT, SlotComponentHost } from "../lib/slot-host";
import {
	readSurfaceOrder,
	readSurfaceWidth,
	SURFACES,
	type SurfaceDescriptor,
	type SurfaceProps,
	surfaceById,
	surfaceVisible,
	writeSurfaceOrder,
	writeSurfaceWidth,
} from "../lib/surfaces/registry";
import { Icon, type IconName } from "../vendor/oc-icons";
import { RailTooltip } from "./RailTooltip";
import { StateIcon } from "./StateIcon";

/**
 * RightRail — the right-edge 44px icon rail, driven by the surface registry:
 * ① toolbar from the registry; ② primary-group surfaces render as icons,
 *    secondary-group surfaces fold into the "…" overflow menu (rail 过载治理);
 * ③ has-content items hidden when empty; ④ width starts from
 * defaultWidthFraction and persists. Keyboard (Mod+1..N / Mod+E / Mod+Shift+E)
 * stays in App/ChatView, not duplicated here.
 */
export function RightRail({
	rpc,
	sessionId,
	cwd,
	tool,
	rightPanelOpen,
	onSelect,
	onToggleRightPanel,
	extTabs = [],
}: {
	rpc: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
	tool: string | null;
	rightPanelOpen: boolean;
	onSelect(tool: string): void;
	onToggleRightPanel?(): void;
	/** Extension panel-tab slots (panel.tab.*), rendered as primary rail
	 *  items after the built-in surfaces (nav unification: the rail is the
	 *  single navigation axis — no second tab row in the panel header). */
	extTabs?: import("../lib/slot-host").SlotComponent[];
}): ReactNode {
	// 顺序（目录级）+ 面板宽（目录级）
	const [order, setOrder] = useState<string[]>(() => readSurfaceOrder(cwd));
	const [width, setWidth] = useState<number>(() => readSurfaceWidth(cwd));
	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement | null>(null);
	const railRef = useRef<HTMLElement | null>(null);
	// Nav-axis overflow fold (user: 更多按钮只在高度不够时显示). When every
	// surface fits the rail height, render all (incl. secondary) as icons;
	// only a rail shorter than the item stack folds secondary into the "…".
	const [railFits, setRailFits] = useState(false);
	const ctx: SurfaceProps = useMemo(() => ({ rpc, sessionId, cwd }), [rpc, sessionId, cwd]);

	// 注册表顺序 → 渲染项（过滤 has-content 不可见；未知/扩展追加在尾）
	const items = useMemo(() => {
		const ordered: Array<{ id: string; s: import("../lib/surfaces/registry").SurfaceDescriptor }> = [];
		for (const id of order) {
			const s = surfaceById(id);
			if (!s) continue;
			if (!surfaceVisible(s, ctx)) continue;
			ordered.push({ id, s });
		}
		// Registry ids absent from a stale stored order still ship (the rail
		// grew from tools-only to the full nav axis).
		for (const s of SURFACES) {
			if (!order.includes(s.id) && surfaceVisible(s, ctx)) ordered.push({ id: s.id, s });
		}
		return ordered;
	}, [order, ctx]);

	// Extension tabs render as primary items after the built-ins.
	const extItems = useMemo(() => extTabs.map(item => ({ id: `ext:${item.slot}`, item })), [extTabs]);

	// primary → rail 图标；secondary → 折叠菜单
	const primaryItems = useMemo(() => items.filter(({ s }) => s.group === "primary"), [items]);
	const secondaryItems = useMemo(() => items.filter(({ s }) => s.group !== "primary"), [items]);
	// When the rail fits everything, show the whole order as icons (state
	// changes); otherwise keep the primary axis and fold secondary into "…".
	const railItems = railFits ? items : primaryItems;
	const foldedItems = railFits ? [] : secondaryItems;

	const persist = useCallback(
		(next: string[]) => {
			setOrder(next);
			writeSurfaceOrder(next, cwd);
		},
		[cwd],
	);

	// Drag reorder (openchamber ContextPanelRail parity, @dnd-kit): the
	// pointer must travel ≥8px to arm a drag, so a click never starts one;
	// touch waits 200ms/6px. The move resolves against the FULL order —
	// secondary surfaces and ones above the fold keep their relative slots.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
	);
	const onDragEnd = (e: DragEndEvent): void => {
		const active = String(e.active.id);
		const over = e.over ? String(e.over.id) : null;
		setDragging(false);
		if (!over || active === over) return;
		const from = order.indexOf(active);
		const to = order.indexOf(over);
		if (from === -1 || to === -1) return;
		persist(arrayMove(order, from, to));
	};
	const [dragging, setDragging] = useState(false);

	// ⌘/Ctrl hold-to-reveal order numbers (openchamber
	// RAIL_NUMBER_HOLD_DELAY_MS parity): ⌘1..8 jumps the nth rail icon, but
	// the mapping is invisible. Hold the modifier half a second and the
	// digits paint on the icons; releasing, losing focus, or actually
	// pressing a digit with the modifier dismisses them until the next hold.
	const [revealNumbers, setRevealNumbers] = useState(false);
	useEffect(() => {
		const HOLD_MS = 500;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let consumed = false;
		const held = new Set<string>();
		const modHeld = (): boolean => held.has("meta") || held.has("control");
		const disarm = (): void => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			setRevealNumbers(false);
		};
		const update = (): void => {
			if (modHeld()) {
				if (!consumed && timer === null) timer = setTimeout(() => setRevealNumbers(true), HOLD_MS);
			} else {
				consumed = false;
				disarm();
			}
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			held.add(e.key.toLowerCase());
			// A digit with the modifier IS the shortcut — consume the badges
			// for this hold (app.tsx owns the actual jump).
			if (modHeld() && e.key.length === 1 && e.key >= "0" && e.key <= "9") {
				consumed = true;
				disarm();
				return;
			}
			update();
		};
		const onKeyUp = (e: KeyboardEvent): void => {
			held.delete(e.key.toLowerCase());
			update();
		};
		const onBlur = (): void => {
			held.clear();
			consumed = false;
			disarm();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			if (timer !== null) clearTimeout(timer);
		};
	}, []);

	// Git changed-files badge (openchamber parity): a live count on the git
	// rail icon. Same RPC + 15s cadence as StatusCards — the panel shows the
	// same fact in words a few pixels away, so no second source of truth.
	// Paths deduped (a file can be staged AND modified again).
	const [gitChanges, setGitChanges] = useState<number | null>(null);
	useEffect(() => {
		if (!rpc || !cwd) {
			setGitChanges(null);
			return;
		}
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{
					staged?: { path: string }[];
					unstaged?: { path: string }[];
					untracked?: { path: string }[];
					error?: string;
				}>("git.status", { cwd })
				.then(res => {
					if (cancelled) return;
					if (res?.error) {
						setGitChanges(null);
						return;
					}
					const seen = new Set<string>();
					for (const f of [...(res?.staged ?? []), ...(res?.unstaged ?? []), ...(res?.untracked ?? [])]) {
						seen.add(f.path);
					}
					setGitChanges(seen.size);
				})
				.catch(() => {});
		};
		load();
		const id = window.setInterval(load, 15_000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [rpc, cwd]);

	// One hover tooltip for the whole rail (a single portal, not one per
	// icon): tracks the hovered button + which surface it is.
	const [tip, setTip] = useState<{ anchor: HTMLElement; id: string } | null>(null);

	// Nav-axis overflow measure: enable edge feathering only while the icon
	// column actually scrolls (short windows); a permanent mask would dim
	// the first/last icons for everyone.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [feathered, setFeathered] = useState(false);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const update = (): void => setFeathered(el.scrollHeight > el.clientHeight + 1);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [items.length, extItems.length, railFits]);

	// Does the whole surface stack fit the rail height? Drives the fold
	// (see railItems). Uses a per-item height so the decision never
	// oscillates from the render it controls.
	useEffect(() => {
		const el = railRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ITEM_H = 34; // 32px button + 2px column gap
		const PAD = 12; // group vertical padding (6+6)
		const update = (): void => {
			const count = items.length + extItems.length;
			setRailFits(PAD + count * ITEM_H <= el.clientHeight);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [items.length, extItems.length]);

	// 折叠菜单：点击外部关闭
	useEffect(() => {
		if (!overflowOpen) return;
		const onDocClick = (e: MouseEvent): void => {
			if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [overflowOpen]);

	useEffect(() => {
		const apply = (id: string): void => {
			const s = surfaceById(id);
			if (!s) return;
			setWidth(w => {
				const next = Math.max(200, Math.min(900, Math.round((s.defaultWidthFraction ?? 0.5) * 900)));
				writeSurfaceWidth(next, cwd);
				return w === 0 || w === 300 ? next : w; // 首次用默认占比，之后保持用户拖拽
			});
		};
		if (tool) apply(tool);
	}, [tool, cwd]);

	return (
		<aside
			ref={railRef}
			className={`gui-right-rail${rightPanelOpen ? "" : " gui-right-rail--closed"}`}
			aria-label="right rail"
		>
			{/* The single navigation axis (VSCode Activity-Bar unification).
			 * Scrolls when a short window cannot fit every view; edges
			 * feather only while overflowing. */}
			<div
				ref={scrollRef}
				className="gui-right-rail-group gui-right-rail-scroll"
				data-feathered={feathered ? "" : undefined}
			>
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragStart={() => setDragging(true)}
					onDragEnd={onDragEnd}
					onDragCancel={() => setDragging(false)}
				>
					<SortableContext items={railItems.map(({ id }) => id)} strategy={verticalListSortingStrategy}>
						{railItems.map(({ id, s }, index) => (
							<SortableRailItem
								key={id}
								id={id}
								s={s}
								active={tool === id}
								orderNumber={index + 1}
								revealNumbers={revealNumbers}
								badgeCount={id === "git" ? gitChanges : null}
								dragging={dragging}
								onSelect={onSelect}
								onHover={(anchor, hoverId) => setTip(anchor && hoverId ? { anchor, id: hoverId } : null)}
							/>
						))}
					</SortableContext>
				</DndContext>
				{extItems.map(({ id, item }) => (
					<button
						key={`${item.extensionId}:${item.slot}`}
						type="button"
						className={`gui-right-rail-btn${tool === id ? " gui-right-rail-btn--active" : ""}`}
						title={item.label ?? item.slot}
						aria-label={item.label ?? item.slot}
						aria-pressed={tool === id}
						onClick={() => onSelect(id)}
					>
						<Icon name="plug" className="h-4 w-4" />
					</button>
				))}
			</div>
			{foldedItems.length > 0 && (
				<div className="gui-right-rail-group" ref={overflowRef}>
					<button
						type="button"
						className={`gui-right-rail-btn${overflowOpen ? " gui-right-rail-btn--active" : ""}`}
						title="more tools"
						aria-label="more tools"
						aria-expanded={overflowOpen}
						onClick={() => setOverflowOpen(v => !v)}
					>
						<Icon name="more" className="h-4 w-4" />
					</button>
					{overflowOpen && (
						<div
							className="gui-right-rail-overflow"
							role="menu"
							aria-orientation="vertical"
							onKeyDown={e => {
								if (e.key === "Escape") {
									e.preventDefault();
									setOverflowOpen(false);
									return;
								}
								// ArrowUp/Down cycle items, Enter activates.
								const buttons = Array.from(
									e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
								);
								if (buttons.length === 0) return;
								const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
								if (e.key === "ArrowDown") {
									e.preventDefault();
									buttons[(idx + 1) % buttons.length]!.focus();
								} else if (e.key === "ArrowUp") {
									e.preventDefault();
									buttons[(idx - 1 + buttons.length) % buttons.length]!.focus();
								} else if (e.key === "Enter" || e.key === " ") {
									const active = document.activeElement as HTMLButtonElement | null;
									if (active?.getAttribute("role") === "menuitem") {
										e.preventDefault();
										active.click();
									}
								}
							}}
						>
							{foldedItems.map(({ id, s }) => (
								<button
									key={id}
									type="button"
									role="menuitem"
									className={`gui-right-rail-overflow-item${tool === id ? " gui-right-rail-overflow-item--active" : ""}`}
									onClick={() => {
										onSelect(id);
										setOverflowOpen(false);
									}}
								>
									<Icon name={s.icon as IconName} className="h-3.5 w-3.5" />
									<span>{t(s.label as TranslationKey)}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
			<div className="gui-right-rail-spacer" />
			<div className="gui-right-rail-group">
				<button
					type="button"
					className="gui-right-rail-btn"
					title={rightPanelOpen ? "collapse" : "expand"}
					aria-label={rightPanelOpen ? "collapse right panel" : "expand right panel"}
					onClick={() => onToggleRightPanel?.()}
				>
					<StateIcon on={rightPanelOpen} pair={["arrow-right", "arrow-left"]} className="h-4 w-4" />
				</button>
				<SlotComponentHost rpc={rpc} slot={RIGHT_RAIL_SLOT} sessionId={sessionId} cwd={cwd} />
			</div>
			<RailTooltip
				anchor={tip?.anchor ?? null}
				label={tip ? (surfaceById(tip.id)?.label ?? "context") : "context"}
				description={tip ? surfaceById(tip.id)?.description : undefined}
				extra={tip?.id === "git" && gitChanges ? t("{count} changed files", { count: gitChanges }) : null}
				suppressed={dragging}
			/>
		</aside>
	);
}

// ── Sortable rail item (openchamber ContextPanelRailItem parity) ──────────
// The whole icon button is the drag activator: it carries no nested buttons
// or inputs, and the 8px activation constraint keeps a click a click. The
// badge corner shows either the live git changed-files count or, while the
// ⌘/Ctrl modifier is held, the digit that jumps to this surface.
function SortableRailItem({
	id,
	s,
	active,
	orderNumber,
	revealNumbers,
	badgeCount,
	dragging,
	onSelect,
	onHover,
}: {
	id: string;
	s: SurfaceDescriptor;
	active: boolean;
	orderNumber: number;
	revealNumbers: boolean;
	badgeCount: number | null;
	dragging: boolean;
	onSelect(id: string): void;
	onHover(anchor: HTMLElement | null, hoverId: string | null): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
	const label = t(s.label as TranslationKey);
	const displayBadge = badgeCount != null && badgeCount > 0 ? (badgeCount > 99 ? "99+" : String(badgeCount)) : null;
	const badgeAria = badgeCount ? t("{count} changed files", { count: badgeCount }) : null;
	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={isDragging ? "gui-right-rail-item--dragging" : undefined}
		>
			<button
				type="button"
				{...attributes}
				{...listeners}
				className={`gui-right-rail-btn${active ? " gui-right-rail-btn--active" : ""}`}
				aria-label={badgeAria ? `${label}，${badgeAria}` : label}
				aria-pressed={active}
				onClick={() => onSelect(id)}
				onMouseEnter={e => onHover(e.currentTarget, id)}
				onMouseLeave={() => onHover(null, null)}
				onFocus={e => onHover(e.currentTarget, id)}
				onBlur={() => onHover(null, null)}
			>
				<Icon name={s.icon as IconName} className="h-4 w-4" />
				{revealNumbers ? (
					<span className="gui-right-rail-badge gui-right-rail-badge--order" aria-hidden="true">
						{orderNumber}
					</span>
				) : displayBadge ? (
					<span className="gui-right-rail-badge gui-right-rail-badge--count" aria-hidden="true">
						{displayBadge}
					</span>
				) : null}
			</button>
		</div>
	);
}
