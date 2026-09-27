import { Segmented, type TranslationKey, t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	buildProjectMetadata,
	type CreationDraft,
	type CreationTab,
	DEFAULT_CREATION_DRAFT,
	hydrateDraftFromMetadata,
	MEDIA_ASPECTS,
	MEDIA_DURATIONS,
	PROMPT_TEMPLATES,
	promptTemplateLabel,
} from "../lib/creation";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { GuiSelect } from "./GuiSelect";

/**
 * CreationPanel — M3.2 六 tab 创作面板（docs/review/0.5.0-m3.1-creation-surface-design.md
 * §3/§5）。欢迎页全屏 overlay（L2 带 z-2000，与设置面板平级）：欢迎 composer
 * 的 mode chip 选中 design 时展开，Escape/收起回到欢迎页。
 *
 * 硬纪律落点：常驻挂载由 open 驱动（DialogFrame 同款两相位入场/退场，
 * 条件挂载会杀掉出场动画）；所有 hook 声明在任何早退之前；零新视觉 token
 * （全部取档 M1.10 玻璃/动效规范）；`gui-motion-off` / prefers-reduced-motion
 * 下全部动效归零；模型身份 provider/id（媒体 provider 卡直接用 provider id）。
 *
 * 表单草稿跨收起/再入保留（模块级缓存）；应用重启后的回填走
 * creation.metadata.get（cwd → .musepi/project.json 镜像），仅在本会话
 * 尚无草稿时消费一次。
 */

