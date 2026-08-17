import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { Reveal } from "../Reveal";

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

interface PromptRow {
	name: string;
	order: number;
	text: string;
}

export function ModesSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [modes, setModes] = useState<ModeRow[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);

	/** 编辑面板:null = 关闭;对象 = 编辑中(编辑中的快照)。 */
	const [edit, setEdit] = useState<ModeDef | null>(null);
	/** 看板式新建输入框(参考 BoardPage 悬浮输入):点击「新建」出现输入框,
	 *  Enter 以 id 创建空预设后进入编辑 —— 非人为填表。 */
	const [newOpen, setNewOpen] = useState(false);
	const [newId, setNewId] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);
	/** 当前默认预设(新会话;localStorage 持久化,app.tsx welcome 同步)。 */
	const [defaultModeId, setDefaultModeId] = useState<string | null>(
		() => localStorage.getItem("omp-gui-default-mode") ?? "work",
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

	const openEdit = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request<ModeDef | null>("modes.get", { id })
			.then(def => {
				if (!def) return;
				setEdit({
					id: def.id,
					label: def.label,
					description: def.description,
					extends: def.extends ?? [],
					extensions: def.extensions,
					prompt: (def.prompt ?? []).map(row =>
						typeof row === "string"
							? { name: `mode:${def.id}:section`, order: 25, text: row }
							: { name: row.name, order: row.order, text: row.text },
					),
					promptComplete: def.promptComplete === true,
					runtimeContext: def.runtimeContext !== false,
					settings: def.settings ?? {},
				});
				setSaveMsg(null);
			})
			.catch(error => setErrors([`${t("modes load failed")}: ${String(error)}`]));
	};

	const startNew = (): void => {
		setNewOpen(true);
		setNewId("");
		setSaveMsg(null);
	};

	const createNew = async (): Promise<void> => {
		if (!rpc || !newId.trim()) return;
		const id = newId.trim();
		// 与 daemon modes.save 同一校验(MODE_ID_PATTERN)。
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
			setSaveMsg(`⚠ invalid id: ${id}`);
			return;
		}
		setSaving(true);
		try {
			await rpc.request("modes.save", { id, label: id, prompt: [] });
			setNewOpen(false);
			setNewId("");
			setSaveMsg(null);
			openEdit(id);
		} catch (error) {
			setSaveMsg(`⚠ ${String(error)}`);
		} finally {
			setSaving(false);
		}
	};

	const patch = (part: Partial<ModeDef>): void => setEdit(prev => (prev ? { ...prev, ...part } : prev));

	const save = async (): Promise<void> => {
		if (!rpc || !edit) return;
		setSaving(true);
		setSaveMsg(null);
		try {
			await rpc.request("modes.save", {
				...edit,
				// 空数组与 undefined 三态:extensions 缺省 = 全部启用
				...(edit.extensions === undefined ? {} : { extensions: edit.extensions }),
				...(edit.extends && edit.extends.length > 0 ? { extends: edit.extends } : {}),
				prompt: edit.prompt ?? [],
				...(edit.promptComplete ? { promptComplete: true } : {}),
				...(edit.runtimeContext === false ? { runtimeContext: false } : {}),
				settings: edit.settings ?? {},
			});
			setSaveMsg(t("modes saved"));
			setEdit(null);
		} catch (error) {
			setSaveMsg(`⚠ ${String(error)}`);
		} finally {
			setSaving(false);
		}
	};

	const setDefault = (id: string): void => {
		setDefaultModeId(id);
		localStorage.setItem("omp-gui-default-mode", id);
		// welcome 预设 chip 同步(与 omp-gui-default-model-changed 同模式)。
		window.dispatchEvent(new CustomEvent("omp-gui-default-mode-changed", { detail: id }));
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
			<div className="mt-1 flex items-center gap-2">
				<button type="button" className="gui-pane-action" onClick={startNew} disabled={edit !== null || newOpen}>
					<span>{t("modes new")}</span>
				</button>
				{edit && (
					<>
						<button type="button" className="gui-pane-action" onClick={() => void save()} disabled={saving}>
							<span>{t("modes save")}</span>
						</button>
						<button
							type="button"
							className="gui-pane-action"
							onClick={() => {
								setEdit(null);
								setSaveMsg(null);
							}}
						>
							<span>{t("modes cancel")}</span>
						</button>
						{saveMsg && <span className="text-[12px] text-[var(--color-text-muted)]">{saveMsg}</span>}
					</>
				)}
			</div>
			{newOpen && (
				<div className="mt-1 flex items-center gap-2 rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-1.5">
					<input
						className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-1 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
						placeholder={t("modes id field")}
						value={newId}
						autoFocus
						onChange={e => setNewId(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") void createNew();
							if (e.key === "Escape") setNewOpen(false);
						}}
					/>
					<button
						type="button"
						className="gui-pane-action"
						onClick={() => void createNew()}
						disabled={saving || !newId.trim()}
					>
						<span>{t("modes save")}</span>
					</button>
					<button type="button" className="gui-pane-action" onClick={() => setNewOpen(false)}>
						<span>{t("modes cancel")}</span>
					</button>
				</div>
			)}
			<Reveal open={edit !== null}>
				{edit && <ModeEditor rpc={rpc} def={edit} modes={modes ?? []} onPatch={patch} />}
			</Reveal>
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
													onClick={() => openEdit(mode.id)}
												>
													{t("modes edit")}
												</button>
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
			{/* 查看弹窗:只读展示预设完整定义 */}
			{viewDef && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
					onClick={() => setViewDef(null)}
				>
					<div
						className="max-h-[70vh] w-[520px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--color-surface)] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
						onClick={e => e.stopPropagation()}
					>
						<div className="flex items-center justify-between">
							<h3 className="text-[14px] font-medium">{t("modes view title")}</h3>
							<button
								type="button"
								className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
								onClick={() => setViewDef(null)}
							>
								✕
							</button>
						</div>
						<pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
							{JSON.stringify(viewDef, null, 2)}
						</pre>
					</div>
				</div>
			)}
			{/* 复制弹窗:输入新 id → 复制为自定义预设 */}
			{duplicateSource && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
					onClick={() => setDuplicateSource(null)}
				>
					<div
						className="w-[400px] rounded-xl border border-[var(--border)] bg-[var(--color-surface)] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
						onClick={e => e.stopPropagation()}
					>
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
					</div>
				</div>
			)}
		</>
	);
}

