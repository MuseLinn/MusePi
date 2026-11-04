/**
 * Asset-policy selection state (M3.7c §4,
 * docs/review/0.5.0-m3-mode-page-redesign.md).
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：asset-policy（daemon 侧素材策略选择状态；简报的文本与渲染由
 *   `bundled-plugins/design-guidance` 拥有，order 41 紧随 design-system 的
 *   40）。
 * - 输入：会话共享 project metadata 的 `assetPolicy` 键
 *   （`"ai-image" | "placeholder"`，值域由 daemon/creation.ts 的
 *   validateProjectMetadata 在 session.create 前 fail-fast 校验）。
 * - 输出：`readAssetPolicy(metadata)` 把当前选择交给 prompt 装配；插件据此
 *   渲染 ai-image（generate_image/agnes_video_gen 工具链）或 placeholder
 *   （色块+标注占位、不触发媒体生成）简报。
 * - 生命周期：无状态——每次 rebuildSystemPrompt 从 metadata 重读选择，
 *   插件函数文本按当前选择渲染;缺键/未知值不注入不炸（与 design-system
 *   的「未命中不注入」同款语义,防御历史会话头里的悬空值）。
 * - 启停：选择状态 always-on；简报随 design-guidance 插件卸载而消失。
 * - 冲突：区块 name/source 由插件固定为 `asset-policy`;扩展不得占用该
 *   name（composer 同 name 后加者替换,与既有区块同一契约）。
 * - 检视入口：本文件 + `bundled-plugins/design-guidance` + sdk.ts 的
 *   rebuildSystemPrompt 挂点。
 */

/** 素材策略值域（与 daemon/creation.ts 校验、GUI lib/creation.ts 草稿同源）。 */
export const ASSET_POLICIES = ["ai-image", "placeholder"] as const;
export type AssetPolicy = (typeof ASSET_POLICIES)[number];

/**
 * Read the current asset-policy selection from project metadata.
 * Missing/unknown values read as undefined (skip silently — never throws).
 */
export function readAssetPolicy(metadata: Record<string, unknown> | null | undefined): AssetPolicy | undefined {
	const policy = metadata?.assetPolicy;
	return policy === "ai-image" || policy === "placeholder" ? policy : undefined;
}