/** daemon CreationTemplate 的 GUI 视图（creation.templates.list 返回）。 */
interface CreationTemplateRow {
	id: string;
	name?: string;
	tab: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/** daemon media.providers 条目（settings-sections/media.tsx 同款形状）。 */
interface MediaProviderEntry {
	id: string;
	label: string;
	kind: "image" | "video";
	configured: boolean;
	models?: string[];
}

/** 草稿的模块级缓存：面板卸载（退场动画后）后仍保留，收起再入即回填。 */
let sessionDraft: CreationDraft | null = null;
/** 每次应用运行只向 daemon 镜像回填一次（cwd 变化时重置）。 */
let mirrorHydratedFor: string | null = null;

const CREATION_TABS: CreationTab[] = ["prototype", "live-artifact", "deck", "template", "media", "other"];

/** tab id → i18n key（id 带连字符而 key 走空格分词，两处必须经此表对齐）。 */
const CREATION_TAB_LABEL_KEYS: Record<CreationTab, TranslationKey> = {
	prototype: "creation tab prototype",
	"live-artifact": "creation tab live artifact",
	deck: "creation tab deck",
	template: "creation tab template",
	media: "creation tab media",
	other: "creation tab other",
};

const PLATFORM_LABEL_KEYS: Record<string, TranslationKey> = {
	responsive: "creation platform responsive",
	"web-desktop": "creation platform web-desktop",
	"mobile-ios": "creation platform mobile-ios",
	"mobile-android": "creation platform mobile-android",
	tablet: "creation platform tablet",
	"desktop-app": "creation platform desktop-app",
};

/** 模板文件里的 tab 是任意字符串（daemon 不枚举校验历史文件）——
 *  已知 tab 走 i18n,未知原样回显。 */
function tabLabel(tab: string): string {
	const key = (CREATION_TAB_LABEL_KEYS as Record<string, TranslationKey>)[tab];
	return key ? t(key) : tab;
}

export function CreationPanel({
	open,
	onClose,
	rpc,
	project,
	onPickProject,
	onSubmit,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	/** 当前工作目录（欢迎页项目 chip）。 */
	project: string | null;
	/** 复用 app 的目录选择器（Electron folder picker + 项目登记）。 */
	onPickProject(): void;
	/** 创建回调：app 组装 session.create(modeId:"design", projectMetadata)。
	 *  返回是否成功（成功后面板自关，app 弹保存模板 toast）。 */
	onSubmit(metadata: Record<string, unknown>): Promise<boolean>;
}): ReactNode {
	// ── 两相位入场/退场（DialogFrame 同款）────────────────────────────────
	const [mounted, setMounted] = useState(open);
	const [phase, setPhase] = useState<"enter" | "open" | "closing">(open ? "enter" : "open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<NodeJS.Timeout | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// ── 表单草稿 ─────────────────────────────────────────────────────────
	const [draft, setDraft] = useState<CreationDraft>(() => sessionDraft ?? DEFAULT_CREATION_DRAFT);
	const updateDraft = useCallback((patch: Partial<CreationDraft>) => {
		setDraft(prev => {
			const next = { ...prev, ...patch };
			sessionDraft = next;
			return next;
		});
	}, []);
	/** 从模板回填（rail 卡/模板 tab 应用）：字段整体替换,tab 不变;
	 *  null = Blank 恒首位 → 重置为默认草稿（保留 tab,清空项目名）。 */
	const applyTemplate = useCallback((metadata: Record<string, unknown> | null) => {
		setDraft(prev => {
			const next = metadata
				? hydrateDraftFromMetadata(metadata, { ...prev, name: "" })
				: { ...DEFAULT_CREATION_DRAFT, tab: prev.tab, name: "" };
			sessionDraft = next;
			return next;
		});
	}, []);

	// ── 模板数据（rail + template tab 共用）───────────────────────────────
	const [templates, setTemplates] = useState<CreationTemplateRow[]>([]);
	const refreshTemplates = useCallback(() => {
		if (!rpc) return;
		void rpc
			.request<{ templates: CreationTemplateRow[] }>("creation.templates.list", {})
			.then(res => setTemplates(res?.templates ?? []))
			.catch(() => setTemplates([]));
	}, [rpc]);

	// rail 选中（null = Blank 恒首位）。模板 tab 的行选择是另一状态。
	const [railTemplateId, setRailTemplateId] = useState<string | null>(null);
	const [templateRowId, setTemplateRowId] = useState<string | null>(null);

	// ── 媒体 provider（media.providers RPC,置灰判断 = configured）──────────
	const [providers, setProviders] = useState<MediaProviderEntry[] | null>(null);
	const refreshProviders = useCallback(() => {
		if (!rpc) return;
		void rpc
			.request<{ builtin: MediaProviderEntry[]; extension: MediaProviderEntry[] }>("media.providers", {})
			.then(res => setProviders([...(res?.builtin ?? []), ...(res?.extension ?? [])]))
			.catch(() => setProviders([]));
	}, [rpc]);

	// ── tab 下划线滑动指示（§5s 档 240ms）─────────────────────────────────
	const tabRefs = useRef<Map<CreationTab, HTMLButtonElement | null>>(new Map());
	const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

	const { confirm } = useConfirm();
	const [busy, setBusy] = useState(false);
	// 提示词模板搜索 popover（§5 L3 档）。
	const [promptSearch, setPromptSearch] = useState("");
	const [promptOpen, setPromptOpen] = useState(false);
	const promptAnchorRef = useRef<HTMLButtonElement | null>(null);
	const { renderMenu: renderPromptMenu } = useFloatingMenu(promptOpen, setPromptOpen, {
		className: "gui-creation-prompt-menu",
		anchor: promptAnchorRef.current,
	});

	// open 翻转驱动两相位（DialogFrame 逐行同构；240ms 入 / 140ms 出）。
	useEffect(() => {
		if (open) {
			setMounted(true);
			setPhase("enter");
			const advance = (): void => {
				rafRef.current = requestAnimationFrame(() => {
					rafRef.current = requestAnimationFrame(() => setPhase("open"));
				});
			};
			advance();
			timerRef.current = setTimeout(() => {
				if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
				setPhase("open");
			}, 80);
			return () => {
				if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
			};
		}
		setPhase("closing");
		const t = setTimeout(() => setMounted(false), 140);
		return () => clearTimeout(t);
	}, [open]);

	// Escape 收合（capture 阶段,面板优先于背后的欢迎页）。嵌套浮层/弹窗
	// （菜单互斥、DialogFrame/confirm）打开时把 Escape 让给它。
	useEffect(() => {
		if (!mounted || phase === "closing") return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			if (e.defaultPrevented) return;
			if (document.querySelector(".gui-menu-popup, .gui-dialog-backdrop")) return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [mounted, phase]);

	// 焦点接管（§5u）：打开时焦点进面板,关闭后还原到之前的焦点元素。
	const prevFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (open) {
			prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			return;
		}
		prevFocusRef.current?.focus();
		prevFocusRef.current = null;
	}, [open]);
	useEffect(() => {
		if (phase === "open") panelRef.current?.focus();
	}, [phase]);

	// 打开时：拉模板列表 + 一次性镜像回填（重启后恢复上次创作配置）。
	useEffect(() => {
		if (!open) return;
		refreshTemplates();
		if (sessionDraft || mirrorHydratedFor === (project ?? "")) return;
		mirrorHydratedFor = project ?? "";
		if (!rpc || !project) return;
		void rpc
			.request<{ metadata: Record<string, unknown> | null }>("creation.metadata.get", { cwd: project })
			.then(res => {
				if (res?.metadata && !sessionDraft) {
					setDraft(prev => {
						const next = hydrateDraftFromMetadata(res.metadata as Record<string, unknown>, prev);
						sessionDraft = next;
						return next;
					});
				}
			})
			.catch(() => {
				// 镜像缺失/损坏 → 保持默认草稿（daemon 会话头才是权威）。
			});
	}, [open, refreshTemplates, project, rpc]);

	// media tab 首次进入时拉 provider 列表（置灰判断数据源）。
	useEffect(() => {
		if (open && draft.tab === "media" && providers === null) refreshProviders();
	}, [open, draft.tab, providers, refreshProviders]);

	// provider 数据到位后,当前 kind 未选 provider 或选中未配置 → 自动选首个已配置。
	useEffect(() => {
		if (!providers) return;
		const kind = draft.mediaKind;
		if (kind === "audio") return; // audio 无 provider 注册表（M3.2 报告项）
		const relevant = providers.filter(p => p.kind === kind);
		const current = draft.mediaProvider ? relevant.find(p => p.id === draft.mediaProvider) : undefined;
		if (current?.configured) return;
		const firstConfigured = relevant.find(p => p.configured);
		if (firstConfigured && firstConfigured.id !== draft.mediaProvider) {
			updateDraft({
				mediaProvider: firstConfigured.id,
				mediaModel: firstConfigured.models?.[0] ?? null,
			});
		}
	}, [providers, draft.mediaKind, draft.mediaProvider, updateDraft]);

	// tab 下划线测量（开合动画后 / tab 切换 / 尺寸变化都要重算）。
	useLayoutEffect(() => {
		if (!mounted) return;
		const measure = (): void => {
			const el = tabRefs.current.get(draft.tab);
			if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
		};
		measure();
		const raf = requestAnimationFrame(measure);
		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", measure);
		};
	}, [mounted, draft.tab]);

