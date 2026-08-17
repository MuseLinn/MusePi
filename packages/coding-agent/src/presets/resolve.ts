/**
 * Modes(命名预设)聚合层:继承展开、结构校验、mtime 缓存。
 * 契约:docs/modes-plan.md §3/§4/§11(决策 #1/#5/#9/#10/#15/#16)。
 *
 * 纯逻辑,零运行时依赖 —— v1 会话创建时消费;v2 热切换复用同一展开结果。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 提示词区块(prompt 数组元素的对象形态)。 */
export interface PromptSection {
	name: string;
	order: number;
	text: string;
}

/** prompt 数组的输入形态:string 快捷语法在解析时展开为 section。 */
export type ModePromptEntry = PromptSection | string;

/** 磁盘上的预设定义(id = 文件名,非定义内字段)。 */
export interface ModeDefinition {
	id: string;
	label?: string;
	description?: string;
	/** 子预设引用;拓扑序展开(§4.2)。 */
	extends?: string[];
	/** 创建会话时的默认模型档位(settings.modelRoles 键或内置角色;§6.1,决策 #9)。 */
	modelRole?: string;
	/** 三态:缺省(undefined)= 全部启用;[] = 仅内置核心;数组 = 启用白名单(决策 #10)。 */
	extensions?: string[];
	prompt?: ModePromptEntry[];
	/** true = 该预设的 prompt 集成为唯一 system prompt(对齐 DSH complete:true;§5.2,决策 #2)。 */
	promptComplete?: boolean;
	/** false = 关闭 activeRepoContext 区块(对齐 DSH includeRuntimeContext:false;决策 #16)。 */
	runtimeContext?: boolean;
	/** 覆盖片段,展开合并进会话有效 settings(冲突用户全局赢,§4.3)。 */
	settings?: Record<string, unknown>;
}

/** 展开后的预设(继承链折叠)。 */
export interface ResolvedMode {
	id: string;
	label: string;
	description?: string;
	/** 创建会话时的默认模型档位;undefined = 不指定。 */
	modelRole?: string;
	/** undefined = 全部启用(链上无任何显式声明);[] = 仅内置核心。 */
	extensions: string[] | undefined;
	/** 链上是否有显式扩展声明(区分"全部"与"仅内置";决策 #10)。 */
	extensionsExplicit: boolean;
	/** 展开后的提示词区块(按拓扑序收集;composer 再做插槽排序)。 */
	prompt: PromptSection[];
	promptComplete: boolean;
	runtimeContext: boolean;
	settings: Record<string, unknown>;
	/** 继承链(拓扑序,诊断用)。 */
	sources: string[];
}

export const MODES_DIR = "modes";
/** 预设 id = 文件名,路径安全边界(与 DSH PRESET_ID 同规则)。 */
export const MODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** string 快捷语法展开时的默认 order(§5.1 注入区间 25)。 */
export const DEFAULT_PROMPT_ORDER = 25;

export class ModeError extends Error {
	constructor(
		message: string,
		readonly modeId?: string,
	) {
		super(modeId ? `${modeId}: ${message}` : message);
	}
}

// ── 校验 ───────────────────────────────────────────────────────────────────

export interface ValidateOptions {
	/** daemon 已知扩展 id 集合;提供时校验白名单/extends 引用存在性。 */
	knownExtensions?: readonly string[];
}

/** 扩展声明预设的查找入口(modes v2 §5.5):文件层未命中时兜底查扩展。 */
export type ExtraModeLookup = (modeId: string) => ModeDefinition | undefined;

export interface ResolveOptions extends ValidateOptions {
	/** 文件层 load 未命中时的兜底查找(扩展 registerMode 声明)。文件优先:
	 *  用户数据层(mode 文件)压过扩展代码层,对齐 DSH patch 分层语义。 */
	extraModes?: ExtraModeLookup;
}

/** 结构校验(单个预设);返回错误列表,空 = 合法。 */
export function validateMode(def: ModeDefinition, opts: ValidateOptions = {}): string[] {
	const errors: string[] = [];
	if (!MODE_ID_PATTERN.test(def.id)) {
		errors.push(`id "${def.id}" 不合法(须匹配 ${MODE_ID_PATTERN})`);
	}
	for (const ext of def.extends ?? []) {
		if (!MODE_ID_PATTERN.test(ext)) errors.push(`extends "${ext}" 不是合法预设 id`);
	}
	const names = new Set<string>();
	for (const entry of def.prompt ?? []) {
		const section = normalizePromptEntry(entry, def.id);
		if (names.has(section.name)) errors.push(`prompt 区块 name "${section.name}" 重复`);
		names.add(section.name);
		if (!Number.isFinite(section.order)) errors.push(`prompt 区块 "${section.name}" 的 order 非法`);
	}
	if (opts.knownExtensions) {
		for (const ext of def.extensions ?? []) {
			if (!opts.knownExtensions.includes(ext)) errors.push(`扩展 "${ext}" 未找到`);
		}
	}
	return errors;
}

