import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "./rpc";
/**
 * Renderer-side component slots (DSH ui-slots analogue): extensions
 * register components via `pi.registerComponent({ slot, moduleUrl })`, the
 * daemon compiles them to self-contained ESM and serves the code through
 * `extensions.list`; this module dynamically imports (blob: URL) and mounts
 * the default export into the slot. Enable/disable takes effect within the
 * 10s poll window — no restart, no rebuild.
 *
 * Slot names are a shared contract with the daemon
 * (@musepi/collab-proto/extension-slots — single authority): `extensions.list`
 * returns the declared exact/prefix slots, and the diagnostics hook compares
 * them against GUI_SLOT_HOSTS so a daemon-side slot with no desktop host
 * shows up in the extension center instead of silently missing.
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
/** Keyed settings card slot (DSH settings.plugin.item 派发对齐):每个启用扩展
 *  注册 `settings.item.<extId>` 组件即自动在设置页"扩展设置"分区获得一张
 *  卡片,组件经 settingsScope 读写该扩展自己的设置键。 */
export const SETTINGS_ITEM_SLOT_PREFIX = "settings.item.";
/** Composer 座位槽(DSH conversation.input.dock/left/right 对齐):
 *  dock = 输入卡上方整行;left/right = 底部工具栏两端。list 语义 ——
 *  多个扩展可同时往同一槽注入组件。 */
export const COMPOSER_DOCK_SLOT = "composer.dock";
export const COMPOSER_LEFT_SLOT = "composer.left";
export const COMPOSER_RIGHT_SLOT = "composer.right";

/** 桌面端实际挂载的槽位(与 daemon 声明对比,诊断未挂载槽位)。
 *  exact 顺序与 collab-proto EXTENSION_SLOT_DECLARATION.exact 对齐。 */
export const GUI_SLOT_HOSTS = {
	exact: [
		SETTINGS_EXTENSION_SLOT,
		RIGHT_PANEL_SLOT,
		RIGHT_RAIL_SLOT,
		COMPOSER_DOCK_SLOT,
		COMPOSER_LEFT_SLOT,
		COMPOSER_RIGHT_SLOT,
	],
	prefixes: [PANEL_TAB_SLOT_PREFIX, SETTINGS_TAB_SLOT_PREFIX, RAIL_SLOT_PREFIX, SETTINGS_ITEM_SLOT_PREFIX],
} as const;

export interface SlotComponent {
	slot: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). */
	code: string;
	error?: string;
	/** Component-scoped CSS extracted at compile time (rendered via <style>). */
	css?: string;
	/** List-slot render order (ascending; registration order otherwise). */
	order?: number;
}

/** One normalized capability entry in extensions.list (10 kinds, TUI
 *  /extensions parity). Type home here so consumers (ExtensionsCenter,
 *  ExtensionStatusCard, settings-sections) share one shape. */
export interface ExtensionItem {
	id: string;
	kind: string;
	name: string;
	displayName: string;
	description?: string;
	trigger?: string;
	path: string;
	source: { provider: string; providerName: string; level: "user" | "project" | "native" };
	state: "active" | "disabled" | "shadowed";
	disabledReason?: "provider-disabled" | "item-disabled" | "shadowed";
	shadowedBy?: string;
	/** 加载失败原因 —— 存在 = 扩展不可用(fail-loud,不静默消失)。 */
	loadError?: string;
}

export interface ExtensionTab {
	id: string;
	label: string;
	enabled: boolean;
	count: number;
}

export interface ProviderInfo {
	id: string;
	displayName: string;
	enabled: boolean;
}

/** Full extensions.list response — the single registry datum all slot
 *  hosts and the extension center consume. */
export interface ExtensionRegistryData {
	extensions: ExtensionItem[];
	tabs: ExtensionTab[];
	providers: ProviderInfo[];
	components: SlotComponent[];
	/** Slot contract from the daemon (collab-proto single authority). */
	slots: { exact: readonly string[]; prefixes: readonly string[] };
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
	/** Settings read/write proxy bound to this extension's keys
	 *  (settings.get/settings.set RPC — the daemon gates writes on
	 *  registerSetting keys). Keyed settings-item components receive it;
	 *  other hosts pass nothing. */
	settingsScope?: {
		get(keys: string[]): Promise<Record<string, unknown>>;
		set(key: string, value: unknown): Promise<void>;
	} | null;
}

