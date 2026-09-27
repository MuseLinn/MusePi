import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	applyChip,
	buildProjectMetadata,
	CREATION_CHIP_LABEL_KEYS,
	CREATION_CHIPS,
	CREATION_PLACEHOLDER_KEYS,
	type CreationChip,
	type CreationDraft,
	chipForDraft,
	DEFAULT_CREATION_DRAFT,
	hydrateDraftFromMetadata,
} from "../lib/creation";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { WelcomeComposer } from "./WelcomeComposer";

/**
 * CreationPanel — M3.7a design 模式页（docs/review/0.5.0-m3-mode-page-redesign.md
 * §2）。欢迎页 mode chip 选中 design 时展开（L2 带 z-2000,与设置面板平级）,
 * Escape/切回其他 mode chip 回到欢迎页。
 *
 * M3.1 的 overlay 骨架与动效原样保留,换掉的是内容物:六 tab 表单让位给
 * 模式页空态——自上而下「类型 chip 排 + 输入框」。chip 只承载类型选择
 * （§2.3）,类型特有字段全部取 M3.1 默认列,所以 `buildProjectMetadata`
 * 的编译结果与 M3.2 逐字段一致;「项目名」「工作目录」随表单底栏一并退役
 * （§4:标题由首轮消息生成,cwd 复用欢迎页当前工作目录）。
 *
 * 硬纪律落点:常驻挂载由 open 驱动(DialogFrame 同款两相位入场/退场,
 * 条件挂载会杀掉出场动画);所有 hook 声明在任何早退之前;零新视觉 token
 * (全部取档 M1.10 玻璃/动效规范);`gui-motion-off` / prefers-reduced-motion
 * 下全部动效归零;模式页的输入框是欢迎页 composer 本体(embedded),不复制
 * 第二份输入实现。
 *
 * 草稿跨收起/再入保留(模块级缓存);应用重启后的回填走
 * creation.metadata.get(cwd → .musepi/project.json 镜像),仅在本会话
 * 尚无草稿时消费一次。
 */

