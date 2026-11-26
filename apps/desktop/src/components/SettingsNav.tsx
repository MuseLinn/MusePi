import { SearchField, t, tLoose } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECTION_ALIAS, type SectionId, type SectionRequest } from "../lib/settings-nav";
import { matchSettingRows, type SettingSearchRow } from "../lib/settings-search";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";
import { iconSpriteData } from "../vendor/oc-icons/sprite";
import { MenuPopup } from "./MenuPopup";

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
	/** Owner-provided search terms (settings.section keywords); additive to
	 *  SECTION_SEARCH_TERMS. */
	keywords?: readonly string[];
	/** Owner-provided nav position (settings.section `order`). */
	order?: number;
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
		"休眠",
		"合盖",
		"开盖",
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
	"session-memory": [
		"会话",
		"session",
		"恢复",
		"resume",
		"归档",
		"archive",
		"历史",
		"history",
		"标题",
		"title",
		"输入框",
		"composer",
		"input",
		"粘贴",
		"paste",
		"图片",
		"image",
		"提及",
		"mention",
		"@",
		"消息",
		"message",
		"浏览",
		"browse",
		"记忆",
		"memory",
		"上下文",
		"context",
		"摘要",
		"summary",
		"向量",
		"vector",
		"嵌入",
		"embed",
		"提示词",
		"suggestion",
		"预设",
		"preset",
		"快捷",
		"chip",
		"starter",
		"建议",
		"prompt",
	],
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
	connectors: ["连接器", "connector", "市场", "market", "oauth", "授权", "远端", "remote", "mcp"],
	secrets: [
		"保险库",
		"vault",
		"密钥",
		"secret",
		"secrets",
		"key",
		"api key",
		"token",
		"password",
		"密码",
		"login",
		"登录",
		"凭证",
		"环境变量",
		"env",
		"加密",
		"encrypted",
	],
	commands: ["命令", "command", "slash", "斜杠", "自定义", "custom", "快捷", "quick"],
	hooks: ["钩子", "hook", "事件", "event", "触发", "trigger", "toml", "脚本", "script"],
	browser: [
		"浏览器",
		"browser",
		"网页",
		"web",
		"受管",
		"managed",
		"代理",
		"proxy",
		"截图",
		"screenshot",
		"扩展",
		"extension",
		"relay",
		"中继",
		"chrome",
		"密码",
		"password",
		"cookie",
		"导入",
		"import",
		"下载",
		"download",
	],
	modes: ["预设", "模式", "mode", "preset", "profile", "角色", "role", "work", "design"],
	indexes: ["索引", "index", "库", "代码库", "搜索", "search", "扫描", "scan", "cwd", "工作区"],
	usage: ["统计", "usage", "用量", "成本", "cost", "token", "模型", "model", "月度", "monthly"],
};

/** Nav ids whose page body ships as a plugin contribution only. The host keeps
 *  no fallback renderer, so the row is gated on a contribution claiming it —
 *  but only once the contribution list is KNOWN: before the registry answers,
 *  every page would look unclaimed and the whole nav would blink empty. */
const PLUGIN_OWNED_SECTIONS: ReadonlySet<string> = new Set([
	"secrets",
	"hooks",
	"commands",
	"shortcuts",
	"notifications",
	"usage",
	"general",
	"appearance",
	"files",
	"model",
	"context",
	"shell",
	"tools",
	"indexes",
	"pet",
	"migration",
]);

/** ZCode-style grouped navigation: 基础设置 / 智能体 / 数据与统计. The
 * openchamber-parity tabs (chat / notifications / sessions / shortcuts /
 * agents) are backed by live settings; hooks (extensions RPC), 索引库
 * (session.search) and 使用统计 (packages/stats) complete the capability
 * groups. Evaluated at render so the labels follow locale switches (a
 * module-level const would freeze the first locale's strings). */
