import type { TranslationKey } from "@musepi/client-core/src/i18n/index.js";

/**
 * Creation surface state + metadata builder (M3.2) — the pure, testable
 * half of CreationModeRow. Owns the §4 project-metadata shape: the row
 * renders chip state, this module is the single translator between form
 * state and the wire metadata object (built once per create, hydrated
 * back on 再入回填).
 *
 * M3.7a (docs/review/0.5.0-m3-mode-page-redesign.md §2.3) adds the mode
 * page's type chips on top: a chip is a TYPE selection only, and it is
 * the sole thing the mode page exposes — every type-specific field stays
 * at its §2.3 default, so `buildProjectMetadata` (unchanged) still emits
 * the M3.2 field-for-field shape.
 */

export type CreationTab = "prototype" | "live-artifact" | "deck" | "template" | "media" | "other";
export type MediaKind = "image" | "video" | "audio";
export type Fidelity = "wireframe" | "high-fidelity";

/**
 * 模式页类型 chip（§2.3）：六面分类法 + 模板 rail + 其他。媒体三类由 M3.2
 * 的「media tab + 二级 segmented」压平为一级 chip，顺序对齐 OpenDesign
 * 类型排。
 */
export type CreationChip = "prototype" | "live-artifact" | "deck" | "image" | "video" | "audio" | "template" | "other";

/** chip 排顺序（渲染顺序即此序，默认选中首项 prototype）。 */
export const CREATION_CHIPS: readonly CreationChip[] = [
	"prototype",
	"live-artifact",
	"deck",
	"image",
	"video",
	"audio",
	"template",
	"other",
];

/** §3.1 平台多选（§4 metadata.platforms 值域）。 */
export const CREATION_PLATFORMS = [
	"responsive",
	"web-desktop",
	"mobile-ios",
	"mobile-android",
	"tablet",
	"desktop-app",
] as const;

/** §3.5 画幅卡值域。 */
export const MEDIA_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

/** 视频/音频时长档（秒）。 */
export const MEDIA_DURATIONS = [4, 8, 12, 16] as const;

export interface CreationDraft {
	tab: CreationTab;
	name: string;
	platforms: string[];
	fidelity: Fidelity;
	landingPage: boolean;
	osWidgets: boolean;
	speakerNotes: boolean;
	/** Media 子面（§3.5 二级 segmented）。 */
	mediaKind: MediaKind;
	mediaProvider: string | null;
	mediaModel: string | null;
	mediaAspect: string;
	mediaDurationSec: number;
	mediaAudioKind: "speech" | "sfx";
	mediaVoice: string;
	mediaPromptTemplateId: string | null;
	mediaPrompt: string;
}

export const DEFAULT_CREATION_DRAFT: CreationDraft = {
	tab: "prototype",
	name: "",
	platforms: ["responsive"],
	fidelity: "high-fidelity",
	landingPage: false,
	osWidgets: false,
	speakerNotes: false,
	mediaKind: "image",
	mediaProvider: null,
	mediaModel: null,
	mediaAspect: "1:1",
	mediaDurationSec: 8,
	mediaAudioKind: "speech",
	mediaVoice: "",
	mediaPromptTemplateId: null,
	mediaPrompt: "",
};

/** Live Artifact（§3.2）:Prototype 特化,强制 high-fidelity。 */
export function isLiveArtifact(draft: CreationDraft): boolean {
	return draft.tab === "live-artifact";
}

/** chip → 标签键（媒体三类复用 media 文案,其余复用 tab 文案,零新文案）。 */
export const CREATION_CHIP_LABEL_KEYS: Record<CreationChip, TranslationKey> = {
	prototype: "creation tab prototype",
	"live-artifact": "creation tab live artifact",
	deck: "creation tab deck",
	image: "creation media image",
	video: "creation media video",
	audio: "creation media audio",
	template: "creation tab template",
	other: "creation tab other",
};

/** chip → 输入框 placeholder 键（§2.4:placeholder 随选中类型变化）。 */
export const CREATION_PLACEHOLDER_KEYS: Record<CreationChip, TranslationKey> = {
	prototype: "creation placeholder prototype",
	"live-artifact": "creation placeholder live artifact",
	deck: "creation placeholder deck",
	image: "creation placeholder image",
	video: "creation placeholder video",
	audio: "creation placeholder audio",
	template: "creation placeholder template",
	other: "creation placeholder other",
};

/**
 * 选中 chip → 草稿:只写类型（tab / mediaKind）,其余字段保持 §2.3 指定的
 * M3.1 默认列——所以编译结果仍与 M3.2 表单逐字段一致。
 */
export function applyChip(draft: CreationDraft, chip: CreationChip): CreationDraft {
	switch (chip) {
		case "image":
		case "video":
		case "audio":
			return { ...draft, tab: "media", mediaKind: chip };
		default:
			return { ...draft, tab: chip };
	}
}

/** 草稿 → chip:镜像回填 / 模板套用后 chip 排跟随解析出的类型。 */
export function chipForDraft(draft: CreationDraft): CreationChip {
	return draft.tab === "media" ? draft.mediaKind : draft.tab;
}