/** daemon CreationTemplate 的 GUI 视图(creation.templates.list 返回)。 */
interface CreationTemplateRow {
	id: string;
	name?: string;
	tab: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/** 模式页输入框的发送载荷(WelcomeComposer 的 onSubmit 形状)。 */
export interface CreationMessage {
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[];
	files?: File[];
	thinkingLevel?: string | null;
	modelId?: string | null;
}

/** 草稿的模块级缓存:面板卸载(退场动画后)后仍保留,收起再入即回填。 */
let sessionDraft: CreationDraft | null = null;
/** 每次应用运行只向 daemon 镜像回填一次(cwd 变化时重置)。 */
let mirrorHydratedFor: string | null = null;

/** 模板文件里的 tab 是任意字符串(daemon 不枚举校验历史文件)——
 *  已知 tab 走 i18n,未知原样回显。 */
const TAB_LABEL_KEYS: Record<string, TranslationKey> = {
	prototype: "creation tab prototype",
	"live-artifact": "creation tab live artifact",
	deck: "creation tab deck",
	template: "creation tab template",
	media: "creation tab media",
	other: "creation tab other",
};

function tabLabel(tab: string): string {
	const key = TAB_LABEL_KEYS[tab];
	return key ? t(key) : tab;
}

export function CreationPanel({
	open,
	onClose,
	rpc,
	project,
	onSubmit,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	/** 当前工作目录(欢迎页项目 chip)—— 创作会话的 cwd 复用它。 */
	project: string | null;
	/** 创建回调:app 组装 session.create(modeId:"design", projectMetadata)
	 *  并发送首轮消息。返回是否成功(成功后面板自关,app 弹保存模板 toast)。 */
	onSubmit(metadata: Record<string, unknown>, message?: CreationMessage): Promise<boolean>;
}): ReactNode {
	// ── 两相位入场/退场(DialogFrame 同款)────────────────────────────────
	const [mounted, setMounted] = useState(open);
	const [phase, setPhase] = useState<"enter" | "open" | "closing">(open ? "enter" : "open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<NodeJS.Timeout | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// ── 创作草稿(chip 选择的 kind/intent 落在这里)─────────────────────
	const [draft, setDraft] = useState<CreationDraft>(() => sessionDraft ?? DEFAULT_CREATION_DRAFT);
	const updateDraft = useCallback((patch: Partial<CreationDraft>) => {
		setDraft(prev => {
			const next = { ...prev, ...patch };
			sessionDraft = next;
			return next;
		});
	}, []);

	// ── 模板数据(template chip 的内容区)────────────────────────────────
	const [templates, setTemplates] = useState<CreationTemplateRow[]>([]);
	const refreshTemplates = useCallback(() => {
		if (!rpc) return;
		void rpc
			.request<{ templates: CreationTemplateRow[] }>("creation.templates.list", {})
			.then(res => setTemplates(res?.templates ?? []))
			.catch(() => setTemplates([]));
	}, [rpc]);

	const { confirm } = useConfirm();
	const [busy, setBusy] = useState(false);

	// open 翻转驱动两相位(DialogFrame 逐行同构;240ms 入 / 140ms 出)。
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

	// Escape 收合(capture 阶段,面板优先于背后的欢迎页)。嵌套浮层/弹窗
	// (菜单互斥、DialogFrame/confirm)打开时把 Escape 让给它。
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

	// 焦点接管(§5u):打开时焦点进面板,关闭后还原到之前的焦点元素。
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

	// 打开时:拉模板列表 + 一次性镜像回填(重启后恢复上次的类型选择)。
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
						// 项目名随表单退役(§4):镜像里的旧项目名不回写 —— 会话
						// 标题由首轮消息生成。
						const next = {
							...hydrateDraftFromMetadata(res.metadata as Record<string, unknown>, prev),
							name: "",
						};
						sessionDraft = next;
						return next;
					});
				}
			})
			.catch(() => {
				// 镜像缺失/损坏 → 保持默认草稿(daemon 会话头才是权威)。
			});
	}, [open, refreshTemplates, project, rpc]);

	// ── 派生数据(全部在早退之前计算)────────────────────────────────────
	const chip = chipForDraft(draft);
	const placeholder = t(CREATION_PLACEHOLDER_KEYS[chip]);

	/** chip 排:只写类型(kind/intent),其余字段保持默认列。 */
	const pickChip = (next: CreationChip): void => {
		updateDraft(applyChip(draft, next));
	};

	/** 输入框发送:既有 session.create + projectMetadata 管线(§2.4)。 */
	const submitComposer = (text: string, opts?: Omit<CreationMessage, "text">): void => {
		if (busy) return;
		setBusy(true);
		const metadata = buildProjectMetadata(draft);
		void onSubmit(metadata, { text, ...opts })
			.then(ok => {
				if (ok) onCloseRef.current();
			})
			.finally(() => setBusy(false));
	};

	/** 模板 rail:点一条即以该模板快照建会话(§3.4 机制不变)。 */
	const createFromTemplate = async (tpl: CreationTemplateRow): Promise<void> => {
		if (busy) return;
		setBusy(true);
		try {
			const now = new Date().toISOString();
			const inner = tpl.metadata;
			const name = typeof inner.name === "string" ? inner.name : null;
			const metadata = { ...inner, name, templateId: tpl.id, createdAt: now, updatedAt: now };
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
			refreshTemplates();
		} catch {
			// daemon 离线等:静默(列表刷新自然暴露状态)。
		}
	};

	const templateRail = (
		<div className="gui-creation-field">
			<div className="gui-creation-field-label">{t("creation templates title")}</div>
			{templates.length === 0 ? (
				<p className="gui-creation-empty">{t("creation templates empty")}</p>
			) : (
				<div className="gui-creation-template-list">
					{templates.map(tpl => (
						<div key={tpl.id} className="gui-creation-template-row">
							<button
								type="button"
								className="gui-creation-template-main"
								onClick={() => void createFromTemplate(tpl)}
							>
								<span className="gui-creation-template-name">{tpl.name ?? t("creation template unnamed")}</span>
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
					))}
				</div>
			)}
		</div>
	);

	if (!mounted || !rpc) return null;

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
				{/* 类型 chip 排(§2.3:单选,默认 prototype) */}
				<div className="gui-creation-chips gui-creation-chiprow" role="radiogroup" aria-label={t("creation title")}>
					{CREATION_CHIPS.map(item => {
						const on = chip === item;
						return (
							<button
								key={item}
								type="button"
								role="radio"
								aria-checked={on}
								className={`gui-creation-chip${on ? " gui-creation-chip--on" : ""}`}
								onClick={() => pickChip(item)}
							>
								{t(CREATION_CHIP_LABEL_KEYS[item])}
							</button>
						);
					})}
				</div>
				{/* 内容区:类型 chip → 输入框;template chip → 模板 rail */}
				<div className="gui-creation-body gui-creation-mode">
					{chip === "template" ? (
						templateRail
					) : (
						<WelcomeComposer
							embedded
							rpc={rpc}
							busy={busy}
							project={project}
							placeholder={placeholder}
							onSubmit={(text, opts) => submitComposer(text, opts)}
						/>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
