import { SpotlightCard, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { resolveModeLabel } from "../../lib/mode-label";
import {
	collectChainIds,
	MAX_MODE_CHAIN_DEPTH,
	type ModeChainView,
	type ModeDefLike,
	resolveModeView,
} from "../../lib/resolve-mode-view";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { DialogFrame } from "../DialogFrame";
import { FadeScroll } from "../FadeScroll";

/** Settings → 智能体 → 预设:命名预设(工具集 + 提示词 + settings 覆盖)卡片面板
 *  + 完整编辑器(modes-plan §8/§9:ModesCenter)。数据源 daemon modes.list/
 *  modes.get/modes.save;modes.changed 即时刷新。编辑字段:label/description/
 *  extends(继承多选)/extensions(三态白名单)/prompt 区块列表/promptComplete/
 *  runtimeContext/settings 键值。
 * 分组卡片 + 「查看配置」只读视图(dsh 0.2.0 预设设置页信息架构 parity,
 * 委托单 2026-09-29-preset-page-cards-design):内置/自定义两卡片区,只读视图
 * 展示继承展开结果(resolve-mode-view.ts,镜像 daemon resolveMode 语义,
 * 环/悬空/超深链客户端防御,零新 RPC——摘要行 + 链上逐次 modes.get)。 */

interface ModeRow {
	id: string;
	label: string;
	description?: string;
	extends: string[];
	extensions?: string[];
	hasPrompt: boolean;
	promptComplete: boolean;
	settingsKeys: string[];
	builtin?: boolean;
	source?: "extension";
}

interface ModeDef {
	id: string;
	label?: string;
	description?: string;
	extends?: string[];
	extensions?: string[];
	prompt?: Array<{ name: string; order: number; text: string } | string>;
	promptComplete?: boolean;
	runtimeContext?: boolean;
	settings?: Record<string, unknown>;
}

/** 「查看配置」弹窗状态机:idle/loading/ready/error(判别联合,渲染按 status 分派)。 */
type ViewState =
	| { status: "idle" }
	| { status: "loading"; id: string }
	| { status: "error"; id: string; error: string }
	| { status: "ready"; id: string; view: ModeChainView };

export function ModesSection({
	rpc,
	onCreateChat,
}: {
	rpc: RpcClient | null;
	onCreateChat?: (text: string) => void;
}): ReactNode {
	const [modes, setModes] = useState<ModeRow[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);

	/** 看板式新建输入框(参考 BoardPage 悬浮输入):始终可见的自然语言输入,
	 *  Enter 把预设描述发给 Creator 会话 —— 由 Creator 设计并保存预设。 */
	const [newDesc, setNewDesc] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);
	/** 当前默认预设(新会话;localStorage 持久化,app.tsx welcome 同步)。 */
	const [defaultModeId, setDefaultModeId] = useState<string | null>(
		() => localStorage.getItem("musepi-gui-default-mode") ?? "work",
	);
	/** 「查看配置」弹窗状态(DialogFrame 始终挂载、open 驱动)。 */
	const [viewState, setViewState] = useState<ViewState>({ status: "idle" });
	/** 复制弹窗来源(null = 关闭)。 */
	const [duplicateSource, setDuplicateSource] = useState<ModeDef | null>(null);
	const [dupId, setDupId] = useState("");
	/** modes 目录(打开目录按钮;modes.list 返回)。 */
	const [modesDir, setModesDir] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{ modes: ModeRow[]; modesDir?: string } | null>("modes.list", {})
				.then(res => {
					if (!alive) return;
					setModes(res?.modes ?? []);
					if (res?.modesDir) setModesDir(res.modesDir);
					setErrors([]);
				})
				.catch(error => {
					if (!alive) return;
					setModes([]);
					setErrors([String(error)]);
				});
		};
		load();
		const id = setInterval(load, 5000);
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "modes.changed") load();
		});
		return () => {
			alive = false;
			clearInterval(id);
			off();
		};
	}, [rpc]);

	/** DSH creation-flow: send the preset description to a Creator session
	 *  (app layer owns createAndSend → createSession + sendPrompt). */
	const submitPreset = (): void => {
		const desc = newDesc.trim();
		if (!desc || !onCreateChat) return;
		setNewDesc("");
		onCreateChat(desc);
	};

	const setDefault = (id: string): void => {
		setDefaultModeId(id);
		localStorage.setItem("musepi-gui-default-mode", id);
		// welcome 预设 chip 同步(与 musepi-gui-default-model-changed 同模式)。
		window.dispatchEvent(new CustomEvent("musepi-gui-default-mode-changed", { detail: id }));
	};

	/** 「查看配置」:只读展示继承展开结果。数据源零新 RPC——根定义 modes.get,
	 *  链闭包由 modes.list 摘要行的 extends 一次算出,链上全部层并行 modes.get,
	 *  再交 resolveModeView 合并(环/悬空/超深链只记标记不抛错)。 */
	const openView = (id: string): void => {
		if (!rpc) return;
		setViewState({ status: "loading", id });
		void (async () => {
			try {
				const rootDef = await rpc.request<ModeDef | null>("modes.get", { id });
				if (!rootDef) {
					setViewState({ status: "error", id, error: t("modes view missing", { id }) });
					return;
				}
				const rows = modes ?? [];
				const chainIds = collectChainIds(id, mid =>
					mid === id ? (rootDef.extends ?? []) : rows.find(r => r.id === mid)?.extends,
				);
				const fetched = await Promise.all(
					chainIds.map(mid =>
						mid === id
							? Promise.resolve(rootDef)
							: rpc.request<ModeDef | null>("modes.get", { id: mid }).catch(() => null),
					),
				);
				const byId = new Map<string, ModeDefLike>();
				for (const def of fetched) {
					if (def) byId.set(def.id, def);
				}
				const view = resolveModeView(id, mid => byId.get(mid));
				setViewState({ status: "ready", id, view });
			} catch (error) {
				setViewState({ status: "error", id, error: String(error) });
			}
		})();
	};

	const openDuplicate = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request<ModeDef | null>("modes.get", { id })
			.then(def => {
				if (!def) return;
				setDuplicateSource(def);
				setDupId("");
				setSaveMsg(null);
			})
			.catch(error => setErrors([String(error)]));
	};

	const doDuplicate = async (): Promise<void> => {
		if (!rpc || !duplicateSource || !dupId.trim()) return;
		const id = dupId.trim();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
			setSaveMsg(`⚠ invalid id: ${id}`);
			return;
		}
		setSaving(true);
		try {
			await rpc.request("modes.save", { ...duplicateSource, id, label: duplicateSource.label ?? id });
			setSaveMsg(t("modes saved"));
			setDuplicateSource(null);
		} catch (error) {
			setSaveMsg(`⚠ ${String(error)}`);
		} finally {
			setSaving(false);
		}
	};

	const openModesDir = async (): Promise<void> => {
		if (!modesDir) return;
		const api = (
			window as unknown as { electronAPI?: { openPath?(p: string): Promise<{ ok?: boolean; error?: string }> } }
		).electronAPI;
		const res = await api?.openPath?.(modesDir);
		if (res && res.ok === false) setErrors([String(res.error)]);
	};

	const remove = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request("modes.delete", { id })
			.then(() => {
				setModes(prev => (prev ? prev.filter(m => m.id !== id) : prev));
				setErrors([]);
			})
			.catch(error => setErrors([String(error)]));
	};

	/** 分组卡片:内置(builtin)与自定义分两卡片区。插件注册的
	 * 预设(source=extension)归入自定义区,操作按钮自带禁用逻辑。 */
	const builtinModes = modes?.filter(m => m.builtin === true) ?? [];
	const customModes = modes?.filter(m => m.builtin !== true) ?? [];

	const renderModeCard = (mode: ModeRow): ReactNode => (
		<div
			key={mode.id}
			className={`gui-agent-card cursor-pointer transition-colors${
				defaultModeId === mode.id ? " !border-[var(--color-accent)]" : ""
			}`}
			onClick={() => setDefault(mode.id)}
			role="button"
			tabIndex={0}
			onKeyDown={e => {
				if (e.key === "Enter" || e.key === " ") setDefault(mode.id);
			}}
		>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					{defaultModeId === mode.id && (
						<Icon name="check" className="h-3 w-3 flex-shrink-0 text-[var(--color-accent)]" />
					)}
					<span className="truncate text-[13px] font-medium">{resolveModeLabel(mode.id, modes)}</span>
					<span className="text-[11px] text-[var(--color-text-faint)]">({mode.id})</span>
					<span className="gui-provider-chip">
						{mode.builtin === true ? t("modes builtin badge") : t("modes custom badge")}
					</span>
					{mode.promptComplete ? <span className="gui-provider-chip">{t("modes complete badge")}</span> : null}
					{mode.extensions?.length === 0 ? (
						<span className="gui-provider-chip">{t("modes core-only badge")}</span>
					) : null}
					{mode.settingsKeys.length > 0 ? (
						<span className="gui-provider-chip">
							{t("{count} settings", { count: String(mode.settingsKeys.length) })}
						</span>
					) : null}
				</div>
				{mode.description ? (
					<div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{mode.description}</div>
				) : null}
				{mode.extends.length > 0 ? (
					<div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
						{t("modes based on")} {mode.extends.map(e => resolveModeLabel(e, modes)).join(" + ")}
					</div>
				) : null}
				{/* 卡片右下角操作(DSH Agent presets 对齐):内置 = 查看/复制;
				 * 自定义 = 编辑/打开目录/复制/删除。点击卡片主体 = 设为默认。 */}
				<div className="mt-1.5 flex items-center gap-2" onClick={e => e.stopPropagation()}>
					<button
						type="button"
						className="text-[12px] text-[var(--color-accent)] hover:underline"
						onClick={() => openView(mode.id)}
						disabled={mode.source === "extension"}
					>
						{t("modes view")}
					</button>
					<button
						type="button"
						className="text-[12px] text-[var(--color-accent)] hover:underline"
						onClick={() => openDuplicate(mode.id)}
						disabled={mode.source === "extension"}
					>
						{t("modes duplicate")}
					</button>
					{mode.builtin !== true && mode.source !== "extension" && (
						<>
							<button
								type="button"
								className="text-[12px] text-[var(--color-accent)] hover:underline"
								onClick={() => void openModesDir()}
							>
								{t("modes open dir")}
							</button>
							<button
								type="button"
								className="text-[12px] text-[var(--color-danger)] hover:underline"
								onClick={() => remove(mode.id)}
							>
								{t("modes delete")}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);

	return (
		<>
			<h2 className="gui-settings-page-title">{t("modes title")}</h2>
			<p className="gui-settings-page-desc">{t("modes description")}</p>
			{errors.length > 0 && (
				<div className="gui-settings-row text-[12px] text-[var(--color-danger)]">{errors.join("; ")}</div>
			)}
			{/* 新建预设:看板式始终可见自然语言输入框 —— Enter/发送把预设描述
			 * 发给 Creator 会话,由 Creator 设计并保存预设。SpotlightCard
			 * 提供板输入框同款光标跟随光晕(accent 微光),overflow-visible 让
			 * 发送按钮的 glow 不被容器裁掉。 */}
			<SpotlightCard
				className="mt-2 flex items-center gap-2 overflow-visible rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-1.5"
				spotlightColor="color-mix(in oklab, var(--color-accent) 10%, transparent)"
				glowSize={340}
			>
				<input
					className="gui-board-home-input"
					placeholder={t("modes create placeholder")}
					value={newDesc}
					onChange={e => setNewDesc(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") submitPreset();
					}}
				/>
				<button
					type="button"
					className="gui-board-home-send"
					disabled={!newDesc.trim() || !onCreateChat}
					onClick={submitPreset}
				>
					<Icon name="arrow-up" className="h-4 w-4" />
				</button>
			</SpotlightCard>

			{modes === null ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("loading")}</div>
			) : modes.length === 0 ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("modes empty")}</div>
			) : (
				<>
					<p className="mt-1 text-[11px] text-[var(--color-text-faint)]">{t("modes default hint")}</p>
					{builtinModes.length > 0 && (
						<>
							<div className="gui-modes-group-title">{t("modes builtin group")}</div>
							<div className="mt-1 flex flex-col gap-2">{builtinModes.map(renderModeCard)}</div>
						</>
					)}
					{customModes.length > 0 && (
						<>
							<div className="gui-modes-group-title">{t("modes custom group")}</div>
							<div className="mt-1 flex flex-col gap-2">{customModes.map(renderModeCard)}</div>
						</>
					)}
				</>
			)}
			{/* 「查看配置」弹窗(DialogFrame = 进入/退出动画 + Escape/焦点托管 +
			 * portal 到 body;始终挂载、用 open 驱动,条件挂载会杀掉退出动画):
			 * 只读展示继承展开结果——继承链逐层 + 提示词区块(按 order)+ 扩展
			 * 白名单 + settings 覆盖 + 标志位,环/悬空/超深链显示诊断提示。 */}
			<DialogFrame
				open={viewState.status !== "idle"}
				onClose={() => setViewState({ status: "idle" })}
				label={t("modes view title")}
				className="w-[560px] max-w-[92vw]"
			>
				{viewState.status !== "idle" && (
					<>
						<div className="gui-dialog-head">
							<h3 className="text-[14px] font-medium">{t("modes view title")}</h3>
							<button
								type="button"
								className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
								onClick={() => setViewState({ status: "idle" })}
							>
								✕
							</button>
						</div>
						{viewState.status === "loading" ? (
							<div className="p-4 text-[12px] text-[var(--color-text-muted)]">{t("loading")}</div>
						) : viewState.status === "error" ? (
							<div className="p-4 text-[12px] text-[var(--color-danger)]">{viewState.error}</div>
						) : (
							<ModeViewBody id={viewState.id} view={viewState.view} catalog={modes} />
						)}
					</>
				)}
			</DialogFrame>
			{/* 复制弹窗(DialogFrame 紧凑样式 gui-dialog--confirm:自动尺寸 +
			 * 进入/退出动画):输入新 id → 复制为自定义预设。 */}
			<DialogFrame
				open={duplicateSource !== null}
				onClose={() => setDuplicateSource(null)}
				label={t("modes duplicate as")}
				className="gui-dialog--confirm"
			>
				{duplicateSource && (
					<>
						<h3 className="text-[14px] font-medium">{t("modes duplicate as")}</h3>
						<p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{t("modes duplicate hint")}</p>
						<input
							className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--color-surface)] px-2 py-1 text-[13px] outline-none focus:border-[var(--color-accent)]"
							placeholder={`${duplicateSource.id}-copy`}
							autoFocus
							value={dupId}
							onChange={e => setDupId(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter") void doDuplicate();
								if (e.key === "Escape") setDuplicateSource(null);
							}}
						/>
						<div className="mt-3 flex items-center gap-2">
							<button
								type="button"
								className="gui-pane-action"
								onClick={() => void doDuplicate()}
								disabled={saving || !dupId.trim()}
							>
								<span>{t("modes duplicate")}</span>
							</button>
							<button type="button" className="gui-pane-action" onClick={() => setDuplicateSource(null)}>
								<span>{t("modes cancel")}</span>
							</button>
							{saveMsg && <span className="text-[12px] text-[var(--color-text-muted)]">{saveMsg}</span>}
						</div>
					</>
				)}
			</DialogFrame>
		</>
	);
}

