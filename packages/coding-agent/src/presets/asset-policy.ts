/**
 * Asset policy prompt sections (M3.7c §4, docs/review/0.5.0-m3-mode-page-redesign.md).
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：asset-policy（daemon 侧素材策略 prompt 注入；消费走
 *   `applyAssetPolicySection` → PromptComposer，与 design-system 区块同一
 *   composer 通道,source="asset-policy",order=41 紧随 design-system 的 40）。
 * - 输入：会话共享 project metadata 的 `assetPolicy` 键
 *   （`"ai-image" | "placeholder"`，值域由 daemon/creation.ts 的
 *   validateProjectMetadata 在 session.create 前 fail-fast 校验）。
 * - 输出：composer 区块 `asset-policy`（ai-image = 产物引用处走
 *   generate_image/agnes_video_gen 工具链;placeholder = 产物用色块+标注
 *   占位、不触发媒体生成）。
 * - 生命周期：无状态注册表——每次 rebuildSystemPrompt 由 sdk.ts 重解析
 *   metadata（removeBySource → 命中重加）,幂等;缺键/未知值不注入不炸
 *   （与 design-system 的「未命中不注入」同款语义,防御历史会话头里的
 *   悬空值）。
 * - 启停：always-on——注入随 rebuild 重解析,无可卸载状态。
 * - 冲突：区块 name/source 固定 `asset-policy`;扩展不得占用该 name
 *   （composer 同 name 后加者替换,与既有区块同一契约）。
 * - 检视入口：本文件 + sdk.ts 的 rebuildSystemPrompt 挂点。
 */

import type { PromptComposer } from "../prompts/composer";

/** 素材策略值域（与 daemon/creation.ts 校验、GUI lib/creation.ts 草稿同源）。 */
export const ASSET_POLICIES = ["ai-image", "placeholder"] as const;
export type AssetPolicy = (typeof ASSET_POLICIES)[number];

/**
 * 两个策略的指令段（静态文案,与 BUILTIN_DESIGN_SYSTEMS 的 promptSection
 * 同一形态——配置数据而非代码拼接）。order 41 = design-system(40)之后、
 * mode 预设区块(≤25)之后,与素材策略行的视觉位置（设计体系 rail 之下）
 * 同序。
 */
const ASSET_POLICY_PROMPT_SECTIONS: Record<AssetPolicy, { name: string; order: number; text: string }> = {
	"ai-image": {
		name: "asset-policy",
		order: 41,
		text: "素材策略（AI 生图）：产物中需要图片/视频素材的引用处,一律调用媒体生成工具产出真实素材——图片走 generate_image 工具,视频走 agnes_video_gen 工具,按产物语境选择合适的画幅与时长;不得以占位色块或外链图片代替实际生成。",
	},
	placeholder: {
		name: "asset-policy",
		order: 41,
		text: "素材策略（色块占位）：产物中需要图片/视频素材的引用处,一律用色块加文字标注占位（标注写清素材用途与建议画幅/时长）,布局按真实素材的尺寸与比例预留;禁止调用 generate_image、agnes_video_gen 等任何媒体生成工具。",
	},
};

/**
 * Resolve the asset-policy composer section from project metadata.
 * Missing/unknown values yield undefined (skip silently — never throws).
 */
export function resolveAssetPolicyPromptSection(
	metadata: Record<string, unknown> | null | undefined,
): { name: string; order: number; text: string } | undefined {
	const policy = metadata?.assetPolicy;
	if (policy !== "ai-image" && policy !== "placeholder") return undefined;
	return ASSET_POLICY_PROMPT_SECTIONS[policy];
}

/**
 * Session-guidance injection seam (mode-page-redesign §4): sync the
 * `asset-policy` composer section from project metadata. Idempotent across
 * rebuilds (removeBySource → re-add); leaves the composer untouched when the
 * key is absent or carries an unknown value.
 */
export function applyAssetPolicySection(
	composer: PromptComposer,
	metadata: Record<string, unknown> | null | undefined,
): void {
	composer.removeBySource("asset-policy");
	const section = resolveAssetPolicyPromptSection(metadata);
	if (!section) return;
	composer.add({ ...section, source: "asset-policy" });
}
