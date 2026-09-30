/**
 * 预设「查看配置」只读视图的客户端聚合层（modes-plan 继承展开的 GUI 镜像）。
 *
 * 数据源（委托单 A.2，零新 RPC）：`modes.list` 摘要行给出每条 extends，
 * 链上每层再按 id `modes.get` 取完整定义，本模块把「id → 定义」的查找表
 * 折叠成只读视图模型。合并语义逐条镜像 daemon `resolveMode`
 * （packages/coding-agent/src/presets/resolve.ts §4.1）——拓扑序、prompt
 * 同名子胜父、settings 后者胜、runtimeContext 任一 false 即 false、
 * promptComplete 取最后声明者且其 prompt 集成为唯一 system prompt。
 *
 * 与 resolveMode 的唯一差异是容错策略：daemon 遇环/悬空引用抛 ModeError
 * （会话创建是写路径，必须失败）；只读视图是读路径，环/悬空/超深链只
 * 记录诊断标记（cycle/missing/truncated）并尽力给出部分合并结果。
 */

/** 提示词区块（prompt 数组元素的对象形态）。 */
export interface ModePromptSection {
	name: string;
	order: number;
	text: string;
}

/** prompt 数组的输入形态：string 快捷语法在解析时展开为 section。 */
export type ModePromptEntry = ModePromptSection | string;

/** `modes.get` 返回的完整预设定义（GUI 侧最小镜像，字段与 wire 对齐）。 */
export interface ModeDefLike {
	id: string;
	label?: string;
	description?: string;
	extends?: string[];
	modelRole?: string;
	/** 三态：缺省 = 全部启用；[] = 仅内置核心；数组 = 启用白名单。 */
	extensions?: string[];
	prompt?: ModePromptEntry[];
	promptComplete?: boolean;
	runtimeContext?: boolean;
	settings?: Record<string, unknown>;
}

/** 继承展开结果（与 daemon ResolvedMode 同语义，GUI 只读呈现用）。 */
export interface ResolvedModeView {
	label: string;
	description?: string;
	modelRole?: string;
	/** undefined = 链上无任何显式声明（全部启用）；[] = 仅内置核心。 */
	extensions: string[] | undefined;
	/** 链上是否有显式扩展声明（区分「全部」与「仅内置」）。 */
	extensionsExplicit: boolean;
	/** 展开后的提示词区块（拓扑序收集、同名子胜父；complete 时为唯一来源的自身区块）。 */
	prompt: ModePromptSection[];
	promptComplete: boolean;
	/** promptComplete 的最后声明者（诊断用）。 */
	promptCompleteSource?: string;
	runtimeContext: boolean;
	settings: Record<string, unknown>;
}

/** 只读视图模型：诊断标记 + 展开结果。 */
export interface ModeChainView {
	/** 拓扑序（父先子后，resolveMode 合并顺序）；环/截断下为部分序。 */
	sources: string[];
	/** 检测到的环路径（首尾相接，如 ["a", "b", "a"]）；无环为 null。 */
	cycle: string[] | null;
	/** 悬空引用：被 extends 但查找表中无定义（去重，发现顺序）。 */
	missing: string[];
	/** 链深超过 MAX_MODE_CHAIN_DEPTH，停止继续展开。 */
	truncated: boolean;
	resolved: ResolvedModeView;
}

/**
 * 链深上限（GUI 防御，daemon 无此限制）。超过后不再展开新节点，
 * truncated 标记置位；取整 16 = 四倍于内置模板最大实际深度（2），
 * 给足自定义链空间，同时把异常/恶意链的渲染与 fetch 开销钉死。
 */
export const MAX_MODE_CHAIN_DEPTH = 16;

/** string 快捷语法展开时的默认 order（与 daemon DEFAULT_PROMPT_ORDER 同契约）。 */
export const DEFAULT_PROMPT_ORDER = 25;

/** 与 daemon normalizePromptEntry 同规则：name = `mode:{id}:{text 前 24 字符}`。 */
export function normalizePromptEntry(entry: ModePromptEntry, modeId: string): ModePromptSection {
	if (typeof entry === "string") {
		return { name: `mode:${modeId}:${entry.slice(0, 24)}`, order: DEFAULT_PROMPT_ORDER, text: entry };
	}
	return entry;
}

