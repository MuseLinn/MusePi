import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
 * ① toolbar from the registry; ② has-content items hidden when empty;
 * ③ draggable reorder persisted to localStorage; ④ width starts from
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
}: {
	rpc: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
	tool: string | null;
	rightPanelOpen: boolean;
	onSelect(tool: string): void;
	onToggleRightPanel?(): void;
}): ReactNode {
	// 顺序（目录级）+ 面板宽（目录级）
	const [order, setOrder] = useState<string[]>(() => readSurfaceOrder(cwd));
	const [width, setWidth] = useState<number>(() => readSurfaceWidth(cwd));
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
		return ordered;
	}, [order, ctx]);

	const persist = useCallback((next: string[]) => { setOrder(next); writeSurfaceOrder(next, cwd); }, [cwd]);

	// 拖拽重排（原生 HTML5 drag）
	const [dragId, setDragId] = useState<string | null>(null);
	const onDrop = (targetId: string): void => {
		if (!dragId || dragId === targetId) return;
		const ids = order.filter(id => id !== dragId);
		const ti = ids.indexOf(targetId);
		ids.splice(ti < 0 ? ids.length : ti, 0, dragId);
		persist(ids);
		setDragId(null);
	};

	useEffect(() => {
		const apply = (id: string): void => {
			const s = surfaceById(id);
			if (!s) return;
			setWidth(w => {
				const next = Math.max(200, Math.min(560, Math.round((s.defaultWidthFraction ?? 0.5) * 560)));
				writeSurfaceWidth(next, cwd);
				return w === 0 || w === 300 ? next : w; // 首次用默认占比，之后保持用户拖拽
			});
		};
		if (tool) apply(tool);
	}, [tool, cwd]);

	return (
		<aside className={`gui-right-rail${rightPanelOpen ? "" : " gui-right-rail--closed"}`} aria-label="right rail">
			<div className="gui-right-rail-group">
				{items.map(({ id, s }) => (
					<button
						key={id}
						type="button"
						draggable
						onDragStart={() => setDragId(id)}
						onDragOver={e => e.preventDefault()}
						onDrop={() => onDrop(id)}
						className={`gui-right-rail-btn${tool === id ? " gui-right-rail-btn--active" : ""}`}
						title={s.label}
						aria-label={s.label}
						aria-pressed={tool === id}
						onClick={() => onSelect(id)}
					>
						<Icon name={s.icon as IconName} className="h-4 w-4" />
					</button>
				))}
			</div>
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