/**
 * Build the §4 project metadata object for a create. Field routing is
 * per-tab (设计稿 §3 各表"去向"列):platform/fidelity/surfaceOptions only
 * for prototype/live-artifact/other;speakerNotes only for deck;media only
 * for media. `skillId` stays null in M3.2 — the design preset rides on
 * modeId, and the resolved-skill + template-replacement semantics land in
 * M3.3 (applied templates keep their snapshot's skillId).
 */
export function buildProjectMetadata(draft: CreationDraft, templateId?: string | null): Record<string, unknown> {
	const now = new Date().toISOString();
	const name = draft.name.trim();
	const metadata: Record<string, unknown> = {
		version: 1,
		name: name || null,
		skillId: null,
		designSystemId: null,
		inspirationDesignSystemIds: [],
		templateId: templateId ?? null,
		createdAt: now,
		updatedAt: now,
	};
	if (draft.tab === "deck") {
		metadata.kind = "deck";
		metadata.speakerNotes = draft.speakerNotes;
		return metadata;
	}
	if (draft.tab === "media") {
		metadata.kind = "media";
		const prompt = draft.mediaPrompt.trim();
		const media: Record<string, unknown> = {
			kind: draft.mediaKind,
			provider: draft.mediaProvider,
			model: draft.mediaModel,
			aspect: draft.mediaKind === "audio" ? null : draft.mediaAspect,
			durationSec: draft.mediaKind === "image" ? null : draft.mediaDurationSec,
			voice:
				draft.mediaKind === "audio" && draft.mediaAudioKind === "speech" ? draft.mediaVoice.trim() || null : null,
			...(draft.mediaKind === "audio" ? { audioKind: draft.mediaAudioKind } : {}),
			...(prompt ? { promptTemplate: { id: draft.mediaPromptTemplateId, prompt } } : {}),
		};
		metadata.media = media;
		return metadata;
	}
	// prototype / live-artifact / other share the platform block.
	metadata.kind = draft.tab === "live-artifact" ? "prototype" : draft.tab;
	if (isLiveArtifact(draft)) metadata.intent = "live-artifact";
	metadata.platforms = [...draft.platforms];
	metadata.fidelity = isLiveArtifact(draft) ? "high-fidelity" : draft.fidelity;
	metadata.surfaceOptions = { landingPage: draft.landingPage, osWidgets: draft.osWidgets };
	return metadata;
}

/**
 * Hydrate a draft from persisted metadata（§4 会话恢复原样回读）。
 * Unknown/absent fields fall back to the base draft; kind → tab mapping
 * inverts buildProjectMetadata ("prototype"+intent:"live-artifact" →
 * the live-artifact tab).
 */
export function hydrateDraftFromMetadata(metadata: Record<string, unknown>, base?: CreationDraft): CreationDraft {
	const draft: CreationDraft = { ...(base ?? DEFAULT_CREATION_DRAFT) };
	if (typeof metadata.name === "string") draft.name = metadata.name;
	const kind = metadata.kind;
	if (kind === "deck") {
		draft.tab = "deck";
		draft.speakerNotes = metadata.speakerNotes === true;
		return draft;
	}
	if (kind === "media") {
		draft.tab = "media";
		const media = metadata.media;
		if (typeof media === "object" && media !== null) {
			const m = media as Record<string, unknown>;
			if (m.kind === "image" || m.kind === "video" || m.kind === "audio") draft.mediaKind = m.kind;
			if (typeof m.provider === "string") draft.mediaProvider = m.provider;
			if (typeof m.model === "string") draft.mediaModel = m.model;
			if (typeof m.aspect === "string") draft.mediaAspect = m.aspect;
			if (typeof m.durationSec === "number" && (MEDIA_DURATIONS as readonly number[]).includes(m.durationSec)) {
				draft.mediaDurationSec = m.durationSec;
			}
			if (m.audioKind === "speech" || m.audioKind === "sfx") draft.mediaAudioKind = m.audioKind;
			if (typeof m.voice === "string") draft.mediaVoice = m.voice;
			const pt = m.promptTemplate;
			if (typeof pt === "object" && pt !== null) {
				const p = pt as Record<string, unknown>;
				if (typeof p.id === "string") draft.mediaPromptTemplateId = p.id;
				if (typeof p.prompt === "string") draft.mediaPrompt = p.prompt;
			}
		}
		return draft;
	}
	if (kind === "prototype" || kind === "other") {
		draft.tab = kind === "prototype" && metadata.intent === "live-artifact" ? "live-artifact" : kind;
		if (Array.isArray(metadata.platforms)) {
			const platforms = metadata.platforms.filter((p): p is string => typeof p === "string");
			if (platforms.length > 0) draft.platforms = platforms;
		}
		if (metadata.fidelity === "wireframe" || metadata.fidelity === "high-fidelity")
			draft.fidelity = metadata.fidelity;
		const so = metadata.surfaceOptions;
		if (typeof so === "object" && so !== null) {
			const s = so as Record<string, unknown>;
			draft.landingPage = s.landingPage === true;
			draft.osWidgets = s.osWidgets === true;
		}
	}
	return draft;
}