export function navGroups(
	extTabs: ReadonlyArray<{
		id?: string;
		label?: string;
		icon?: string;
		order?: number;
		keywords?: readonly string[];
		code?: string;
		url?: string;
		error?: string;
	}>,
	/** Whether `extTabs` is the complete answer. Callers that always have the
	 *  full list (static rosters) omit it; a live registry passes false while
	 *  the first read is still in flight. */
	options: { contributionsKnown?: boolean } = {},
): { title: string; items: SectionDef[] }[] {
	const groups: { title: string; items: SectionDef[] }[] = [
		{
			title: t("settings.basicSettings"),
			items: [
				{ id: "general", icon: "settings-3", label: t("settings.general2"), enabled: true },
				{ id: "appearance", icon: "palette", label: t("settings.appearance"), enabled: true },
				{ id: "notifications", icon: "notification-3", label: t("settings.notificationsSound"), enabled: true },
				{ id: "pet", icon: "robot-2", label: t("settings.agentCompanion"), enabled: true },
				{ id: "session-memory", icon: "brain", label: t("settings.sessionMemory"), enabled: true },
				{ id: "git", icon: "git-branch", label: t("general.gitSettings"), enabled: true },
				{ id: "shortcuts", icon: "command", label: t("general.shortcuts"), enabled: true },
				{ id: "model", icon: "ai-agent", label: t("settings.modelSettings"), enabled: true },
				{ id: "interaction", icon: "shuffle", label: t("settings.interaction"), enabled: true },
				{ id: "voice", icon: "mic", label: tLoose("voice settings"), enabled: true },
				{ id: "context", icon: "stack", label: t("settings.context"), enabled: true },
				{ id: "shell", icon: "terminal-window", label: t("settings.shell"), enabled: true },
				{ id: "tools", icon: "plug-2", label: t("settings.tools"), enabled: true },
				{ id: "media", icon: "image-download", label: t("settings.imageVideoGeneration"), enabled: true },
				{ id: "files", icon: "file-text", label: t("general.filesLsp"), enabled: true },
			],
		},
		{
			title: t("settings.agentCapabilities"),
			items: [
				{ id: "skills", icon: "sparkling", label: t("tools.extensionsPlugins"), enabled: true },
				{ id: "subagents", icon: "user", label: t("settings.tasksSubagents"), enabled: true },
				{ id: "connectors", icon: "plug", label: t("settings.connectors"), enabled: true },
				{ id: "secrets", icon: "key", label: t("settings.secrets"), enabled: true },
				{ id: "commands", icon: "terminal-box", label: t("settings.commands"), enabled: true },
				{ id: "hooks", icon: "node-tree", label: t("settings.hooks"), enabled: true },
				{ id: "modes", icon: "stack", label: t("settings.modesTitle"), enabled: true },
				{ id: "browser", icon: "compass-3", label: t("settings.browser"), enabled: true },
			],
		},
		{
			title: t("settings.dataStatistics"),
			items: [
				{ id: "indexes", icon: "book", label: t("settings.indexLibrary"), enabled: true },
				{ id: "usage", icon: "star", label: t("settings.usageStatistics"), enabled: true },
				{ id: "migration", icon: "download", label: t("settings.dataMigration"), enabled: true },
			],
		},
	];
	// 内核级 slot(P1):`settings.section` 的每个条目挂为左侧导航项 ——
	// 扩展声明一个设置页即出现在导航，条目自带 id/label/icon/order/keywords。
	// 配置项级贡献走 registerSetting 的 ui.tab(插入现有 tab)或
	// settings.item 卡片(扩展中心),不设"扩展设置"聚合 tab。
	// Pages whose content is entirely plugin-owned: the host keeps no renderer
	// for them, so a missing contribution would open a blank page. Their row
	// exists only while a contribution claims it (a compile failure retracts
	// it, like a missing plugin).
	if (options.contributionsKnown !== false) {
		const claimed = new Set(extTabs.filter(c => c.id && !c.error).map(c => c.id as string));
		for (const group of groups) {
			group.items = group.items.filter(item => !PLUGIN_OWNED_SECTIONS.has(item.id) || claimed.has(item.id));
		}
	}
	// A page whose id names an existing page TAKES IT OVER: the built-in row
	// (and its id, keywords and deep links) stays, and the extension does not
	// add a second row. Only genuinely new pages get an `ext:` row.
	const builtinIds = new Set(groups.flatMap(group => group.items.map(item => item.id)));
	const iconOf = (name: string | undefined): IconName | undefined =>
		name && name in iconSpriteData ? (name as IconName) : undefined;
	const overrides = new Map<
		string,
		{ label?: string; icon?: IconName; order?: number; keywords?: readonly string[] }
	>();
	for (const c of extTabs) {
		const sectionId = c.id;
		if (!sectionId) continue;
		// A slot may name a capability alias (sessions / memory → session-memory);
		// resolve it before deciding whether it takes over a built-in page.
		const pageId = (SECTION_ALIAS as Record<string, string | undefined>)[sectionId] ?? sectionId;
		// An alias names a sub-page of a composite page (sessions/memory inside
		// 会话与记忆): the composite owns its label and position, so only a slot
		// whose id IS the page id may rewrite the nav identity.
		const direct = pageId === sectionId;
		if (builtinIds.has(pageId)) {
			if (!direct) continue;
			overrides.set(pageId, {
				...(c.label ? { label: c.label } : {}),
				...(iconOf(c.icon) ? { icon: iconOf(c.icon) } : {}),
				...(c.order !== undefined ? { order: c.order } : {}),
				...(c.keywords && c.keywords.length > 0 ? { keywords: c.keywords } : {}),
			});
			continue;
		}
		groups[1]!.items.push({
			id: `ext:${sectionId}`,
			icon: iconOf(c.icon) ?? "plug",
			label: c.label ?? sectionId,
			enabled: true,
			...(c.order !== undefined ? { order: c.order } : {}),
			...(c.keywords && c.keywords.length > 0 ? { keywords: c.keywords } : {}),
		});
	}
	// Owner options project onto the built-in row (label/icon/keywords); an
	// explicit order positions the row inside its group, rows without one keep
	// their built-in position (1000 + index).
	if (overrides.size > 0) {
		for (const group of groups) {
			group.items = group.items.map((item, index) => {
				const override = overrides.get(item.id);
				return {
					...item,
					...(override?.label ? { label: override.label } : {}),
					...(override?.icon ? { icon: override.icon } : {}),
					...(override?.keywords ? { keywords: override.keywords } : {}),
					order: override?.order ?? index,
				};
			});
			group.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		}
	}
	return groups;
}

