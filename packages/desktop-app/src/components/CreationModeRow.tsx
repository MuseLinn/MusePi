import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { RpcClient } from "../lib/rpc";
import { useScrollShadow } from "../lib/use-scroll-shadow";

/**
 * CreationModeRow — M3.7a design 模式页的欢迎页内联形态
 * （docs/review/0.5.0-m3-mode-page-redesign.md v2 修订,§2.2/§2.3）。
 * 欢迎页 mode chip 选中「设计」时,类型 chip 排直接渲染在欢迎页空态
 * composer 上方一行;没有弹层、没有标题栏、没有第二个输入框——发送
 * 走欢迎页 composer 本体,本组件只拥有「类型选择 → projectMetadata」
 * 的编译。模板 chip 的内容区(TemplateRail,§3.4 机制不变)由
 * WelcomeComposer 渲染在 composer 下方,opendesign 铁律:composer 是
 * 创建页永久锚点,选中 chip 永不替换输入框。
 *
 * chip 只承载类型(kind/intent 写进创作草稿,§2.3),类型特有字段全部
 * 取 M3.1 默认列,所以 `buildProjectMetadata` 的编译结果与 M3.2 逐字段
 * 一致;「项目名」「工作目录」随 M3.2 表单底栏一并退役(§4:标题由首轮
 * 消息生成,cwd 复用欢迎页当前工作目录)。
 *
 * 与 composer 的协作通过两个缝:① `onStateChange` 上报
 * placeholder/template/busy(composer 依此覆盖 placeholder、在 template
 * chip 时于 composer 下方展开 TemplateRail、发送期禁按);② `onReady` 交出
 * `CreationRailHandle`,composer 的发送钩子调 `handle.submit(text, opts)` 进入
 * session.create + projectMetadata 管线(§2.4),失败返回 false 由
 * composer 回填草稿。
 *
 * Escape/切回其他 mode chip → chip 排收起(§2.1:回到普通欢迎页)。收起时
 * 组件保持挂载(退场动效 + 草稿保留),由 `active` prop 门控副作用;
 * 草稿跨收起/再入保留(模块级缓存);应用重启后的回填走
 * creation.metadata.get(cwd → .musepi/project.json 镜像),仅在本会话
 * 尚无草稿时消费一次。
 */

/** 模式页输入框的发送载荷(WelcomeComposer 的 onSubmit 形状)。 */
export interface CreationMessage {
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[];
	files?: File[];
	thinkingLevel?: string | null;
	modelId?: string | null;
}

/** composer 侧驱动发送的句柄(§2.4:发送 = 既有 session.create 管线)。 */
export interface CreationRailHandle {
	/**
	 * 欢迎页 composer 的发送钩子。返回是否成功;失败(false)时 composer
	 * 回填输入草稿,模式页保持展开供修正。
	 */
	submit(text: string, opts?: Omit<CreationMessage, "text">): Promise<boolean>;
}

/** 上报给 composer 的派生态:placeholder 随选中 chip 变化,template
 *  chip 选中时 composer 下方展开模板 rail(输入框常驻,opendesign 铁律),
 * busy 期间禁按发送。 */
export interface CreationRailState {
	placeholder: string;
	template: boolean;
	busy: boolean;
}

/** 草稿的模块级缓存:chip 排收起(卸载)后仍保留,再入即回填。 */
let sessionDraft: CreationDraft | null = null;
/** 每次应用运行只向 daemon 镜像回填一次(cwd 变化时重置)。 */
let mirrorHydratedFor: string | null = null;

