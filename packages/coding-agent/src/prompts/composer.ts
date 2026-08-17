/**
 * PromptComposer:命名区块(§5.1)的插槽注入与聚合。
 * 契约:docs/modes-plan.md §5。
 *
 * 挂点(§5.7):会话创建时包装 rebuildSystemPrompt 回调 ——
 * buildSystemPrompt 输出(base: string[]) → compose()/composeComplete() → 返回。
 * 无注入区块时 compose(base) 原样返回 base(零行为变化回归锚)。
 */
export interface PromptSection {
	name: string;
	order: number;
	text: string;
	source: string;
}

export type PromptSectionInput = Omit<PromptSection, "source"> & { source?: string };

/** 与 buildSystemPrompt 数组输出对齐的 order 常量(§5.1)。 */
export const PROMPT_ORDERS = {
	core: 0,
	injection: 25,
	safety: 100,
	project: 200,
	repoContext: 300,
} as const;

/** 注入区块槽位边界:core < [<100] < safety < [100-199] < project < [200-299] < repo < [>=300]。 */
const SAFETY_ORDER = 100;
const PROJECT_ORDER = 200;
const REPO_ORDER = 300;

export class PromptComposer {
	#sections = new Map<string, PromptSection>();

	/** 注册区块;同 name 后 add 者替换(继承展开已在 resolve 层定序)。 */
	add(section: PromptSectionInput, source?: string): void {
		this.#sections.set(section.name, {
			name: section.name,
			order: section.order,
			text: section.text,
			source: section.source ?? source ?? "anonymous",
		});
	}

	/** 按贡献方整体卸载(热切换 removeBySource("mode:<id>")/扩展 reload,§5.6)。 */
	removeBySource(source: string): void {
		for (const [name, section] of this.#sections) {
			if (section.source === source) this.#sections.delete(name);
		}
	}

	clear(): void {
		this.#sections.clear();
	}

	get size(): number {
		return this.#sections.size;
	}

	/**
	 * 把注入区块按 order 插槽合并进 base。
	 * base = buildSystemPrompt 输出,结构 [core, safety?, project?, repo?];
	 * base tail 按 [safety, project, repo] 锚定(条件 push,可能缺)。
	 */
	compose(base: string[]): string[] {
		if (this.#sections.size === 0) return base;
		const injections = this.#sortedSections();
		const groups: PromptSection[][] = [[], [], [], []];
		for (const section of injections) {
			const group =
				section.order < SAFETY_ORDER ? 0 : section.order < PROJECT_ORDER ? 1 : section.order < REPO_ORDER ? 2 : 3;
			groups[group].push(section);
		}
		const tail = base.slice(1);
		const out: string[] = [base[0] ?? ""];
		for (const section of groups[0]) out.push(section.text);
		if (tail[0] !== undefined) {
			out.push(tail[0]);
			for (const section of groups[1]) out.push(section.text);
		}
		if (tail[1] !== undefined) {
			out.push(tail[1]);
			for (const section of groups[2]) out.push(section.text);
		}
		if (tail[2] !== undefined) {
			out.push(tail[2]);
			for (const section of groups[3]) out.push(section.text);
		} else {
			for (const section of groups[3]) out.push(section.text);
		}
		return out;
	}

	/** promptComplete 语义(DSH complete:true):仅注入层按 order 输出,忽略 base 与内置区块。 */
	composeComplete(): string[] {
		return this.#sortedSections().map(section => section.text);
	}

	#sortedSections(): PromptSection[] {
		return [...this.#sections.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	}
}
