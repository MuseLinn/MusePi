import { registerExternalToolRenderers, type ToolRenderer } from "@musepi/client-core";
import { EXTENSION_SLOT_DECLARATION, EXTENSION_SLOT_NAMES, slotKindOf } from "@musepi/collab-proto/extension-slots";
import type {
	ConfigFieldDesc,
	ConfigFieldError,
	PluginCompatibility,
	PluginComponentDesc,
	PluginConfigValues,
	PluginResources,
	SessionEntry,
} from "@musepi/pi-wire";
import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RpcClient } from "./rpc";

/**
 * The React surface compiled plugin modules bind to: the artifact compiler
 * maps the `React` identifier to `window.MusePiReact`, so whatever lands here
 * IS the plugin's whole platform. The react namespace itself has no
 * `createPortal` (that export lives in react-dom), and a plugin that portals
 * its popover crashed on open with "React.createPortal is not a function" —
 * spread the namespace and add the portal entry.
 */
function exposeHostReact(): void {
	(window as unknown as { MusePiReact: unknown }).MusePiReact = { ...React, createPortal };
}

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

/**
 * Look a slot id up by name.
 *
 * The exact list is ordered by UI position, so an index would silently point at
 * the wrong slot the moment a seat is added — a name lookup cannot. The
 * `!` is safe: every name below is declared in EXTENSION_SLOT_DECLARATION.
 */
function slot(name: string): string {
	if (!Object.hasOwn(EXTENSION_SLOT_DECLARATION.exact, name)) {
		throw new Error(`Unknown extension slot: ${name}`);
	}
	return name;
}

/** First slot id — the settings page's extension-contributed section. */
export const SETTINGS_EXTENSION_SLOT = slot("settings.extensions");
/** Right-side workspace panel slot. */
export const RIGHT_PANEL_SLOT = slot("panel.right");
/** Right-edge 44px icon rail slot. */
export const RIGHT_RAIL_SLOT = slot("rail.right");
/** 内核级 slot 命名空间(P1 架构开放):slot 名是开放命名空间,前缀决定挂载位置。 */
export const PANEL_TAB_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[0]; // "panel.tab."
export const SETTINGS_TAB_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[1]; // "settings.tab."
export const RAIL_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[2]; // "rail."
/** Keyed settings card slot. */
export const SETTINGS_ITEM_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[3]; // "settings.item."
/** 单行偏好槽。 */
export const SETTINGS_ACTION_SLOT_PREFIX = EXTENSION_SLOT_DECLARATION.prefixes[4]; // "settings.action."
/** Composer 座位槽（见 EXTENSION_SLOT_DECLARATION 的席位表）。 */
export const COMPOSER_DOCK_SLOT = slot("composer.dock");
export const COMPOSER_LEFT_SLOT = slot("composer.left");
export const COMPOSER_RIGHT_SLOT = slot("composer.right");
export const COMPOSER_MODEL_SLOT = slot("composer.model");
export const COMPOSER_ATTACHMENTS_SLOT = slot("composer.attachments");
export const COMPOSER_PERMISSION_SLOT = slot("composer.permission");
export const COMPOSER_PLAN_SLOT = slot("composer.plan");
export const COMPOSER_ACTIVITY_SLOT = slot("composer.activity");
export const COMPOSER_OVERLAY_SLOT = slot("composer.overlay");
export const COMPOSER_REQUEST_DRAFT_SLOT = slot("composer.requestDraft");
export const COMPOSER_FOR_SLOT = slot("composer.for");
/** transcript.node seat slot —— 单一
 *  聊天节点 seat,按节点 kind(entryKey)分发;turn-tail/tool/user/assistant
 *  都是该 seat 的节点 kind,而非独立槽。 */
export const TRANSCRIPT_NODE_SLOT = slot("transcript.node");

/** 桌面端实际挂载的槽位(与 daemon 声明对比,诊断未挂载槽位)。
 *  exact 顺序与 collab-proto EXTENSION_SLOT_DECLARATION.exact 对齐。 */
/** 桌面端实际挂载的槽位(与 EXTENSION_SLOT_DECLARATION 对齐,诊断未挂载)。
 *  Values derived from the collab-proto single source of truth. */
export const GUI_SLOT_HOSTS = {
	exact: EXTENSION_SLOT_NAMES,
	prefixes: EXTENSION_SLOT_DECLARATION.prefixes,
} as const;

