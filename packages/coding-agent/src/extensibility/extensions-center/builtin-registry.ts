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
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { BUNDLED_SKILL_NAMES } from "../../bundled-skills/index.ts";
import { getBuiltinThemes } from "../../modes/theme/loader.ts";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_VALUES } from "../../stt/models.ts";
import { STT_SUBMIT_TRIGGER_VALUES } from "../../stt/submit-trigger.ts";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_VALUES,
} from "../../tts/models.ts";
import { type Extension, type ExtensionKind, makeExtensionId, parseExtensionId } from "./types";

/** 组件 deny 通道:组件开关按通道落不同隐藏设置键(见 componentDenyTarget)。 */
export type BuiltinComponentDeny =
	| "tool"
	| "stt-engine"
	| "tts-engine"
	| "terminal-backend"
	| "browser-backend"
	| "file-backend";

/**
 * 组件 deny 通道 → 隐藏设置键 + 名单内 id(daemon setComponentEnabled 与
 * TUI 仪表盘写侧共用同一映射,读侧见 daemon extension-service 的
 * extensions.list 组件状态标注):
 * - "tool" → tools.disabled(id 即组件 id)
 * - "stt-engine"/"tts-engine" → voice.disabledEngines(id 带 "stt:"/"tts:" 前缀)
 * - "terminal-backend" → terminal.disabledBackends
 * - "browser-backend" → browser.disabledBackends
 * - "file-backend" → file.disabledBackends
 */
export function componentDenyTarget(
	deny: BuiltinComponentDeny,
	componentId: string,
): {
	key:
		| "tools.disabled"
		| "voice.disabledEngines"
		| "terminal.disabledBackends"
		| "browser.disabledBackends"
		| "file.disabledBackends";
	id: string;
} {
	switch (deny) {
		case "tool":
			return { key: "tools.disabled", id: componentId };
		case "terminal-backend":
			return { key: "terminal.disabledBackends", id: componentId };
		case "browser-backend":
			return { key: "browser.disabledBackends", id: componentId };
		case "file-backend":
			return { key: "file.disabledBackends", id: componentId };
		default:
			return { key: "voice.disabledEngines", id: `${deny === "stt-engine" ? "stt" : "tts"}:${componentId}` };
	}
}