/**
 * extends 闭包收集（BFS，去重，返回发现顺序）。供 GUI 在打开只读视图前
 * 一次并行发起链上全部 `modes.get`——摘要行（modes.list）已带 extends，
 * 闭包无需逐层串行往返。超出 cap 的引用不再入队（resolveModeView 的
 * truncated 标记负责如实呈现截断）。
 */
export function collectChainIds(
	rootId: string,
	extendsOf: (id: string) => string[] | undefined,
	cap: number = MAX_MODE_CHAIN_DEPTH,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const queue: string[] = [rootId];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= cap) break;
		for (const parent of extendsOf(id) ?? []) {
			if (!seen.has(parent)) queue.push(parent);
		}
	}
	return out;
}

/**
 * 继承展开的容错版（resolveMode 读路径镜像）：拓扑序 DFS + 合并，
 * 环/悬空/超深只记标记不抛错。lookup 返回 undefined = 该 id 无定义。
 */
export function resolveModeView(rootId: string, lookup: (id: string) => ModeDefLike | undefined): ModeChainView {
	const order: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const defs = new Map<string, ModeDefLike>();
	const missing: string[] = [];
	const missingSeen = new Set<string>();
	let cycle: string[] | null = null;
	let truncated = false;

	const dfs = (modeId: string, chain: string[]): void => {
		const status = state.get(modeId);
		if (status === "done") return;
		if (status === "visiting") {
			// 只记录首个环：chain 从 modeId 首次出现到当前，闭合成路径。
			if (cycle === null) cycle = [...chain.slice(chain.indexOf(modeId)), modeId];
			return;
		}
		if (defs.size >= MAX_MODE_CHAIN_DEPTH) {
			truncated = true;
			return;
		}
		const def = lookup(modeId);
		if (!def) {
			if (!missingSeen.has(modeId)) {
				missingSeen.add(modeId);
				missing.push(modeId);
			}
			return;
		}
		defs.set(modeId, def);
		state.set(modeId, "visiting");
		for (const parent of def.extends ?? []) dfs(parent, [...chain, modeId]);
		state.set(modeId, "done");
		order.push(modeId);
	};
	dfs(rootId, []);

	// 合并（与 resolveMode 逐条同序）：拓扑序遍历，prompt 同名子胜父、
	// settings 后者胜、runtimeContext 任一 false 即 false、promptComplete
	// 最后声明者胜。
	const extSet = new Set<string>();
	let extensionsExplicit = false;
	let modelRole: string | undefined;
	let runtimeContext = true;
	let promptComplete = false;
	let promptCompleteSource: string | undefined;
	const settings: Record<string, unknown> = {};
	const promptByName = new Map<string, ModePromptSection>();
	for (const modeId of order) {
		const def = defs.get(modeId) as ModeDefLike;
		if (def.extensions !== undefined) {
			extensionsExplicit = true;
			for (const ext of def.extensions) extSet.add(ext);
		}
		if (def.modelRole !== undefined) modelRole = def.modelRole;
		if (def.runtimeContext === false) runtimeContext = false;
		for (const entry of def.prompt ?? []) {
			const section = normalizePromptEntry(entry, modeId);
			promptByName.set(section.name, section);
		}
		if (def.promptComplete === true) {
			promptComplete = true;
			promptCompleteSource = modeId;
		}
		if (def.settings) Object.assign(settings, def.settings);
	}

	let prompt: ModePromptSection[];
	if (promptComplete && promptCompleteSource) {
		// complete 预设的 prompt 集 = 声明者自身 sections，丢弃继承链其他 prompt。
		const source = promptCompleteSource;
		prompt = (defs.get(source)?.prompt ?? []).map(e => normalizePromptEntry(e, source));
	} else {
		prompt = [...promptByName.values()];
	}

	const top = defs.get(rootId);
	return {
		sources: order,
		cycle,
		missing,
		truncated,
		resolved: {
			label: top?.label ?? rootId,
			description: top?.description,
			modelRole,
			extensions: extensionsExplicit ? [...extSet] : undefined,
			extensionsExplicit,
			prompt,
			promptComplete,
			promptCompleteSource,
			runtimeContext,
			settings,
		},
	};
}
