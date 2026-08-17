import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "./rpc";
/**
 * Renderer-side component slots (DSH ui-slots analogue): extensions
 * register components via `pi.registerComponent({ slot, moduleUrl })`, the
 * daemon compiles them to self-contained ESM and serves the code through
 * `extensions.list`; this module dynamically imports (blob: URL) and mounts
 * the default export into the slot. Enable/disable takes effect within the
 * 10s poll window — no restart, no rebuild.
 */

/** First slot id — the settings page's extension-contributed section. */
export const SETTINGS_EXTENSION_SLOT = "settings.extensions";
/** Right-side workspace panel slot (modes v2 右面板 Phase 0-2): extensions
 *  contribute tabs/sections to the right pane via
 *  `pi.registerComponent({ slot: "panel.right", moduleUrl })`. */
export const RIGHT_PANEL_SLOT = "panel.right";
/** Right-edge 44px icon rail slot (openchamber ContextPanelRail parity):
 *  extension icons mount at the rail's bottom section. */
export const RIGHT_RAIL_SLOT = "rail.right";

export interface SlotComponent {
	slot: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). */
	code: string;
	error?: string;
}

/** Poll extensions.list (daemon caches 10s) and pick compiled components for one slot.
 *  The daemon's extension watcher (HMR) pushes `extensions.changed` — that
 *  triggers an immediate reload instead of waiting for the next poll. */
export function useSlotComponents(rpc: RpcClient | null, slot: string): SlotComponent[] {
	const [items, setItems] = useState<SlotComponent[]>([]);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{ components?: SlotComponent[] } | null>("extensions.list", {})
				.then(res => {
					if (!alive) return;
					setItems((res?.components ?? []).filter(c => c.slot === slot && c.code.length > 0));
				})
				.catch(() => alive && setItems([]));
		};
		load();
		const id = setInterval(load, 10_000);
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") load();
		});
		return () => {
			alive = false;
			clearInterval(id);
			off();
		};
	}, [rpc, slot]);
	return items;
}

/** Mount every extension-contributed component registered for a slot. */
export function SlotComponentHost({ rpc, slot }: { rpc: RpcClient | null; slot: string }): ReactNode {
	const items = useSlotComponents(rpc, slot);
	return (
		<>
			{items.map(item => (
				<DynamicComponent key={item.extensionId} item={item} />
			))}
		</>
	);
}

function DynamicComponent({ item }: { item: SlotComponent }): ReactNode {
	const [error, setError] = useState<string | null>(null);
	const [Comp, setComp] = useState<ComponentType | null>(null);
	useEffect(() => {
		let alive = true;
		let url: string | null = null;
		void (async () => {
			try {
				// Compiled components bind to the HOST react instance via the
				// `React` identifier (window.MusePiReact) — see
				// daemon/extension-components.ts. Inject before import.
				(window as unknown as { MusePiReact: unknown }).MusePiReact = React;
				// Dynamic import: specifier is a runtime blob URL served from
				// the extension registry — static import is impossible here.
				url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
				const mod = (await import(url)) as { default?: ComponentType };
				if (!alive) return;
				const Component = mod.default;
				if (typeof Component !== "function") {
					throw new Error("component module must export a default React component");
				}
				// React 19:setState(函数) 会被当作 updater 执行 —— 直接传
				// Component 会把它调用一次,state 变成执行结果(JSX 元素),
				// 渲染时 "<Comp />" 报 "got: <div />"。包一层返回组件本身。
				setComp(() => Component);
			} catch (e) {
				if (alive) setError(String(e));
			}
		})();
		return () => {
			alive = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [item]);
	if (error) {
		return (
			<div className="gui-slot-error">
				{item.label ?? item.extensionId}: 组件加载失败 — {error}
			</div>
		);
	}
	if (!Comp) return null;
	return <Comp />;
}