/** 自有内置扩展的统一来源标记(musepi-extensions provider,builtin 级)。 */
const BUILTIN_SOURCE: Extension["source"] = {
	provider: "musepi-extensions",
	providerName: "MusePi Plugins",
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
	/** 镜像设置键的内置扩展(state 由设置驱动,setEnabled 写设置而非禁用列表)。
	 *  unsetDisabled:设置从未写入时按禁用呈现(用于 schema 默认值即 false
	 *  的键,如 computer.enabled);缺省仍按「未设置 = 启用」处理。 */
	settingsMirror?: { key: string; on: unknown; off: unknown; unsetDisabled?: boolean };
	/**
	 * dsh 式插件配置表单声明(字段键即设置键):daemon 的 extensions.list
	 * 据此挂 config + 从设置读出的 configValues,extensions.setConfig 按
	 * 声明钳制后经 settings 落盘——语音等内置子系统借此获得与插件包
	 * 同款管理页,不重复发明配置存储。
	 */
	config?: readonly ConfigFieldDesc[];
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
	/**
	 * dsh 式「包含的组件」声明:该单元暴露的可独立启停组件。组件开关
	 * 是真实禁用而非展示层,按 deny 通道落不同隐藏设置键:
	 * - "tool" → tools.disabled(tools/index.ts isToolAllowed 谓词消费)
	 * - "stt-engine"/"tts-engine" → voice.disabledEngines
	 *   (voice/engine-denylist.ts:模型状态/下载/转写/合成全路径过滤)
	 * - "terminal-backend" → terminal.disabledBackends
	 *   (terminal-provider.ts:auto 回退剔除 + 显式选中 DISABLED_BACKEND)
	 * - "browser-backend" → browser.disabledBackends
	 *   (tools/browser.ts:设置链回退跳过 + 显式 app 参数 DISABLED_BACKEND)
	 * - "file-backend" → file.disabledBackends
	 *   (tools/file-backend.ts:工具从 slate 剔除 + index 扫描门)
	 * extensions.list 据此下发组件状态,setComponentEnabled 写名单。
	 * 无独立启停语义的组件不声明。
	 */
	components?: readonly {
		id: string;
		deny: BuiltinComponentDeny;
		description?: string;
	}[];
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
	// ── 语音子系统(2,voice:stt / voice:tts;settingsMirror 镜像总开关 +
	//    dsh 式配置表单——字段键即设置键,extensions.setConfig 经设置落盘,
	//    与设置页语音分区同一条存储,双入口零漂移)────────────────────────
	{
		kind: "voice",
		name: "stt",
		displayName: "Speech Input (STT)",
		description:
			"On-device speech-to-text dictation (Whisper / SenseVoice / Parakeet tiers, downloaded on first use). Toggle mirrors stt.enabled; config fields are the stt.* settings keys.",
		settingsMirror: { key: "stt.enabled", on: true, off: false },
		components: [
			{
				id: "whisper",
				deny: "stt-engine",
				description: "ext builtin stt component whisper desc",
			},
			{
				id: "sensevoice",
				deny: "stt-engine",
				description: "ext builtin stt component sensevoice desc",
			},
			{
				id: "parakeet",
				deny: "stt-engine",
				description: "ext builtin stt component parakeet desc",
			},
		],
		config: [
			{
				key: "stt.modelName",
				type: "select",
				options: STT_MODEL_VALUES,
				default: DEFAULT_STT_MODEL_KEY,
				restart: "none",
				label: "plugin cfg stt.modelName label",
				description: "plugin cfg stt.modelName desc",
			},
			{
				key: "stt.language",
				type: "string",
				default: "",
				restart: "none",
				label: "plugin cfg stt.language label",
				description: "plugin cfg stt.language desc",
			},
			{
				key: "stt.vadEndMs",
				type: "number",
				default: 700,
				restart: "none",
				label: "plugin cfg stt.vadEndMs label",
				description: "plugin cfg stt.vadEndMs desc",
			},
			{
				key: "stt.submitTrigger",
				type: "select",
				options: STT_SUBMIT_TRIGGER_VALUES,
				default: "never",
				restart: "none",
				label: "plugin cfg stt.submitTrigger label",
				optionLabels: {
					never: "plugin cfg stt.submitTrigger opt never",
					release: "plugin cfg stt.submitTrigger opt release",
					"release-complete": "plugin cfg stt.submitTrigger opt release-complete",
					"say-submit": "plugin cfg stt.submitTrigger opt say-submit",
				},
				description: "plugin cfg stt.submitTrigger desc",
			},
		],
		raw: { name: "stt", kind: "voice" },
	},
	{
		kind: "voice",
		name: "tts",
		displayName: "Speech Output (TTS)",
		description:
			"Streaming neural text-to-speech readback (Kokoro-82M / MeloTTS 中文, downloaded on first use). Toggle mirrors speech.enabled; config fields are the tts.* settings keys.",
		settingsMirror: { key: "speech.enabled", on: true, off: false },
		components: [
			{
				id: "kokoro",
				deny: "tts-engine",
				description: "ext builtin tts component kokoro desc",
			},
			{
				id: "melotts-zh",
				deny: "tts-engine",
				description: "ext builtin tts component melotts-zh desc",
			},
		],
		config: [
			{
				key: "tts.localModel",
				type: "select",
				options: TTS_LOCAL_MODEL_VALUES,
				default: DEFAULT_TTS_LOCAL_MODEL_KEY,
				restart: "none",
				label: "plugin cfg tts.localModel label",
				description: "plugin cfg tts.localModel desc",
			},
			{
				key: "tts.localVoice",
				type: "select",
				options: TTS_LOCAL_VOICE_VALUES,
				default: DEFAULT_TTS_VOICE,
				restart: "none",
				label: "plugin cfg tts.localVoice label",
				description: "plugin cfg tts.localVoice desc",
			},
			{
				key: "tts.rate",
				type: "number",
				default: 1,
				min: 0.5,
				max: 2,
				step: 0.1,
				restart: "none",
				label: "plugin cfg tts.rate label",
				description: "plugin cfg tts.rate desc",
			},
			{
				key: "tts.inputMode",
				type: "select",
				options: ["raw", "sanitize", "summarize"],
				default: "sanitize",
				restart: "none",
				label: "plugin cfg tts.inputMode label",
				optionLabels: {
					raw: "plugin cfg tts.inputMode opt raw",
					sanitize: "plugin cfg tts.inputMode opt sanitize",
					summarize: "plugin cfg tts.inputMode opt summarize",
				},
				description: "plugin cfg tts.inputMode desc",
			},
			{
				key: "tts.autoRead",
				type: "boolean",
				default: false,
				restart: "none",
				label: "plugin cfg tts.autoRead label",
				description: "plugin cfg tts.autoRead desc",
			},
		],
		raw: { name: "tts", kind: "voice" },
	},
	// ── 更多内置子系统(dsh 子系统插件 parity:terminal/browser/computer/
	//    lsp ——终端无总开关语义(不发明),两个 provider 单元以组件形式
	//    独立启停;其余镜像各自 enabled 设置键,配置字段键即设置键)───────
	{
		kind: "terminal",
		name: "terminal",
		displayName: "Terminal",
		description:
			"Session terminal backend (bun-pty → node-pty auto-fallback) powering the TUI terminal and the GUI terminal panel. Read-only display: no master switch — the two provider units toggle as components.",
		readonly: true,
		components: [
			{
				id: "bun-pty",
				deny: "terminal-backend",
				description: "ext builtin terminal component bun-pty desc",
			},
			{
				id: "node-pty",
				deny: "terminal-backend",
				description: "ext builtin terminal component node-pty desc",
			},
		],
		config: [
			{
				key: "terminal.provider",
				type: "select",
				options: ["auto", "bun-pty", "node-pty"],
				default: "auto",
				restart: "daemon",
				label: "plugin cfg terminal.provider label",
				optionLabels: {
					auto: "plugin cfg terminal.provider opt auto",
					"bun-pty": "plugin cfg terminal.provider opt bun-pty",
					"node-pty": "plugin cfg terminal.provider opt node-pty",
				},
				description: "plugin cfg terminal.provider desc",
			},
			{
				key: "terminal.showImages",
				type: "boolean",
				default: true,
				restart: "none",
				label: "plugin cfg terminal.showImages label",
				description: "plugin cfg terminal.showImages desc",
			},
			{
				key: "terminal.showProgress",
				type: "boolean",
				default: true,
				restart: "none",
				label: "plugin cfg terminal.showProgress label",
				description: "plugin cfg terminal.showProgress desc",
			},
		],
		raw: { name: "terminal", kind: "terminal" },
	},
	{
		kind: "browser",
		name: "browser",
		displayName: "Browser",
		description:
			"Scripted Chromium automation tool (puppeteer) plus the managed in-app browser bridge. Toggle mirrors browser.enabled; the three backend units toggle as components.",
		settingsMirror: { key: "browser.enabled", on: true, off: false },
		components: [
			{
				id: "launch",
				deny: "browser-backend",
				description: "ext builtin browser component launch desc",
			},
			{
				id: "attach",
				deny: "browser-backend",
				description: "ext builtin browser component attach desc",
			},
			{
				id: "gui",
				deny: "browser-backend",
				description: "ext builtin browser component gui desc",
			},
		],
		config: [
			{
				key: "browser.headless",
				type: "boolean",
				default: true,
				restart: "none",
				label: "plugin cfg browser.headless label",
				description: "plugin cfg browser.headless desc",
			},
			{
				key: "browser.cdpUrl",
				type: "string",
				default: "",
				restart: "none",
				label: "plugin cfg browser.cdpUrl label",
				description: "plugin cfg browser.cdpUrl desc",
			},
		],
		raw: { name: "browser", kind: "browser" },
	},
	{
		kind: "computer",
		name: "computer",
		displayName: "Computer Use",
		description:
			"Scriptable host-desktop control tool (screenshots, input, accessibility tree). Off by default; toggle mirrors computer.enabled.",
		settingsMirror: { key: "computer.enabled", on: true, off: false, unsetDisabled: true },
		components: [
			{
				id: "computer",
				deny: "tool",
				description: "ext builtin computer component computer desc",
			},
		],
		config: [
			{
				key: "computer.display",
				type: "string",
				default: "all",
				restart: "none",
				label: "plugin cfg computer.display label",
				description: "plugin cfg computer.display desc",
			},
			{
				key: "computer.maxWidth",
				type: "number",
				default: 3840,
				restart: "none",
				label: "plugin cfg computer.maxWidth label",
				description: "plugin cfg computer.maxWidth desc",
			},
		],
		raw: { name: "computer", kind: "computer" },
	},
	{
		kind: "lsp",
		name: "lsp",
		displayName: "LSP",
		description:
			"Code intelligence via language servers (definitions, references, diagnostics, rename). Toggle mirrors lsp.enabled.",
		settingsMirror: { key: "lsp.enabled", on: true, off: false },
		components: [
			{
				id: "lsp",
				deny: "tool",
				description: "ext builtin lsp component lsp desc",
			},
		],
		config: [
			{
				key: "lsp.lazy",
				type: "boolean",
				default: true,
				restart: "session",
				label: "plugin cfg lsp.lazy label",
				description: "plugin cfg lsp.lazy desc",
			},
			{
				key: "lsp.shared",
				type: "boolean",
				default: true,
				restart: "daemon",
				label: "plugin cfg lsp.shared label",
				description: "plugin cfg lsp.shared desc",
			},
		],
		raw: { name: "lsp", kind: "lsp" },
	},
	// ── file 子系统（dsh fs 插件族 parity：tool-fs / tool-str-replace-editor /
	//    tool-fs-search / 索引——读写检索三工具族 + 索引扫描四组件；无总开关
	//    语义（不发明），file 工具是编码核心能力，禁用粒度落到后端组件）──
	{
		kind: "file",
		name: "file",
		displayName: "File Tools & Index",
		description:
			"Workspace file subsystems: the read/write/search tool families and the background content index. Read-only display: no master switch — the four backend units toggle as components.",
		readonly: true,
		components: [
			{
				id: "read",
				deny: "file-backend",
				description: "ext builtin file component read desc",
			},
			{
				id: "write",
				deny: "file-backend",
				description: "ext builtin file component write desc",
			},
			{
				id: "search",
				deny: "file-backend",
				description: "ext builtin file component search desc",
			},
			{
				id: "index",
				deny: "file-backend",
				description: "ext builtin file component index desc",
			},
		],
		raw: { name: "file", kind: "file" },
	},
];

/** 由 kind+name 得注册表定义(不存在返回 undefined)。 */
export function findBuiltinDef(id: string): BuiltinExtensionDef | undefined {
	const parsed = parseExtensionId(id);
	if (!parsed) return undefined;
	return BUILTIN_EXTENSIONS.find(d => d.kind === parsed.kind && d.name === parsed.name);
}

/**
 * 镜像设置项的禁用判定:设置值 === off 即禁用;声明了 unsetDisabled
 * 的项未设置时按禁用(schema 默认值即 false,如 computer.enabled),
 * 其余未设置一律视为启用。daemon extensions.list 与 TUI 仪表盘共用此口径。
 */
export function builtinMirrorDisabled(def: BuiltinExtensionDef, getRaw: (key: string) => unknown): boolean {
	if (!def.settingsMirror) return false;
	const raw = getRaw(def.settingsMirror.key);
	if (raw === undefined) return def.settingsMirror.unsetDisabled === true;
	return raw === def.settingsMirror.off;
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
