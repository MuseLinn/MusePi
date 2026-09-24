/**
 * 内置扩展注册表(DSH builtins 对齐,0.5.0 M2.1 登记补全)。
 *
 * DSH 语义:内置插件 = 部署物(bundle/inline),只读不可改删,可禁用(patch
 * disable)。注册表把"内置扩展"变成显式概念:
 *
 * - 声明集中:新增内置扩展只需往 BUILTIN_EXTENSIONS 加一项(不再改两处)。
 * - 只读保护:内置项 path 恒为空(无文件可 reload/rollback),level=native
 *   (GUI/daemon 的既有删除/禁用保护判定复用)。
 * - 可禁用:通用项走 disabledExtensions;镜像设置的项(settingsMirror)由
 *   daemon 的 extensions.setEnabled 写对应设置键(server.ts 特判保留);
 *   TUI 仪表盘同样写设置键(builtinMirrorDisabled 读回)。
 * - provider 口径(AGENTS.md "Modes(预设)与扩展中心分类"):自有内置能力
 *   一律以 `musepi-extensions` provider 的 builtin 项呈现,不扩大 native
 *   语义;native provider 本身保留给 ~/.musepi/agent 配置文件扫描项。
 *
 * 登记清单(0.5.0 M2.1,清单来源 = 代码事实,契约测试守交集):
 * - 样式/桌面壳(2,settingsMirror 可禁用);
 * - bundled skills(6,annotate-only:安装后由 native 扫描呈现为 skill 行,
 *   注册表只做"内置"标注,不产生重复行;禁走该行自身的 disabledExtensions,
 *   运行时 skills 装配确实消费);
 * - magic keywords(3,settingsMirror 镜像 magicKeywords.<kw>,可禁用);
 * - modes 主题包(1 包,只读展示,无禁用语义 —— 不发明);
 * - tool-render 卡片工具(1 包,只读展示,无禁用语义 —— 不发明)。
 *
 * 边界:内置 hooks 不存在(coding-agent 的 hook 全部是文件/插件态,经
 * native 扫描自然可见),登记数为 0;musepi-extensions provider 级开关
 * 不级联到 builtin 行(与注册前行为一致)。
 */
import { BUNDLED_SKILL_NAMES } from "../../bundled-skills/index.ts";
import { getBuiltinThemes } from "../../modes/theme/loader.ts";
import { type Extension, type ExtensionKind, makeExtensionId, parseExtensionId } from "./types";

/** 自有内置扩展的统一来源标记(musepi-extensions provider,builtin 级)。 */
const BUILTIN_SOURCE: Extension["source"] = {
	provider: "musepi-extensions",
	providerName: "MusePi Extensions",
	level: "native",
};

/**
 * tool-render 卡片工具的 wire 工具名清单。权威清单在 client-core
 * `tool-render/card-tools.ts`(RENDERERS 的键由 registry.test.ts 把守);
 * 此处是 daemon 侧的服务副本 —— coding-agent 契约测试对两边做交集断言,
 * 新增渲染器漏登记时测试失败。
 */
const TOOL_RENDER_CARD_TOOLS_SNAPSHOT: readonly string[] = [
	"apply_patch",
	"ask",
	"ast_edit",
	"ast_grep",
	"await",
	"bash",
	"board",
	"browser",
	"cancel_job",
	"computer",
	"debug",
	"edit",
	"eval",
	"fetch",
	"find",
	"generate_image",
	"github",
	"glob",
	"goal",
	"grep",
	"hub",
	"inspect_image",
	"irc",
	"job",
	"js",
	"lsp",
	"notebook",
	"poll",
	"propose",
	"puppeteer",
	"python",
	"read",
	"recall",
	"reflect",
	"reject",
	"report_tool_issue",
	"resolve",
	"retain",
	"schedule_task",
	"search",
	"task",
	"todo",
	"vibe_kill",
	"vibe_list",
	"vibe_send",
	"vibe_spawn",
	"vibe_wait",
	"web_search",
	"widget",
	"write",
	"yield",
];

/** 内置扩展定义:注册表一行 = 一个部署内置扩展。 */
export interface BuiltinExtensionDef {
	kind: ExtensionKind;
	name: string;
	displayName: string;
	description?: string;
	/** 镜像设置键的内置扩展(state 由设置驱动,setEnabled 写设置而非禁用列表)。 */
	settingsMirror?: { key: string; on: unknown; off: unknown };
	/**
	 * 只读展示项:无禁用语义(如主题包/渲染器包),UI 不渲染停用开关,
	 * 禁用也不会改变运行时 —— 登记仅为可见性与清单契约,不发明语义。
	 */
	readonly?: boolean;
	/**
	 * 标注项:不产生独立条目,只给扫描出的同 id 条目打 builtin 标记
	 * (如 bundled skills —— 安装后的 skill 行已存在,重复登记会出现两行)。
	 */
	annotate?: boolean;
	/** inspector 的 raw 载荷(可为生成值)。 */
	raw: unknown;
}

