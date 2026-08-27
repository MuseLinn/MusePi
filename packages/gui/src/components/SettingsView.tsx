import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import {
	SETTINGS_ACTION_SLOT_PREFIX,
	SETTINGS_TAB_SLOT_PREFIX,
	SlotComponentMount,
	useSlotComponentsByPrefix,
} from "../lib/slot-host";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";
import { HeightMorph } from "./HeightMorph";
import { MigrationSection } from "./MigrationSection";

type SectionId =
	| "general"
	| "appearance"
	| "model"
	| "files"
	| "memory"
	| "notifications"
	| "pet"
	| "sessions"
	| "git"
	| "shortcuts"
	| "interaction"
	| "voice"
	| "context"
	| "shell"
	| "tools"
	| "providers"
	| "plugins"
	| "skills"
	| "subagents"
	| "commands"
	| "mcp"
	| "hooks"
	| "indexes"
	| "usage"
	| "migration"
	| "history"
	| "browser"
	| "suggestions"
	| "modes";

/** Conditional settings fields animate in/out per the shared standard —
 * see components/Reveal.tsx (useCollapse px height + outer fade). */

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
function navGroups(extTabs: ReadonlyArray<{ slot: string; label?: string }>): { title: string; items: SectionDef[] }[] {
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

interface ProviderInfo {
	id: string;
	name: string;
	available: boolean;
	storeCredentialsAs?: string;
	loggedIn: boolean;
}

/** Wire shape of one API-key provider row (daemon providers.list → api). */
interface ApiProviderInfo {
	id: string;
	name: string;
	modelCount: number;
	models: string[];
	configured: boolean;
}

interface CustomProvider {
	name: string;
	models: { id: string; name?: string }[];
}

/** Thinking levels storable as a role-selector suffix (TUI
 * formatModelSelectorValue parity: `provider/model:id:level`). */
/**
 * Full-window settings view (ZCode-style, not a modal): grouped category
 * tree on the left with the same width as the main sidebar (collapses to an
 * icon rail on narrow windows), content on the right, back-to-workspace in
 * the top bar. The model section is the real credential manager: provider
 * login/logout runs the daemon's OAuth flow and custom OpenAI-compatible
 * providers are written to models.yml.
 */
export function SettingsView({
	rpc,
	sessionId,
	providerEvent,
	onBack,
	initialSection,
	onOpenSession,
	onCreateChat,
	cwd,
}: {
	rpc: RpcClient | null;
	sessionId: string | null;
	providerEvent: StreamEvent | null;
	onBack(): void;
	/** Section to land on when the pane opens (sidebar 技能 entry). */
	initialSection?: SectionId;
	/** Open a session from the 索引库 search results (app layer owns openSession). */
	onOpenSession?: (sessionId: string) => void;
	/** DSH creation-flow entry: settings preset 新建 sends a natural-language
	 *  description to a Creator session that designs & saves the preset. */
	onCreateChat?: (text: string) => void;
	/** Active session's workspace dir — the 代码库 index scans this. */
	cwd?: string | null;
}): ReactNode {
	const [section, setSection] = useState<SectionId | string>(initialSection ?? "appearance");
	// 内核级 slot(P1):`settings.tab.<id>` 槽位组件自动挂载为设置页导航项
	// (扩展声明即出现——设置面板=宿主壳,内容由插件贡献)。
	const extSettingsTabs = useSlotComponentsByPrefix(rpc, SETTINGS_TAB_SLOT_PREFIX);
	// 单行偏好槽:settings.action.<id> 组件。
	const actionItems = useSlotComponentsByPrefix(rpc, SETTINGS_ACTION_SLOT_PREFIX);
	// Fixed settings search: filters the nav by section label (live).
	const [settingsQuery, setSettingsQuery] = useState("");
	// Settings search highlight: with an active query, imperatively mark the
	// matching setting rows inside the content area (.gui-settings-field for
	// hand-written sections, .gui-settings-row for schema-driven ones) and
	// scroll the first match into view — once per new query and once per
	// section switch, so further typing never re-scrolls and the pane can't
	// jitter. The class is applied outside React, keeping every section
	// component unaware of the search state.
	const prevSearchRef = useRef<{ q: string; section: SectionId | string }>({
		q: "",
		section: section ?? "appearance",
	});
	useEffect(() => {
		const content = settingsContentRef.current;
		if (!content) return;
		const q = settingsQuery.trim().toLowerCase();
		content.querySelectorAll<HTMLElement>(".gui-settings-match").forEach(el => {
			el.classList.remove("gui-settings-match");
		});
		if (!q) return;
		const rows = Array.from(content.querySelectorAll<HTMLElement>(".gui-settings-field, .gui-settings-row")).filter(
			row => !row.closest("[aria-hidden='true'], [inert]") && (row.textContent ?? "").toLowerCase().includes(q),
		);
		rows.forEach(el => {
			el.classList.add("gui-settings-match");
		});
		const prev = prevSearchRef.current;
		const scroll = q !== prev.q || section !== prev.section;
		prevSearchRef.current = { q, section };
		if (scroll && rows.length > 0) rows[0].scrollIntoView({ block: "center", behavior: "smooth" });
	}, [settingsQuery, section]);
	const [showAvatars, setShowAvatars] = useState(() => localStorage.getItem("musepi-gui-avatars") !== "0");
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [apiProviders, setApiProviders] = useState<ApiProviderInfo[]>([]);
	const [custom, setCustom] = useState<CustomProvider[]>([]);
	const [loginState, setLoginState] = useState<{
		providerId: string;
		url?: string;
		launchUrl?: string;
		instructions?: string;
		message?: string;
		waitingInput?: boolean;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	// Provider ids whose OAuth/API login is in flight. Kept per-provider so a
	// pending login only disables THAT provider's buttons; the global `busy`
	// flag alone froze every login button for the whole OAuth wait (user
	// report: "设置界面的模型登录按钮有时点击没反应").
	const [pendingLogins, setPendingLogins] = useState<string[]>([]);
	// Ref-count of in-flight logins (ref, not state): the `finally` runs after
	// an await, so reading `pendingLogins` there sees the render-time snapshot
	// — a stale-closure bug for concurrent logins. `busy` is derived from this
	// counter instead.
	const pendingLoginCount = useRef(0);
	// Content-boundary feather (transcript parity): the nav column and the
	// section content both scroll inside the settings surface — the shared
	// hook flips their data-top-scroll / data-bottom-scroll mask attrs.
	const settingsNavRef = useRef<HTMLDivElement | null>(null);
	const settingsContentRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(settingsNavRef);
	useScrollShadow(settingsContentRef);

	const loadProviders = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const raw = (await rpc.request<unknown>("providers.list", {
				sessionId: sessionId ?? undefined,
			})) as { oauth?: unknown; api?: unknown } | ProviderInfo[] | null;
			// Pre-{oauth,api} daemons return the bare OAuth array — degrade
			// to the auth section only instead of crashing the page.
			if (Array.isArray(raw)) {
				setProviders(raw as ProviderInfo[]);
				setApiProviders([]);
			} else {
				setProviders(Array.isArray(raw?.oauth) ? (raw.oauth as ProviderInfo[]) : []);
				setApiProviders(Array.isArray(raw?.api) ? (raw.api as ApiProviderInfo[]) : []);
			}
			const cfg = await rpc.request<{
				providers?: Record<
					string,
					{
						models?: {
							id: string;
							name?: string;
							input?: string[];
							contextWindow?: number;
							maxTokens?: number;
						}[];
					}
				>;
			}>("models.listCustom", { sessionId: sessionId ?? undefined });
			setCustom(
				Object.entries(cfg?.providers ?? {}).map(([name, v]) => ({
					name,
					models: Array.isArray(v?.models) ? v.models : [],
				})),
			);
		} catch {
			setProviders([]);
		}
	}, [rpc, sessionId]);

	useEffect(() => {
		void loadProviders();
	}, [loadProviders]);

	// Provider auth/prompt envelopes drive the inline login panel.
	useEffect(() => {
		if (!providerEvent) return;
		const p = providerEvent.payload as {
			providerId?: string;
			url?: string;
			launchUrl?: string;
			instructions?: string;
			message?: string;
			placeholder?: string;
		};
		if (providerEvent.kind === "provider-auth") {
			setLoginState({
				providerId: p.providerId ?? "",
				url: p.url,
				...(p.launchUrl ? { launchUrl: p.launchUrl } : {}),
				...(p.instructions ? { instructions: p.instructions } : {}),
				...(p.message ? { message: p.message } : {}),
			});
		} else if (providerEvent.kind === "provider-prompt") {
			setLoginState(s => ({
				providerId: p.providerId ?? s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(s?.message ? { message: s.message } : {}),
				waitingInput: true,
			}));
		} else if (providerEvent.kind === "provider-progress") {
			setLoginState(s => ({
				providerId: s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(p.message ? { message: p.message } : {}),
				...(s?.waitingInput ? { waitingInput: true } : {}),
			}));
		}
	}, [providerEvent]);

	const login = async (providerId: string): Promise<void> => {
		// The daemon's providers.login only needs providerId — a session is
		// NOT required. The old `!sessionId` guard silently swallowed clicks
		// from the settings page opened without an active session.
		if (!rpc) return;
		setBusy(true);
		pendingLoginCount.current += 1;
		setPendingLogins(p => (p.includes(providerId) ? p : [...p, providerId]));
		setLoginState({ providerId });
		try {
			const result = await rpc.request<{ ok: boolean }>("providers.login", { sessionId, providerId });
			if (result?.ok) {
				// Only clear the login panel if THIS provider's flow is still
				// the one being shown (a later login may have taken the spot).
				setLoginState(s => (s?.providerId === providerId ? null : s));
				await loadProviders();
			}
		} catch (err) {
			setLoginState(s =>
				s?.providerId === providerId
					? { providerId, message: err instanceof Error ? err.message : String(err) }
					: s,
			);
		} finally {
			setPendingLogins(p => p.filter(x => x !== providerId));
			pendingLoginCount.current = Math.max(0, pendingLoginCount.current - 1);
			if (pendingLoginCount.current === 0) setBusy(false);
		}
	};

	const submitLoginInput = async (value: string): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await rpc.request("providers.loginInput", { providerId: loginState.providerId, value });
			setLoginState(s => (s ? { ...s, waitingInput: false } : s));
		} catch {
			// daemon rejects — keep the input open
		}
	};

	const cancelLogin = async (): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await rpc.request("providers.loginCancel", { providerId: loginState.providerId });
		} catch {
			// ignore
		}
		setLoginState(null);
	};

	const logout = async (providerId: string): Promise<void> => {
		if (!rpc || !sessionId) return;
		try {
			await rpc.request("providers.logout", { sessionId, providerId });
			await loadProviders();
		} catch (err) {
			setLoginState({ providerId, message: err instanceof Error ? err.message : String(err) });
		}
	};

	return (
		<div className="gui-settings-view">
			{/* Window drag strip (main-UI parity): long-press/drag the top band
			 * to move the window; the nav/surface below stay interactive. */}
			<div className="gui-settings-drag" aria-hidden />
			<div className="flex min-h-0 flex-1">
				{/* Left navigation panel — mirrors the main sidebar: the back
				 * button sits in a header row at the top of the nav column,
				 * the grouped NAV_GROUPS scroll below it. */}
				<nav className="gui-settings-nav-col flex w-64 flex-shrink-0 flex-col overflow-hidden">
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
							value={settingsQuery}
							onChange={e => setSettingsQuery(e.target.value)}
							placeholder={t("search settings…")}
							aria-label={t("search settings…")}
						/>
						{settingsQuery && (
							<button
								type="button"
								className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
								onClick={() => setSettingsQuery("")}
								title={t("clear")}
								aria-label={t("clear")}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						)}
					</div>
					<div
						ref={settingsNavRef}
						className="gui-settings-nav-scroll"
						data-top-scroll="false"
						data-bottom-scroll="false"
					>
						{navGroups(extSettingsTabs)
							.map(group => ({
								...group,
								items: settingsQuery.trim()
									? group.items.filter(item => {
											const q = settingsQuery.trim().toLowerCase();
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
											className={`gui-settings-nav${section === item.id ? " gui-settings-nav--active" : ""}${!item.enabled ? " gui-settings-nav--disabled" : ""}`}
											onClick={() => {
												if (item.enabled) setSection(item.id as SectionId | string);
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
							onClick={() => window.dispatchEvent(new CustomEvent("omp-open-onboarding"))}
						>
							<Icon name="rocket" className="h-4 w-4" />
							<span className="gui-settings-nav-label">{t("onboarding")}</span>
						</button>
						<button
							type="button"
							className="gui-settings-nav"
							onClick={() => window.dispatchEvent(new CustomEvent("omp-open-announcement"))}
						>
							<Icon name="sparkling" className="h-4 w-4" />
							<span className="gui-settings-nav-label">{t("what's new")}</span>
						</button>
					</div>
				</nav>
				{/* Right column: the detail card floats over the same glassy
				 * backdrop as the nav (chat-surface parity; no divider line). */}
				<div className="gui-settings-main">
					<div className="gui-settings-surface">
						{/* Section switch: HeightMorph in a fixed-height scroll
						 * container animates nothing (height is constant), but
						 * the keyed inner supplies the standard 160ms fade-in
						 * instead of an abrupt content swap. */}
						<HeightMorph
							morphKey={section}
							innerRef={settingsContentRef}
							className={`gui-settings-content${
								section === "history" || section === "model" ? " gui-settings-content--fill" : ""
							}`}
						>
							{section === "general" && (
								<>
									<GeneralSection rpc={rpc} />
									{/* 单行偏好槽:settings.action.<id> 组件挂到通用分区末尾 —— 功能插件
									 * 贡献单行偏好,无需整 tab/整卡。 */}
									{actionItems.length > 0 && (
										<div className="gui-settings-row">
											{actionItems.map(item => (
												<SlotComponentMount
													key={`${item.slot}:${item.extensionId}`}
													item={item}
													rpc={rpc}
												/>
											))}
										</div>
									)}
								</>
							)}
							{section === "appearance" && (
								<AppearanceSection
									rpc={rpc}
									showAvatars={showAvatars}
									onToggleAvatars={() => {
										const next = !showAvatars;
										localStorage.setItem("musepi-gui-avatars", next ? "1" : "0");
										setShowAvatars(next);
									}}
								/>
							)}
							{section === "model" && (
								<ModelSection
									providers={providers}
									apiProviders={apiProviders}
									custom={custom}
									loginState={loginState}
									busy={busy}
									pendingLogins={pendingLogins}
									onLogin={login}
									onLogout={logout}
									onSubmitInput={submitLoginInput}
									onCancelLogin={cancelLogin}
									onChanged={loadProviders}
									rpc={rpc}
									sessionId={sessionId}
								/>
							)}
							{section === "notifications" && <NotificationsSection rpc={rpc} />}
							{section === "pet" && <PetSection />}
							{section === "sessions" && <SessionsSection rpc={rpc} currentSessionId={sessionId} />}
							{section === "git" && <GitSection rpc={rpc} />}
							{section === "shortcuts" && <ShortcutsSection />}
							{section === "interaction" && <InteractionSection rpc={rpc} />}
							{section === "voice" && <VoiceSection rpc={rpc} />}
							{section === "context" && <ContextSection rpc={rpc} />}
							{section === "shell" && <ShellSection rpc={rpc} />}
							{section === "tools" && <ToolsSection rpc={rpc} />}
							{section === "files" && <FilesLspSection rpc={rpc} />}
							{section === "memory" && <MemorySection rpc={rpc} />}
							{section === "skills" && <SkillsSection rpc={rpc} />}
							{typeof section === "string" && section.startsWith("ext:")
								? (() => {
										const item = extSettingsTabs.find(x => `ext:${x.slot}` === section);
										return item ? (
											<div className="px-3 py-2">
												<SlotComponentMount item={item} rpc={rpc} />
											</div>
										) : null;
									})()
								: null}
							{section === "suggestions" && <PromptsSection />}
							{section === "modes" && <ModesSection rpc={rpc} onCreateChat={onCreateChat} />}
							{section === "migration" && <MigrationSection rpc={rpc} />}
							{section === "subagents" && <SubagentsSection rpc={rpc} />}
							{section === "commands" && <CommandsSection rpc={rpc} />}
							{section === "mcp" && <McpSection rpc={rpc} />}
							{section === "hooks" && <HooksSection rpc={rpc} />}
							{section === "browser" && <BrowserSection rpc={rpc} />}
							{section === "indexes" && <IndexesSection rpc={rpc} cwd={cwd} />}
							{section === "history" && <HistorySection rpc={rpc} onOpenSession={onOpenSession} />}
							{section === "usage" && <UsageSection rpc={rpc} />}
						</HeightMorph>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Accent preset → swatch color (display tints readable on both schemes;
 *  the tokens own the real values: brand = emerald #34d399). */
import {
	AppearanceSection,
	BrowserSection,
	CommandsSection,
	ContextSection,
	FilesLspSection,
	GeneralSection,
	GitSection,
	HistorySection,
	HooksSection,
	IndexesSection,
	InteractionSection,
	McpSection,
	MemorySection,
	ModelSection,
	ModesSection,
	NotificationsSection,
	PetSection,
	PromptsSection,
	SessionsSection,
	ShellSection,
	ShortcutsSection,
	SkillsSection,
	SubagentsSection,
	ToolsSection,
	UsageSection,
	VoiceSection,
} from "./settings-sections";
