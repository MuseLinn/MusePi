import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
	ASSET_POLICIES,
	CREATION_PLATFORMS,
	type CreationChip,
	type CreationDraft,
	chipForDraft,
	MEDIA_ASPECTS,
	MEDIA_DURATIONS,
} from "../../lib/creation";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { GuiSelect } from "../GuiSelect";
import { Reveal } from "../Reveal";

/**
 * 素材策略行 + 「高级 ▸」折叠区（M3.7c §4，
 * docs/review/0.5.0-m3-mode-page-redesign.md §2.2 信息架构最底行）。
 *
 * 落在 composer 下方、设计体系预览 rail 之下（WelcomeComposer 提供
 * portal 插槽,本组件由 CreationModeRow 渲染——草稿单一所有权留在
 * chip 排,这里只消费 draft/updateDraft）。
 *
 * 素材策略:`素材：◉ AI 生图 ○ 色块占位` 单选（对齐 WorkBuddy「素材
 * 不足时的处理策略」语义）,选中值写进创作草稿,发送时
 * `buildProjectMetadata` 总是落 `metadata.assetPolicy`（默认 ai-image
 * 也落键,契约明确;daemon 侧值域校验 fail-fast）。
 *
 * 高级折叠:承载类型特有字段（平台/保真度/画幅/时长/音色,默认值 = M3.1
 * 逐字段对表默认列,控件规格沿用 M3.2 表单实现）,字段可见性 = M3.2 既有
 * 映射（live-artifact 无保真度选择器,audio 无 provider 卡……）。图片/
 * 视频 chip 选中时区内内联媒体 provider 选择卡（M3.2 媒体子面控件原样
 * 搬入,数据源 `media.providers` RPC,已配置优先排序 + 载入自动选中第一个
 * 已配置 provider——M3.2 同款语义）。展开态入草稿缓存（sessionDraft）,
 * 切 chip 不丢;template chip 是模板 rail 的内容区,本行整体不渲染。
 *
 * 动效:进出场复用 Reveal（高度 240ms + 淡出 160ms,gui-creation-reveal
 * 内层 6px 位移）,gui-motion-off / prefers-reduced-motion 归零;零新
 * 视觉 token。
 */

/** daemon `media.providers` 条目（settings-sections/media.tsx 同款形状）。 */
export interface MediaProviderEntry {
	id: string;
	label: string;
	kind: string;
	source: "builtin" | "extension";
	configured: boolean;
	description?: string;
	baseUrl?: string | null;
	models?: string[];
	authType?: string;
}