	// ── 派生数据（全部在早退之前计算）────────────────────────────────────
	const isLive = draft.tab === "live-artifact";
	const railTemplates = templates.filter(
		tpl => tpl.tab === draft.tab || (draft.tab === "live-artifact" && tpl.tab === "prototype"),
	);
	const kindProviders = (providers ?? []).filter(p => p.kind === draft.mediaKind);
	const mediaProviderConfigured =
		draft.mediaKind === "audio" ||
		(!!draft.mediaProvider && !!providers?.find(p => p.id === draft.mediaProvider)?.configured);
	const canCreate = draft.tab !== "media" || mediaProviderConfigured;
	const filteredPromptTemplates = PROMPT_TEMPLATES.filter(tpl =>
		t(tpl.labelKey).toLowerCase().includes(promptSearch.trim().toLowerCase()),
	);

	const switchTab = (tab: CreationTab): void => {
		updateDraft({ tab });
		setRailTemplateId(null);
	};

	const create = async (): Promise<void> => {
		if (busy || !canCreate) return;
		if (draft.tab === "template") {
			// 模板 tab 创建 = 应用选中模板（快照整体 + templateId 盖章）。
			const tpl = templates.find(x => x.id === templateRowId);
			if (!tpl) return;
			setBusy(true);
			try {
				const now = new Date().toISOString();
				const inner = tpl.metadata;
				const name = draft.name.trim() || (typeof inner.name === "string" ? inner.name : null);
				const metadata = { ...inner, name, templateId: tpl.id, createdAt: now, updatedAt: now };
				const ok = await onSubmit(metadata);
				if (ok) onCloseRef.current();
			} finally {
				setBusy(false);
			}
			return;
		}
		setBusy(true);
		try {
			const metadata = buildProjectMetadata(draft, railTemplateId);
			const ok = await onSubmit(metadata);
			if (ok) onCloseRef.current();
		} finally {
			setBusy(false);
		}
	};

