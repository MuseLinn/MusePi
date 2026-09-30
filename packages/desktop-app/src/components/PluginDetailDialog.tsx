import { t } from "@musepi/client-core";
import { isSttDownloadEvent, isTtsDownloadEvent } from "@musepi/pi-wire";
import { type ReactNode, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import type { ExtensionItem } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { SpeechModelPicker, TIER_META, TTS_TIER_META } from "./settings-sections/voice";
import {
	builtinDescription,
	builtinDisplayName,
	builtinText,
	PluginManifestSections,
	pluginStateLabel,
	sourceLevelLabel,
} from "./UnifiedPluginsView";

/**
 * 插件详情液态玻璃弹层（dsh 插件详情页 parity，交互形态按小袁总决策
 * 从「跳转页面」改为「弹出浮层」，浮层本身日后可插件化）：
 * 标题（图标 + 显示名 + kind/来源标签 + 状态点）、ID + 描述、
 * 触发词 / 来源 / 路径、dsh「包含的组件」段——每组件一行独立开关
 * （tool 通道写 tools.disabled 工具黑名单，stt/tts-engine 通道写
 * voice.disabledEngines 引擎黑名单——都是真实禁用，禁用后工具集/
 * 模型目录/转写合成路径同步关闭）、清单配置表单与资源卡
 * （PluginManifestSections 单一权威复用）。
 *
 * 语音单元（voice:stt / voice:tts）的模型/音色字段不用裸下拉渲染，
 * 内嵌与设置页完全相同的 SpeechModelPicker 卡片（同一组件、同一
 * 下载通道、同一存储——双入口零漂移），其余字段才进通用表单。
 *
 * DialogFrame 常驻挂载由 open 驱动（GUI 规范：条件挂载会杀死退场动画）。
 */

/** 语音单元内由模型选择器卡片承载、不再进通用配置表单的设置键。 */
const VOICE_PICKER_KEYS: Record<string, readonly string[]> = {
	"voice:stt": ["stt.modelName"],
	"voice:tts": ["tts.localModel", "tts.localVoice"],
};

function VoiceModelPicker({ item, rpc }: { item: ExtensionItem; rpc: RpcClient | null }): ReactNode {
	if (item.id === "voice:stt") {
		return (
			<div className="gui-ext-detail-section">
				<SpeechModelPicker
					rpc={rpc}
					titleKey="speech recognition model"
					radioName="stt-model-dialog"
					statusMethod="stt.modelStatus"
					downloadMethod="stt.modelDownload"
					settingsKey="stt.modelName"
					meta={TIER_META}
					isDownloadEvent={isSttDownloadEvent}
					autoFetchOnSelect
				/>
			</div>
		);
	}
	if (item.id === "voice:tts") {
		return (
			<div className="gui-ext-detail-section">
				<SpeechModelPicker
					rpc={rpc}
					titleKey="speech synthesis model"
					radioName="tts-model-dialog"
					statusMethod="tts.modelStatus"
					downloadMethod="tts.modelDownload"
					settingsKey="tts.localModel"
					voiceSettingsKey="tts.localVoice"
					meta={TTS_TIER_META}
					isDownloadEvent={isTtsDownloadEvent}
					autoFetchOnSelect={false}
				/>
			</div>
		);
	}
	return null;
}

function ComponentsSection({
	item,
	rpc,
	onError,
}: {
	item: ExtensionItem;
	rpc: RpcClient | null;
	onError(m: string | null): void;
}): ReactNode {
	const [busy, setBusy] = useState<string | null>(null);
	if (!item.components || item.components.length === 0) return null;

	const toggle = (componentId: string, enabled: boolean): void => {
		if (!rpc || busy) return;
		setBusy(componentId);
		void rpc
			.request("extensions.setComponentEnabled", { id: item.id, component: componentId, enabled })
			.then(() => onError(null))
			.catch((err: unknown) =>
				onError(`${t("ext component toggle failed")}: ${err instanceof Error ? err.message : String(err)}`),
			)
			.finally(() => setBusy(null));
		// daemon 广播 extensions.changed → registry 单例重拉，不本地乐观更新。
	};

	return (
		<div className="gui-ext-detail-section">
			<div className="gui-ext-detail-label">
				{t("ext plugin components")} · {item.components.length}
			</div>
			<div className="gui-plugin-config-desc">{t("ext plugin components desc")}</div>
			<div className="gui-plugin-components">
				{item.components.map(c => {
					// 组件名/描述同 builtin 覆盖模式：daemon 英文原文,GUI 按
					// `ext builtin <name> component <id>[ desc]` 键查译文。
					const name = (item.builtin ? builtinText(`ext builtin ${item.name} component ${c.id}`) : null) ?? c.name;
					const description =
						(item.builtin ? builtinText(`ext builtin ${item.name} component ${c.id} desc`) : null) ??
						c.description;
					return (
						<div key={c.id} className="gui-plugin-component-row">
							<div className="min-w-0 flex-1">
								<div className="gui-plugin-component-name">
									<span className={`gui-ext-dot${c.enabled ? "" : " gui-ext-dot--off"}`} />
									{name}
								</div>
								{description ? <div className="gui-plugin-component-desc">{description}</div> : null}
								{!c.enabled && c.disabledReason ? (
									<div className="gui-plugin-component-denied">{t("ext component denied")}</div>
								) : null}
							</div>
							{c.canToggle && (
								<button
									type="button"
									role="switch"
									aria-checked={c.enabled}
									aria-label={`${t("plugin enable")} ${name}`}
									className={`gui-toggle gui-toggle--sm${c.enabled ? " gui-toggle--on" : ""}`}
									disabled={busy === c.id}
									onClick={() => toggle(c.id, !c.enabled)}
								>
									<span className="gui-toggle-knob" />
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function PluginDetailDialog({
	open,
	onClose,
	item,
	rpc,
	onError,
}: {
	open: boolean;
	onClose(): void;
	item: ExtensionItem | null;
	rpc: RpcClient | null;
	/** 组件开关错误出口（弹层内横幅）。 */
	onError(message: string | null): void;
}): ReactNode {
	const pickerKeys = item ? VOICE_PICKER_KEYS[item.id] : undefined;
	const filteredItem =
		item && pickerKeys && item.config
			? { ...item, config: item.config.filter(f => !pickerKeys.includes(f.key)) }
			: item;
	return (
		<DialogFrame open={open} onClose={onClose} label={t("ext plugin details")} className="gui-plugin-dialog">
			{item && filteredItem && (
				<>
					<div className="gui-dialog-head">
						<Icon name="code-box" className="h-4 w-4 opacity-70" />
						<span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{builtinDisplayName(item)}</span>
						<span className="gui-ext-item-tag">{item.id}</span>
						<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("close")}>
							<Icon name="close" className="h-4 w-4" />
						</button>
					</div>
					<div className="gui-plugin-dialog-body">
						<div className="gui-ext-detail-section">
							<div
								className={`gui-ext-detail-status${item.state === "active" && !item.loadError ? " gui-ext-detail-status--active" : item.state === "shadowed" ? " gui-ext-detail-status--shadowed" : ""}`}
							>
								<span
									className={`gui-ext-dot${item.loadError ? " gui-ext-dot--error" : item.state === "active" ? "" : item.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
								/>
								{pluginStateLabel(item)}
								<span className="gui-ext-item-tag">
									{sourceLevelLabel(item.source.provider, item.source.level)}
								</span>
							</div>
							{builtinDescription(item) ? (
								<div className="gui-ext-plugins-desc">{builtinDescription(item)}</div>
							) : null}
							{item.loadError && (
								<div className="gui-ext-detail-loaderror" title={item.loadError}>
									<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
									<span className="min-w-0 truncate">{item.loadError}</span>
								</div>
							)}
						</div>
						{/* dsh CardFacts parity：完整名称 / 配置状态 / 启用于。
						 *  预设提供的条目（会话插件面）配置状态读「由 Agent 预设
						 *  按会话提供」，与 dsh presetProvidedDetail 同语义。 */}
						<dl className="gui-plugin-facts">
							<div>
								<dt>{t("ext full name")}</dt>
								<dd>
									<code>{item.id}</code>
								</dd>
							</div>
							<div>
								<dt>{t("ext configuration status")}</dt>
								<dd>
									{item.enabledInPresets && item.enabledInPresets.length > 0
										? t("ext preset provided detail")
										: pluginStateLabel(item)}
								</dd>
							</div>
							{item.enabledInPresets && item.enabledInPresets.length > 0 ? (
								<div>
									<dt>{t("ext enabled in")}</dt>
									<dd>{item.enabledInPresets.join(" · ")}</dd>
								</div>
							) : null}
						</dl>
						{item.trigger && (
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">{t("trigger")}</div>
								<div className="gui-ext-detail-path">{item.trigger}</div>
							</div>
						)}
						<div className="gui-ext-detail-section">
							<div className="gui-ext-detail-label">{t("source")}</div>
							<div className="gui-ext-detail-value">
								{t("via {provider} ({level})", {
									provider: item.source.providerName,
									level: sourceLevelLabel(item.source.provider, item.source.level),
								})}
							</div>
							<div className="gui-ext-detail-path">{item.path}</div>
						</div>
						<ComponentsSection item={item} rpc={rpc} onError={onError} />
						<VoiceModelPicker item={item} rpc={rpc} />
						{(filteredItem.config?.length || item.configErrors?.length || item.resources) && (
							<PluginManifestSections item={filteredItem} rpc={rpc} />
						)}
					</div>
				</>
			)}
		</DialogFrame>
	);
}