/** 「查看配置」正文:诊断警告(环/截断/悬空)→ 继承链逐层 → 展开结果四段
 *  (提示词区块按 order、扩展白名单、settings 覆盖、标志位)。展示顺序
 *  把 sources(拓扑序,父先子后)反转成「当前预设 → 父 → 祖父」的继承
 *  阅读方向,与卡片行的「基于 X + Y」一致。 */
function ModeViewBody({
	id,
	view,
	catalog,
}: {
	id: string;
	view: ModeChainView;
	catalog: ModeRow[] | null;
}): ReactNode {
	const { resolved } = view;
	const chainDisplay = [...view.sources].reverse();
	const settingsEntries = Object.entries(resolved.settings);
	const promptSorted = [...resolved.prompt].sort((a, b) => a.order - b.order);
	return (
		<FadeScroll className="min-h-0 flex-1 overflow-auto p-4">
			{view.cycle && (
				<div className="gui-modes-view-warn text-[var(--color-danger)]">
					{t("modes view cycle warning", { path: view.cycle.join(" → ") })}
				</div>
			)}
			{view.truncated && (
				<div className="gui-modes-view-warn text-[var(--color-text-muted)]">
					{t("modes view truncated", { max: String(MAX_MODE_CHAIN_DEPTH) })}
				</div>
			)}
			{view.missing.map(missingId => (
				<div key={missingId} className="gui-modes-view-warn text-[var(--color-danger)]">
					{t("modes view missing", { id: missingId })}
				</div>
			))}

			<div className="gui-modes-view-section-title">{t("modes view chain")}</div>
			<div className="gui-modes-chain">
				{chainDisplay.map((nodeId, i) => (
					<div key={nodeId} className="gui-modes-chain-row">
						<span className="gui-modes-chain-tag">{i === 0 ? t("modes view chain root") : "extends"}</span>
						<span className="truncate text-[12px] font-medium">{resolveModeLabel(nodeId, catalog)}</span>
						<span className="text-[11px] text-[var(--color-text-faint)]">({nodeId})</span>
					</div>
				))}
				{chainDisplay.length === 0 && (
					<div className="text-[12px] text-[var(--color-text-muted)]">{t("modes view none")}</div>
				)}
			</div>

			<div className="gui-modes-view-section-title">{t("modes view prompt sections")}</div>
			{promptSorted.length === 0 ? (
				<div className="text-[12px] text-[var(--color-text-muted)]">{t("modes view none")}</div>
			) : (
				promptSorted.map(section => (
					<div key={section.name} className="gui-modes-prompt-block">
						<div className="flex items-center gap-1.5">
							<span className="gui-provider-chip">
								{t("modes prompt order")} {section.order}
							</span>
							<span className="truncate text-[12px] font-medium">{section.name}</span>
						</div>
						<pre className="gui-modes-prompt-text">{section.text}</pre>
					</div>
				))
			)}

			<div className="gui-modes-view-section-title">{t("modes view extensions")}</div>
			{!resolved.extensionsExplicit ? (
				<div className="text-[12px] text-[var(--color-text-muted)]">{t("modes extensions all")}</div>
			) : resolved.extensions && resolved.extensions.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{resolved.extensions.map(ext => (
						<span key={ext} className="gui-provider-chip">
							{ext}
						</span>
					))}
				</div>
			) : (
				<div className="text-[12px] text-[var(--color-text-muted)]">{t("modes extensions none")}</div>
			)}

			<div className="gui-modes-view-section-title">{t("modes view settings")}</div>
			{settingsEntries.length === 0 ? (
				<div className="text-[12px] text-[var(--color-text-muted)]">{t("modes view none")}</div>
			) : (
				settingsEntries.map(([key, value]) => (
					<div key={key} className="gui-modes-kv">
						<span className="gui-modes-kv-key">{key}</span>
						<span className="gui-modes-kv-val">{JSON.stringify(value)}</span>
					</div>
				))
			)}

			<div className="gui-modes-view-section-title">{t("modes view flags")}</div>
			<div className="gui-modes-kv">
				<span className="gui-modes-kv-key">promptComplete</span>
				<span className="gui-modes-kv-val">
					{resolved.promptComplete ? t("modes view flag on") : t("modes view flag off")}
					{resolved.promptCompleteSource ? ` · ${resolved.promptCompleteSource}` : ""}
				</span>
			</div>
			<div className="gui-modes-kv">
				<span className="gui-modes-kv-key">runtimeContext</span>
				<span className="gui-modes-kv-val">
					{resolved.runtimeContext ? t("modes view flag on") : t("modes view flag off")}
				</span>
			</div>
			<div className="gui-modes-kv">
				<span className="gui-modes-kv-key">{t("modes view model role")}</span>
				<span className="gui-modes-kv-val">{resolved.modelRole ?? t("modes view model role none")}</span>
			</div>
			{/* 兜底提示:视图根 id 与展示 id 不符说明聚合来自部分链。 */}
			{view.missing.includes(id) && (
				<div className="mt-2 text-[11px] text-[var(--color-text-faint)]">
					{t("modes view title")} · {id}
				</div>
			)}
		</FadeScroll>
	);
}