	const deleteTemplate = async (tpl: CreationTemplateRow): Promise<void> => {
		const name = tpl.name ?? t("creation template unnamed");
		const ok = await confirm(t("creation template confirm delete", { name }), t("creation template delete"));
		if (!ok) return;
		try {
			await rpc?.request("creation.templates.delete", { id: tpl.id });
			if (templateRowId === tpl.id) setTemplateRowId(null);
			refreshTemplates();
		} catch {
			// daemon 离线等:静默（列表刷新自然暴露状态）。
		}
	};

	if (!mounted) return null;

	const backdropCls = `gui-creation-backdrop${
		phase === "enter"
			? " gui-creation-backdrop--pending"
			: phase === "closing"
				? " gui-creation-backdrop--closing"
				: " gui-creation-backdrop--entered"
	}`;
	const panelCls = `gui-creation-panel${
		phase === "enter"
			? " gui-creation-panel--pending"
			: phase === "closing"
				? " gui-creation-panel--closing"
				: " gui-creation-panel--entered"
	}`;

	// ── 各 tab 内容 ────────────────────────────────────────────────────────
	const platformPicker = (
		<div className="gui-creation-field">
			<div className="gui-creation-field-label">{t("creation platform label")}</div>
			<div className="gui-creation-chips" role="group" aria-label={t("creation platform label")}>
				{Object.entries(PLATFORM_LABEL_KEYS).map(([value, key]) => {
					const on = draft.platforms.includes(value);
					return (
						<button
							key={value}
							type="button"
							className={`gui-creation-chip${on ? " gui-creation-chip--on" : ""}`}
							aria-pressed={on}
							onClick={() =>
								updateDraft({
									platforms: on ? draft.platforms.filter(p => p !== value) : [...draft.platforms, value],
								})
							}
						>
							{t(key)}
						</button>
					);
				})}
			</div>
		</div>
	);

	const fidelityPicker = isLive ? null : (
		<div className="gui-creation-field">
			<div className="gui-creation-field-label">{t("creation fidelity label")}</div>
			<div className="gui-creation-fidelity" role="radiogroup" aria-label={t("creation fidelity label")}>
				{(["wireframe", "high-fidelity"] as const).map(fid => {
					const on = draft.fidelity === fid;
					return (
						<button
							key={fid}
							type="button"
							role="radio"
							aria-checked={on}
							className={`gui-creation-fidelity-card${on ? " gui-creation-fidelity-card--on" : ""}`}
							onClick={() => updateDraft({ fidelity: fid })}
						>
							<span className="gui-creation-fidelity-demo" data-fidelity={fid} aria-hidden="true">
								{fid === "wireframe" ? (
									<>
										<i />
										<i />
										<i />
									</>
								) : (
									<>
										<i data-hi="hero" />
										<i data-hi="line" />
										<i data-hi="line" />
									</>
								)}
							</span>
							<span className="gui-creation-fidelity-name">{t(`creation fidelity ${fid}`)}</span>
							<span className="gui-creation-fidelity-desc">{t(`creation fidelity ${fid} desc`)}</span>
						</button>
					);
				})}
			</div>
		</div>
	);

	const surfaceToggles =
		draft.tab === "other" ? null : (
			<div className="gui-creation-field">
				<ToggleRow
					label={t("creation surface landing")}
					on={draft.landingPage}
					onChange={v => updateDraft({ landingPage: v })}
				/>
				<ToggleRow
					label={t("creation surface os widgets")}
					on={draft.osWidgets}
					onChange={v => updateDraft({ osWidgets: v })}
				/>
			</div>
		);

