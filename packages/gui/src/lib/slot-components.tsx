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
/** 内核级 slot 命名空间(P1 架构开放,DSH cordis slot 语义):slot 名是开放
 *  命名空间,前缀决定挂载位置,GUI 按前缀自动挂载 —— 扩展声明任意
 *  `panel.tab.<id>` / `settings.tab.<id>` / `rail.<id>` 即自动出现为
 *  tab/设置页/rail 图标,宿主不再逐槽位硬编码。保留的旧槽位
 *  (panel.right/rail.right/settings.extensions)语义不变。 */
export const PANEL_TAB_SLOT_PREFIX = "panel.tab.";
export const SETTINGS_TAB_SLOT_PREFIX = "settings.tab.";
export const RAIL_SLOT_PREFIX = "rail.";
/** Composer 座位槽(DSH conversation.input.dock/left/right 对齐):
 *  dock = 输入卡上方整行;left/right = 底部工具栏两端。list 语义 ——
 *  多个扩展可同时往同一槽注入组件。 */
export const COMPOSER_DOCK_SLOT = "composer.dock";
export const COMPOSER_LEFT_SLOT = "composer.left";
export const COMPOSER_RIGHT_SLOT = "composer.right";

export interface SlotComponent {
	slot: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). */
	code: string;
	error?: string;
	/** Component-scoped CSS extracted at compile time (rendered via <style>). */
	css?: string;
}

/** Props every extension component receives when mounted. Hosts pass what
 *  they have; a component must treat every field as optional — the same
 *  component may be mounted in different hosts (panel tab vs composer). */
export interface SlotComponentProps {
	/** Daemon RPC bridge (models.list / session.setModel / …). */
	rpc?: RpcClient | null;
	/** Active session id, when the host has one. */
	sessionId?: string | null;
	/** Session working directory, when the host has one. */
	cwd?: string;
	/** The slot id this component was registered into. */
	slot?: string;
	/** Extension path that contributed this component. */
	extensionId?: string;
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
					setItems((res?.components ?? []).filter(c => c.slot === slot && (c.code.length > 0 || c.error)));
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

/** Poll extensions.list and pick compiled components for one slot prefix
 *  (内核级 slot:PANEL_TAB_SLOT_PREFIX 等按前缀自动挂载)。 */
export function useSlotComponentsByPrefix(rpc: RpcClient | null, prefix: string): SlotComponent[] {
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
					setItems(
						(res?.components ?? []).filter(c => c.slot.startsWith(prefix) && (c.code.length > 0 || c.error)),
					);
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
	}, [rpc, prefix]);
	return items;
}

/** Mount every extension-contributed component registered for a slot. */
export function SlotComponentHost({
	rpc,
	slot,
	sessionId,
	cwd,
}: {
	rpc: RpcClient | null;
	slot: string;
	sessionId?: string | null;
	cwd?: string;
}): ReactNode {
	const items = useSlotComponents(rpc, slot);
	return (
		<>
			{items.map(item => (
				<SlotComponentMount
					key={`${item.extensionId}:${item.slot}`}
					item={item}
					rpc={rpc}
					sessionId={sessionId}
					cwd={cwd}
				/>
			))}
		</>
	);
}

/** 单个槽位组件挂载(动态 tab/rail 注入用——内核级 slot 的宿主侧接收端)。
 *  扩展组件收到 SlotComponentProps(rpc/sessionId/cwd/slot/extensionId),
 *  全部可选 —— 宿主持有哪项传哪项。 */
export function SlotComponentMount({
	item,
	rpc,
	sessionId,
	cwd,
}: {
	item: SlotComponent;
	rpc?: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
}): ReactNode {
	const [error, setError] = useState<string | null>(null);
	const [Comp, setComp] = useState<ComponentType<SlotComponentProps> | null>(null);
	// Component-scoped CSS (daemon extracts it at compile time): inject a
	// <style> beside the component and drop it on unmount.
	useEffect(() => {
		if (!item.css) return;
		const style = document.createElement("style");
		style.setAttribute("data-slot-css", `${item.extensionId}:${item.slot}`);
		style.textContent = item.css;
		document.head.appendChild(style);
		return () => style.remove();
	}, [item.css, item.extensionId, item.slot]);
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
			<div className="gui-slot-error" role="alert">
				<strong>{item.label ?? item.slot}</strong> 组件加载失败 — {error}
			</div>
		);
	}
	if (!Comp) return null;
	// Extension components receive the host's live context as optional props
	// (RPC bridge, session id, cwd, slot identity) — a component may ignore
	// them entirely; hosts pass what they have.
	const hostProps: SlotComponentProps = {
		rpc,
		sessionId,
		cwd,
		slot: item.slot,
		extensionId: item.extensionId,
	};
	return <Comp {...hostProps} />;
}