/** 内置扩展注册表(只读部署物;增补 = 加一行)。 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtensionDef[] = [
	{
		kind: "style",
		name: "task-card-swarm",
		displayName: "Swarm Task Card",
		description:
			"Kimi-parity task/swarm card style: member grid with per-agent avatars, progress bars and accordion outputs",
		settingsMirror: { key: "display.taskCardStyle", on: "swarm", off: "classic" },
		raw: { name: "task-card-swarm", style: "swarm" },
	},
	{
		kind: "desktop-shell",
		name: "shell",
		displayName: "MusePi Desktop Shell",
		description:
			"Electron compat shell: wraps the daemon-served renderer (dsh-desktop parity). Enabled -> the shell loads the runtime-served content; disabled -> the local bundle.",
		settingsMirror: { key: "shell.enabled", on: true, off: false },
		raw: { name: "shell", kind: "desktop-shell" },
	},
	// ── bundled skills(annotate-only:由 native 扫描的安装行呈现)──────────
	...BUNDLED_SKILL_NAMES.map(name => ({
		kind: "skill" as const,
		name,
		displayName: name,
		annotate: true as const,
		raw: { name, kind: "bundled-skill" },
	})),
	// ── magic keywords(settingsMirror 镜像 magicKeywords.<kw>)─────────────
	{
		kind: "magic-keyword",
		name: "ultrathink",
		displayName: "Ultrathink Keyword",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		settingsMirror: { key: "magicKeywords.ultrathink", on: true, off: false },
		raw: { name: "ultrathink", trigger: "ultrathink", setting: "magicKeywords.ultrathink" },
	},
	{
		kind: "magic-keyword",
		name: "orchestrate",
		displayName: "Orchestrate Keyword",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		settingsMirror: { key: "magicKeywords.orchestrate", on: true, off: false },
		raw: { name: "orchestrate", trigger: "orchestrate", setting: "magicKeywords.orchestrate" },
	},
	{
		kind: "magic-keyword",
		name: "workflow",
		displayName: "Workflow Keyword",
		description: "Let standalone workflowz append its hidden eval workflow notice",
		settingsMirror: { key: "magicKeywords.workflow", on: true, off: false },
		raw: { name: "workflow", trigger: "workflowz", setting: "magicKeywords.workflow" },
	},
	// ── modes 主题包(只读展示;主题无禁用语义)─────────────────────────────
	{
		kind: "theme",
		name: "builtin-themes",
		displayName: "Builtin Theme Pack",
		description: "Built-in TUI themes shipped with the CLI (dark/light plus the bundled default set)",
		readonly: true,
		raw: { name: "builtin-themes", kind: "theme-pack", themes: Object.keys(getBuiltinThemes()).sort() },
	},
	// ── tool-render 卡片工具(只读展示;渲染器无禁用语义)───────────────────
	{
		kind: "tool-render",
		name: "builtin-cards",
		displayName: "Tool Card Renderers",
		description: "First-party GUI card renderers for the built-in tool wire names",
		readonly: true,
		raw: { name: "builtin-cards", kind: "tool-render-pack", tools: [...TOOL_RENDER_CARD_TOOLS_SNAPSHOT] },
	},
];

/** 由 kind+name 得注册表定义(不存在返回 undefined)。 */
export function findBuiltinDef(id: string): BuiltinExtensionDef | undefined {
	const parsed = parseExtensionId(id);
	if (!parsed) return undefined;
	return BUILTIN_EXTENSIONS.find(d => d.kind === parsed.kind && d.name === parsed.name);
}

/**
 * 镜像设置项的禁用判定:设置值 === off 即禁用,其余(含未设置,默认值
 * 均为启用)视为启用。daemon extensions.list 与 TUI 仪表盘共用此口径。
 */
export function builtinMirrorDisabled(def: BuiltinExtensionDef, getRaw: (key: string) => unknown): boolean {
	if (!def.settingsMirror) return false;
	return getRaw(def.settingsMirror.key) === def.settingsMirror.off;
}

/**
 * 给扫描出的条目打 builtin 标注(annotate 定义):同 id 的扫描行
 * (如已安装的 bundled skill)获得 builtin 标记与注册表描述,注册表
 * 不为它产生第二条记录。
 */
export function annotateBuiltinExtensions(extensions: Extension[]): Extension[] {
	const annotateDefs = BUILTIN_EXTENSIONS.filter(d => d.annotate);
	if (annotateDefs.length === 0) return extensions;
	const byId = new Map(annotateDefs.map(d => [makeExtensionId(d.kind, d.name), d]));
	return extensions.map(ext => {
		const def = byId.get(ext.id);
		if (!def) return ext;
		const annotated: Extension = { ...ext, builtin: true };
		if (!annotated.description && def.description) annotated.description = def.description;
		return annotated;
	});
}

/** 生成内置扩展条目(state 按 disabledExtensions 计算;镜像设置的项由
 *  daemon extensions.list / TUI 仪表盘在读回时按设置改写 state ——
 *  与注册前行为一致)。annotate 定义不产生条目。 */
export function builtinExtensionEntries(disabledExtensions: ReadonlySet<string>): Extension[] {
	return BUILTIN_EXTENSIONS.filter(def => !def.annotate).map(def => {
		const id = makeExtensionId(def.kind, def.name);
		return {
			id,
			kind: def.kind,
			name: def.name,
			displayName: def.displayName,
			description: def.description,
			trigger: (def.raw as { trigger?: string }).trigger,
			path: "",
			source: { ...BUILTIN_SOURCE },
			state: disabledExtensions.has(id) ? "disabled" : "active",
			disabledReason: disabledExtensions.has(id) ? "item-disabled" : undefined,
			builtin: true,
			readonly: def.readonly,
			raw: def.raw,
		};
	});
}
