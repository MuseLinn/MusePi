import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/**
 * TemplateRail — template chip 的内容区（M3.7a §3.4 机制不变），落在欢迎页
 * composer 下方、设计体系 rail 上方（与 design-system-rail.tsx 同层同构：
 * 容器标题 + 内容区，进出场由调用方的 Reveal 承担）。
 *
 * opendesign 铁律（.workbuddy/spec/2026-09-28-opendesign-states.md §2）：
 * composer 是创建页的永久锚点，选中模板 chip 只在本 rail 展开，绝不替换
 * 输入框。点模板行 = 带模板快照建会话（createFromTemplate 语义不变）；
 * 输入框里的草稿继续存在，可以先写需求再点模板。
 *
 * 空态对齐 OD 的 noTemplatesBody：来源指引（创建原型/演示稿成功后可在
 * toast 存为模板）+ 「空白起步」等价路径（聚焦 composer 直接输入发送），
 * 避免用户被空态卡住。
 */

/** daemon CreationTemplate 的 GUI 视图(creation.templates.list 返回)。 */
export interface CreationTemplateRow {
	id: string;
	name?: string;
	tab: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

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

export function TemplateRail({
	rpc,
	active,
	onCreate,
	onCreated,
	onBusyChange,
	onBlankStart,
}: {
	rpc: RpcClient | null;
	/** rail 是否展开(template chip 选中);收起期间不拉取、不可交互
	 *  (节点由调用方 Reveal 保持挂载,本 prop 门控副作用)。 */
	active: boolean;
	/** 以模板快照建会话(metadata 已含 templateId);返回是否成功。 */
	onCreate(metadata: Record<string, unknown>): Promise<boolean>;
	/** 创建成功后的收尾(mode chip 复位 work,与点行建会话的原行为一致)。 */
	onCreated(): void;
	/** 创建期 busy 上报(composer 发送期禁按,与 railState.busy 同一语义)。 */
	onBusyChange(busy: boolean): void;
	/** 「空白起步」:聚焦 composer,直接输入发送即可建会话。 */
	onBlankStart(): void;
}): ReactNode {
	const [templates, setTemplates] = useState<CreationTemplateRow[]>([]);
	const [busy, setBusy] = useState(false);
	const { confirm } = useConfirm();

	const refreshTemplates = useCallback(() => {
		if (!rpc) return;
		void rpc
			.request<{ templates: CreationTemplateRow[] }>("creation.templates.list", {})
			.then(res => setTemplates(res?.templates ?? []))
			.catch(() => setTemplates([]));
	}, [rpc]);

	// 只在展开时拉取:普通欢迎页/其他 chip 选中时不产生 creation RPC。
	useEffect(() => {
		if (!active) return;
		refreshTemplates();
	}, [active, refreshTemplates]);

	// busy 透传给 composer 折进 canSend(发送期禁按);setState 引用稳定。
	useEffect(() => {
		onBusyChange(busy);
	}, [busy, onBusyChange]);

	/** 模板 rail:点一条即以该模板快照建会话(§3.4 机制不变)。 */
	const createFromTemplate = async (tpl: CreationTemplateRow): Promise<void> => {
		if (busy) return;
		setBusy(true);
		try {
			const now = new Date().toISOString();
			const inner = tpl.metadata;
			const name = typeof inner.name === "string" ? inner.name : null;
			const metadata = { ...inner, name, templateId: tpl.id, createdAt: now, updatedAt: now };
			const ok = await onCreate(metadata);
			if (ok) onCreated();
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

	return (
		<div className="gui-creation-template-rail" data-testid="gui-template-rail">
			<div className="gui-creation-field-label">{t("creation templates title")}</div>
			{templates.length === 0 ? (
				<div className="gui-creation-template-empty">
					{/* 来源指引:等价 OD 的 noTemplatesBody(怎么造模板)。 */}
					<p className="gui-creation-empty">{t("creation templates empty")}</p>
					{/* 「空白起步」等价路径(OD StartFromPicker 的 Blank 第一项):
					 *  聚焦 composer,直接输入发送即可建会话,空态不卡住用户。 */}
					<button type="button" className="gui-creation-template-blank" onClick={onBlankStart}>
						<Icon name="file-add" className="h-3.5 w-3.5" />
						<span>{t("creation templates blank start")}</span>
					</button>
				</div>
			) : (
				<div className="gui-creation-template-list">
					{templates.map(tpl => (
						<div key={tpl.id} className="gui-creation-template-row">
							<button
								type="button"
								className="gui-creation-template-main"
								disabled={busy}
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
}