// ── 展开 ───────────────────────────────────────────────────────────────────

function normalizePromptEntry(entry: ModePromptEntry, id: string): PromptSection {
	if (typeof entry === "string") {
		return { name: `mode:${id}:${entry.slice(0, 24)}`, order: DEFAULT_PROMPT_ORDER, text: entry };
	}
	return entry;
}

export interface ResolveOptions extends ValidateOptions {}

/**
 * 继承展开(§4.1):DFS 拓扑序,环/悬空引用抛 ModeError;展开后
 * extensions 并集、prompt 混排(同名子胜父)、settings 后者胜、
 * runtimeContext 任一显式 false 即 false、promptComplete 取最后声明者。
 */
export function resolveMode(
	id: string,
	load: (modeId: string) => ModeDefinition | undefined,
	opts: ResolveOptions = {},
): ResolvedMode {
	const order: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const defs = new Map<string, ModeDefinition>();

	const dfs = (modeId: string, chain: string[]): void => {
		const status = state.get(modeId);
		if (status === "done") return;
		if (status === "visiting") {
			const cycle = [...chain.slice(chain.indexOf(modeId)), modeId].join(" → ");
			throw new ModeError(`extends 环检测到:${cycle}`, modeId);
		}
		const def = load(modeId);
		if (!def) throw new ModeError("未定义的预设(悬空 extends)", modeId);
		defs.set(modeId, def);
		state.set(modeId, "visiting");
		for (const parent of def.extends ?? []) dfs(parent, [...chain, modeId]);
		state.set(modeId, "done");
		order.push(modeId);
	};
	dfs(id, []);

	const allErrors: string[] = [];
	for (const modeId of order) {
		for (const error of validateMode(defs.get(modeId)!, opts)) allErrors.push(`${modeId}: ${error}`);
	}
	if (allErrors.length > 0) throw new ModeError(`预设校验失败:\n${allErrors.join("\n")}`, id);

	const extSet = new Set<string>();
	let extensionsExplicit = false;
	let modelRole: string | undefined;
	let runtimeContext = true;
	let promptComplete = false;
	let promptCompleteSource: string | undefined;
	const settings: Record<string, unknown> = {};
	const promptByName = new Map<string, PromptSection>();

	for (const modeId of order) {
		const def = defs.get(modeId)!;
		if (def.extensions !== undefined) {
			extensionsExplicit = true;
			for (const ext of def.extensions) extSet.add(ext);
		}
		if (def.modelRole !== undefined) modelRole = def.modelRole;
		if (def.runtimeContext === false) runtimeContext = false;
		for (const entry of def.prompt ?? []) {
			const section = normalizePromptEntry(entry, modeId);
			promptByName.set(section.name, section); // 后声明(子)覆盖先声明(父)
		}
		if (def.promptComplete === true) {
			promptComplete = true;
			promptCompleteSource = modeId; // 最后声明者胜
		}
		if (def.settings) Object.assign(settings, def.settings);
	}

	let prompt: PromptSection[];
	if (promptComplete && promptCompleteSource) {
		// complete 预设的 prompt 集 = 自身 sections,丢弃继承链其他 prompt(§5.2)
		prompt = (defs.get(promptCompleteSource)!.prompt ?? []).map(e => normalizePromptEntry(e, promptCompleteSource!));
	} else {
		prompt = [...promptByName.values()];
	}

	const top = defs.get(id)!;
	return {
		id,
		label: top.label ?? id,
		description: top.description,
		modelRole,
		extensions: extensionsExplicit ? [...extSet] : undefined,
		extensionsExplicit,
		prompt,
		promptComplete,
		runtimeContext,
		settings,
		sources: order,
	};
}

// ── 文件加载 + mtime 缓存(§4.1,与 P5 entryMtimes 同模式) ──────────────────

export function modeFilePath(dir: string, id: string): string {
	return join(dir, `${id}.json`);
}

export function loadModeFile(dir: string, id: string): ModeDefinition | undefined {
	const path = modeFilePath(dir, id);
	try {
		const raw = readFileSync(path, "utf8");
		const def = JSON.parse(raw) as Partial<ModeDefinition>;
		if (typeof def !== "object" || def === null) throw new ModeError("预设文件不是 JSON 对象");
		return { id, ...def };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new ModeError(`读取预设失败:${String(error)}`, id);
	}
}