/** Live filter over the nav groups: a group survives when the query hits an
 *  item's label or one of its keyword entries (see SECTION_SEARCH_TERMS).
 *  Shared by the inline search box and the collapsed-mode floating panel so
 *  both surfaces rank sections identically. */
function filterNavGroups(
	groups: { title: string; items: SectionDef[] }[],
	query: string,
): { title: string; items: SectionDef[] }[] {
	const q = query.trim().toLowerCase();
	if (!q) return groups;
	return groups
		.map(group => ({
			...group,
			items: group.items.filter(item => {
				if (item.label.toLowerCase().includes(q)) return true;
				// Extension rows carry `ext:<id>`; search the underlying section id so
				// a replaced page keeps the built-in keywords.
				const termsKey = item.id.startsWith("ext:") ? (item.id.slice(4).split(".").pop() ?? item.id) : item.id;
				const terms = [...(SECTION_SEARCH_TERMS[termsKey] ?? []), ...(item.keywords ?? [])];
				return terms.some(k => k.includes(q) || q.includes(k));
			}),
		}))
		.filter(group => group.items.length > 0);
}

/** Mirrors the ≤900px icon-rail media query in gui-settings.css so the
 *  component can swap the inline search box for a floating panel without
 *  relying on CSS-only state (:focus-within was fragile — a click on the
 *  icon button did not reliably focus the hidden input). */