/** ── 全局单例 registry 数据源 ─────────────────────────────────────
 * 所有消费者(右面板/设置页/composer/rail/扩展中心/状态卡/motion 注入)
 * 共享**一个** extensions.list 轮询 + extensions.changed 即时刷新,而不是
 * 每个宿主独立轮询(此前 N 个宿主 = N 个轮询,同一 daemon 同一数据)。
 * 首个宿主挂载时启动,最后一个卸载时停止;失败保留旧数据不闪空。 */

interface RegistryStoreState {
	data: ExtensionRegistryData | null;
	timer: Timer | null;
	refs: number;
	unlisten?: () => void;
}

const registryStores = new WeakMap<RpcClient, RegistryStoreState>();

const POLL_MS = 10_000;

function startRegistryStore(rpc: RpcClient, notify: () => void): void {
	const st = registryStores.get(rpc)!;
	const load = (): void => {
		if (document.visibilityState === "hidden") return;
		void rpc
			.request<ExtensionRegistryData | null>("extensions.list", {})
			.then(res => {
				if (!res) return;
				// Reference compare: daemon returns a fresh object per call;
				// consumers filter subsets with useMemo, which converges.
				if (res !== st.data) {
					st.data = res;
					notify();
				}
			})
			.catch(() => {
				// 轮询失败保留上次数据(瞬时断连不闪空)
			});
	};
	load();
	st.timer = setInterval(load, POLL_MS);
	st.unlisten = rpc.addEventListener(event => {
		const payload = event.payload as { type?: string } | undefined;
		// HMR + mutation RPCs:daemon 清缓存后广播 extensions.changed,
		// 立即重拉 —— 不等下一个轮询周期。
		if (payload?.type === "extensions.changed") load();
	});
}

/** 订阅全局 registry 数据(单例)。返回完整响应,消费者自行过滤子集。 */
export function useExtensionRegistry(rpc: RpcClient | null): ExtensionRegistryData | null {
	const [, setVersion] = useState(0);
	useEffect(() => {
		if (!rpc) return;
		let st = registryStores.get(rpc);
		if (!st) {
			st = { data: null, timer: null, refs: 0 };
			registryStores.set(rpc, st);
		}
		st.refs += 1;
		const first = st.refs === 1;
		if (first) startRegistryStore(rpc, () => setVersion(v => v + 1));
		else setVersion(v => v + 1); // 已启动:立即同步当前数据
		return () => {
			st!.refs -= 1;
			if (st!.refs === 0) {
				clearInterval(st!.timer ?? undefined);
				st!.unlisten?.();
				st!.data = null;
			}
		};
	}, [rpc]);
	return rpc ? (registryStores.get(rpc)?.data ?? null) : null;
}

/** Daemon-declared slots with no desktop mount point (diagnostics: a new
 *  slot added in collab-proto surfaces here before the GUI implements it). */
export function useUnhostedSlots(rpc: RpcClient | null): string[] {
	const data = useExtensionRegistry(rpc);
	return useMemo(() => {
		if (!data?.slots) return [];
		return data.slots.exact.filter(s => !(GUI_SLOT_HOSTS.exact as readonly string[]).includes(s));
	}, [data]);
}

/** Pick compiled components registered for one exact slot. */
export function useSlotComponents(rpc: RpcClient | null, slot: string): SlotComponent[] {
	const data = useExtensionRegistry(rpc);
	return useMemo(() => {
		const all = data?.components ?? [];
		return all
			.filter(c => c.slot === slot && (c.code.length > 0 || c.error))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}, [data, slot]);
}

/** Pick compiled components whose slot starts with a namespace prefix
 *  (内核级 slot:PANEL_TAB_SLOT_PREFIX 等按前缀自动挂载)。 */
export function useSlotComponentsByPrefix(rpc: RpcClient | null, prefix: string): SlotComponent[] {
	const data = useExtensionRegistry(rpc);
	return useMemo(() => {
		const all = data?.components ?? [];
		return all
			.filter(c => c.slot.startsWith(prefix) && (c.code.length > 0 || c.error))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}, [data, prefix]);
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
	settingsScope,
}: {
	item: SlotComponent;
	rpc?: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
	/** Settings read/write proxy (keyed settings-item hosts inject it). */
	settingsScope?: SlotComponentProps["settingsScope"];
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
				// daemon/extension-artifact-compiler.ts. Inject before import.
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
		settingsScope,
	};
	return <Comp {...hostProps} />;
}