/** 把 prompt 条目(string 快捷语法)规范化为可编辑对象。 */
function normalizePrompt(def: ModeDef): PromptRow[] {
	return (def.prompt ?? []).map(row =>
		typeof row === "string"
			? { name: `mode:${def.id}:section`, order: 25, text: row }
			: { name: row.name, order: row.order, text: row.text },
	);
}

/** 内联编辑面板(modes-plan §9):继承多选 + 扩展三态 + prompt 区块列表 +
 *  promptComplete/runtimeContext 开关 + settings 键值。 */
function ModeEditor({
	rpc,
	def,
	modes,
	onPatch,
}: {
	rpc: RpcClient | null;
	def: ModeDef;
	modes: ModeRow[];
	onPatch(part: Partial<ModeDef>): void;
}): ReactNode {
	const setPrompt = (rows: PromptRow[]): void => onPatch({ prompt: rows });
	const setSettings = (settings: Record<string, unknown>): void => onPatch({ settings });
	const [extList, setExtList] = useState<{ id: string; label?: string }[] | null>(null);
	useEffect(() => {
		// 白名单多选需要已发现扩展(extension-module 类目)。
		if (!rpc) return;
		void rpc.request<{ extensions?: Array<{ id: string; label?: string }> }>("extensions.list", {}).then(res => {
			setExtList((res?.extensions ?? []).filter(e => e.id.startsWith("extension-module:")));
		});
	}, [rpc]);
	const extNames = extList?.map(e => e.id.replace(/^extension-module:/, "")) ?? [];
	const toggleExt = (name: string): void => {
		const cur = def.extensions === undefined ? undefined : new Set(def.extensions);
		if (cur === undefined) return; // 三态缺省态需先显式选:点"全部"radio 后 cur 变 []/数组
		cur.has(name) ? cur.delete(name) : cur.add(name);
		onPatch({ extensions: [...cur] });
	};

	const inputCls =
		"w-full rounded-md border border-[var(--border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] outline-none focus:border-[var(--color-accent)]";
	// flex 行内元素:不能带 w-full(flex-basis 100% 会被 shrink 压没),
	// 用 flex-1 min-w-0 吃剩余宽度。
	const rowInputCls =
		"rounded-md border border-[var(--border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] outline-none focus:border-[var(--color-accent)]";

	return (
		<div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--color-surface)] p-3">
			<div className="grid grid-cols-2 gap-2">
				<label className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
					{t("modes id field")}
					<input
						className={inputCls}
						value={def.id}
						onChange={e => onPatch({ id: e.target.value })}
						placeholder="my-mode"
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
					{t("modes label field")}
					<input className={inputCls} value={def.label ?? ""} onChange={e => onPatch({ label: e.target.value })} />
				</label>
			</div>
			<label className="mt-2 flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
				{t("modes desc field")}
				<textarea
					className={`${inputCls} min-h-[48px] resize-y`}
					value={def.description ?? ""}
					onChange={e => onPatch({ description: e.target.value })}
				/>
			</label>

			{/* 继承:已存在预设多选(禁自身/循环由 save 校验拦截) */}
			<div className="mt-2 text-[12px] text-[var(--color-text-muted)]">{t("modes extends field")}</div>
			<div className="mt-1 flex flex-wrap gap-1">
				{modes
					.filter(m => m.id !== def.id)
					.map(m => {
						const checked = def.extends?.includes(m.id) ?? false;
						return (
							<button
								key={m.id}
								type="button"
								className={`gui-provider-chip${checked ? " !border-[var(--color-accent)]" : ""}`}
								onClick={() => {
									const cur = new Set(def.extends ?? []);
									cur.has(m.id) ? cur.delete(m.id) : cur.add(m.id);
									onPatch({ extends: [...cur] });
								}}
							>
								{m.label} ({m.id})
							</button>
						);
					})}
			</div>

			{/* 扩展三态:全部(缺省) / 仅内置 / 白名单多选 */}
			<div className="mt-2 text-[12px] text-[var(--color-text-muted)]">{t("modes extensions field")}</div>
			<div className="mt-1 flex items-center gap-2 text-[12px]">
				<label className="flex items-center gap-1">
					<input
						type="radio"
						checked={def.extensions === undefined}
						onChange={() => onPatch({ extensions: undefined })}
					/>
					{t("modes extensions all")}
				</label>
				<label className="flex items-center gap-1">
					<input
						type="radio"
						checked={def.extensions !== undefined && def.extensions.length === 0}
						onChange={() => onPatch({ extensions: [] })}
					/>
					{t("modes extensions none")}
				</label>
			</div>
			{def.extensions !== undefined && (
				<div className="mt-1 flex flex-wrap gap-1">
					{extNames.map(name => {
						const checked = def.extensions?.includes(name) ?? false;
						return (
							<button
								key={name}
								type="button"
								className={`gui-provider-chip${checked ? " !border-[var(--color-accent)]" : ""}`}
								onClick={() => toggleExt(name)}
							>
								{name}
							</button>
						);
					})}
				</div>
			)}

			{/* 提示词区块列表 */}
			<div className="mt-2 flex items-center justify-between text-[12px] text-[var(--color-text-muted)]">
				<span>{t("modes prompt field")}</span>
				<button
					type="button"
					className="text-[var(--color-accent)] hover:underline"
					onClick={() =>
						setPrompt([...normalizePrompt(def), { name: `mode:${def.id}:section`, order: 25, text: "" }])
					}
				>
					+ {t("modes prompt add")}
				</button>
			</div>
			<div className="mt-1 flex flex-col gap-1.5">
				{normalizePrompt(def).map((section, idx) => (
					<div key={idx} className="flex items-center gap-1.5">
						<input
							className={`${rowInputCls} w-[64px] shrink-0`}
							title={t("modes prompt order")}
							type="number"
							value={section.order}
							onChange={e => {
								const next = normalizePrompt(def);
								next[idx] = { ...section, order: Number(e.target.value) || 0 };
								setPrompt(next);
							}}
						/>
						<textarea
							className={`${rowInputCls} min-h-[36px] min-w-0 flex-1 resize-y`}
							title={t("modes prompt text")}
							value={section.text}
							onChange={e => {
								const next = normalizePrompt(def);
								next[idx] = { ...section, text: e.target.value };
								setPrompt(next);
							}}
						/>
						<button
							type="button"
							className="shrink-0 text-[12px] text-[var(--color-danger)] hover:underline"
							onClick={() => setPrompt(normalizePrompt(def).filter((_, i) => i !== idx))}
						>
							✕
						</button>
					</div>
				))}
			</div>

			{/* promptComplete / runtimeContext 开关 */}
			<div className="mt-2 flex flex-col gap-1.5 text-[12px]">
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={def.promptComplete === true}
						onChange={e => onPatch({ promptComplete: e.target.checked })}
					/>
					{t("modes complete toggle")}
				</label>
				{def.promptComplete === true && (
					<p className="text-[11px] text-[var(--color-text-faint)]">{t("modes complete hint")}</p>
				)}
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={def.runtimeContext !== false}
						onChange={e => onPatch({ runtimeContext: e.target.checked })}
					/>
					{t("modes runtime toggle")}
				</label>
			</div>

			{/* settings 键值 */}
			<div className="mt-2 flex items-center justify-between text-[12px] text-[var(--color-text-muted)]">
				<span>{t("modes settings field")}</span>
				<button
					type="button"
					className="text-[var(--color-accent)] hover:underline"
					onClick={() => {
						const next = { ...(def.settings ?? {}) };
						next[`key${Object.keys(next).length + 1}`] = "";
						setSettings(next);
					}}
				>
					+ {t("modes settings add")}
				</button>
			</div>
			<div className="mt-1 flex flex-col gap-1.5">
				{Object.entries(def.settings ?? {}).map(([key, value]) => (
					<div key={key} className="flex items-center gap-1.5">
						<input
							className={`${rowInputCls} w-[40%] shrink-0`}
							title={t("modes settings key")}
							value={key}
							onChange={e => {
								const next: Record<string, unknown> = {};
								for (const [k, v] of Object.entries(def.settings ?? {})) {
									if (k === key) next[e.target.value] = v;
									else next[k] = v;
								}
								setSettings(next);
							}}
						/>
						<input
							className={`${rowInputCls} min-w-0 flex-1`}
							title={t("modes settings value")}
							value={String(value ?? "")}
							onChange={e => setSettings({ ...(def.settings ?? {}), [key]: e.target.value })}
						/>
						<button
							type="button"
							className="shrink-0 text-[12px] text-[var(--color-danger)] hover:underline"
							onClick={() => {
								const next = { ...(def.settings ?? {}) };
								delete next[key];
								setSettings(next);
							}}
						>
							✕
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