/** 折叠区内的类型特有字段（M3.2 表单字段控件,按 chip 可见性映射搬入）。 */
function AdvancedFields({
	chip,
	draft,
	updateDraft,
	providers,
}: {
	chip: CreationChip;
	draft: CreationDraft;
	updateDraft(patch: Partial<CreationDraft>): void;
	providers: MediaProviderEntry[] | null;
}): ReactNode {
	// 平台多选（prototype/live-artifact/other 共用,M3.1 §3.1 默认 responsive）。
	const platformPicker = (
		<div className="gui-creation-advanced-field">
			<div className="gui-creation-field-label">{t("creation platform label")}</div>
			<div className="gui-creation-chips" role="group" aria-label={t("creation platform label")}>
				{CREATION_PLATFORMS.map(p => {
					const on = draft.platforms.includes(p);
					return (
						<button
							key={p}
							type="button"
							aria-pressed={on}
							className={`gui-creation-chip${on ? " gui-creation-chip--on" : ""}`}
							onClick={() =>
								updateDraft({
									platforms: on ? draft.platforms.filter(x => x !== p) : [...draft.platforms, p],
								})
							}
						>
							{t(`creation platform ${p}` as const)}
						</button>
					);
				})}
			</div>
		</div>
	);
	// 保真度双卡压成 chip 单选（值域不变;live-artifact 不渲染——强制
	// high-fidelity 的编译语义由 buildProjectMetadata 保证,M3.1 §3.2）。
	const fidelityPicker = (
		<div className="gui-creation-advanced-field">
			<div className="gui-creation-field-label">{t("creation fidelity label")}</div>
			<div className="gui-creation-chips" role="radiogroup" aria-label={t("creation fidelity label")}>
				{(["wireframe", "high-fidelity"] as const).map(f => (
					<button
						key={f}
						type="button"
						role="radio"
						aria-checked={draft.fidelity === f}
						className={`gui-creation-chip${draft.fidelity === f ? " gui-creation-chip--on" : ""}`}
						onClick={() => updateDraft({ fidelity: f })}
					>
						{t(`creation fidelity ${f}` as const)}
					</button>
				))}
			</div>
		</div>
	);
	// 表面选项双 toggle（M3.1 §3.1「含落地页 / 含 OS 控件」,默认关）。
	const surfaceToggles = (
		<div className="gui-creation-advanced-field">
			<div className="gui-creation-chips" role="group" aria-label={t("creation surface landing")}>
				{(
					[
						["landingPage", "creation surface landing"],
						["osWidgets", "creation surface os widgets"],
					] as const
				).map(([key, labelKey]) => {
					const on = draft[key];
					return (
						<button
							key={key}
							type="button"
							aria-pressed={on}
							className={`gui-creation-chip${on ? " gui-creation-chip--on" : ""}`}
							onClick={() => updateDraft({ [key]: !on })}
						>
							{t(labelKey)}
						</button>
					);
				})}
			</div>
		</div>
	);
	// 媒体 provider 选择卡（image/video,按 kind 过滤、已配置优先;M3.2
	// 媒体子面控件原样搬入）。audio 在 M3.2 映射里就没有 provider 卡。
	const kindProviders = (providers ?? [])
		.filter(p => p.kind === draft.mediaKind)
		.sort((a, b) => Number(b.configured) - Number(a.configured));
	const providerCards = (
		<div className="gui-creation-advanced-field">
			<div className="gui-creation-field-label">{t("creation media model label")}</div>
			{providers === null ? null : kindProviders.length === 0 ? (
				<p className="gui-creation-empty">{t("creation media no providers")}</p>
			) : (
				<div className="gui-creation-media-cards" role="radiogroup" aria-label={t("creation media model label")}>
					{kindProviders.map(p => {
						const on = draft.mediaProvider === p.id;
						return (
							<button
								key={p.id}
								type="button"
								role="radio"
								aria-checked={on}
								disabled={!p.configured}
								data-media-provider={p.id}
								className={`gui-creation-media-card${on ? " gui-creation-media-card--on" : ""}${p.configured ? "" : " gui-creation-media-card--off"}`}
								onClick={() => updateDraft({ mediaProvider: p.id, mediaModel: p.models?.[0] ?? null })}
							>
								<span className="gui-creation-media-card-main">
									<span className="gui-creation-media-card-label">{p.label}</span>
									<span className="gui-creation-media-card-status">
										<span
											className={`gui-provider-status-dot${p.configured ? " gui-provider-status-dot--on" : ""}`}
											aria-hidden="true"
										/>
										{p.configured ? t("creation media configured") : t("creation media not configured")}
									</span>
								</span>
								{on && <Icon name="check" className="gui-creation-media-card-check" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
	// 画幅卡（image/video,M3.1 §3.5 值域 MEDIA_ASPECTS）。
	const aspectPicker = (
		<div className="gui-creation-advanced-field">
			<div className="gui-creation-field-label">{t("creation media aspect label")}</div>
			<div className="gui-creation-chips" role="radiogroup" aria-label={t("creation media aspect label")}>
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
	);
	// 时长档（video/audio,值域 MEDIA_DURATIONS;控件沿用 M3.2 的 GuiSelect）。
	const durationSelect = (
		<div className="gui-creation-advanced-field">
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
	);
	switch (chip) {
		case "prototype":
		case "other":
			return (
				<>
					{platformPicker}
					{fidelityPicker}
					{surfaceToggles}
				</>
			);
		case "live-artifact":
			// §3.2:保真度选择器不渲染（强制 high-fidelity）。
			return (
				<>
					{platformPicker}
					{surfaceToggles}
				</>
			);
		case "deck":
			return (
				<div className="gui-creation-advanced-field">
					<div className="gui-creation-chips" role="group" aria-label={t("creation speaker notes")}>
						<button
							type="button"
							aria-pressed={draft.speakerNotes}
							className={`gui-creation-chip${draft.speakerNotes ? " gui-creation-chip--on" : ""}`}
							onClick={() => updateDraft({ speakerNotes: !draft.speakerNotes })}
						>
							{t("creation speaker notes")}
						</button>
					</div>
				</div>
			);
		case "image":
			return (
				<>
					{providerCards}
					{aspectPicker}
				</>
			);
		case "video":
			return (
				<>
					{providerCards}
					{aspectPicker}
					{durationSelect}
				</>
			);
		case "audio":
			return (
				<>
					<div className="gui-creation-advanced-field">
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
									{t(`creation media kind ${k}` as const)}
								</button>
							))}
						</div>
					</div>
					{durationSelect}
					{draft.mediaAudioKind === "speech" && (
						<div className="gui-creation-advanced-field">
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
			);
		case "template":
			return null;
	}
}

export function AssetPolicyRow({
	rpc,
	draft,
	updateDraft,
}: {
	rpc: RpcClient;
	draft: CreationDraft;
	updateDraft(patch: Partial<CreationDraft>): void;
}): ReactNode {
	const chip = chipForDraft(draft);
	// 媒体 provider 列表（M3.2 同款数据源:media.providers RPC;行挂载即拉,
	// daemon 侧 session-less,host 共享存储）。失败 → 空表,provider 卡区
	// 显示「暂无可用 provider」引导,不阻断其它字段。
	const [providers, setProviders] = useState<MediaProviderEntry[] | null>(null);
	useEffect(() => {
		let cancelled = false;
		void rpc
			.request<{ builtin?: MediaProviderEntry[]; extension?: MediaProviderEntry[] } | null>("media.providers", {})
			.then(res => {
				if (cancelled) return;
				setProviders([...(res?.builtin ?? []), ...(res?.extension ?? [])]);
			})
			.catch(() => {
				if (!cancelled) setProviders([]);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc]);
	// 载入后自动选中第一个已配置 provider（M3.2「已配置优先」语义）:
	// 仅在媒体 chip 展开时生效;已选中的 provider 仍在列表里则不覆盖。
	const kindProviders = (providers ?? []).filter(p => p.kind === draft.mediaKind);
	const providerStillValid = !!draft.mediaProvider && kindProviders.some(p => p.id === draft.mediaProvider);
	useEffect(() => {
		if (draft.tab !== "media") return;
		if (providers === null || providerStillValid) return;
		const firstConfigured = kindProviders.find(p => p.configured);
		if (firstConfigured) {
			updateDraft({ mediaProvider: firstConfigured.id, mediaModel: firstConfigured.models?.[0] ?? null });
		}
	}, [providers, draft.tab, providerStillValid, kindProviders, updateDraft]);

	// template chip 的内容区是模板 rail（composer 下方独立展开）,素材策略
	// 行与高级折叠整体不渲染。hook 全在上——此处纯渲染分支。
	if (chip === "template") return null;

	return (
		<div className="gui-creation-assetrow" data-testid="gui-creation-assetrow">
			<div className="gui-creation-assetrow-main">
				<span className="gui-creation-asset-label">{t("creation asset policy label")}</span>
				<div className="gui-creation-asset-radios" role="radiogroup" aria-label={t("creation asset policy label")}>
					{ASSET_POLICIES.map(policy => {
						const on = draft.assetPolicy === policy;
						return (
							<button
								key={policy}
								type="button"
								role="radio"
								aria-checked={on}
								data-asset-policy={policy}
								className={`gui-creation-chip${on ? " gui-creation-chip--on" : ""}`}
								onClick={() => updateDraft({ assetPolicy: policy })}
							>
								{t(
									policy === "ai-image"
										? "creation asset policy ai image"
										: "creation asset policy placeholder",
								)}
							</button>
						);
					})}
				</div>
				<button
					type="button"
					className="gui-creation-advanced-toggle"
					aria-expanded={draft.advancedOpen}
					onClick={() => updateDraft({ advancedOpen: !draft.advancedOpen })}
				>
					{t("creation advanced")}
					<Icon
						name="arrow-down-s"
						className={`gui-creation-advanced-chevron${draft.advancedOpen ? " gui-creation-advanced-chevron--open" : ""}`}
					/>
				</button>
			</div>
			{/* 高级折叠:展开态入草稿缓存（sessionDraft）,切 chip 不丢;进出场
			 *  走 Reveal（高度 240ms + 淡出 160ms + 内层 6px 位移,
			 *  gui-creation-reveal）,gui-motion-off / prefers-reduced-motion 归零。 */}
			<Reveal open={draft.advancedOpen} className="gui-creation-reveal w-full">
				<div className="gui-creation-advanced">
					<AdvancedFields chip={chip} draft={draft} updateDraft={updateDraft} providers={providers} />
				</div>
			</Reveal>
		</div>
	);
}
