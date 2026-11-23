/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「压缩方法 provider seam」）：
 * - 名称+ns：`CompactionMethodProvider`，`registerCompactionMethodProvider(provider)`。
 * - 输入：方法 id、设置项文案键、`available(ctx)` 判定、`run(ctx)` 执行体。
 * - 输出：`isCompactionMethod` / `resolveCompactionMethodOrder` 认这些 id；
 *   `compaction.methodOrder` 的选择项由已注册 provider 合并；执行按 id 分派。
 * - 生命周期：宿主在模块装载时注册五种内置方法；插件 apply 时注册自己的方法，
 *   卸载/重载或 disposer 调用时注销。
 * - 启停：同一 id 只能有一个 provider；未注册的 id 在配置里被丢弃，回退到内置顺序。
 * - 冲突：重复 id 拒绝。provider 只回答「能不能跑、怎么跑」，压缩条目提交、花费
 *   记账与上下文重锚仍归宿主会话维护所有。
 * - 检视入口：本文件、`compaction-builtin-methods.ts`、`docs/capability-seams.md`，
 *   测试 `test/compaction-method-provider.test.ts`。
 */
import type { Model } from "@musepi/pi-ai";
import type { CompactionSettings } from "../config/settings-schema";

/** The five methods the host ships; every one has an entry in `methodOrder`. */
export type BuiltinCompactionMethod = "remote" | "snapcompact" | "handoff" | "soft" | "shake";

/**
 * A configured method id. Widened to `string` so a plugin can contribute one,
 * while `BuiltinCompactionMethod` stays the closed union for exhaustive maps.
 */
export type CompactionMethod = string;

/** Everything a method needs to decide whether it can run. */
export interface CompactionMethodContext {
	readonly model: Model | undefined;
	/** The policy in force for the active model (per-model entries applied). */
	readonly settings: CompactionSettings;
	/** Why the pass runs: automatic pressure, overflow recovery, idle, or a command. */
	readonly trigger: "pressure" | "overflow" | "idle" | "manual";
	/** Manual passes carry focus text; a method that cannot use it must decline. */
	readonly hasFocusInstructions: boolean;
}

/** Why a method declined a pass it was otherwise eligible for. */
export interface CompactionMethodDecline {
	readonly decline: string;
}

/**
 * One compaction method. `run` owns only the condensation step; the host commits
 * the compaction entry, journals spend and re-anchors context afterwards.
 */
export interface CompactionMethodProvider {
	readonly id: CompactionMethod;
	/** Settings copy keys for the ordered `compaction.methodOrder` picker. */
	readonly label: string;
	readonly description: string;
	/** Whether this method can run right now; false advances the order. */
	available(ctx: CompactionMethodContext): boolean;
	/** Produce the summary; a decline advances to the next method. */
	run(
		ctx: CompactionMethodContext & { readonly signal: AbortSignal },
	): Promise<CompactionMethodResult | CompactionMethodDecline>;
}

/** What a method produced; the host owns committing it. */
export interface CompactionMethodResult {
	readonly summary: string;
	readonly shortSummary?: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details?: unknown;
	readonly preserveData?: Record<string, unknown>;
}

const providers = new Map<CompactionMethod, CompactionMethodProvider>();

/** Register one method. A second provider for the same id is refused rather
 *  than silently replacing the first; unregister before registering a replacement. */
export function registerCompactionMethodProvider(provider: CompactionMethodProvider): () => void {
	if (providers.has(provider.id)) {
		throw new Error(`A compaction method provider for "${provider.id}" is already registered.`);
	}
	providers.set(provider.id, provider);
	return () => {
		if (providers.get(provider.id) === provider) providers.delete(provider.id);
	};
}

/** The provider for `id`, when one is registered. */
export function getCompactionMethodProvider(id: CompactionMethod): CompactionMethodProvider | undefined {
	return providers.get(id);
}

/** Every registered method, in registration order. */
export function listCompactionMethodProviders(): CompactionMethodProvider[] {
	return [...providers.values()];
}

/** Whether `value` names a registered method. */
export function isCompactionMethod(value: unknown): value is CompactionMethod {
	return typeof value === "string" && providers.has(value);
}

/** Picker choices for `compaction.methodOrder`, merged from registered providers. */
export function compactionMethodChoices(): Array<{ value: string; label: string; description: string }> {
	return listCompactionMethodProviders().map(provider => ({
		value: provider.id,
		label: provider.label,
		description: provider.description,
	}));
}

/**
 * First method in `order` whose provider accepts `ctx`. Both automatic passes
 * and the manual `/compact` resolver share this so the two cannot disagree
 * about which methods are usable.
 */
export function firstAvailableCompactionMethod(
	order: readonly CompactionMethod[],
	ctx: CompactionMethodContext,
): CompactionMethod | undefined {
	for (const id of order) {
		const provider = providers.get(id);
		if (provider?.available(ctx)) return id;
	}
	return undefined;
}
