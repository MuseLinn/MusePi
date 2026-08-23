import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import { registerExternalToolRenderers, type ToolRenderer } from "@musepi/desktop-web";
import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "./rpc";
/**
 * Renderer-side component slots: extensions
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

/** First slot id — the settings page's extension-contributed section.
 *  Values derived from EXTENSION_SLOT_DECLARATION (collab-proto 单一权威). */
export const SETTINGS_EXTENSION_SLOT = EXTENSION_SLOT_DECLARATION.exact[0] as string;
/** Right-side workspace panel slot. */
export const RIGHT_PANEL_SLOT = EXTENSION_SLOT_DECLARATION.exact[1] as string;
/** Right-edge 44px icon rail slot. */
export const RIGHT_RAIL_SLOT = EXTENSION_SLOT_DECLARATION.exact[2] as string;
/** 内核级 slot 命名空间(P1 架构开放):slot 名是开放
 *  命名空间,前缀决定挂载位置,GUI 按前缀自动挂载。 */
export const PANEL_TAB_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[0] as string;
export const SETTINGS_TAB_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[1] as string;
export const RAIL_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[2] as string;
/** Keyed settings card slot. */
export const SETTINGS_ITEM_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[3] as string;
/** 单行偏好槽。 */
export const SETTINGS_ACTION_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[4] as string;
/** Composer 座位槽。 */
export const COMPOSER_DOCK_SLOT = EXTENSION_SLOT_DECLARATION.exact[3] as string;
export const COMPOSER_LEFT_SLOT = EXTENSION_SLOT_DECLARATION.exact[4] as string;
export const COMPOSER_RIGHT_SLOT = EXTENSION_SLOT_DECLARATION.exact[5] as string;

/** 桌面端实际挂载的槽位(与 daemon 声明对比,诊断未挂载槽位)。
 *  exact 顺序与 collab-proto EXTENSION_SLOT_DECLARATION.exact 对齐。 */
/** 桌面端实际挂载的槽位(与 EXTENSION_SLOT_DECLARATION 对齐,诊断未挂载)。
 *  Values derived from the collab-proto single source of truth. */
export const GUI_SLOT_HOSTS = {
	exact: EXTENSION_SLOT_DECLARATION.exact.map(s => s as string) as unknown as typeof EXTENSION_SLOT_DECLARATION.exact,
	prefixes: EXTENSION_SLOT_DECLARATION.prefixes.map(s => s as string) as unknown as typeof EXTENSION_SLOT_DECLARATION.prefixes,
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

/** One compiled per-tool view from extensions.list (registerToolView —
 *  ). Module default export must be a
 *  ToolRenderer-shaped object ({ Summary, Body?, Card? }). */
export interface ToolViewItem {
	tool: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). Empty on compile failure. */
	code: string;
	error?: string;
	/** Component-scoped CSS extracted at compile time. */
	css?: string;
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
	/** Per-tool renderer views (registerToolView
	 *  analogue): compiled modules dispatched by tool name in the
	 *  transcript. */
	toolViews: ToolViewItem[];
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
	/** Daemon-side extension RPC bridge (registerRpc
	 *  analogue): invoke a JSON-RPC method registered by THIS extension
	 *  (ext.call RPC). Bound to the component's extensionId; absent when
	 *  no rpc bridge is available. */
	extensionCall?: (method: string, params?: unknown) => Promise<unknown>;
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
		// Daemon compile failure (item.error set + empty code): the blob
		// import of "" would fail with a misleading "must export a default
		// React component" — surface the daemon's real error instead.
		if (item.error) {
			setError(item.error);
			return () => {
				alive = false;
			};
		}
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
		// 扩展 RPC 桥(registerRpc):绑定当前
		// 组件的 extensionId,组件直接调自己扩展的 daemon 侧方法。
		extensionCall:
			rpc && item.extensionId
				? (method, params) =>
						rpc.request("ext.call", {
							extensionId: item.extensionId,
							method,
							params,
							sessionId: sessionId ?? undefined,
						})
				: undefined,
	};
	return <Comp {...hostProps} />;
}

/**
 * 扩展 per-tool 渲染器注册(registerToolView):把 extensions.list 的
 * toolViews(daemon 编译好的 ESM)blob-import
 * 并注册进 desktop-web 的 tool-render 外部注册表,transcript 按工具名
 * 分派时扩展渲染器覆盖内置。模块 default export 必须是 ToolRenderer
 * 形状({ Summary, Body?, Card? })。任何宿主挂载一次即可 ——
 * registry 是全局单例(desktop-web module 级)。
 */
export function useExtensionToolViews(rpc: RpcClient | null): void {
	const data = useExtensionRegistry(rpc);
	const toolViews = data?.toolViews ?? [];
	useEffect(() => {
		if (toolViews.length === 0) {
			registerExternalToolRenderers({});
			return;
		}
		let alive = true;
		const urls: string[] = [];
		const registered: Record<string, ToolRenderer> = {};
		void (async () => {
			for (const item of toolViews) {
				if (item.error) continue; // 编译失败:回退内置/generic 渲染器
				try {
					(window as unknown as { MusePiReact: unknown }).MusePiReact = React;
					const url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
					urls.push(url);
					const mod = (await import(url)) as { default?: unknown };
					if (!alive) return;
					const exported = mod.default;
					// 两种合法形状:
					// ① default = React 组件 → 作为全卡 Card 渲染;
					// ② default = ToolRenderer 对象({ Summary, Body?, Card? })
					// 与 desktop-web 内置注册表同构。
					let renderer: ToolRenderer | null = null;
					if (typeof exported === "function") {
						renderer = { Card: exported as ToolRenderer["Card"] } as ToolRenderer;
					} else if (exported && typeof exported === "object") {
						renderer = exported as ToolRenderer;
					}
					if (!renderer) {
						console.warn(`toolview for "${item.tool}" missing default export (component or ToolRenderer)`);
						continue;
					}
					registered[item.tool] = renderer;
				} catch (e) {
					console.warn(`toolview "${item.tool}" load failed`, e);
				}
			}
			if (alive) registerExternalToolRenderers(registered);
		})();
		return () => {
			alive = false;
			for (const url of urls) URL.revokeObjectURL(url);
		};
	}, [toolViews]);
}
