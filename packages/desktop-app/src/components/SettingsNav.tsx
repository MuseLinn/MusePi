import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useRef } from "react";
import type { SectionId, SectionRequest } from "../lib/settings-nav";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * The settings navigation column as a controlled component (2026-09-24 slot
 * replacement refactor). Extracted verbatim from SettingsView when the
 * settings shell stopped overlaying the chat column and started occupying
 * the app sidebar's slot: app.tsx renders a `.gui-settings-nav-slot` filler
 * in the sidebar position and SettingsView portals this column into it, so
 * the nav shares the sidebar's geometry instead of floating as a second
 * column beside the session list. State (activeSection + query) stays in
 * SettingsView — the content branches and the search-highlight effect read
 * it — so this component is presentation-only, which also keeps it
 * mountable in bun tests (its import chain avoids the settings-sections /
 * @lobehub graph that cannot initialize under bun's module loader).
 *
 * The section id contract lives in lib/settings-nav.ts.
 */

interface SectionDef {
	id: SectionId | string;
	/** Must be a real sprite key — IconName is derived from the sprite, so
	 *  a typo'd name is a compile error, not a silent blank tab icon. */
	icon: IconName;
	label: string;
	/** Implemented sections are clickable; placeholders stay disabled. */
	enabled: boolean;
}

/**
 * Settings search terms per section (id → keywords found in that section's
 * actual settings rows: labels, descriptions, option names). The nav filter
 * matches a section when the query hits its label OR any of these keywords —
 * so searching "头像" finds the 常规 section even though its nav label is
 * just "常规". Bilingual on purpose (users search in either language).
 */
const SECTION_SEARCH_TERMS: Record<string, string[]> = {
	general: [
		"头像",
		"avatar",
		"点阵",
		"dot",
		"brand",
		"enter",
		"回车",
		"防休眠",
		"caffeinate",
		"存储",
		"storage",
		"路径",
		"path",
		"守护",
		"daemon",
		"版本",
		"version",
		"引擎",
		"engine",
		"语言",
		"language",
		"时区",
		"timezone",
		"更新",
		"update",
		"检查",
		"check",
	],
	appearance: [
		"主题",
		"theme",
		"强调",
		"accent",
		"字体",
		"font",
		"字号",
		"density",
		"密度",
		"暗色",
		"dark",
		"浅色",
		"light",
		"颜色",
		"color",
		"动画",
		"animation",
		"动效",
		"motion",
		"圆角",
		"radius",
	],
	notifications: ["通知", "notification", "声音", "sound", "提示", "提醒", "alert", "横幅", "banner"],
	pet: [
		"桌宠",
		"pet",
		"宠物",
		"伙伴",
		"companion",
		"动画",
		"animation",
		"尾巴",
		"tail",
		"皮肤",
		"skin",
		"交互",
		"interact",
	],
	sessions: ["会话", "session", "恢复", "resume", "归档", "archive", "历史", "history", "标题", "title"],
	git: [
		"git",
		"仓库",
		"repository",
		"提交",
		"commit",
		"认证",
		"auth",
		"登录",
		"sign",
		"gh",
		"github",
		"拉取",
		"push",
		"推送",
	],
	shortcuts: ["快捷键", "shortcut", "按键", "key", "组合", "绑定", "bind", "⌘", "command"],
	model: [
		"模型",
		"model",
		"供应商",
		"provider",
		"角色",
		"role",
		"思考",
		"thinking",
		"外部",
		"external",
		"视觉",
		"vision",
		"侧信道",
		"side",
		"channel",
		"api",
		"key",
	],
	interaction: [
		"交互",
		"enter",
		"回车",
		"补全",
		"completion",
		"滚动",
		"scroll",
		"粘贴",
		"paste",
		"光标",
		"cursor",
		"ime",
		"输入",
		"input",
		"自动",
		"auto",
		"建议",
		"suggest",
	],
	context: ["上下文", "context", "压缩", "compact", "窗口", "window", "token", "令牌", "限制", "limit"],
	shell: [
		"终端",
		"terminal",
		"shell",
		"pty",
		"命令",
		"command",
		"bash",
		"zsh",
		"环境",
		"env",
		"最大",
		"max",
		"输出",
		"output",
	],
	tools: ["工具", "tool", "权限", "permission", "批准", "approval", "审批", "自动", "auto", "确认", "confirm"],
	media: [
		"图像生成",
		"image",
		"视频生成",
		"video",
		"文生图",
		"generate_image",
		"agnes_video_gen",
		"供应商",
		"provider",
		"api key",
		"密钥",
	],
	files: [
		"文件",
		"file",
		"lsp",
		"语言服务",
		"language",
		"索引",
		"index",
		"搜索",
		"search",
		"忽略",
		"ignore",
		"排除",
		"exclude",
	],
	memory: ["记忆", "memory", "上下文", "context", "摘要", "summary", "向量", "vector", "嵌入", "embed"],
	plugins: ["插件", "plugin", "扩展", "extension", "加载", "load", "启用", "enable"],
	skills: [
		"技能",
		"skill",
		"扩展",
		"extension",
		"内置",
		"builtin",
		"市场",
		"market",
		"搜索",
		"search",
		"安装",
		"install",
		"目录",
		"dir",
	],
	subagents: ["子代理", "subagent", "任务", "task", "并行", "parallel", "并发", "concurrency", "数量", "count"],
	mcp: ["mcp", "服务", "server", "工具", "tool", "端点", "endpoint", "url"],
	commands: ["命令", "command", "slash", "斜杠", "自定义", "custom", "快捷", "quick"],
	hooks: ["钩子", "hook", "事件", "event", "触发", "trigger", "toml", "脚本", "script"],
	browser: ["浏览器", "browser", "网页", "web", "受管", "managed", "代理", "proxy", "截图", "screenshot"],
	suggestions: ["提示词", "suggestion", "预设", "preset", "快捷", "chip", "starter", "建议", "prompt"],
	modes: ["预设", "模式", "mode", "preset", "profile", "角色", "role", "work", "design"],
	history: ["历史", "history", "会话", "session", "时间", "time", "保留", "retention", "清理", "clean"],
	indexes: ["索引", "index", "库", "代码库", "搜索", "search", "扫描", "scan", "cwd", "工作区"],
	usage: ["统计", "usage", "用量", "成本", "cost", "token", "模型", "model", "月度", "monthly"],
};

/** ZCode-style grouped navigation: 基础设置 / 智能体 / 数据与统计. The
 * openchamber-parity tabs (chat / notifications / sessions / shortcuts /
 * agents) are backed by live settings; hooks (extensions RPC), 索引库
 * (session.search) and 使用统计 (packages/stats) complete the capability
 * groups. Evaluated at render so the labels follow locale switches (a
 * module-level const would freeze the first locale's strings). */
export function navGroups(
	extTabs: ReadonlyArray<{ slot: string; label?: string }>,
): { title: string; items: SectionDef[] }[] {
	const groups: { title: string; items: SectionDef[] }[] = [
		{
			title: t("basic settings"),
			items: [
				{ id: "general", icon: "settings-3", label: t("general"), enabled: true },
				{ id: "appearance", icon: "palette", label: t("appearance"), enabled: true },
				{ id: "notifications", icon: "notification-3", label: t("notifications & sound"), enabled: true },
				{ id: "pet", icon: "robot-2", label: t("agent companion"), enabled: true },
				{ id: "sessions", icon: "history", label: t("sessions"), enabled: true },
				{ id: "git", icon: "git-branch", label: t("git settings"), enabled: true },
				{ id: "shortcuts", icon: "command", label: t("shortcuts"), enabled: true },
				{ id: "model", icon: "ai-agent", label: t("model settings"), enabled: true },
				{ id: "interaction", icon: "shuffle", label: t("interaction"), enabled: true },
				{ id: "voice", icon: "mic", label: t("voice"), enabled: true },
				{ id: "context", icon: "stack", label: t("context"), enabled: true },
				{ id: "shell", icon: "terminal-window", label: t("shell"), enabled: true },
				{ id: "tools", icon: "plug-2", label: t("tools"), enabled: true },
				{ id: "media", icon: "image-download", label: t("image & video generation"), enabled: true },
				{ id: "files", icon: "file-text", label: t("files & lsp"), enabled: true },
				{ id: "memory", icon: "brain", label: t("memory settings"), enabled: true },
			],
		},
		{
			title: t("agent capabilities"),
			items: [
				{ id: "skills", icon: "sparkling", label: t("extensions"), enabled: true },
				{ id: "subagents", icon: "user", label: t("tasks & subagents"), enabled: true },
				{ id: "mcp", icon: "server", label: t("mcp servers"), enabled: true },
				{ id: "commands", icon: "terminal-box", label: t("commands"), enabled: true },
				{ id: "hooks", icon: "node-tree", label: t("hooks"), enabled: true },
				{ id: "suggestions", icon: "chat-1", label: t("starter prompts"), enabled: true },
				{ id: "modes", icon: "stack", label: t("modes title"), enabled: true },
				{ id: "browser", icon: "compass-3", label: t("browser"), enabled: true },
			],
		},
		{
			title: t("data and statistics"),
			items: [
				{ id: "history", icon: "history", label: t("session history"), enabled: true },
				{ id: "indexes", icon: "book", label: t("index library"), enabled: true },
				{ id: "usage", icon: "star", label: t("usage statistics"), enabled: true },
				{ id: "migration", icon: "download", label: t("data migration"), enabled: true },
			],
		},
	];
	// 内核级 slot(P1):`settings.tab.<id>` 槽位组件挂为左侧导航项 ——
	// 扩展声明一个设置页即出现在导航。
	// 配置项级贡献走 registerSetting 的 ui.tab(插入现有 tab)或
	// settings.item 卡片(扩展中心),不设"扩展设置"聚合 tab。
	for (const c of extTabs) {
		groups[1]!.items.push({
			id: `ext:${c.slot}`,
			icon: "plug",
			label: c.label ?? c.slot,
			enabled: true,
		});
	}
	return groups;
}

/**
 * The nav column body: back-to-workspace header, the section search box,
 * the grouped rows (filtered live by `query`) and the bottom user-area
 * entries (onboarding + what's-new). Rendering is presentation-only; the
 * section id contract is lib/settings-nav.ts's.
 */
export function SettingsNav({
	extTabs,
	activeSection,
	onSelect,
	onBack,
	query,
	onQueryChange,
}: {
	extTabs: ReadonlyArray<{ slot: string; label?: string }>;
	/** The section SettingsView currently renders — drives the highlight. */
	activeSection: SectionId | string;
	onSelect(id: SectionRequest): void;
	onBack(): void;
	/** Search box value; filters rows by label + section keywords. */
	query: string;
	onQueryChange(query: string): void;
}): ReactNode {
	const groups = navGroups(extTabs);
	// Content-boundary feather (transcript parity): the nav column scrolls
	// inside the slot — the shared hook flips its data-top-scroll /
	// data-bottom-scroll mask attrs.
	const navRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(navRef);
	return (
		<nav className="gui-settings-nav-col flex h-full w-full flex-shrink-0 flex-col overflow-hidden">
			<div className="gui-settings-nav-head">
				<button type="button" className="gui-settings-back" onClick={onBack}>
					<Icon name="arrow-left-s" className="h-4 w-4" />
					<span className="gui-settings-back-label">{t("back to workspace")}</span>
				</button>
			</div>
			<div className="gui-settings-search">
				<Icon name="search" className="h-3.5 w-3.5 flex-none" />
				<input
					className="gui-input min-w-0 flex-1"
					value={query}
					onChange={e => onQueryChange(e.target.value)}
					placeholder={t("search settings…")}
					aria-label={t("search settings…")}
				/>
				{query && (
					<button
						type="button"
						className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
						onClick={() => onQueryChange("")}
						title={t("clear")}
						aria-label={t("clear")}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				)}
			</div>
			<div ref={navRef} className="gui-settings-nav-scroll" data-top-scroll="false" data-bottom-scroll="false">
				{groups
					.map(group => ({
						...group,
						items: query.trim()
							? group.items.filter(item => {
									const q = query.trim().toLowerCase();
									if (item.label.toLowerCase().includes(q)) return true;
									const terms = SECTION_SEARCH_TERMS[item.id] ?? [];
									return terms.some(k => k.includes(q) || q.includes(k));
								})
							: group.items,
					}))
					.filter(group => group.items.length > 0)
					.map(group => (
						<div key={group.title} className="mb-1">
							<div className="gui-settings-nav-group">{group.title}</div>
							{group.items.map(item => (
								<button
									key={item.id}
									type="button"
									title={item.enabled ? item.label : `${item.label} · ${t("coming soon")}`}
									className={`gui-settings-nav${activeSection === item.id ? " gui-settings-nav--active" : ""}${!item.enabled ? " gui-settings-nav--disabled" : ""}`}
									onClick={() => {
										if (item.enabled) onSelect(item.id as SectionRequest);
									}}
								>
									<Icon name={item.icon} className="h-4 w-4" />
									<span className="gui-settings-nav-label">{item.label}</span>
								</button>
							))}
						</div>
					))}
			</div>
			{/* Bottom: onboarding + announcements + daemon status (user-area slot). */}
			<div className="flex flex-col gap-0.5 border-t border-[var(--border)] px-2 py-2">
				<button
					type="button"
					className="gui-settings-nav"
					onClick={() => window.dispatchEvent(new CustomEvent("musepi-open-onboarding"))}
				>
					<Icon name="rocket" className="h-4 w-4" />
					<span className="gui-settings-nav-label">{t("onboarding")}</span>
				</button>
				<button
					type="button"
					className="gui-settings-nav"
					onClick={() => window.dispatchEvent(new CustomEvent("musepi-open-announcement"))}
				>
					<Icon name="sparkling" className="h-4 w-4" />
					<span className="gui-settings-nav-label">{t("what's new")}</span>
				</button>
			</div>
		</nav>
	);
}