/**
 * The config form a slot component receives, mirroring the daemon's
 * `ConfigForm` over the RPC boundary.
 *
 * Shaped for a form: `getSnapshot` is synchronous (a form renders from it every
 * frame), writes are async and report whether the revision fence held.
 */
export interface SlotConfigForm {
	getSnapshot(): SlotConfigFormSnapshot;
	subscribe(listener: () => void): () => void;
	mutate(ops: readonly SlotConfigFieldOp[], expectedRevision?: number): Promise<boolean>;
	set(field: string, value: unknown): Promise<boolean>;
	unset(field: string): Promise<boolean>;
}

interface SlotConfigFormSnapshot {
	status: "ready" | "readonly" | "unavailable";
	/** Effective values: the manifest base with the user layer over it. */
	value: Record<string, unknown> | undefined;
	/** Manifest-declared defaults — what a cleared field returns to. */
	base: Record<string, unknown> | undefined;
	/** The user layer. Key PRESENCE marks an override, regardless of value. */
	user: Record<string, unknown> | undefined;
	revision: number | undefined;
	writable: boolean;
	mode: "host" | "memory";
}

/** One field edit; `unset` clears the user layer so the field re-inherits. */
type SlotConfigFieldOp = { kind: "set"; field: string; value: unknown } | { kind: "unset"; field: string };

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
	/** transcript.node seat: node kinds (transcriptNodeKind entryKey) this
	 *  renderer owns. No entryKinds → does not participate in per-kind
	 *  dispatch (targets other exact slots). */
	entryKinds?: string[];
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
/** One status-bar segment from extensions.list (registerStatusBarSegment —
 *  static label rendered after the built-in model/mode/context segments,
 *  ordered by `order`). */
export interface StatusBarSegmentItem {
	/** Unique segment id (`statusbar.seg.<id>` slot key). */
	id: string;
	/** Static display label. */
	label: string;
	/** Order among daemon-contributed segments (ascending; registration order otherwise). */
	order?: number;
	/** Forward-compat renderer hint for hosts that register named renderers. */
	renderKey?: string;
	/** Extension entry path that contributed it (identity). */
	extensionPath: string;
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
	/** 来自内置注册表(BUILTIN_EXTENSIONS)的条目或标注行 —— 渲染"内置"徽章。 */
	builtin?: boolean;
	/** 只读展示项(主题包/渲染器包):无禁用语义,不渲染停用开关。 */
	readonly?: boolean;
	/** 插件清单声明的配置字段表(管理页;daemon 经 pi-wire 校验后下发)。 */
	config?: ConfigFieldDesc[];
	/** 被丢弃的坏配置字段及原因(fail-soft 证据)。 */
	configErrors?: ConfigFieldError[];
	/** 插件声明的资源占用(disk/memory/setup/models)。 */
	resources?: PluginResources;
	/** 已落盘的插件配置值(daemon 按字段钳制后下发;表单初始值)。 */
	configValues?: PluginConfigValues;
	/** 「包含的组件」状态(声明了组件的内置单元才有;详情弹层渲染开关行)。 */
	components?: PluginComponentDesc[];
	/** dsh「会话插件」面:显式预设白名单启用了该扩展的预设名列表。 */
	enabledInPresets?: string[];
	/** cordis 运行状态（仅接入 fiber 的条目才有;builtin 单元随 daemon
	 *  挂载,user 插件会话装载无宿主 fiber,缺省如实不显示）。 */
	runtime?: { fiberState: string; effects: number; operational: "running" | "stopped" };
	/** 「启用条件」:镜像设置键为 on 时启用。 */
	activation?: { kind: "setting"; key: string };
	/** 插件清单版本（extension-module 条目;宿主 runtime 透出,回退保护②）。 */
	version?: string;
	/** 兼容性预检判定（回退保护②;incompatible = 结构化拒绝的证据面,
	 *  exempted = 精确版本豁免放行,GUI 归因段据此渲染 + 提供豁免入口）。 */
	compatibility?: PluginCompatibility;
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
	/** Status-bar segments contributed by active extensions
	 *  (registerStatusBarSegment), rendered after the built-ins by `order`. */
	statusBarSegments: StatusBarSegmentItem[];
	/** Slot contract from the daemon (collab-proto single authority). */
	slots: { exact: readonly string[]; prefixes: readonly string[] };
	/** dsh「会话插件」面:显式扩展白名单的预设清单(旧 daemon 无此字段)。 */
	presets?: { id: string; label: string }[];
}

