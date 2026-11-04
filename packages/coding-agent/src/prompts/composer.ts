/**
 * PromptComposer:命名区块(§5.1)的插槽注入与聚合,委托给具名注册表。
 * 契约:docs/archive/modes-plan.md §5。
 *
 * 挂点(§5.7):会话创建时包装 rebuildSystemPrompt 回调 ——
 * buildSystemPrompt 输出(base: string[], baseSlots) → compose()/composeComplete() → 返回。
 * 无注入区块时 compose(base) 原样返回 base(零行为变化回归锚)。
 */
import { PromptRegistry, type PromptRenderContext, type PromptText } from "./registry";

export type { PromptOrder, PromptOrderName } from "./orders";
export { PROMPT_ORDERS } from "./orders";
export type { PromptRenderContext, PromptText, PromptTextContext } from "./registry";

export interface PromptSection {
	name: string;
	order: number;
	text: string;
	source: string;
}

export type PromptSectionInput = Omit<PromptSection, "source" | "text"> & {
	text: PromptText;
	source?: string;
	/** 该区块即完整 system prompt:compose 只输出它(注册表保证唯一)。 */
	complete?: boolean;
};

/** 注入区块槽位边界:core < [<100] < safety < [100-199] < project < [200-299] < repo < [>=300]。 */
const SAFETY_ORDER = 100;
const PROJECT_ORDER = 200;
const REPO_ORDER = 300;

/** Base prompt block identity produced by `buildSystemPrompt`. */
export type PromptBaseSlot = "core" | "safety" | "project" | "repo";

/** Canonical base order; optional slots may be absent without shifting later anchors. */
const BASE_SLOTS: readonly PromptBaseSlot[] = ["core", "safety", "project", "repo"];

/**
 * 把按 order 排序的区块按插槽组合并进 base。
 * base = buildSystemPrompt 输出,结构 [core, safety?, project?, repo?]。
 *
 * `baseSlots`(与 base 等长)标明每个 block 的真实槽位;缺失的可选槽位
 * 仍按规范顺序输出自己的注入组,不会把 project block 误当成 safety。
 * 旧调用方不传 `baseSlots` 时沿用历史 tail 位置语义(兼容锚点)。
 * compose() 与 host 装配(sdk.ts)共用本合并核心。
 */
export function mergeSectionsIntoBase(
	base: string[],
	sections: ReadonlyArray<{ order: number; text: string }>,
	baseSlots?: readonly PromptBaseSlot[],
): string[] {
	if (sections.length === 0) return base;
	const groups: string[][] = [[], [], [], []];
	for (const section of sections) {
		const group =
			section.order < SAFETY_ORDER ? 0 : section.order < PROJECT_ORDER ? 1 : section.order < REPO_ORDER ? 2 : 3;
		groups[group].push(section.text);
	}
	if (baseSlots && baseSlots.length === base.length) {
		const textBySlot = new Map<PromptBaseSlot, string>();
		base.forEach((text, index) => {
			const slot = baseSlots[index];
			if (slot) textBySlot.set(slot, text);
		});
		const out: string[] = [];
		for (let index = 0; index < BASE_SLOTS.length; index++) {
			const anchored = textBySlot.get(BASE_SLOTS[index]);
			if (anchored !== undefined) out.push(anchored);
			for (const text of groups[index]) out.push(text);
		}
		return out;
	}
	const tail = base.slice(1);
	const out: string[] = [base[0] ?? ""];
	for (const text of groups[0]) out.push(text);
	if (tail[0] !== undefined) {
		out.push(tail[0]);
		for (const text of groups[1]) out.push(text);
	}
	if (tail[1] !== undefined) {
		out.push(tail[1]);
		for (const text of groups[2]) out.push(text);
	}
	if (tail[2] !== undefined) {
		out.push(tail[2]);
		for (const text of groups[3]) out.push(text);
	} else {
		for (const text of groups[3]) out.push(text);
	}
	return out;
}

export class PromptComposer {
	/** 新代码直接使用注册表(函数文本、严格变量、revision);add 是兼容入口。 */
	readonly registry = new PromptRegistry();

	/** 注册区块;同 name 后 add 者替换(旧 Map 语义),旧字符串不参与变量插值。 */
	add(section: PromptSectionInput, source?: string): void {
		this.registry.registerSection(section, section.source ?? source, { replace: true, interpolate: false });
	}

	/** 按贡献方整体卸载(热切换 removeBySource("mode:<id>")/扩展 reload,§5.6)。 */
	removeBySource(source: string): void {
		this.registry.removeBySource(source);
	}

	clear(): void {
		this.registry.clear();
	}

	get size(): number {
		return this.registry.size;
	}

	get revision(): number {
		return this.registry.revision;
	}

	/**
	 * 把注入区块按 order 插槽合并进 base。
	 * base = buildSystemPrompt 输出,结构 [core, safety?, project?, repo?]。
	 *
	 * `baseSlots`(与 base 等长)标明每个 block 的真实槽位;缺失的可选槽位
	 * 仍按规范顺序输出自己的注入组,不会把 project block 误当成 safety。
	 * 旧调用方不传 `baseSlots` 时沿用历史 tail 位置语义(兼容锚点)。
	 * 可见的 complete 区块替换 base 与全部其他区块。
	 */
	compose(base: string[], context: PromptRenderContext = {}, baseSlots?: readonly PromptBaseSlot[]): string[] {
		const { sections, complete } = this.registry.assemble(context);
		if (sections.length === 0) return base;
		if (complete) return [complete.text];
		return mergeSectionsIntoBase(base, sections, baseSlots);
	}

	/** promptComplete 语义(DSH complete:true):仅注入层按 order 输出,忽略 base 与内置区块。 */
	composeComplete(context: PromptRenderContext = {}): string[] {
		const { sections, complete } = this.registry.assemble(context);
		if (complete) return [complete.text];
		return sections.map(section => section.text);
	}
}
