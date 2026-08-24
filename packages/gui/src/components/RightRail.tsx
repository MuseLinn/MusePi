import { t, type TranslationKey } from "@musepi/desktop-web";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon, type IconName } from "../vendor/oc-icons";
import {
	readSurfaceOrder,
	readSurfaceWidth,
	surfaceById,
	surfaceVisible,
	writeSurfaceOrder,
	writeSurfaceWidth,
	SURFACES,
	type SurfaceProps,
} from "../lib/surfaces/registry";
import { RIGHT_RAIL_SLOT, SlotComponentHost } from "../lib/slot-host";

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
	const extItems = useMemo(
		() => extTabs.map(item => ({ id: `ext:${item.slot}`, item })),
		[extTabs],
	);

	// primary → rail 图标；secondary → 折叠菜单
	const primaryItems = useMemo(() => items.filter(({ s }) => s.group === "primary"), [items]);
	const secondaryItems = useMemo(() => items.filter(({ s }) => s.group !== "primary"), [items]);

	const persist = useCallback((next: string[]) => { setOrder(next); writeSurfaceOrder(next, cwd); }, [cwd]);

	// 拖拽重排（原生 HTML5 drag，primary 组内）
	const [dragId, setDragId] = useState<string | null>(null);
	const onDrop = (targetId: string): void => {
		if (!dragId || dragId === targetId) return;
		const ids = order.filter(id => id !== dragId);
		const ti = ids.indexOf(targetId);
		ids.splice(ti < 0 ? ids.length : ti, 0, dragId);
		persist(ids);
		setDragId(null);
	};

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
		<aside className={`gui-right-rail${rightPanelOpen ? "" : " gui-right-rail--closed"}`} aria-label="right rail">
			{/* The single navigation axis (VSCode Activity-Bar unification).
			 * Scrolls when a short window cannot fit every view; edges
			 * feather only while overflowing. */}
			<div
				ref={scrollRef}
				className="gui-right-rail-group gui-right-rail-scroll"
				data-feathered={feathered ? "" : undefined}
			>
				{primaryItems.map(({ id, s }) => (
					<button
						key={id}
						type="button"
						draggable
						onDragStart={() => setDragId(id)}
						onDragOver={e => e.preventDefault()}
						onDrop={() => onDrop(id)}
						className={`gui-right-rail-btn${tool === id ? " gui-right-rail-btn--active" : ""}`}
						title={t(s.label as TranslationKey)}
						aria-label={t(s.label as TranslationKey)}
						aria-pressed={tool === id}
						onClick={() => onSelect(id)}
					>
						<Icon name={s.icon as IconName} className="h-4 w-4" />
					</button>
				))}
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
			{secondaryItems.length > 0 && (
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
							{secondaryItems.map(({ id, s }) => (
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
					<Icon name={rightPanelOpen ? "arrow-right" : "arrow-left"} className="h-4 w-4" />
				</button>
				<SlotComponentHost rpc={rpc} slot={RIGHT_RAIL_SLOT} sessionId={sessionId} cwd={cwd} />
			</div>
		</aside>
	);
}
