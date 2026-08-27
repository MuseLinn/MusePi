import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { DialogFrame } from "../DialogFrame";
import { FadeScroll } from "../FadeScroll";
import { SpotlightCard } from "../SpotlightCard";

/** Settings → 智能体 → 预设:命名预设(工具集 + 提示词 + settings 覆盖)卡片面板
 *  + 完整编辑器(modes-plan §8/§9:ModesCenter)。数据源 daemon modes.list/
 *  modes.get/modes.save;modes.changed 即时刷新。编辑字段:label/description/
 *  extends(继承多选)/extensions(三态白名单)/prompt 区块列表/promptComplete/
 *  runtimeContext/settings 键值。 */

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
	/** 查看弹窗内容(null = 关闭)。 */
	const [viewDef, setViewDef] = useState<ModeDef | null>(null);
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

	const openView = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request<ModeDef | null>("modes.get", { id })
			.then(def => def && setViewDef(def))
			.catch(error => setErrors([String(error)]));
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

	return (
		<>
			<h2 className="gui-settings-page-title">{t("modes title")}</h2>
			<p className="gui-settings-page-desc">{t("modes description")}</p>
			{errors.length > 0 && (
				<div className="gui-settings-row text-[12px] text-[var(--color-danger)]">{errors.join("; ")}</div>
			)}
			{/* 新建预设:看板式始终可见自然语言输入框 —— Enter/发送把预设描述
			 * 发给 Creator 会话(DSH),由 Creator 设计并保存预设。SpotlightCard
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
					<div className="mt-1 flex flex-col gap-2">
						{modes.map(mode => (
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
										<span className="truncate text-[13px] font-medium">{mode.label}</span>
										<span className="text-[11px] text-[var(--color-text-faint)]">({mode.id})</span>
										{mode.promptComplete ? (
											<span className="gui-provider-chip">{t("modes complete badge")}</span>
										) : null}
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
										<div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
											{mode.description}
										</div>
									) : null}
									{mode.extends.length > 0 ? (
										<div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
											{t("modes based on")} {mode.extends.join(" + ")}
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
						))}
					</div>
				</>
			)}
			{/* 查看弹窗(DialogFrame = 进入/退出动画 + Escape/焦点托管 + portal
			 * 到 body;始终挂载、用 open 驱动,条件挂载会杀掉退出动画):只读展示
			 * 预设完整定义。 */}
			<DialogFrame
				open={viewDef !== null}
				onClose={() => setViewDef(null)}
				label={t("modes view title")}
				className="w-[520px] max-w-[92vw]"
			>
				{viewDef && (
					<>
						<div className="gui-dialog-head">
							<h3 className="text-[14px] font-medium">{t("modes view title")}</h3>
							<button
								type="button"
								className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
								onClick={() => setViewDef(null)}
							>
								✕
							</button>
						</div>
						<FadeScroll className="min-h-0 flex-1 overflow-auto p-4">
							<pre className="whitespace-pre-wrap break-all rounded-lg bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
								{JSON.stringify(viewDef, null, 2)}
							</pre>
						</FadeScroll>
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