/** Props every extension component receives when mounted. Hosts pass what
 *  they have; a component must treat every field as optional — the same
 *  component may be mounted in different hosts (panel tab vs composer). */
/**
 * A namespace's config form, backed by the daemon's pluginConfig.* RPCs.
 *
 * Snapshot access is synchronous — a form renders from it every frame — so the
 * snapshot is cached locally and refreshed after each write (and on mount).
 * Writes report whether the revision fence held, which is the whole difference
 * from `settingsScope`: a stale editor is told it lost instead of clobbering.
 *
 * Not exported: only `ConfigFormSlotMount` needs it, and a host wanting a form
 * for its own namespace uses that component.
 */
function useConfigForm(rpc: RpcClient | null, namespace: string | undefined): SlotConfigForm | null {
	const [snapshot, setSnapshot] = useState<SlotConfigFormSnapshot | null>(null);
	const listenersRef = useRef(new Set<() => void>());

	const publish = useCallback((next: SlotConfigFormSnapshot): void => {
		setSnapshot(next);
		for (const listener of listenersRef.current) listener();
	}, []);

	const refresh = useCallback(async (): Promise<void> => {
		if (!rpc || !namespace) return;
		try {
			const view = await rpc.request<{ snapshot: SlotConfigFormSnapshot }>("pluginConfig.form", { namespace });
			publish(view.snapshot);
		} catch {
			// A namespace with no form is not an error the component needs to
			// render differently for — it simply gets no form.
			publish({
				status: "unavailable",
				value: undefined,
				base: undefined,
				user: undefined,
				revision: undefined,
				writable: false,
				mode: "memory",
			});
		}
	}, [rpc, namespace, publish]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Wire the mutable form object once per namespace/rpc, so a component can
	// hold it across renders without resubscribing.
	return useMemo(() => {
		if (!rpc || !namespace) return null;
		const write = async (ops: readonly SlotConfigFieldOp[], expectedRevision?: number): Promise<boolean> => {
			if (!ops || ops.length === 0) return true;
			const result = await rpc.request<{ applied: boolean; revision: number | undefined }>("pluginConfig.mutate", {
				namespace,
				ops,
				...(expectedRevision !== undefined ? { expectedRevision } : {}),
			});
			await refresh();
			return result.applied === true;
		};
		const form: SlotConfigForm = {
			getSnapshot: () =>
				snapshot ?? {
					status: "unavailable",
					value: undefined,
					base: undefined,
					user: undefined,
					revision: undefined,
					writable: false,
					mode: "memory",
				},
			subscribe: listener => {
				listenersRef.current.add(listener);
				return () => {
					listenersRef.current.delete(listener);
				};
			},
			mutate: write,
			set: (field, value) => write([{ kind: "set", field, value }]),
			unset: field => write([{ kind: "unset", field }]),
		};
		return form;
	}, [rpc, namespace, snapshot, refresh]);
}

/**
 * Mount a settings component with its namespace's config form.
 *
 * The form is built here rather than inside `SlotComponentMount` because the
 * namespace belongs to the EXTENSION, not to one component: an extension may
 * contribute several settings components and they all edit the same namespace
 * values, so they share one form — and therefore one revision fence between
 * them. Two editors on two components of one extension cannot clobber each
 * other silently.
 */
export function ConfigFormSlotMount({
	item,
	rpc,
	settingsScope,
	namespace,
}: {
	item: SlotComponent;
	rpc: RpcClient | null;
	settingsScope?: SlotComponentProps["settingsScope"];
	/** Namespace for the form; defaults to the component's extension id. */
	namespace?: string;
}): ReactNode {
	const configForm = useConfigForm(rpc, namespace ?? item.extensionId);
	return <SlotComponentMount item={item} rpc={rpc} settingsScope={settingsScope} configForm={configForm} />;
}

/**
 * The context a plugin component module's `apply(ctx)` receives.
 *
 * A module MAY export `apply` alongside its default component. It is called once
 * per module load, before the component mounts, and exists for contributions
 * that are NOT per-render: one shared stylesheet, one event source across the
 * plugin's panels, window-level listeners.
 *
 * Without it those contributions have no owner: a reload swaps the compiled
 * module, the old module is never run again, and whatever it installed stays in
 * the document for the life of the window (duplicate `<style>` tags, sockets
 * still open against a module nobody can unload).
 *
 * Host contract:
 * - `effect(dispose)` collects a teardown; disposers run in REVERSE order
 *   (later contributions may depend on earlier ones).
 * - `signal` aborts when the module is superseded or unmounted — pass it to
 *   `fetch`/`EventSource` rather than tracking lifetime by hand.
 * - Both are per-load: a recompiled module gets a fresh ctx, and the previous
 *   one's disposers have already run.
 */
export interface PluginClientContext {
	/** Register a teardown for a contribution this module installed. */
	effect(dispose: () => void, label?: string): void;
	/** Aborted when this module load is superseded or unmounted. */
	readonly signal: AbortSignal;
	/** The seat this component was mounted into (`composer.model`, …). */
	readonly slot: string;
	/** The extension entry path this component came from. */
	readonly extensionId: string;
}
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
	/**
	 * The namespace's config form — the settings contract a real form needs on
	 * top of `settingsScope`: a revision fence (so a stale write is refused
	 * rather than clobbering a newer one) and a base/user split (so "did the
	 * user set this" is answerable, and a field can be reset to inherit).
	 *
	 * Absent when the host has no namespace for the component, the same as
	 * `settingsScope`; a component that needs it must treat it as optional.
	 */
	configForm?: SlotConfigForm | null;
	/** Daemon-side extension RPC bridge (registerRpc
	 *  analogue): invoke a JSON-RPC method registered by THIS extension
	 *  (ext.call RPC). Bound to the component's extensionId; absent when
	 *  no rpc bridge is available. */
	extensionCall?: (method: string, params?: unknown) => Promise<unknown>;
	/** transcript.node seat。宿主(渲染器)按节点
	 *  kind(entryKey)派发到注册组件;组件可用 `children`(内建 MusePi 渲染)做
	 *  增强/追加,或独立渲染。核心消息渲染仍由宿主持有 —— 扩展只贡献到 seat。 */
	node?: {
		/** 该 transcript 条目的原始 wire 值。 */
		entry: SessionEntry;
		/** transcriptNodeKind(entry) —— seat 的派发键(entryKey)。 */
		kind: string;
		/** 归属回合序号(可选)。 */
		turnIndex?: number;
		/** 内建 MusePi 对该条目的渲染 —— 用于“增强而不替换核心渲染”。 */
		children?: ReactNode;
	} | null;
	/** turn 级上下文。用于回合底 footer / 总结面板。 */
	turn?: {
		turnIndex: number;
		userText?: string;
		assistantMessageId?: string;
		usage?: { input?: number; output?: number; cache?: number };
		durationMs?: number;
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
		const matching = all
			.filter(c => c.slot === slot && (c.code.length > 0 || c.error))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		// `single` seats hold ONE occupant: the last contributor (by order, then
		// registration order) takes the seat, the earlier ones give way. Rendering
		// both would put two competing readouts in one place — e.g. two model
		// balances side by side with no way to tell which is authoritative.
		if (slotKindOf(slot) === "single") return matching.slice(-1);
		return matching;
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

/** transcript.node seat 派发: 从注册到 `transcript.node`
 *  的组件中挑出声明处理该 kind 的。无 entryKinds 的组件不参与按 kind 派发
 *  (它面向其它精确槽位)。命中列表为空 -> seat 回退到内建渲染;
 *  命中 -> 命中组件"拥有"该节点渲染(可包含 children 基座做增强或完全自绘)。 */
export function selectTranscriptNodeComponents(components: readonly SlotComponent[], kind: string): SlotComponent[] {
	return components
		.filter(c => (c.entryKinds?.includes(kind) ?? false) === true)
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
	node,
	turn,
	configForm,
}: {
	item: SlotComponent;
	rpc?: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
	/** Settings read/write proxy (keyed settings-item hosts inject it). */
	settingsScope?: SlotComponentProps["settingsScope"];
	/** transcript.node seat 节点上下文: 命中
	 *  kind 的组件收到它,可用 node.children 增强或完全自绘。 */
	node?: SlotComponentProps["node"];
	/** turn 级上下文。 */
	turn?: SlotComponentProps["turn"];
	/** 该组件的 config form(宿主从 pluginConfig.* 构造);缺省时本组件
	 *  按 extensionId 自行构造一个。 */
	configForm?: SlotConfigForm | null;
}): ReactNode {
	const [error, setError] = useState<string | null>(null);
	// This mount's module-level teardown (see the pply(ctx) call below). Held in
	// This mount's module-level teardown (see the apply(ctx) call below). Held
	// resolved — a local would be out of scope by then.
	const moduleTeardown = useRef<(() => void) | null>(null);
	const [Comp, setComp] = useState<ComponentType<SlotComponentProps> | null>(null);
	// The form is always constructed (never conditionally) — a component with
	// no namespace simply gets `null`, which is what "no form" means.
	const ownConfigForm = useConfigForm(rpc ?? null, item.extensionId);
	const resolvedConfigForm = configForm !== undefined ? configForm : ownConfigForm;
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
		// The blob URL must outlive the import: revoking it inside this
		// effect's cleanup kills a fetch still in flight, and the registry
		// hands out a new `item` object on every poll (and a StrictMode
		// remount runs cleanup immediately) — so the revoke raced the
		// import and the component failed with "Failed to fetch dynamically
		// imported module". Revoke only once the import has settled.
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
				exposeHostReact();
				// Dynamic import: specifier is a runtime blob URL served from
				// the extension registry — static import is impossible here.
				url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
				const mod = (await import(url)) as {
					default?: ComponentType;
					apply?: (ctx: PluginClientContext) => void;
				};
				if (!alive) return;
				const Component = mod.default;
				if (typeof Component !== "function") {
					throw new Error("component module must export a default React component");
				}
				// Module-level setup: a plugin whose contribution is NOT per-render
				// (one stylesheet, one shared event source, window listeners) has
				// nowhere else to put it, and no way to clean it up. `apply(ctx)`
				// gets a disposer list and an abort signal that this mount owns —
				// both die with the component, including on a reload that swaps
				// `item.code` for the recompiled module.
				//
				// A module with no `apply` export is the common case (a pure
				// component) and stays exactly as it was.
				if (typeof mod.apply === "function") {
					const controller = new AbortController();
					const disposers: Array<() => void> = [];
					moduleTeardown.current = () => {
						controller.abort();
						// Reverse order: later contributions may depend on earlier
						// ones (a listener registered on top of an open connection).
						for (let i = disposers.length - 1; i >= 0; i--) disposers[i]?.();
					};
					mod.apply({
						effect(dispose, label) {
							void label;
							disposers.push(dispose);
						},
						signal: controller.signal,
						slot: item.slot,
						extensionId: item.extensionId,
					});
				}
				// React 19:setState(函数) 会被当作 updater 执行 —— 直接传
				// Component 会把它调用一次,state 变成执行结果(JSX 元素),
				// 渲染时 "<Comp />" 报 "got: <div />"。包一层返回组件本身。
				setComp(() => Component);
			} catch (e) {
				if (alive) setError(String(e));
			} finally {
				// Settle first, then release — a revoked-in-flight fetch is
				// unrecoverable and the failure message points at the wrong
				// thing (the module's own code, which is fine).
				if (url) URL.revokeObjectURL(url);
			}
		})();
		return () => {
			alive = false;
			// Run the module's teardown BEFORE the next load replaces it: a
			// reload would otherwise leave the old stylesheet in <head> and the
			// old EventSource open against a module nobody will ever unload.
			moduleTeardown.current?.();
			moduleTeardown.current = null;
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
		configForm: resolvedConfigForm,
		node,
		turn,
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
 * 并注册进 guest-client 的 tool-render 外部注册表,transcript 按工具名
 * 分派时扩展渲染器覆盖内置。模块 default export 必须是 ToolRenderer
 * 形状({ Summary, Body?, Card? })。任何宿主挂载一次即可 ——
 * registry 是全局单例(guest-client module 级)。
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
					exposeHostReact();
					const url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
					urls.push(url);
					const mod = (await import(url)) as { default?: unknown };
					if (!alive) return;
					const exported = mod.default;
					// 两种合法形状:
					// ① default = React 组件 → 作为全卡 Card 渲染;
					// ② default = ToolRenderer 对象({ Summary, Body?, Card? })
					// 与 guest-client 内置注册表同构。
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
			// Same settle-then-release rule as the component loader: revoking
			// a URL while its import is in flight fails the fetch.
			for (const url of urls) URL.revokeObjectURL(url);
		})();
		return () => {
			alive = false;
		};
	}, [toolViews]);
}
