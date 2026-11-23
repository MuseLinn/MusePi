/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「压缩阈值策略 seam」）：
 * - 名称+ns：`CompactionThresholdStrategy`，`registerCompactionThresholdStrategy(strategy)`。
 * - 输入：策略 id、优先级、`resolve(settings, model)` —— 返回一份改写后的策略，或 `undefined` 表示不适用。
 * - 输出：`resolveModelCompactionSettings` 按优先级依次询问已注册策略；第一个返回结果的生效。
 * - 生命周期：宿主内置「按模型阈值」策略在模块装载时注册；插件 apply 时注册自己的策略，
 *   卸载/重载或 disposer 调用时注销。
 * - 启停：同一 id 只能有一个策略；全部不适用时使用配置原样（`compaction.threshold*`）。
 * - 冲突：重复 id 拒绝。策略只改写阈值相关字段，不参与方法选择，也不能提交压缩条目。
 * - 检视入口：本文件、`model-compaction-threshold.ts`、`docs/capability-seams.md`，
 *   测试 `test/compaction-threshold-strategy.test.ts`。
 *
 * 为什么需要这条缝：阈值是「什么时候压」的核心策略，而这类策略需要全部做成可替换的
 * 可选能力。按模型覆盖、按目录覆盖、按订阅档位覆盖，都是同一个问题的不同答案；插件
 * 应该能新增一种，而不是等内核为它加字段。
 */
import type { Model } from "@musepi/pi-ai";
import type { CompactionSettings } from "../config/settings";

/** What a strategy sees: the configured policy plus the model it applies to. */
export interface CompactionThresholdContext {
	readonly settings: CompactionSettings;
	readonly model: Pick<Model, "provider" | "id"> | null | undefined;
}

/**
 * One threshold strategy. `resolve` returns a rewritten policy, or `undefined`
 * to leave the decision to the next strategy.
 *
 * A strategy must not change anything that is not a threshold: enabling
 * compaction, the method order and the keep-recent budget all belong to the
 * user's configuration, and a threshold rule that silently rewrote them would
 * make the settings page lie.
 */
export interface CompactionThresholdStrategy {
	readonly id: string;
	/**
	 * Consultation order, lowest first. The built-in per-model rule runs at
	 * `0`, so a plugin strategy defaults to a later slot and only takes effect
	 * for models the built-in rule does not cover.
	 */
	readonly priority?: number;
	resolve(ctx: CompactionThresholdContext): CompactionSettings | undefined;
}

const strategies = new Map<string, CompactionThresholdStrategy>();

/** Register one strategy. A duplicate id is refused rather than silently replacing the incumbent. */
export function registerCompactionThresholdStrategy(strategy: CompactionThresholdStrategy): () => void {
	if (strategies.has(strategy.id)) {
		throw new Error(`A compaction threshold strategy "${strategy.id}" is already registered.`);
	}
	strategies.set(strategy.id, strategy);
	return () => {
		if (strategies.get(strategy.id) === strategy) strategies.delete(strategy.id);
	};
}

/** Every registered strategy, in consultation order. */
export function listCompactionThresholdStrategies(): CompactionThresholdStrategy[] {
	return [...strategies.values()].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

/**
 * `settings` after the first strategy that applies to `model` rewrote it; the
 * same object when none applies.
 */
export function resolveCompactionThreshold(
	settings: CompactionSettings,
	model: Pick<Model, "provider" | "id"> | null | undefined,
): CompactionSettings {
	for (const strategy of listCompactionThresholdStrategies()) {
		const resolved = strategy.resolve({ settings, model });
		if (resolved !== undefined) return resolved;
	}
	return settings;
}

/**
 * Identity of the strategy layer for one settings snapshot and model: cache
 * keys must include it, or two models (or two strategy sets) would share an
 * entry.
 */
export function compactionThresholdStrategyKey(
	settings: CompactionSettings,
	model: Pick<Model, "provider" | "id"> | null | undefined,
): string {
	const parts = [model ? `${model.provider}/${model.id}` : "none"];
	for (const strategy of listCompactionThresholdStrategies()) parts.push(strategy.id);
	return parts.join("\u0000");
}