export function CreationModeRow({
	rpc,
	active,
	project,
	onSubmit,
	onClose,
	onStateChange,
	onReady,
}: {
	rpc: RpcClient | null;
	/** chip 排当前是否展开(欢迎页 mode chip 选中「设计」)。收起期间组件
	 *  保持挂载(退场动效 + 草稿保留),本 prop 门控所有对外副作用:
	 *  Escape 收起、派生态上报、模板/镜像拉取都只在展开时生效。 */
	active: boolean;
	/** 当前工作目录(欢迎页项目 chip)—— 创作会话的 cwd 复用它。 */
	project: string | null;
	/** 创建回调:app 组装 session.create(modeId:"design", projectMetadata)
	 *  并发送首轮消息。返回是否成功(成功后 chip 排收起,app 弹保存模板 toast)。 */
	onSubmit(metadata: Record<string, unknown>, message?: CreationMessage): Promise<boolean>;
	/** 收起模式页(§2.1:Escape/切回其他 mode chip 回到普通欢迎页)。 */
	onClose(): void;
	/** 派生态上报(composer 覆盖 placeholder / 展开模板 rail / 禁按发送)。 */
	onStateChange(state: CreationRailState): void;
	/** 发送句柄注册(composer 的发送钩子经此进入创建管线)。 */
	onReady(handle: CreationRailHandle | null): void;
}): ReactNode {
	// ── 创作草稿(chip 选择的 kind/intent 落在这里)─────────────────────
	const [draft, setDraft] = useState<CreationDraft>(() => sessionDraft ?? DEFAULT_CREATION_DRAFT);
	const updateDraft = useCallback((patch: Partial<CreationDraft>) => {
		setDraft(prev => {
			const next = { ...prev, ...patch };
			sessionDraft = next;
			return next;
		});
	}, []);

	// ── 发送期 busy(模板 rail 的 busy 由 TemplateRail 自行上报 composer)──
	const [busy, setBusy] = useState(false);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onStateChangeRef = useRef(onStateChange);
	onStateChangeRef.current = onStateChange;
	const activeRef = useRef(active);
	activeRef.current = active;

	// chip 排横向溢出时左右边缘羽化(全局滚动羽化机制,§gui-design)。
	const chiprailRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(chiprailRef);

	// ── 派生数据(全部在早退之前计算)────────────────────────────────────
	const chip = chipForDraft(draft);
	const placeholder = t(CREATION_PLACEHOLDER_KEYS[chip]);
	const template = chip === "template";

	// 派生态变化即上报(composer 依此覆盖 placeholder/展开模板 rail/禁按);
	// 收起期间上报中性态——composer 的 designActive 分支不消费 placeholder,
	// 但 busy/template 必须复位,防止收起态残留禁按或 rail 保持展开。
	useEffect(() => {
		onStateChangeRef.current(
			active ? { placeholder, template, busy } : { placeholder: "", template: false, busy: false },
		);
	}, [active, placeholder, template, busy]);

	// 挂载时:一次性镜像回填(重启后恢复上次的类型选择)。只在展开时消费:
	// 普通欢迎页(work 模式)不应产生 creation RPC(模板列表由 TemplateRail
	// 在 rail 展开时自行拉取)。
	useEffect(() => {
		if (!active) return;
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
	}, [active, project, rpc]);

	// Escape 收起(capture 阶段,优先于欢迎页背后的输入框处理)。嵌套
	// 浮层/弹窗(菜单互斥、DialogFrame/confirm)打开时把 Escape 让给它。
	// 收起期间组件仍挂载(退场动效),Escape 只在展开时响应。
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			if (!activeRef.current) return;
			if (e.defaultPrevented) return;
			if (document.querySelector(".gui-menu-popup, .gui-dialog-backdrop")) return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, []);

	/** 发送句柄:composer 的发送钩子 → 既有 session.create + metadata 管线。 */
	useEffect(() => {
		onReady({
			submit: (text, opts) => {
				if (busy) return Promise.resolve(false);
				setBusy(true);
				const metadata = buildProjectMetadata(draft);
				return onSubmit(metadata, { text, ...opts })
					.then(ok => {
						if (ok) onCloseRef.current();
						return ok;
					})
					.finally(() => setBusy(false));
			},
		});
		return () => onReady(null);
	}, [busy, draft, onSubmit]);

	if (!rpc) return null;

	/** chip 排:只写类型(kind/intent),其余字段保持默认列。 */
	const pickChip = (next: CreationChip): void => {
		updateDraft(applyChip(draft, next));
	};

	return (
		<div className="gui-creation-modepage w-full">
			{/* 类型 chip 排(§2.3:单选,默认 prototype;横向溢出滚动,
			 *  左右羽化由 useScrollShadow + .gui-fade-scroll 接管)。 */}
			<div
				ref={chiprailRef}
				className="gui-creation-chiprail gui-fade-scroll"
				role="radiogroup"
				aria-label={t("creation title")}
			>
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
		</div>
	);
}