export function listModeIds(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter(f => f.endsWith(".json"))
			.map(f => f.slice(0, -".json".length))
			.filter(id => MODE_ID_PATTERN.test(id))
			.sort();
	} catch {
		return [];
	}
}

export interface ModeResolver {
	resolve(modeId: string): ResolvedMode;
	invalidate(): void;
}

/** 内置模板(决策 #12 修订,DSH 四预设对齐):work(默认全量)/ chat(极简)/
 *  design(设计)/ creator(创作);文件已存在不覆盖(用户编辑优先)。
 *  label/description 由 daemon modes.list 按内置 id 本地化(i18n keys)。 */
export const BUILTIN_MODE_TEMPLATES: Record<string, ModeDefinition> = {
	work: {
		id: "work",
		label: "Work",
		description: "默认工作预设:完整工具集、无提示词覆盖(未启用预设时的行为)",
	},
	chat: {
		id: "chat",
		label: "Chat",
		description: "极简对话:仅内置核心工具 + 固定 prompt + 无压缩",
		modelRole: "fast",
		extensions: [],
		promptComplete: true,
		runtimeContext: false,
		prompt: [
			{
				name: "mode:chat:persona",
				order: 0,
				text: "你是一名简洁的对话助手。只回答结论,不做多余分析;优先给出最小可行的方案。",
			},
		],
		settings: { "compaction.enabled": false },
	},
	design: {
		id: "design",
		label: "Design",
		description: "设计模式:全量工具 + 设计师 persona(视觉方案优先)",
		prompt: [
			{
				name: "mode:design:role",
				order: 25,
				text: "你是一名资深 UI/UX 设计师。优先给出视觉方案而非代码;涉及布局时先做结构判断,再给实现细节。",
			},
		],
	},
	creator: {
		id: "creator",
		label: "Creator",
		description: "创造模式:创作预设/扩展的助手(全量工具 + 创作 persona)",
		prompt: [
			{
				name: "mode:creator:role",
				order: 25,
				text: "你是一名 MusePi 扩展与预设创作者。创建/修改扩展时遵循 musepi-extension-dev 技能;创建预设时遵循 docs/modes-plan.md 的契约(extends 继承、promptComplete、settings 覆盖),完成后用 modes.validate 自检。",
			},
		],
	},
};

/** 首次使用时把内置模板写入 modeDir(缺失才写,不覆盖已有文件)。 */
export function ensureModeTemplates(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const [id, def] of Object.entries(BUILTIN_MODE_TEMPLATES)) {
		const file = modeFilePath(dir, id);
		try {
			statSync(file); // 已存在 → 用户编辑过/已初始化,跳过
		} catch {
			writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`, "utf8");
		}
	}
}

/** 带 mtime 失效缓存的解析器;预设文件变更后首次 resolve 自动重建。 */
export function createModeResolver(dir: string, opts: ResolveOptions = {}): ModeResolver {
	const mtimes = new Map<string, number>();
	const resolved = new Map<string, ResolvedMode>();

	const refreshIfStale = (): void => {
		for (const [cachedId, mtime] of mtimes) {
			let current: number;
			try {
				current = statSync(modeFilePath(dir, cachedId)).mtimeMs;
			} catch {
				mtimes.clear();
				resolved.clear();
				return;
			}
			if (current !== mtime) {
				mtimes.clear();
				resolved.clear();
				return;
			}
		}
	};

	return {
		resolve(modeId: string): ResolvedMode {
			refreshIfStale();
			const hit = resolved.get(modeId);
			if (hit) return hit;
			// 记录展开涉及的全部文件(顶层 + extends 链),任一个 mtime 变更都使缓存失效
			const touched = new Set<string>();
			const load = (mid: string): ModeDefinition | undefined => {
				touched.add(mid);
				return loadModeFile(dir, mid) ?? opts.extraModes?.(mid);
			};
			const def = load(modeId);
			if (!def) {
				const available = listModeIds(dir).join(", ") || "none";
				throw new ModeError(`未找到预设(available: ${available})`, modeId);
			}
			const out = resolveMode(modeId, load, opts);
			for (const mid of touched) {
				// 纯扩展 mode(无文件)不参与 mtime 失效;扩展集变化由
				// runner 侧主动 invalidate(热启用/禁用扩展后调用)。
				const filePath = modeFilePath(dir, mid);
				try {
					mtimes.set(mid, statSync(filePath).mtimeMs);
				} catch {
					/* ENOENT:扩展声明 mode,无文件层时间戳 */
				}
			}
			resolved.set(modeId, out);
			return out;
		},
		invalidate() {
			mtimes.clear();
			resolved.clear();
		},
	};
}