	const startFromRail =
		draft.tab === "template" ? null : (
			<div className="gui-creation-field">
				<div className="gui-creation-field-label">{t("creation start from")}</div>
				<div className="gui-creation-rail" role="radiogroup" aria-label={t("creation start from")}>
					<button
						type="button"
						role="radio"
						aria-checked={railTemplateId === null}
						className={`gui-creation-rail-card gui-creation-rail-card--blank${railTemplateId === null ? " gui-creation-rail-card--on" : ""}`}
						style={{ "--stagger": 0 } as CSSProperties}
						onClick={() => {
							setRailTemplateId(null);
							applyTemplate(null);
						}}
					>
						<Icon name="add" className="gui-creation-rail-blank-icon" />
						<span>{t("creation blank")}</span>
					</button>
					{railTemplates.map((tpl, i) => {
						const on = railTemplateId === tpl.id;
						return (
							<button
								key={tpl.id}
								type="button"
								role="radio"
								aria-checked={on}
								className={`gui-creation-rail-card${on ? " gui-creation-rail-card--on" : ""}`}
								style={{ "--stagger": i + 1 } as CSSProperties}
								onClick={() => {
									setRailTemplateId(tpl.id);
									applyTemplate(tpl.metadata);
								}}
							>
								<span className="gui-creation-rail-name">{tpl.name ?? t("creation template unnamed")}</span>
								<span className="gui-creation-rail-tab">{tabLabel(tpl.tab)}</span>
							</button>
						);
					})}
				</div>
			</div>
		);