function useCollapsedNav(): boolean {
	const [mq] = useState(() =>
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(max-width: 900px)")
			: null,
	);
	const [collapsed, setCollapsed] = useState(() => mq?.matches ?? false);
	useEffect(() => {
		if (!mq) return;
		const onChange = () => setCollapsed(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [mq]);
	return collapsed;
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
	settingsRows,
	onSelectRow,
	contributionsKnown = true,
}: {
	extTabs: ReadonlyArray<{
		slot: string;
		label?: string;
		icon?: string;
		order?: number;
		keywords?: readonly string[];
	}>;
	/** The section SettingsView currently renders — drives the highlight. */
	activeSection: SectionId | string;
	onSelect(id: SectionRequest): void;
	onBack(): void;
	/** Search box value; filters rows by label + section keywords. */
	query: string;
	onQueryChange(query: string): void;
	/** Cross-page schema index: lets the search find a setting by its label
	 *  and jump to the page that renders it. */
	settingsRows?: readonly SettingSearchRow[];
	onSelectRow?(section: string, key: string): void;
	/** False while the contribution list is still loading: plugin-owned pages
	 *  keep their rows until the answer is known. */
	contributionsKnown?: boolean;
}): ReactNode {
	const groups = navGroups(extTabs, { contributionsKnown });
	const sectionLabels = new Map(groups.flatMap(group => group.items.map(item => [item.id, item.label] as const)));
	const pageLabel = (section: string): string => sectionLabels.get(section) ?? section;
	const settingMatches = matchSettingRows(settingsRows ?? [], query);
	const collapsedNav = useCollapsedNav();
	const [searchOpen, setSearchOpen] = useState(false);
	const searchFabRef = useRef<HTMLButtonElement | null>(null);
	const wasCollapsed = useRef(collapsedNav);
	const navRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(navRef);
	const closeSearch = useCallback(() => {
		setSearchOpen(false);
		onQueryChange("");
		searchFabRef.current?.focus();
	}, [onQueryChange]);
	useEffect(() => {
		if (wasCollapsed.current === collapsedNav) return;
		wasCollapsed.current = collapsedNav;
		closeSearch();
	}, [collapsedNav, closeSearch]);
	useEffect(() => {
		if (!searchOpen) return;
		const close = (): void => closeSearch();
		window.addEventListener("resize", close);
		return () => window.removeEventListener("resize", close);
	}, [searchOpen, closeSearch]);
	return (
		<nav
			className="gui-settings-nav-col flex h-full w-full flex-shrink-0 flex-col overflow-hidden"
			data-gui-window-drag="off"
		>
			<div className="gui-settings-nav-head">
				<button type="button" className="gui-settings-back" onClick={onBack}>
					<Icon name="arrow-left-s" className="h-4 w-4" />
					<span className="gui-settings-back-label">{t("settings.backWorkspace")}</span>
				</button>
			</div>
			{collapsedNav ? (
				<div className="gui-settings-search-slot">
					<button
						ref={searchFabRef}
						type="button"
						className="gui-settings-search-fab"
						title={t("settings.searchSettings")}
						aria-label={t("settings.searchSettings")}
						aria-expanded={searchOpen}
						aria-controls="gui-settings-search-pop"
						onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
					>
						<Icon name="search" className="h-4 w-4" />
					</button>
					<MenuPopup
						open={searchOpen}
						className="gui-settings-search-popup"
						anchor={searchFabRef.current}
						onOpenChange={open => (open ? setSearchOpen(true) : closeSearch())}
					>
						<div
							id="gui-settings-search-pop"
							className="gui-settings-search-pop"
							role="dialog"
							aria-label={t("settings.searchSettings")}
						>
							<div className="gui-settings-search-pop-input">
								{/* eslint-disable-next-line jsx-a11y/no-autofocus -- explicit search-button activation continues into the field. */}
								<SearchField
									size="compact"
									value={query}
									onChange={onQueryChange}
									placeholder={t("settings.searchSettings")}
									autoFocus
									onKeyDown={e => {
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											closeSearch();
										}
									}}
									trailing={
										query && (
											<button
												type="button"
												className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
												onClick={() => onQueryChange("")}
												title={t("settings.clear")}
												aria-label={t("settings.clear")}
											>
												<Icon name="close" className="h-3 w-3" />
											</button>
										)
									}
								/>
							</div>
							<div className="gui-settings-search-pop-results">
								{filterNavGroups(groups, query).map(group => (
									<div key={group.title} className="mb-0.5">
										<div className="gui-settings-search-pop-group">{group.title}</div>
										{group.items.map(item => (
											<button
												key={item.id}
												type="button"
												className="gui-settings-search-pop-item"
												onClick={() => {
													onSelect(item.id as SectionRequest);
													closeSearch();
												}}
											>
												<Icon name={item.icon} className="h-4 w-4 flex-none" />
												<span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
											</button>
										))}
									</div>
								))}
								{query.trim() && filterNavGroups(groups, query).length === 0 && (
									<div className="gui-settings-search-pop-empty">{t("general.noResults")}</div>
								)}
							</div>
						</div>
					</MenuPopup>
				</div>
			) : (
				<SearchField
					className="gui-settings-search"
					size="compact"
					value={query}
					onChange={onQueryChange}
					placeholder={t("settings.searchSettings")}
					trailing={
						query && (
							<button
								type="button"
								className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
								onClick={() => onQueryChange("")}
								title={t("settings.clear")}
								aria-label={t("settings.clear")}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						)
					}
				/>
			)}
			<div ref={navRef} className="gui-settings-nav-scroll" data-top-scroll="false" data-bottom-scroll="false">
				{!collapsedNav && settingMatches.length > 0 && (
					<div className="gui-settings-nav-matches">
						<div className="gui-settings-nav-group">{t("settings.matchingSettings")}</div>
						{settingMatches.map(row => (
							<button
								key={row.key}
								type="button"
								className="gui-settings-nav gui-settings-nav--setting"
								title={`${pageLabel(row.section)}${row.group ? ` · ${tLoose(row.group)}` : ""}`}
								onClick={() => {
									onSelectRow?.(row.section, row.key);
									onQueryChange("");
								}}
							>
								<Icon name="settings-3" className="h-4 w-4 flex-none" />
								<span className="gui-settings-nav-label truncate">{tLoose(row.label)}</span>
							</button>
						))}
					</div>
				)}
				{filterNavGroups(groups, collapsedNav ? "" : query).map(group => (
					<div key={group.title} className="mb-1">
						<div className="gui-settings-nav-group">{group.title}</div>
						{group.items.map(item => (
							<button
								key={item.id}
								type="button"
								title={item.enabled ? item.label : `${item.label} · ${t("settings.comingSoon")}`}
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
					title={t("settings.onboarding")}
					aria-label={t("settings.onboarding")}
					onClick={() => window.dispatchEvent(new CustomEvent("musepi-open-onboarding"))}
				>
					<Icon name="rocket" className="h-4 w-4" />
					<span className="gui-settings-nav-label">{t("settings.onboarding")}</span>
				</button>
				<button
					type="button"
					className="gui-settings-nav"
					title={t("settings.whatSNew")}
					aria-label={t("settings.whatSNew")}
					onClick={() => window.dispatchEvent(new CustomEvent("musepi-open-announcement"))}
				>
					<Icon name="sparkling" className="h-4 w-4" />
					<span className="gui-settings-nav-label">{t("settings.whatSNew")}</span>
				</button>
			</div>
		</nav>
	);
}
