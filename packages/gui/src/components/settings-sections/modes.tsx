import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

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

const EMPTY_EDIT: ModeDef = { id: "", extends: [], prompt: [], settings: {} };

export function ModesSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [modes, setModes] = useState<ModeRow[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [validation, setValidation] = useState<Record<string, string[]>>({});
	/** 编辑面板:null = 关闭;对象 = 编辑中(编辑中的快照)。 */
	const [edit, setEdit] = useState<ModeDef | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{ modes: ModeRow[] } | null>("modes.list", {})
				.then(res => {
					if (!alive) return;
					setModes(res?.modes ?? []);
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
		setEdit({ ...EMPTY_EDIT });
		setSaveMsg(null);
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

	const validate = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request<{ valid: boolean; errors: string[] }>("modes.validate", { id })
			.then(res => setValidation(v => ({ ...v, [id]: res.valid ? [] : (res.errors ?? []) })))
			.catch(error => setValidation(v => ({ ...v, [id]: [String(error)] })));
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
				<button type="button" className="gui-pane-action" onClick={startNew} disabled={edit !== null}>
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
			{edit && <ModeEditor rpc={rpc} def={edit} modes={modes ?? []} onPatch={patch} />}
			{modes === null ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("loading")}</div>
			) : modes.length === 0 ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("modes empty")}</div>
			) : (
				<div className="mt-2 flex flex-col gap-2">
					{modes.map(mode => (
						<div key={mode.id} className="gui-agent-card">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
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
									<div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{mode.description}</div>
								) : null}
								{mode.extends.length > 0 ? (
									<div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
										{t("modes based on")} {mode.extends.join(" + ")}
									</div>
								) : null}
								<div className="mt-1.5 flex items-center gap-2">
									<button
										type="button"
										className="text-[12px] text-[var(--color-accent)] hover:underline"
										onClick={() => openEdit(mode.id)}
										disabled={mode.source === "extension"}
									>
										{t("modes edit")}
									</button>
									<button
										type="button"
										className="text-[12px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
										onClick={() => validate(mode.id)}
									>
										{t("modes validate")}
									</button>
									{mode.builtin !== true && mode.source !== "extension" && (
										<button
											type="button"
											className="text-[12px] text-[var(--color-danger)] hover:underline"
											onClick={() => remove(mode.id)}
										>
											{t("modes delete")}
										</button>
									)}
								</div>
								{validation[mode.id]?.length > 0 && (
									<div className="mt-1 text-[12px] text-[var(--color-danger)]">
										{validation[mode.id].join("; ")}
									</div>
								)}
							</div>
						</div>
					))}
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
							className={`${inputCls} w-[64px] shrink-0`}
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
							className={`${inputCls} min-h-[36px] resize-y`}
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
							className={`${inputCls} w-[40%] shrink-0`}
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
							className={inputCls}
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