	let tabBody: ReactNode;
	switch (draft.tab) {
		case "prototype":
		case "other":
			tabBody = (
				<>
					{draft.tab === "other" && <p className="gui-creation-desc">{t("creation other desc")}</p>}
					{platformPicker}
					{fidelityPicker}
					{surfaceToggles}
				</>
			);
			break;
		case "live-artifact":
			tabBody = (
				<>
					<p className="gui-creation-desc">
						<span className="gui-creation-beta">{t("creation live artifact beta")}</span>
						{t("creation live artifact desc")}
					</p>
					{platformPicker}
					{surfaceToggles}
					<div className="gui-creation-field">
						<div className="gui-creation-connectors">
							<Icon name="briefcase" className="h-3.5 w-3.5 flex-none opacity-60" />
							{t("creation connectors placeholder")}
						</div>
					</div>
				</>
			);
			break;
		case "deck":
			tabBody = (
				<div className="gui-creation-field">
					<ToggleRow
						label={t("creation speaker notes")}
						on={draft.speakerNotes}
						onChange={v => updateDraft({ speakerNotes: v })}
					/>
				</div>
			);
			break;
		case "template":
			tabBody = (
				<div className="gui-creation-field">
					<div className="gui-creation-field-label">{t("creation templates title")}</div>
					{templates.length === 0 ? (
						<p className="gui-creation-empty">{t("creation templates empty")}</p>
					) : (
						<div
							className="gui-creation-template-list"
							role="radiogroup"
							aria-label={t("creation templates title")}
						>
							{templates.map(tpl => {
								const on = templateRowId === tpl.id;
								return (
									<div
										key={tpl.id}
										className={`gui-creation-template-row${on ? " gui-creation-template-row--on" : ""}`}
									>
										<button
											type="button"
											role="radio"
											aria-checked={on}
											className="gui-creation-template-main"
											onClick={() => setTemplateRowId(tpl.id)}
										>
											<Icon
												name="check"
												className={`gui-creation-template-radio${on ? " gui-creation-template-radio--on" : ""}`}
											/>
											<span className="gui-creation-template-name">
												{tpl.name ?? t("creation template unnamed")}
											</span>
											<span className="gui-creation-template-tab">{tabLabel(tpl.tab)}</span>
										</button>
										<button
											type="button"
											className="gui-creation-template-delete"
											aria-label={t("creation template delete")}
											onClick={() => void deleteTemplate(tpl)}
										>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
									</div>
								);
							})}
						</div>
					)}
				</div>
			);
			break;
		case "media":
			tabBody = (
				<>
					<div className="gui-creation-field">
						<Segmented
							className="gui-creation-media-seg"
							ariaLabel={t("creation tab media")}
							value={draft.mediaKind}
							options={[
								{ value: "image", label: t("creation media image") },
								{ value: "video", label: t("creation media video") },
								{ value: "audio", label: t("creation media audio") },
							]}
							onChange={v => updateDraft({ mediaKind: v, mediaProvider: null, mediaModel: null })}
						/>
					</div>
					{draft.mediaKind !== "audio" ? (
						<>
							<div className="gui-creation-field">
								<div className="gui-creation-field-label">{t("creation media model label")}</div>
								{kindProviders.length === 0 ? (
									<p className="gui-creation-empty">{t("creation media no providers")}</p>
								) : (
									<div
										className="gui-creation-media-cards"
										role="radiogroup"
										aria-label={t("creation media model label")}
									>
										{kindProviders.map(p => {
											const on = draft.mediaProvider === p.id;
											return (
												<button
													key={p.id}
													type="button"
													role="radio"
													aria-checked={on}
													disabled={!p.configured}
													className={`gui-creation-media-card${on ? " gui-creation-media-card--on" : ""}${p.configured ? "" : " gui-creation-media-card--off"}`}
													onClick={() =>
														updateDraft({ mediaProvider: p.id, mediaModel: p.models?.[0] ?? null })
													}
												>
													<span className="gui-creation-media-card-main">
														<span className="gui-creation-media-card-label">{p.label}</span>
														<span className="gui-creation-media-card-status">
															<span
																className={`gui-provider-status-dot${p.configured ? " gui-provider-status-dot--on" : ""}`}
																aria-hidden="true"
															/>
															{p.configured
																? t("creation media configured")
																: t("creation media not configured")}
														</span>
													</span>
													{on && <Icon name="check" className="gui-creation-media-card-check" />}
												</button>
											);
										})}
									</div>
								)}
							</div>
							<div className="gui-creation-field">
								<div className="gui-creation-field-label">{t("creation media aspect label")}</div>
								<div
									className="gui-creation-chips"
									role="radiogroup"
									aria-label={t("creation media aspect label")}
								>
									{MEDIA_ASPECTS.map(aspect => (
										<button
											key={aspect}
											type="button"
											role="radio"
											aria-checked={draft.mediaAspect === aspect}
											className={`gui-creation-chip${draft.mediaAspect === aspect ? " gui-creation-chip--on" : ""}`}
											onClick={() => updateDraft({ mediaAspect: aspect })}
										>
											{aspect}
										</button>
									))}
								</div>
							</div>
						</>
					) : (
						<>
							<div className="gui-creation-field">
								<div className="gui-creation-field-label">{t("creation media audio kind label")}</div>
								<div
									className="gui-creation-chips"
									role="radiogroup"
									aria-label={t("creation media audio kind label")}
								>
									{(["speech", "sfx"] as const).map(k => (
										<button
											key={k}
											type="button"
											role="radio"
											aria-checked={draft.mediaAudioKind === k}
											className={`gui-creation-chip${draft.mediaAudioKind === k ? " gui-creation-chip--on" : ""}`}
											onClick={() => updateDraft({ mediaAudioKind: k })}
										>
											{t(`creation media kind ${k}`)}
										</button>
									))}
								</div>
							</div>
							{draft.mediaAudioKind === "speech" && (
								<div className="gui-creation-field">
									<div className="gui-creation-field-label">{t("creation media voice label")}</div>
									<input
										type="text"
										className="gui-input w-full"
										value={draft.mediaVoice}
										placeholder={t("creation media voice placeholder")}
										spellCheck={false}
										onChange={e => updateDraft({ mediaVoice: e.target.value })}
									/>
								</div>
							)}
						</>
					)}
					{draft.mediaKind !== "image" && (
						<div className="gui-creation-field">
							<div className="gui-creation-field-label">{t("creation media duration label")}</div>
							<GuiSelect
								value={String(draft.mediaDurationSec)}
								onChange={v => updateDraft({ mediaDurationSec: Number(v) })}
								ariaLabel={t("creation media duration label")}
								options={MEDIA_DURATIONS.map(sec => ({
									value: String(sec),
									label: t("creation media duration sec", { sec: String(sec) }),
								}))}
							/>
						</div>
					)}
					<div className="gui-creation-field">
						<div className="gui-creation-field-label">{t("creation media prompt label")}</div>
						<button
							ref={promptAnchorRef}
							type="button"
							className="gui-creation-prompt-trigger"
							onClick={() => setPromptOpen(v => !v)}
						>
							<Icon name="search" className="h-3.5 w-3.5 flex-none opacity-60" />
							<span className="min-w-0 flex-1 truncate text-left">
								{draft.mediaPromptTemplateId
									? promptTemplateLabel(draft.mediaPromptTemplateId)
									: t("creation media prompt search")}
							</span>
							<Icon name="arrow-down-s" className="h-3 w-3 flex-none opacity-60" />
						</button>
						{renderPromptMenu(
							<div className="gui-creation-prompt-list">
								<input
									type="text"
									className="gui-input w-full"
									value={promptSearch}
									placeholder={t("creation media prompt search")}
									onChange={e => setPromptSearch(e.target.value)}
								/>
								{filteredPromptTemplates.map(tpl => (
									<button
										key={tpl.id}
										type="button"
										className="gui-select-opt"
										onClick={() => {
											updateDraft({ mediaPromptTemplateId: tpl.id, mediaPrompt: t(tpl.bodyKey) });
											setPromptOpen(false);
										}}
									>
										<span className="min-w-0 flex-1 truncate">{t(tpl.labelKey)}</span>
									</button>
								))}
							</div>,
						)}
						<textarea
							className="gui-creation-prompt-text"
							value={draft.mediaPrompt}
							placeholder={t("creation media prompt placeholder")}
							rows={3}
							onChange={e => updateDraft({ mediaPrompt: e.target.value })}
						/>
					</div>
				</>
			);
			break;
	}

	return createPortal(
		<div className={backdropCls} onClick={onClose}>
			<div
				ref={panelRef}
				className={panelCls}
				role="dialog"
				aria-modal="true"
				aria-label={t("creation title")}
				onClick={e => e.stopPropagation()}
				tabIndex={-1}
			>
				{/* 标题行 + 关闭 */}
				<div className="gui-creation-head">
					<div className="gui-creation-title">{t("creation title")}</div>
					<button type="button" className="gui-creation-close" aria-label={t("creation close")} onClick={onClose}>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				{/* tab 条（§5s 滑动下划线） */}
				<div className="gui-creation-tabs" role="tablist">
					{CREATION_TABS.map(tab => (
						<button
							key={tab}
							type="button"
							role="tab"
							aria-selected={draft.tab === tab}
							ref={el => {
								tabRefs.current.set(tab, el);
							}}
							className={`gui-creation-tab${draft.tab === tab ? " gui-creation-tab--on" : ""}`}
							onClick={() => switchTab(tab)}
						>
							{t(CREATION_TAB_LABEL_KEYS[tab])}
							{tab === "live-artifact" && (
								<span className="gui-creation-beta gui-creation-beta--tab">
									{t("creation live artifact beta")}
								</span>
							)}
						</button>
					))}
					{indicator && (
						<span
							className="gui-creation-tab-underline"
							style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
						/>
					)}
				</div>
				{/* 内容区（160ms 交叉淡入,不位移） */}
				<div className="gui-creation-body" key={draft.tab}>
					{tabBody}
					{startFromRail}
				</div>
				{/* 公共底栏：项目名 + 工作目录 + 创建 */}
				<div className="gui-creation-foot">
					<div className="gui-creation-foot-field">
						<label className="gui-creation-foot-label" htmlFor="gui-creation-name">
							{t("creation project name")}
						</label>
						<input
							id="gui-creation-name"
							type="text"
							className="gui-input gui-creation-name"
							value={draft.name}
							placeholder={t("creation project name placeholder")}
							onChange={e => updateDraft({ name: e.target.value })}
							onKeyDown={e => {
								if (e.key === "Enter") void create();
							}}
						/>
					</div>
					<div className="gui-creation-foot-field">
						<span className="gui-creation-foot-label">{t("creation workspace")}</span>
						<button
							type="button"
							className="gui-creation-workspace"
							onClick={onPickProject}
							title={project ?? t("creation workspace none")}
						>
							<Icon name="folder" className="h-3.5 w-3.5 flex-none" />
							<span className="min-w-0 flex-1 truncate">{project ?? t("creation workspace none")}</span>
							<span className="gui-creation-workspace-pick">{t("creation pick workspace")}</span>
						</button>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn-approve gui-creation-create"
						disabled={busy || !canCreate || (draft.tab === "template" && !templateRowId)}
						onClick={() => void create()}
					>
						{draft.tab === "template" ? t("creation template apply") : t("creation create button")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** 设置页同款开关行（.gui-toggle 既有 token,零新样式）。 */
function ToggleRow({ label, on, onChange }: { label: string; on: boolean; onChange(v: boolean): void }): ReactNode {
	return (
		<div className="gui-creation-toggle-row">
			<span className="gui-creation-toggle-label">{label}</span>
			<button
				type="button"
				className={`gui-toggle${on ? " gui-toggle--on" : ""}`}
				aria-pressed={on}
				onClick={() => onChange(!on)}
			>
				<span className="gui-toggle-knob" />
			</button>
		</div>
	);
}
