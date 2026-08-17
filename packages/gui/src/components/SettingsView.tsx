import {
	CodeHighlightProvider,
	countGraphemes,
	DARK_THEME_PRESETS,
	DiffBlock,
	getLocaleSnapshot,
	graphemeSpans,
	highlightToCodeHtml,
	LIGHT_THEME_PRESETS,
	nextStep,
	renderMermaidHtml,
	STREAMING_REVEAL_FRAME_MS,
	setLocale,
	sliceGraphemes,
	subscribeLocale,
	TAIL_RENDERERS,
	type TranslationKey,
	t,
	type UiThemeId,
	UNIFIED_THEME_PRESETS,
	useAccentPreference,
	useThemePreference,
	useUiThemePreferences,
} from "@musepi/collab-web";
import type { SoundName } from "cuelume";
import { LoaderCircle as LoaderCircleIconData, RefreshCw as RefreshCwIconData } from "lucide";
import { Monitor as MonitorIcon, Moon as MoonIcon, Sun as SunIcon } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	applyCodeSize,
	applyCodeThemes,
	applyDensity,
	applyMonoFont,
	applyUiFont,
	CODE_FONT_OPTIONS,
	CODE_LINES_KEY,
	CODE_THEME_DARK_KEY,
	CODE_THEME_LIGHT_KEY,
	CODE_WRAP_KEY,
	type CodeTheme,
	DARK_CODE_THEMES,
	DEFAULT_CODE_FONT,
	DEFAULT_DARK_CODE_THEME,
	DEFAULT_LIGHT_CODE_THEME,
	DEFAULT_UI_FONT,
	DENSITY_KEY,
	EDITOR_FONT_KEY,
	LIGHT_CODE_THEMES,
	MONO_FONT_KEY,
	TIME_FMT_KEY,
	UI_FONT_KEY,
	UI_FONT_OPTIONS,
	WEEK_START_KEY,
} from "../lib/appearance";
import { openExternalUrl } from "../lib/electron";
import { applyGlassLevel, applyGlassMaterial, GLASS_MAX, GLASS_MIN, readGlassLevel } from "../lib/glass";
import { tapFeedback } from "../lib/haptic";
import { nativeHighlight, useChatHighlight } from "../lib/highlight";
import {
	defaultTemplate,
	eventEnabled,
	loadNotifyTemplates,
	NOTIFY_EVENTS,
	type NotifyEvent,
	type NotifyTemplates,
	notifyEnabled,
	notifyWhileFocused,
	saveEventPrefs,
	saveNotifyTemplates,
	sendTestNotification,
} from "../lib/notify";
import {
	BUILTIN_PETDEX,
	DEFAULT_PET_ID,
	loadPetdex,
	measurePetdex,
	PET_CONTENT_TARGET_H,
	PET_SCALE_MAX,
	PET_SCALE_MIN,
	PETDEX_COLUMNS,
	type PetDisplayMode,
	type PetdexPackage,
	petEnabled,
	petId,
	petMode,
	petScale,
	savePetdex,
	setPetScale,
} from "../lib/pet";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import {
	cleanupAction as cleanupActionPref,
	cleanupCandidates,
	cleanupDays as cleanupDaysPref,
	cleanupEnabled as cleanupEnabledPref,
	runCleanupOnce,
} from "../lib/session-cleanup";
import {
	ALL_SOUNDS,
	DEFAULT_SFX,
	previewSound,
	SFX_EVENTS,
	type SfxEvent,
	setSoundFor,
	soundFor,
	WIRED_SOUNDS,
} from "../lib/sfx";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { AVATAR_PRESETS, avatarPresetId } from "./avatar-presets";
import { ChromaGroup } from "./ChromaGroup";
import { ColorPickerPanel } from "./ColorPicker";
import { AgentStatusLine } from "./Composer";
import { DialogFrame } from "./DialogFrame";
import { DotMatrixMark } from "./DotMatrixMark";
import { ExtensionsCenter } from "./ExtensionsCenter";
import { HeightMorph } from "./HeightMorph";
import { ModelSelector } from "./ModelSelector";
import { BuiltinPetSprite, PetdexSprite } from "./PetSprite";
import { Pop } from "./Pop";
import { Reveal } from "./Reveal";
import { type SchemaItem, SchemaSettings } from "./SchemaSettings";
import { SpotlightCard } from "./SpotlightCard";
import {
	TURN_RAIL_CHANGED_EVENT,
	TURN_RAIL_SIDE_KEY,
	TURN_RAIL_STYLE_KEY,
	type TurnRailSide,
	type TurnRailStyle,
} from "./TurnRail";

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
	| "history"
	| "browser";

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
function navGroups(): { title: string; items: SectionDef[] }[] {
	return [
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
				{ id: "plugins", icon: "plug", label: t("plugins"), enabled: true },
				{ id: "skills", icon: "sparkling", label: t("extensions"), enabled: true },
				{ id: "subagents", icon: "user", label: t("tasks & subagents"), enabled: true },
				{ id: "mcp", icon: "server", label: t("mcp servers"), enabled: true },
				{ id: "commands", icon: "terminal-box", label: t("commands"), enabled: true },
				{ id: "hooks", icon: "node-tree", label: t("hooks"), enabled: true },
				{ id: "browser", icon: "compass-3", label: t("browser"), enabled: true },
			],
		},
		{
			title: t("data and statistics"),
			items: [
				{ id: "history", icon: "history", label: t("session history"), enabled: true },
				{ id: "indexes", icon: "book", label: t("index library"), enabled: true },
				{ id: "usage", icon: "star", label: t("usage statistics"), enabled: true },
			],
		},
	];
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

/** Cards per provider section before the "show all" expand (bitfun parity). */
const PROVIDER_COLLAPSE_LIMIT = 8;

/** Built-in role display tags (TUI config/model-roles MODEL_ROLES parity). */
const BUILTIN_ROLE_TAGS: Record<string, string> = {
	default: "DEFAULT",
	smol: "SMOL",
	slow: "SLOW",
	vision: "VISION",
	plan: "PLAN",
	designer: "DESIGNER",
	commit: "COMMIT",
	tiny: "TINY",
	task: "TASK",
	advisor: "ADVISOR",
};

/** Thinking levels storable as a role-selector suffix (TUI
 * formatModelSelectorValue parity: `provider/model:id:level`). */
const ROLE_THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Split `provider/model:id:level` into the bare selector + thinking level
 * (or null when no known level suffix is present). */
function splitRoleValue(value: string): { model: string; level: string | null } {
	const colon = value.lastIndexOf(":");
	if (colon > 0 && (ROLE_THINK_LEVELS as readonly string[]).includes(value.slice(colon + 1))) {
		return { model: value.slice(0, colon), level: value.slice(colon + 1) };
	}
	return { model: value, level: null };
}

/** Rebuild the selector with a thinking suffix ("inherit" strips it). */
function joinRoleValue(model: string, level: string | null): string {
	return level && level !== "inherit" ? `${model}:${level}` : model;
}

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
	/** Active session's workspace dir — the 代码库 index scans this. */
	cwd?: string | null;
}): ReactNode {
	const [section, setSection] = useState<SectionId>(initialSection ?? "appearance");
	// Fixed settings search: filters the nav by section label (live).
	const [settingsQuery, setSettingsQuery] = useState("");
	// Settings search highlight: with an active query, imperatively mark the
	// matching setting rows inside the content area (.gui-settings-field for
	// hand-written sections, .gui-settings-row for schema-driven ones) and
	// scroll the first match into view — once per new query and once per
	// section switch, so further typing never re-scrolls and the pane can't
	// jitter. The class is applied outside React, keeping every section
	// component unaware of the search state.
	const prevSearchRef = useRef<{ q: string; section: SectionId }>({ q: "", section: section ?? "appearance" });
	useEffect(() => {
		const content = settingsContentRef.current;
		if (!content) return;
		const q = settingsQuery.trim().toLowerCase();
		content
			.querySelectorAll<HTMLElement>(".gui-settings-match")
			.forEach(el => el.classList.remove("gui-settings-match"));
		if (!q) return;
		const rows = Array.from(content.querySelectorAll<HTMLElement>(".gui-settings-field, .gui-settings-row")).filter(
			row => !row.closest("[aria-hidden='true'], [inert]") && (row.textContent ?? "").toLowerCase().includes(q),
		);
		rows.forEach(el => el.classList.add("gui-settings-match"));
		const prev = prevSearchRef.current;
		const scroll = q !== prev.q || section !== prev.section;
		prevSearchRef.current = { q, section };
		if (scroll && rows.length > 0) rows[0].scrollIntoView({ block: "center", behavior: "smooth" });
	}, [settingsQuery, section]);
	const [showAvatars, setShowAvatars] = useState(() => localStorage.getItem("omp-gui-avatars") !== "0");
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
			const cfg = await rpc.request<{ providers?: Record<string, { models?: { id: string; name?: string }[] }> }>(
				"models.listCustom",
				{ sessionId: sessionId ?? undefined },
			);
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
		setLoginState({ providerId });
		try {
			const result = await rpc.request<{ ok: boolean }>("providers.login", { sessionId, providerId });
			if (result?.ok) {
				setLoginState(null);
				await loadProviders();
			}
		} catch (err) {
			setLoginState({ providerId, message: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
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
						{navGroups()
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
												if (item.enabled) setSection(item.id as SectionId);
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
							className={`gui-settings-content${section === "history" ? " gui-settings-content--fill" : ""}`}
						>
							{section === "general" && <GeneralSection rpc={rpc} />}
							{section === "appearance" && (
								<AppearanceSection
									rpc={rpc}
									showAvatars={showAvatars}
									onToggleAvatars={() => {
										const next = !showAvatars;
										localStorage.setItem("omp-gui-avatars", next ? "1" : "0");
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
							{section === "context" && <ContextSection rpc={rpc} />}
							{section === "shell" && <ShellSection rpc={rpc} />}
							{section === "tools" && <ToolsSection rpc={rpc} />}
							{section === "files" && <FilesLspSection rpc={rpc} />}
							{section === "memory" && <MemorySection rpc={rpc} />}
							{section === "plugins" && <PluginsSection rpc={rpc} />}
							{section === "skills" && <SkillsSection rpc={rpc} />}
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
const ACCENT_SWATCH: Record<string, string> = {
	brand: "#34d399",
	mono: "#8a8a93",
	ocean: "#38bdf8",
	jade: "#44b782",
};

/** Accent preset → localized name (swatch tooltip/aria). */
const ACCENT_NAMES: Record<string, TranslationKey> = {
	brand: "accent brand",
	mono: "accent mono",
	ocean: "accent ocean",
	jade: "accent jade",
};

const THEME_OPTIONS = [
	{ id: "system", label: t("follow system") },
	{ id: "light", label: t("light") },
	{ id: "dark", label: t("dark") },
] as const;

/** Same options as a segmented picker with per-mode icons (monitor / sun /
 *  moon) — the theme flip overlay morphs between these same icons. */
const TYPE_THEME_OPTIONS = [
	{ id: "system", label: t("follow system"), Icon: MonitorIcon },
	{ id: "light", label: t("light"), Icon: SunIcon },
	{ id: "dark", label: t("dark"), Icon: MoonIcon },
] as const;

/**
 * ZCode-parity appearance settings, sectioned like the reference: 本地化
 * (language / time format / week start), then 界面设置 (theme + interface
 * type), 代码设置 (light/dark code themes, line numbers, long-line wrap, code
 * sizes), 代码预览 (live light/dark preview cards with a "currently active"
 * tag), then the effects toggles. All prefs persist to localStorage and
 * apply their CSS variable on <html> immediately.
 */
function AppearanceSection({
	showAvatars,
	onToggleAvatars,
	rpc,
}: {
	showAvatars: boolean;
	onToggleAvatars(): void;
	rpc: RpcClient | null;
}): ReactNode {
	// Picking the already-active theme (theme.ts setThemePreference) emits
	// omp-theme-toggle-shake — jiggle the active segmented button instead
	// of running another overlay. The class is removed on animationend (no
	// timer: background-window timers throttle and would leave it stuck).
	const [themeShake, setThemeShake] = useState(false);
	useEffect(() => {
		const on = (): void => {
			setThemeShake(false);
			requestAnimationFrame(() => setThemeShake(true));
		};
		window.addEventListener("omp-theme-toggle-shake", on);
		return () => window.removeEventListener("omp-theme-toggle-shake", on);
	}, []);
	const { preference, resolved, setPreference } = useThemePreference();
	const { accent, setAccent, customAccent, applyCustomAccent } = useAccentPreference();
	// Custom-accent picker popover (app-styled ColorPickerPanel, replaces the
	// native <input type="color"> — portaled via useFloatingMenu). NOTE: no
	// className here — ColorPickerPanel's root carries the card surface;
	// passing one double-draws the rounded card (WelcomeComposer lesson).
	// Interaction: opening snapshots the current preference into a LOCAL
	// preview; edits touch only the preview (no veil/apply); 「应用」 applies
	// it (veil + morphicon); closing discards the preview.
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerPreview, setPickerPreview] = useState<string | null>(null);
	const { anchorRef: accentPickerRef, renderMenu: renderAccentPicker } = useFloatingMenu(pickerOpen, setPickerOpen);
	const {
		lightThemeId,
		darkThemeId,
		setLightTheme,
		setDarkTheme,
		unifiedMode,
		unifiedThemeId,
		setUnifiedMode,
		setUnifiedTheme,
	} = useUiThemePreferences();
	// Locale: subscribe so the dropdown reflects the current language.
	const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot);
	// Custom appearance (persisted, applied on the root element).
	const [motion, setMotion] = useState<"full" | "reduced" | "off">(
		() => (localStorage.getItem("omp-gui-motion") as "full" | "reduced" | "off") ?? "full",
	);
	const [statusBarEffect, setStatusBarEffect] = useState<"shimmer" | "kitt" | "plain">(() => {
		const v = localStorage.getItem("omp-gui-statusbar");
		return v === "kitt" || v === "plain" ? v : "shimmer";
	});
	const [statusBarIndicator, setStatusBarIndicator] = useState<"braille" | "orb" | "lattice" | "ring">(() => {
		const v = localStorage.getItem("omp-gui-statusbar-indicator");
		return v === "orb" || v === "lattice" || v === "ring" ? v : "braille";
	});
	const [sweepColor, setSweepColor] = useState<"default" | "accent">(() => {
		const v = localStorage.getItem("omp-gui-statusbar-kitt-color");
		return v === "accent" ? "accent" : "default";
	});
	const [inlineImages, setInlineImages] = useState<boolean>(() => localStorage.getItem("omp-gui-images") !== "0");
	const [fontScale, setFontScale] = useState<number>(() => Number(localStorage.getItem("omp-gui-font-scale") ?? 15));
	const [termFont, setTermFont] = useState<number>(() => Number(localStorage.getItem("omp-gui-terminal-font") ?? 13));
	const [codeFont, setCodeFont] = useState<number>(() => Number(localStorage.getItem(EDITOR_FONT_KEY) ?? 13));
	const [density, setDensity] = useState<number>(() => Number(localStorage.getItem(DENSITY_KEY) ?? 100));
	const [timeFmt, setTimeFmt] = useState<"auto" | "12h" | "24h">(
		() => (localStorage.getItem(TIME_FMT_KEY) as "auto" | "12h" | "24h") ?? "auto",
	);
	const [weekStart, setWeekStart] = useState<"auto" | "monday" | "sunday">(
		() => (localStorage.getItem(WEEK_START_KEY) as "auto" | "monday" | "sunday") ?? "auto",
	);
	const [uiFont, setUiFont] = useState<string>(() => localStorage.getItem(UI_FONT_KEY) ?? DEFAULT_UI_FONT.id);
	const [monoFont, setMonoFont] = useState<string>(() => localStorage.getItem(MONO_FONT_KEY) ?? DEFAULT_CODE_FONT.id);
	const [turnRailSide, setTurnRailSide] = useState<TurnRailSide>(
		() => (localStorage.getItem(TURN_RAIL_SIDE_KEY) as TurnRailSide) ?? "right",
	);
	const [turnRailStyle, setTurnRailStyle] = useState<TurnRailStyle>(
		() => (localStorage.getItem(TURN_RAIL_STYLE_KEY) as TurnRailStyle) ?? "burger",
	);
	const [glass, setGlass] = useState<number>(() => readGlassLevel());
	const [glassEnabled, setGlassEnabled] = useState<boolean>(
		() => localStorage.getItem("omp-gui-glass-enabled") !== "0",
	);
	const [lightCodeTheme, setLightCodeTheme] = useState<string>(
		() => localStorage.getItem(CODE_THEME_LIGHT_KEY) ?? DEFAULT_LIGHT_CODE_THEME.id,
	);
	const [darkCodeTheme, setDarkCodeTheme] = useState<string>(
		() => localStorage.getItem(CODE_THEME_DARK_KEY) ?? DEFAULT_DARK_CODE_THEME.id,
	);
	const [codeLines, setCodeLines] = useState<boolean>(() => localStorage.getItem(CODE_LINES_KEY) !== "0");
	const [codeWrap, setCodeWrap] = useState<boolean>(() => localStorage.getItem(CODE_WRAP_KEY) === "1");
	const lightTheme: CodeTheme = LIGHT_CODE_THEMES.find(o => o.id === lightCodeTheme) ?? DEFAULT_LIGHT_CODE_THEME;
	const darkTheme: CodeTheme = DARK_CODE_THEMES.find(o => o.id === darkCodeTheme) ?? DEFAULT_DARK_CODE_THEME;
	const setPref = (key: string, value: string | number): void => {
		try {
			localStorage.setItem(key, String(value));
		} catch {
			// storage unavailable
		}
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("appearance")}</h2>
			<p className="gui-settings-page-desc">{t("appearance settings")}</p>

			{/* ── 本地化 — language / time format / week start (openchamber parity). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("localization")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("language")}</div>
					<select
						className="gui-settings-select"
						value={locale}
						onChange={e => {
							const next = e.target.value;
							// Renderer mirror updates immediately; the daemon key
							// (settings.locale, config.yml) is the single source the
							// TUI and the GUI boot sync both read (F1 audit fix).
							setLocale(next);
							if (rpc) void rpc.request("settings.set", { key: "settings.locale", value: next }).catch(() => {});
						}}
					>
						<option value="zh-CN">中文</option>
						<option value="en-US">English</option>
					</select>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("time format")}</div>
					<select
						className="gui-settings-select"
						value={timeFmt}
						onChange={e => {
							const v = e.target.value as "auto" | "12h" | "24h";
							setTimeFmt(v);
							setPref(TIME_FMT_KEY, v);
						}}
					>
						<option value="auto">{t("auto")}</option>
						<option value="12h">{t("12-hour")}</option>
						<option value="24h">{t("24-hour")}</option>
					</select>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("week starts on")}</div>
					<select
						className="gui-settings-select"
						value={weekStart}
						onChange={e => {
							const v = e.target.value as "auto" | "monday" | "sunday";
							setWeekStart(v);
							setPref(WEEK_START_KEY, v);
						}}
					>
						<option value="auto">{t("auto")}</option>
						<option value="monday">{t("monday")}</option>
						<option value="sunday">{t("sunday")}</option>
					</select>
				</div>
			</div>

			{/* ── 界面设置 — theme + interface type (ZCode section). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("interface settings")}</div>
				<div className="gui-settings-section-desc">{t("interface settings description")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface theme")}</div>
					<div className="gui-settings-field-hint">{t("choose light, dark or follow the system")}</div>
					<div className="gui-settings-field-control">
						<div className="gui-segmented gui-theme-seg" role="radiogroup" aria-label={t("interface theme")}>
							{TYPE_THEME_OPTIONS.map(o => (
								<button
									key={o.id}
									type="button"
									role="radio"
									aria-checked={preference === o.id}
									className={`gui-seg-btn${preference === o.id ? " gui-seg-btn--active" : ""}${themeShake && preference === o.id ? " gui-seg-btn--shake" : ""}`}
									onAnimationEnd={() => setThemeShake(false)}
									onClick={() => setPreference(o.id)}
								>
									<o.Icon size={14} />
									<span>{o.label}</span>
								</button>
							))}
						</div>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("theme mode")}</div>
					<div className="gui-settings-field-hint">{t("theme mode description")}</div>
					<div className="gui-settings-field-control">
						<div className="gui-segmented" role="radiogroup" aria-label={t("theme mode")}>
							<button
								type="button"
								role="radio"
								aria-checked={!unifiedMode}
								className={`gui-seg-btn${unifiedMode ? "" : " gui-seg-btn--active"}`}
								onClick={() => setUnifiedMode(false)}
							>
								{t("theme mode separate")}
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={unifiedMode}
								className={`gui-seg-btn${unifiedMode ? " gui-seg-btn--active" : ""}`}
								onClick={() => setUnifiedMode(true)}
							>
								{t("theme mode unified")}
							</button>
						</div>
					</div>
				</div>
				<Reveal open={unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("unified theme")}</div>
						<div className="gui-settings-field-hint">{t("unified theme description")}</div>
						<div className="gui-settings-field-control">
							<select
								className="gui-settings-select"
								value={unifiedThemeId}
								onChange={e => setUnifiedTheme(e.target.value as UiThemeId)}
							>
								{UNIFIED_THEME_PRESETS.map(p => (
									<option key={p.id} value={p.id}>
										{t(`theme preset ${p.id}`)}
									</option>
								))}
							</select>
						</div>
					</div>
				</Reveal>
				<Reveal open={!unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("light theme")}</div>
						<div className="gui-settings-field-hint">{t("light theme description")}</div>
						<div className="gui-settings-field-control">
							<select
								className="gui-settings-select"
								value={lightThemeId}
								onChange={e => setLightTheme(e.target.value as UiThemeId)}
							>
								{LIGHT_THEME_PRESETS.map(p => (
									<option key={p.id} value={p.id}>
										{t(`theme preset ${p.id}`)}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("dark theme")}</div>
						<div className="gui-settings-field-hint">{t("dark theme description")}</div>
						<div className="gui-settings-field-control">
							<select
								className="gui-settings-select"
								value={darkThemeId}
								onChange={e => setDarkTheme(e.target.value as UiThemeId)}
							>
								{DARK_THEME_PRESETS.map(p => (
									<option key={p.id} value={p.id}>
										{t(`theme preset ${p.id}`)}
									</option>
								))}
							</select>
						</div>
					</div>
				</Reveal>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface font size")}</div>
					<NumberStepper
						label={t("interface font size")}
						value={fontScale}
						min={12}
						max={18}
						unit="px"
						defaultValue={15}
						onChange={v => {
							setFontScale(v);
							setPref("omp-gui-font-scale", v);
							document.documentElement.style.setProperty("--gui-font-scale", `${v}px`);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface font")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={uiFont}
							onChange={e => {
								const v = e.target.value;
								setUiFont(v);
								setPref(UI_FONT_KEY, v);
								applyUiFont(v);
							}}
						>
							{UI_FONT_OPTIONS.map(o => (
								<option key={o.id} value={o.id} style={{ fontFamily: o.stack }}>
									{o.label}
								</option>
							))}
						</select>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("reset")}
							aria-label={t("reset")}
							disabled={uiFont === DEFAULT_UI_FONT.id}
							onClick={() => {
								setUiFont(DEFAULT_UI_FONT.id);
								setPref(UI_FONT_KEY, DEFAULT_UI_FONT.id);
								applyUiFont(DEFAULT_UI_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("spacing density")}</div>
					<NumberStepper
						label={t("spacing density")}
						value={density}
						min={50}
						max={200}
						step={5}
						unit="%"
						defaultValue={100}
						onChange={v => {
							setDensity(v);
							setPref(DENSITY_KEY, v);
							applyDensity(v);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("turn rail position")}</div>
					<div className="gui-settings-field-hint">{t("turn rail position hint")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={turnRailSide}
							onChange={e => {
								const v = e.target.value as "right" | "left";
								setTurnRailSide(v);
								setPref(TURN_RAIL_SIDE_KEY, v);
								window.dispatchEvent(new Event(TURN_RAIL_CHANGED_EVENT));
							}}
						>
							<option value="right">{t("right side")}</option>
							<option value="left">{t("left side")}</option>
						</select>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("turn rail style")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={turnRailStyle}
							onChange={e => {
								const v = e.target.value as "burger" | "pacman";
								setTurnRailStyle(v);
								setPref(TURN_RAIL_STYLE_KEY, v);
								window.dispatchEvent(new Event(TURN_RAIL_CHANGED_EVENT));
							}}
						>
							<option value="burger">{t("burger layers")}</option>
							<option value="pacman">{t("pacman")}</option>
						</select>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("accent")}</div>
					<div className="gui-settings-field-hint">{t("accent color")}</div>
					<div className="gui-settings-field-control">
						<div className="flex items-center gap-2">
							{Object.entries(ACCENT_SWATCH).map(([id, color]) => (
								<button
									key={id}
									type="button"
									className={`gui-accent-swatch${accent === id ? " gui-accent-swatch--active" : ""}`}
									style={{ background: color }}
									aria-label={t(ACCENT_NAMES[id] ?? "accent brand")}
									title={t(ACCENT_NAMES[id] ?? "accent brand")}
									onClick={() => setAccent(id as "brand" | "mono" | "ocean" | "jade")}
								/>
							))}
							<button
								ref={accentPickerRef}
								type="button"
								className={`gui-accent-swatch gui-accent-swatch--custom${accent === "custom" ? " gui-accent-swatch--active" : ""}`}
								style={{ background: customAccent }}
								title={t("custom accent")}
								aria-label={t("custom accent")}
								aria-haspopup="dialog"
								onClick={() => {
									// Open only — no accent switch, no veil. Snapshot
									// the current preference as the starting preview;
									// apply happens exclusively via the card buttons.
									setPickerPreview(customAccent);
									setPickerOpen(o => !o);
								}}
							/>
						</div>
						{renderAccentPicker(
							<ColorPickerPanel
								value={pickerPreview ?? customAccent}
								onChange={setPickerPreview}
								onApply={applyCustomAccent}
							/>,
						)}
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("window transparency")}</div>
						<div className="gui-settings-row-desc">{t("window transparency description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={glassEnabled}
						className={`gui-toggle${glassEnabled ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !glassEnabled;
							setGlassEnabled(next);
							setPref("omp-gui-glass-enabled", next ? "1" : "0");
							// OFF = opaque panes: a global 100% overlay beats every
							// per-rule translucency; ON restores the slider level.
							if (next) {
								document.documentElement.style.removeProperty("--gui-glass-overlay");
							} else {
								document.documentElement.style.setProperty("--gui-glass-overlay", "100%");
								document.documentElement.classList.remove("gui-glass-adaptive");
							}
							// Desktop shell: mirror onto the native window material.
							applyGlassMaterial(next);
						}}
						aria-label={t("window transparency")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={glassEnabled}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("glass opacity")}</div>
						<div className="gui-settings-field-control">
							<input
								type="range"
								min={GLASS_MIN}
								max={GLASS_MAX}
								step={5}
								value={glass}
								className="gui-range"
								onChange={e => {
									const v = Number(e.target.value);
									setGlass(v);
									setPref("omp-gui-glass", v);
									applyGlassLevel(v);
								}}
							/>
							<span className="gui-settings-row-desc">{glass}%</span>
						</div>
					</div>
				</Reveal>
			</div>

			{/* ── 代码设置 — code themes / line numbers / wrap / sizes (ZCode). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("code settings")}</div>
				<div className="gui-settings-section-desc">{t("code settings description")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("light code theme")}</div>
					<div className="gui-settings-field-hint">{t("light code theme description")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={lightCodeTheme}
							onChange={e => {
								const v = e.target.value;
								setLightCodeTheme(v);
								setPref(CODE_THEME_LIGHT_KEY, v);
								applyCodeThemes(v, darkCodeTheme);
							}}
						>
							{LIGHT_CODE_THEMES.map(o => (
								<option key={o.id} value={o.id}>
									{o.label}
								</option>
							))}
						</select>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("dark code theme")}</div>
					<div className="gui-settings-field-hint">{t("dark code theme description")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={darkCodeTheme}
							onChange={e => {
								const v = e.target.value;
								setDarkCodeTheme(v);
								setPref(CODE_THEME_DARK_KEY, v);
								applyCodeThemes(lightCodeTheme, v);
							}}
						>
							{DARK_CODE_THEMES.map(o => (
								<option key={o.id} value={o.id}>
									{o.label}
								</option>
							))}
						</select>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("show line numbers")}</div>
						<div className="gui-settings-row-desc">{t("show line numbers description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={codeLines}
						className={`gui-toggle${codeLines ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !codeLines;
							setCodeLines(next);
							setPref(CODE_LINES_KEY, next ? "1" : "0");
							document.documentElement.classList.toggle("gui-code-lines", next);
						}}
						aria-label={t("show line numbers")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("wrap long lines")}</div>
						<div className="gui-settings-row-desc">{t("wrap long lines description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={codeWrap}
						className={`gui-toggle${codeWrap ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !codeWrap;
							setCodeWrap(next);
							setPref(CODE_WRAP_KEY, next ? "1" : "0");
							document.documentElement.classList.toggle("gui-code-wrap", next);
						}}
						aria-label={t("wrap long lines")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("code font size")}</div>
					<div className="gui-settings-field-hint">{t("code font size description")}</div>
					<NumberStepper
						label={t("code font size")}
						value={codeFont}
						min={9}
						max={32}
						unit="px"
						defaultValue={13}
						onChange={v => {
							setCodeFont(v);
							setPref(EDITOR_FONT_KEY, v);
							applyCodeSize(v);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("code font")}</div>
					<div className="gui-settings-field-control">
						<select
							className="gui-settings-select"
							value={monoFont}
							onChange={e => {
								const v = e.target.value;
								setMonoFont(v);
								setPref(MONO_FONT_KEY, v);
								applyMonoFont(v);
							}}
						>
							{CODE_FONT_OPTIONS.map(o => (
								<option key={o.id} value={o.id} style={{ fontFamily: o.stack }}>
									{o.label}
								</option>
							))}
						</select>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("reset")}
							aria-label={t("reset")}
							disabled={monoFont === DEFAULT_CODE_FONT.id}
							onClick={() => {
								setMonoFont(DEFAULT_CODE_FONT.id);
								setPref(MONO_FONT_KEY, DEFAULT_CODE_FONT.id);
								applyMonoFont(DEFAULT_CODE_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("terminal font size")}</div>
					<NumberStepper
						label={t("terminal font size")}
						value={termFont}
						min={9}
						max={32}
						unit="px"
						defaultValue={13}
						onChange={v => {
							setTermFont(v);
							setPref("omp-gui-terminal-font", v);
						}}
					/>
				</div>
			</div>

			{/* ── 代码预览 — light/dark preview cards (ZCode), the active main
			 * theme's card carries the "currently active" tag. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("code preview")}</div>
				<div className="gui-settings-section-desc">{t("code preview description")}</div>
				<div className="grid grid-cols-2 gap-3">
					<CodePreviewCard
						title={t("light preview")}
						theme={lightTheme}
						active={resolved === "light"}
						scheme="light"
					/>
					<CodePreviewCard
						title={t("dark preview")}
						theme={darkTheme}
						active={resolved === "dark"}
						scheme="dark"
					/>
				</div>
			</div>

			{/* ── Effects (motion / status line / images) with live preview ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("effects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("motion effects")}</div>
						<div className="gui-settings-row-desc">{t("menu popups, orb animation, splash pulse")}</div>
					</div>
					<div className="gui-segmented">
						{(["full", "reduced", "off"] as const).map(m => (
							<button
								key={m}
								type="button"
								className={`gui-seg-btn${motion === m ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setMotion(m);
									localStorage.setItem("omp-gui-motion", m);
									document.documentElement.classList.toggle("gui-motion-off", m === "off");
								}}
							>
								{m === "full" ? t("full") : m === "reduced" ? t("reduced") : t("off")}
							</button>
						))}
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("agent status line")}</div>
						<div className="gui-settings-row-desc">
							{t("choose the spinner and the label effect shown above the input while the agent works")}
						</div>
					</div>
					<div className="flex flex-col items-end gap-2">
						<div className="flex items-center gap-2">
							<span className="text-[12px] text-[var(--color-text-muted)]">{t("indicator")}</span>
							<div className="gui-segmented">
								{(["braille", "orb", "lattice", "ring"] as const).map(s => (
									<button
										key={s}
										type="button"
										className={`gui-seg-btn${statusBarIndicator === s ? " gui-seg-btn--active" : ""}`}
										onClick={() => {
											setStatusBarIndicator(s);
											localStorage.setItem("omp-gui-statusbar-indicator", s);
										}}
									>
										{s === "braille"
											? t("braille")
											: s === "orb"
												? t("orb")
												: s === "lattice"
													? t("lattice")
													: t("ring")}
									</button>
								))}
							</div>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-[12px] text-[var(--color-text-muted)]">{t("effect")}</span>
							<div className="gui-segmented">
								{(["shimmer", "kitt", "plain"] as const).map(s => (
									<button
										key={s}
										type="button"
										className={`gui-seg-btn${statusBarEffect === s ? " gui-seg-btn--active" : ""}`}
										onClick={() => {
											setStatusBarEffect(s);
											localStorage.setItem("omp-gui-statusbar", s);
										}}
									>
										{s === "shimmer" ? t("shimmer") : s === "kitt" ? t("kitt") : t("plain")}
									</button>
								))}
							</div>
						</div>
						<Reveal open={statusBarEffect === "kitt" || statusBarEffect === "shimmer"}>
							<div className="flex items-center gap-2">
								<span className="text-[12px] text-[var(--color-text-muted)]">{t("sweep color")}</span>
								<div className="gui-segmented">
									{(["default", "accent"] as const).map(k => (
										<button
											key={k}
											type="button"
											className={`gui-seg-btn${sweepColor === k ? " gui-seg-btn--active" : ""}`}
											onClick={() => {
												setSweepColor(k);
												localStorage.setItem("omp-gui-statusbar-kitt-color", k);
											}}
										>
											{k === "default" ? t("default tone") : t("accent color")}
										</button>
									))}
								</div>
							</div>
						</Reveal>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("inline images")}</div>
						<div className="gui-settings-row-desc">{t("show images inside the transcript")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={inlineImages}
						className={`gui-toggle${inlineImages ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !inlineImages;
							setInlineImages(next);
							localStorage.setItem("omp-gui-images", next ? "1" : "0");
							document.documentElement.classList.toggle("gui-no-images", !next);
						}}
						aria-label={t("inline images")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div className="flex-1">
						<div className="gui-settings-row-label">{t("show avatars")}</div>
						<div className="gui-settings-row-desc">
							{t("agent orb avatar beside replies, your avatar at the bubble")}
						</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={showAvatars}
						className={`gui-toggle${showAvatars ? " gui-toggle--on" : ""}`}
						onClick={onToggleAvatars}
						aria-label={t("show avatars")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			{/* ── 效果预览 — one mock scene for the whole effects block (code
			 * preview parity): transcript rows reuse the REAL tr-* classes
			 * so bubbles and avatars match the chat surface, the live
			 * status line hangs above a mock input card — the same
			 * arrangement as the actual composer column. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("effects preview")}</div>
				<div className="gui-settings-section-desc">{t("effects preview description")}</div>
				<div className="gui-effect-preview">
					<div className="tr-row">
						<div className="tr-gutter">{showAvatars && <AgentAvatar state="working" size={64} />}</div>
						<div className="tr-body">
							<div className="tr-md">{t("preview agent message")}</div>
						</div>
					</div>
					<div className="tr-row tr-row--user">
						<div className="tr-gutter" />
						<div className="tr-body">
							<div className="tr-md">{t("preview user message")}</div>
						</div>
					</div>
					<AgentStatusLine
						working={true}
						effect={statusBarEffect}
						indicator={statusBarIndicator}
						sweepColor={sweepColor}
					/>
					<div className="gui-effect-preview-composer">
						<div className="gui-effect-preview-input">{t("ask anything, / for commands, @ for context…")}</div>
						<span className="gui-effect-preview-send" aria-hidden>
							<Icon name="send-plane" className="h-3.5 w-3.5" />
						</span>
					</div>
				</div>
			</div>
			{/* TUI appearance-tab parity (schema-driven): theme presets, status
			 * line, display and images groups from settings.schema. */}
			<SchemaTabSection rpc={rpc} tabs={["appearance"]} />
			{/* Chat display settings (previously the 聊天设置 tab): transcript
			 * rendering prefs are appearance — merged into one 外观 page. */}
			<ChatSection />
		</>
	);
}

/** ZCode code-preview card: the selected theme's real colors over a sample
 * snippet; the card matching the active main scheme gets the tag. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: sample code shown verbatim in the preview card
const PREVIEW_SNIPPET = ["const greet = (name: string) => {", "  return `hello, ${name}!`;", "};"].join("\n");

/** Once-per-scheme cache: the snippet is static, the bridge is async. */
const previewHighlightCache = new Map<"light" | "dark", string | null>();

function CodePreviewCard({
	title,
	theme,
	active,
	scheme,
}: {
	title: string;
	theme: CodeTheme;
	active: boolean;
	scheme: "light" | "dark";
}): ReactNode {
	const [html, setHtml] = useState<string | null>(() => previewHighlightCache.get(scheme) ?? null);
	useEffect(() => {
		const cached = previewHighlightCache.get(scheme);
		if (cached !== undefined) {
			setHtml(cached);
			return;
		}
		let alive = true;
		void nativeHighlight(PREVIEW_SNIPPET, "typescript", scheme).then(out => {
			if (!alive) return;
			const next = out ? highlightToCodeHtml(out) : null;
			previewHighlightCache.set(scheme, next);
			setHtml(next);
		});
		return () => {
			alive = false;
		};
	}, [scheme]);
	return (
		<div className="gui-code-preview-card">
			<div className="gui-code-preview-head">
				<span className="text-[13px] font-medium">{title}</span>
				<span className="gui-settings-row-desc">{theme.label}</span>
				{active && <span className="gui-code-preview-tag">{t("currently active")}</span>}
			</div>
			<pre className="gui-code-preview-body" style={{ background: theme.bg, color: theme.fg }}>
				{html !== null ? (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped spans built by highlightToCodeHtml
					<code dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<span className="tr-code-line">{PREVIEW_SNIPPET}</span>
				)}
			</pre>
		</div>
	);
}

/** Openchamber-style number stepper: [−] input [+] unit, plus reset. */
function NumberStepper({
	label,
	value,
	min,
	max,
	step = 1,
	unit,
	defaultValue,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	unit: "px" | "%";
	defaultValue: number;
	onChange(next: number): void;
}): ReactNode {
	// Local draft while typing; null mirrors the committed prop so the
	// field never fights free editing or snaps mid-keystroke.
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? String(value);
	const clamp = (v: number): number => Math.min(max, Math.max(min, v));
	const commit = (raw: string | number): void => {
		setDraft(null);
		const v = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isNaN(v)) onChange(clamp(v));
	};
	return (
		<div className="gui-settings-field-control">
			<div className="gui-settings-stepper">
				<button
					type="button"
					className="gui-stepper-btn"
					aria-label={t("decrease")}
					disabled={value <= min}
					onClick={() => commit(value - step)}
				>
					<Icon name="subtract" className="h-3 w-3" />
				</button>
				<input
					type="number"
					min={min}
					max={max}
					step={step}
					value={shown}
					className="gui-stepper-input"
					aria-label={label}
					onChange={e => setDraft(e.target.value)}
					onBlur={() => commit(draft ?? value)}
				/>
				<button
					type="button"
					className="gui-stepper-btn"
					aria-label={t("increase")}
					disabled={value >= max}
					onClick={() => commit(value + step)}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
			</div>
			<span className="gui-settings-stepper-unit">{unit}</span>
			<button
				type="button"
				className="gui-settings-reset"
				title={t("reset")}
				aria-label={t("reset")}
				disabled={value === defaultValue}
				onClick={() => commit(defaultValue)}
			>
				<Icon name="restart" className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

/** Small persisted toggle with a settings-row label (shared by the new tabs). */
function PrefToggle({
	label,
	description,
	storageKey,
	onClass,
	on = true,
	disabled = false,
	onChange,
}: {
	label: string;
	description: string;
	storageKey: string;
	/** Optional class toggled on <html> while the pref is OFF. */
	onClass?: string;
	/** Default value when the key is unset. */
	on?: boolean;
	/** Grey the row out and block interaction (a conflicting pref is active). */
	disabled?: boolean;
	/** Notified with the new value after the toggle commits. */
	onChange?: (on: boolean) => void;
}): ReactNode {
	const [onState, setOnState] = useState<boolean>(() => {
		try {
			const v = localStorage.getItem(storageKey);
			return v === null ? on : v !== "0";
		} catch {
			return on;
		}
	});
	return (
		<div className={`gui-settings-row${disabled ? " gui-settings-row--disabled" : ""}`}>
			<div>
				<div className="gui-settings-row-label">{label}</div>
				<div className="gui-settings-row-desc">{description}</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={onState}
				disabled={disabled}
				className={`gui-toggle${onState ? " gui-toggle--on" : ""}`}
				onClick={() => {
					tapFeedback();
					const next = !onState;
					setOnState(next);
					try {
						localStorage.setItem(storageKey, next ? "1" : "0");
					} catch {
						// ignore
					}
					if (onClass) document.documentElement.classList.toggle(onClass, !next);
					onChange?.(next);
				}}
				aria-label={label}
			>
				<span className="gui-toggle-knob" />
			</button>
		</div>
	);
}

/** Segmented alternative to PrefToggle (e.g. 用户消息渲染: Markdown/纯文本). */
function PrefSegmented<T extends string>({
	label,
	description,
	storageKey,
	options,
	defaultValue,
}: {
	label: string;
	description: string;
	storageKey: string;
	options: readonly { id: T; label: string }[];
	defaultValue: T;
}): ReactNode {
	const [value, setValue] = useState<T>(() => {
		try {
			const v = localStorage.getItem(storageKey);
			return options.some(o => o.id === v) ? (v as T) : defaultValue;
		} catch {
			return defaultValue;
		}
	});
	return (
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{label}</div>
				<div className="gui-settings-row-desc">{description}</div>
			</div>
			<div className="gui-segmented">
				{options.map(o => (
					<button
						key={o.id}
						type="button"
						className={`gui-seg-btn${value === o.id ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setValue(o.id);
							try {
								localStorage.setItem(storageKey, o.id);
							} catch {
								// ignore
							}
						}}
					>
						{o.label}
					</button>
				))}
			</div>
		</div>
	);
}

/** Chat display settings (transcript rendering) — rendered as a block at
 *  the bottom of 外观 (previously the standalone 聊天设置 tab; merged
 *  2026-08-12 so transcript rendering prefs live with the rest of the
 *  appearance options). All prefs are renderer-local (localStorage). */
function ChatSection(): ReactNode {
	const [mermaidModeState, setMermaidModeState] = useState<"svg" | "ascii">(() => {
		try {
			return localStorage.getItem("omp-gui-chat-mermaid") === "ascii" ? "ascii" : "svg";
		} catch {
			return "svg";
		}
	});
	// Widget standalone display — when ON, the in-tool-card toggle below
	// is inert (tool cards collapse; the widget lives on its own card).
	const [widgetStandalone, setWidgetStandalone] = useState<boolean>(() => {
		try {
			return (localStorage.getItem("omp-gui-widget-standalone") ?? "1") !== "0";
		} catch {
			return true;
		}
	});
	const [diffLayoutState, setDiffLayoutState] = useState<"dynamic" | "inline" | "side-by-side">(() => {
		try {
			const v = localStorage.getItem("omp-gui-chat-difflayout");
			return v === "dynamic" || v === "side-by-side" ? v : "inline";
		} catch {
			return "inline";
		}
	});
	const [outputStyle, setOutputStyle] = useState<"default" | "kimi" | "zcode">(() => {
		try {
			const v = localStorage.getItem("omp-gui-chat-output-style");
			return v === "kimi" || v === "zcode" ? v : "default";
		} catch {
			return "default";
		}
	});
	// 消息字号 — transcript body ladder (--tr-font-size on <html>; headings
	// and code scale off it in transcript.css). Independent of the interface
	// font slider: shell chrome follows --gui-font-scale, chat text follows
	// this one.
	const [chatFontSize, setChatFontSize] = useState<number>(() =>
		Number(localStorage.getItem("omp-gui-chat-font-size") ?? 14),
	);
	const [typingEffect, setTypingEffect] = useState<"typewriter" | "burst" | "shimmer" | "glitch" | "flip" | "ink">(
		() => {
			try {
				const v = localStorage.getItem("omp-gui-chat-effect");
				return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink" ? v : "ink";
			} catch {
				return "ink";
			}
		},
	);
	// Live previews re-render with the segments (mermaid svg/ascii + diff
	// layout) — same renderers the transcript uses, sample content only.
	const mermaidPreviewHtml = useMemo(() => renderMermaidHtml(MERMAID_SAMPLE, mermaidModeState), [mermaidModeState]);
	// Same highlighter the chat transcript uses (Electron IPC → tree-sitter
	// natives); the provider makes the preview's DiffBlock highlight too.
	const chatHighlight = useChatHighlight();
	return (
		<CodeHighlightProvider highlight={chatHighlight}>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("chat settings")}</div>
				<div className="gui-settings-section-desc">{t("chat settings description")}</div>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("message rendering")}</div>
				<PrefSegmented
					label={t("user message rendering")}
					description={t("user message rendering description")}
					storageKey="omp-gui-chat-usermsg"
					defaultValue="markdown"
					options={[
						{ id: "markdown", label: t("markdown") },
						{ id: "plain", label: t("plain text") },
					]}
				/>
				<PrefToggle
					label={t("collapse long user messages")}
					description={t("collapse long user messages description")}
					storageKey="omp-gui-chat-collapseuser"
				/>
				<PrefToggle
					label={t("show reasoning traces")}
					description={t("show reasoning traces description")}
					storageKey="omp-gui-chat-thinking"
					onClass="gui-chat-hide-thinking"
				/>
				<PrefToggle
					label={t("widget standalone")}
					description={t("widget standalone description")}
					storageKey="omp-gui-widget-standalone"
					onChange={setWidgetStandalone}
				/>
				<PrefToggle
					label={t("widgets expanded")}
					description={t("widgets expanded description")}
					storageKey="omp-gui-widget-expanded"
					disabled={widgetStandalone}
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("mermaid rendering")}</div>
						<div className="gui-settings-row-desc">{t("mermaid rendering description")}</div>
					</div>
					<div className="gui-segmented">
						{(["svg", "ascii"] as const).map(m => (
							<button
								key={m}
								type="button"
								className={`gui-seg-btn${mermaidModeState === m ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setMermaidModeState(m);
									try {
										localStorage.setItem("omp-gui-chat-mermaid", m);
									} catch {
										// ignore
									}
								}}
							>
								{m === "svg" ? t("svg") : t("ascii")}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("mermaid preview")}</div>
					{/* biome-ignore lint/security/noDangerouslySetInnerHtml: built by renderMermaidHtml (escaped source) */}
					<div className="gui-chat-preview-mermaid" dangerouslySetInnerHTML={{ __html: mermaidPreviewHtml }} />
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("diff layout")}</div>
						<div className="gui-settings-row-desc">{t("diff layout description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "dynamic", label: t("dynamic") },
								{ id: "inline", label: t("always inline") },
								{ id: "side-by-side", label: t("always side by side") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${diffLayoutState === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setDiffLayoutState(o.id);
									try {
										localStorage.setItem("omp-gui-chat-difflayout", o.id);
									} catch {
										// ignore
									}
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("diff preview")}</div>
					{/* tr-card--diff container: same aicss file-diff tinting the transcript
					 * ToolCard applies (accent bar + green/red row tints). */}
					<div className="tr-card--diff">
						<DiffBlock diff={DIFF_SAMPLE} layout={diffLayoutState} />
					</div>
				</div>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("interface and input")}</div>
				<PrefToggle
					label={t("preserve draft messages")}
					description={t("preserve draft messages description")}
					storageKey="omp-gui-chat-draft"
				/>
				<PrefToggle
					label={t("enable spell check in text input")}
					description={t("enable spell check in text input description")}
					storageKey="omp-gui-chat-spellcheck"
					on={false}
				/>
				<PrefToggle
					label={t("show timestamps")}
					description={t("time next to assistant messages")}
					storageKey="omp-gui-chat-time"
					onClass="gui-chat-hide-time"
				/>
				<PrefToggle
					label={t("row actions")}
					description={t("row actions description")}
					storageKey="omp-gui-chat-rowactions"
					onClass="gui-chat-hide-row-actions"
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("message font size")}</div>
						<div className="gui-settings-row-desc">{t("message font size description")}</div>
					</div>
					<NumberStepper
						label={t("message font size")}
						value={chatFontSize}
						min={12}
						max={20}
						unit="px"
						defaultValue={14}
						onChange={v => {
							setChatFontSize(v);
							try {
								localStorage.setItem("omp-gui-chat-font-size", String(v));
							} catch {
								// ignore
							}
							document.documentElement.style.setProperty("--tr-font-size", `${v}px`);
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("output style")}</div>
						<div className="gui-settings-row-desc">{t("output style description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "default", label: t("output style default") },
								{ id: "kimi", label: t("output style kimi") },
								{ id: "zcode", label: t("output style zcode") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${outputStyle === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									tapFeedback();
									setOutputStyle(o.id);
									try {
										localStorage.setItem("omp-gui-chat-output-style", o.id);
									} catch {
										// ignore
									}
									document.documentElement.dataset.outputStyle = o.id;
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("typing effect")}</div>
						<div className="gui-settings-row-desc">{t("typing effect description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "typewriter", label: t("typing effect typewriter") },
								{ id: "burst", label: t("typing effect burst") },
								{ id: "shimmer", label: t("typing effect shimmer") },
								{ id: "glitch", label: t("typing effect glitch") },
								{ id: "flip", label: t("typing effect flip") },
								{ id: "ink", label: t("typing effect ink") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${typingEffect === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									tapFeedback();
									setTypingEffect(o.id);
									try {
										localStorage.setItem("omp-gui-chat-effect", o.id);
									} catch {
										// ignore
									}
									// No root-class swap here: the transcript applies the
									// effect only to the block that is streaming right now,
									// and this preview re-renders from `effect` below.
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("output style preview")}</div>
					<div className="gui-chat-preview-desc">{t("output style preview description")}</div>
					{/* The output-style presets are --tr-* variable overrides keyed
					 * off [data-output-style] — scoping this container to the
					 * picker's value previews the exact transcript typography.
					 * The typewriter demo shows the 逐字输出 (smooth streaming)
					 * motion under that typography: reveal + live caret. */}
					<div data-output-style={outputStyle} className="gui-chat-preview-style">
						<TypewriterPreview />
						<div className="tr-md gui-chat-preview-static">
							<h2>{t("preview heading")}</h2>
							<p>{t("preview paragraph")}</p>
							<pre>
								<code>{t("preview code")}</code>
							</pre>
							<ul>
								<li>{t("preview list item")}</li>
								<li>{t("preview list item")}</li>
							</ul>
						</div>
					</div>
				</div>
				<PrefToggle
					label={t("streaming caret")}
					description={t("streaming caret description")}
					storageKey="omp-gui-chat-caret"
					onClass="gui-chat-no-caret"
				/>
				<PrefToggle
					label={t("code highlight")}
					description={t("code highlight description")}
					storageKey="omp-gui-chat-codehl"
					onClass="gui-chat-plain-code"
				/>
			</div>
		</CodeHighlightProvider>
	);
}

/** Sample content for the chat preview (Settings → 聊天 → 聊天预览). */
const MERMAID_SAMPLE = `graph TD
  A[用户提问] --> B{分析需求}
  B -->|明确| C[直接回答]
  B -->|需工具| D[调用工具]
  D --> E[汇总结果]
  C --> F[回复用户]
  E --> F`;

const DIFF_SAMPLE = `--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,3 +1,5 @@
 export function greet(name: string): string {
-  return \`Hello, \${name}!\`;
+  const prefix = name ? "Hello" : "Hi";
+  return \`\${prefix}, \${name}!\`;
 }
+export const version = "1.2.0";`;

/**
 * Looping typewriter demo for the output-style preview — driven by the SAME
 * reveal engine the transcript uses (proportional nextStep catch-up +
 * grapheme slicing), so the preview shows the real 逐字输出 motion: a token
 * burst drains over ~8 frames, a trickle advances 1 grapheme/frame. Follows
 * the 平滑流式渲染 toggle: off → the full text appears instantly.
 */
function TypewriterPreview(): ReactNode {
	const text = useTypewriterSample();
	const smoothOn = (() => {
		try {
			// PrefToggle writes "1"/"0" — absent key = default on.
			const v = localStorage.getItem("omp-gui-chat-smooth");
			return v === null ? true : v !== "0";
		} catch {
			return true;
		}
	})();
	const effect = (() => {
		try {
			const v = localStorage.getItem("omp-gui-chat-effect");
			return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink" ? v : "typewriter";
		} catch {
			return "typewriter";
		}
	})();
	const total = countGraphemes(text);
	const [arrived, setArrived] = useState(0);
	const [shown, setShown] = useState(0);
	const [done, setDone] = useState(false);
	// Replay cycle: increments 1.8s after each demo settles; the arrival
	// effect below depends on it, so the demo restarts (the preview loops).
	const [cycle, setCycle] = useState(0);
	const arrivedRef = useRef(0);
	useEffect(() => {
		arrivedRef.current = arrived;
	}, [arrived]);
	useEffect(() => {
		if (!smoothOn) {
			setArrived(total);
			setShown(total);
			setDone(true);
			return;
		}
		setArrived(0);
		setShown(0);
		setDone(false);
		// Simulated model token stream: 2–3 graphemes arrive every 110ms
		// (~23 chars/s, like a real model), while the reveal eats the
		// backlog at the transcript's own cadence (3/frame floor, catch-up
		// on bursts) — so the preview shows the ACTUAL smooth-streaming
		// motion at a readable pace, not a one-shot dump.
		const arrival = setInterval(() => {
			setArrived(a => {
				if (a >= total) {
					clearInterval(arrival);
					return a;
				}
				return Math.min(total, a + 2 + Math.floor(Math.random() * 2));
			});
		}, 110);
		const reveal = setInterval(() => {
			setShown(s => {
				const target = arrivedRef.current;
				return Math.min(target, s + nextStep(target - s));
			});
		}, STREAMING_REVEAL_FRAME_MS);
		return () => {
			clearInterval(arrival);
			clearInterval(reveal);
		};
		// effect in deps: switching the typing-effect preset restarts the
		// demo immediately (the preview must track the engine's selection).
		// cycle: replay loop — each increment restarts the demo.
	}, [smoothOn, total, cycle]);
	useEffect(() => {
		if (!done || !smoothOn) return;
		const id = setTimeout(() => setCycle(c => c + 1), 1800);
		return () => clearTimeout(id);
	}, [done, smoothOn]);
	useEffect(() => {
		if (smoothOn && arrived >= total && shown >= total) setDone(true);
	}, [arrived, shown, total, smoothOn]);
	const display = smoothOn ? sliceGraphemes(text, shown) : text;
	// The effect only applies while the demo is "typing" — once done, the
	// full text shows plain (no gradient/spans/jitter), same contract as
	// the real transcript: finished output is never colored.
	const eff = done ? "typewriter" : effect;
	// shimmer applies via the CSS class on this .tr-md root (the only
	// preset with pure-CSS styling); the rest render per-grapheme spans
	// through TAIL_RENDERERS. typewriter carries no class.
	const effectCls = eff === "shimmer" ? " gui-chat-effect-shimmer" : "";
	return (
		<div className={`tr-md gui-typewriter${done ? "" : " gui-typewriter--live"}${effectCls}`}>
			<p>
				{(() => {
					const cfg = TAIL_RENDERERS[eff];
					if (!cfg || !smoothOn || done || countGraphemes(display) <= cfg.windowSize) return display;
					const n = countGraphemes(display);
					const head = sliceGraphemes(display, n - cfg.windowSize);
					const tail = graphemeSpans(display.slice(head.length));
					return (
						<>
							{head}
							{tail.map(({ word }, i) => {
								const r = cfg.render(i, word);
								return r ? (
									<span key={i} className={r.cls} style={r.style}>
										{r.text}
									</span>
								) : (
									<span key={i}>{word}</span>
								);
							})}
						</>
					);
				})()}
				{eff === "typewriter" && !done && <span className="gui-typewriter-caret" />}
			</p>
		</div>
	);
}

/** Sample sentence the typewriter demo types out (i18n, keeps it localized). */
function useTypewriterSample(): string {
	return t("preview paragraph");
}

/** Wired sound → trigger description (i18n keys); see sfx.ts WIRED_SOUNDS. */
const SOUND_USAGE_KEYS: Partial<Record<SoundName, TranslationKey>> = {
	chime: "send message, approval request",
	sparkle: "first message, prompt enhanced",
	error: "connect error, approval denied",
	page: "session switch",
	release: "stop current turn",
	success: "approval granted",
	tick: "tool result arrived",
};

/** One configurable activity row (opencode per-category sounds parity):
 *  activity name + trigger desc, a preview button for the current choice,
 *  and a palette select that persists under omp-gui-sfx:<event>. */
function SoundEventRow({ ev }: { ev: SfxEvent }): ReactNode {
	const [name, setName] = useState<SoundName>(() => soundFor(ev));
	return (
		<div className="gui-sfx-event-row">
			<div className="min-w-0 flex-1">
				<div className="gui-settings-row-label">{t(`sfx event ${ev}`)}</div>
				<div className="gui-settings-row-desc">
					{t(`sfx event ${ev} desc`)} · {t("default")}: {DEFAULT_SFX[ev]}
				</div>
			</div>
			<button
				type="button"
				className="gui-sfx-preview"
				onClick={() => previewSound(name)}
				aria-label={`${t("preview")} ${name}`}
				title={`${t("preview")} ${name}`}
			>
				<Icon name="play" className="h-3.5 w-3.5" />
			</button>
			<select
				className="gui-settings-select"
				value={name}
				onChange={e => {
					const next = e.target.value as SoundName;
					setName(next);
					setSoundFor(ev, next);
				}}
				aria-label={t(`sfx event ${ev}`)}
			>
				{ALL_SOUNDS.map(s => (
					<option key={s} value={s}>
						{s}
					</option>
				))}
			</select>
		</div>
	);
}

/** Notification template variables (openchamber parity). */
const TEMPLATE_VARIABLES = [
	"project_name",
	"worktree",
	"branch",
	"session_name",
	"agent_name",
	"model_name",
	"last_message",
] as const;

/** Agent companion (伙伴, BitFun parity): master switch + display mode
 * (input / floating desktop pet) + appearance (preset grid or imported
 * Petdex package). Prefs are renderer-local; the desktop pet window is
 * driven through the Electron bridge (pet-mode IPC). */
interface PetGridEntry {
	id: string;
	name: string;
	description: string;
	src: string;
	width: number;
	height: number;
	rows?: readonly number[];
	contentH?: number;
	source: "preset" | "user";
}

/** One selectable companion card in the appearance grid: rest-frame
 *  thumbnail, name, truncated description; selected card gets the accent
 *  ring + check. Imported cards get a hover delete button (BitFun parity:
 *  the delete lives on the card, stopPropagation keeps it from selecting). */
function PetCard({
	entry,
	selected,
	onSelect,
	onDelete,
}: {
	entry: PetGridEntry;
	selected: boolean;
	onSelect(): void;
	onDelete?(): void;
}): ReactNode {
	return (
		<SpotlightCard
			className={`gui-pet-card${selected ? " gui-pet-card--selected" : ""}`}
			spotlightColor="rgba(255, 255, 255, 0.09)"
		>
			<div
				role="radio"
				aria-checked={selected}
				tabIndex={0}
				onClick={onSelect}
				onKeyDown={e => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelect();
					}
				}}
			>
				<span className="gui-pet-card__thumb">
					<PetdexSprite
						mood="rest"
						src={entry.src}
						width={entry.width}
						height={entry.height}
						rows={entry.rows}
						contentH={entry.contentH}
					/>
				</span>
				<span className="gui-pet-card__body">
					<span className="gui-pet-card__name">
						{entry.name}
						{selected && <Icon name="check" className="gui-pet-card__check" />}
					</span>
					<span className="gui-pet-card__desc">{entry.description}</span>
				</span>
				{onDelete && (
					<button
						type="button"
						className="gui-pet-card__delete"
						aria-label={t("delete pet")}
						title={t("delete pet")}
						onClick={e => {
							e.stopPropagation();
							onDelete();
						}}
					>
						<Icon name="delete-bin" className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
		</SpotlightCard>
	);
}

/** One pet from the petdex.dev search API (main-process trimmed shape). */
interface PetdexCatalogEntry {
	slug: string;
	displayName: string;
	description: string | null;
	spritesheetPath: string;
	zipUrl: string | null;
	soundUrl: string | null;
	featured: boolean;
	kind: string | null;
	vibes: string[];
}

/** Compact preview target width for market cards: the 64px thumb with
 *  8px horizontal padding, so a fully-fitted sprite is exactly 56px wide. */
const PET_MARKET_THUMB_PX = 56;

/** One search result in the embedded petdex market: animated preview
 *  (remote spritesheet measured like a local import) + install button. */
function PetMarketCard({
	pet,
	installed,
	installing,
	onInstall,
}: {
	pet: PetdexCatalogEntry;
	installed: boolean;
	installing: boolean;
	onInstall(): void;
}): ReactNode {
	const [meta, setMeta] = useState<{ width: number; height: number; rows: number[]; contentH: number } | null>(null);
	useEffect(() => {
		let alive = true;
		const img = new Image();
		img.src = pet.spritesheetPath;
		img.onload = () => {
			if (!alive) return;
			try {
				const { rows, contentH } = measurePetdex(img);
				setMeta({ width: img.naturalWidth, height: img.naturalHeight, rows, contentH });
			} catch {
				setMeta(null);
			}
		};
		img.onerror = () => {};
		return () => {
			alive = false;
		};
	}, [pet.spritesheetPath]);
	// PetdexSprite normalizes to a 100px-tall body; shrink it to fit the
	// compact market thumb (frame ratios differ per pack, so scale per pack).
	const fit = meta
		? PET_MARKET_THUMB_PX / ((meta.width / PETDEX_COLUMNS) * (PET_CONTENT_TARGET_H / meta.contentH))
		: 1;
	return (
		<div className="gui-pet-market-card">
			<span className="gui-pet-market-card__thumb">
				{meta ? (
					<PetdexSprite
						mood="rest"
						src={pet.spritesheetPath}
						width={meta.width}
						height={meta.height}
						rows={meta.rows}
						contentH={meta.contentH}
						scale={fit}
					/>
				) : (
					<span className="gui-pet-market-card__loading" />
				)}
			</span>
			<span className="gui-pet-market-card__name">{pet.displayName}</span>
			{installed ? (
				<span className="gui-pet-market-card__installed">
					<Icon name="check" className="h-3 w-3" />
					{t("pet installed")}
				</span>
			) : (
				<button
					type="button"
					className="gui-btn gui-btn--small"
					disabled={installing || !pet.zipUrl}
					onClick={onInstall}
				>
					{installing ? "…" : t("pet market install")}
				</button>
			)}
		</div>
	);
}

/** Embedded petdex.dev market: debounced search (main-process IPC — the
 *  site sends no CORS headers), animated previews, one-click install
 *  (download zip → same unpack path as the local import). */
function PetMarket({
	petdex,
	onInstalled,
}: {
	petdex: PetdexPackage[];
	onInstalled(pkg: PetdexPackage): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PetdexCatalogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	// Petdex catalog search in-flight flag (the search effect + status line
	// both reference it — this state was dropped in a refactor, making the
	// search handler throw on first use).
	const [searching, setSearching] = useState(false);
	const searchRef = useRef(0);
	const runSearch = useCallback(async (q: string): Promise<void> => {
		const bridge = (
			window as unknown as {
				electronAPI?: { searchPetdex?(q: string): Promise<{ pets?: PetdexCatalogEntry[]; error?: string }> };
			}
		).electronAPI;
		if (!bridge?.searchPetdex) return;
		const seq = ++searchRef.current;
		setSearching(true);
		try {
			const res = await bridge.searchPetdex(q);
			if (seq !== searchRef.current) return;
			if (res?.error) {
				setError(res.error);
				setResults(null);
			} else {
				setResults(res?.pets ?? []);
				setError(null);
			}
		} catch (err) {
			if (seq !== searchRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (seq === searchRef.current) setSearching(false);
		}
	}, []);
	// Debounced: instant on clear, 350ms while typing (search endpoint is
	// cheap but a keystroke-per-request fan-out is not).
	useEffect(() => {
		const timer = setTimeout(() => void runSearch(query.trim()), query.trim() ? 350 : 0);
		return () => clearTimeout(timer);
	}, [query, runSearch]);
	const install = async (pet: PetdexCatalogEntry): Promise<void> => {
		const bridge = (
			window as unknown as {
				electronAPI?: {
					installPetdexUrl?(
						zipUrl: string,
					): Promise<(PetdexPackage & { width?: number; height?: number }) | { error: string } | null>;
				};
			}
		).electronAPI;
		if (!bridge?.installPetdexUrl || !pet.zipUrl) return;
		setInstalling(pet.slug);
		try {
			const raw = await bridge.installPetdexUrl(pet.zipUrl);
			if (!raw) return;
			if ("error" in raw) {
				setError(raw.error);
				return;
			}
			// Same measure path as the local import: the main process cannot
			// decode image dimensions, and PetdexSprite needs the real frame
			// size + per-row valid frame counts (empty padding columns).
			const img = new Image();
			img.src = raw.spritesheet;
			const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
			img.onload = () => resolveDecoded();
			img.onerror = () => resolveDecoded();
			await decoded;
			if (!img.naturalWidth || !img.naturalHeight) {
				setError("undecodable spritesheet");
				return;
			}
			const { rows, contentH } = measurePetdex(img);
			onInstalled({
				id: raw.id,
				displayName: raw.displayName,
				description: typeof raw.description === "string" && raw.description ? raw.description : undefined,
				spritesheet: raw.spritesheet,
				width: img.naturalWidth,
				height: img.naturalHeight,
				rows,
				contentH,
				importedAt: Date.now(),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(null);
		}
	};
	return (
		<div className="gui-pet-market">
			<div className="gui-pet-market__head">
				<span className="gui-pet-group-label">{t("pet market")}</span>
				<input
					type="search"
					className="gui-input gui-pet-market__search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={t("pet market search placeholder")}
					aria-label={t("pet market")}
				/>
			</div>
			{error && <div className="gui-pet-market__error">{t("pet market error", { reason: error })}</div>}
			{searching && !results ? <div className="gui-pet-market__status">{t("pet market searching")}</div> : null}
			{results && results.length === 0 && !searching ? (
				<div className="gui-pet-market__status">{t("pet market empty")}</div>
			) : null}
			{results && results.length > 0 && (
				<div className="gui-pet-market__grid">
					{results.map(p => (
						<PetMarketCard
							key={p.slug}
							pet={p}
							installed={petdex.some(x => x.id === p.slug)}
							installing={installing === p.slug}
							onInstall={() => void install(p)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function PetSection(): ReactNode {
	const [enabled, setEnabled] = useState<boolean>(() => petEnabled());
	const [mode, setMode] = useState<PetDisplayMode>(() => petMode());
	const [selectedPetId, setSelectedPetId] = useState<string>(() => petId());
	const [petdex, setPetdex] = useState<PetdexPackage[]>(() => loadPetdex());
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
	const [dock, setDock] = useState<boolean>(() => localStorage.getItem("omp-gui-pet-dock") === "1");
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const commit = (): void => {
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};
	const setPref = (key: "omp-gui-pet" | "omp-gui-pet-mode" | "omp-gui-pet-id", value: string): void => {
		localStorage.setItem(key, value);
		commit();
	};
	const pickPet = (id: string): void => {
		setSelectedPetId(id);
		setPref("omp-gui-pet-id", id);
	};
	const importPetdex = async (): Promise<void> => {
		const electronAPI = (
			window as unknown as {
				electronAPI?: {
					importPetdex?(): Promise<
						(PetdexPackage & { width?: number; height?: number }) | { error: string } | null
					>;
				};
			}
		).electronAPI;
		if (!electronAPI?.importPetdex) {
			// Browser/absent bridge — nothing to pick from yet.
			return;
		}
		setImporting(true);
		setImportError(null);
		try {
			const raw = await electronAPI.importPetdex();
			if (!raw) return;
			if ("error" in raw) {
				console.error("[pet] import failed:", raw.error);
				setImportError(t("pet import failed"));
				return;
			}
			// The main process cannot decode image dimensions — measure the
			// spritesheet here (PetdexSprite needs real frame size + the
			// per-row valid frame counts to skip empty padding columns).
			const img = new Image();
			img.src = raw.spritesheet;
			const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
			img.onload = () => resolveDecoded();
			img.onerror = () => resolveDecoded();
			await decoded;
			if (!img.naturalWidth || !img.naturalHeight) {
				console.error("[pet] spritesheet undecodable");
				setImportError(t("pet import failed"));
				return;
			}
			const { rows, contentH } = measurePetdex(img);
			const pkg: PetdexPackage = {
				id: raw.id,
				displayName: raw.displayName,
				description: typeof raw.description === "string" && raw.description ? raw.description : undefined,
				spritesheet: raw.spritesheet,
				width: img.naturalWidth,
				height: img.naturalHeight,
				rows,
				contentH,
				importedAt: Date.now(),
			};
			const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
			savePetdex(next);
			setPetdex(next);
			pickPet(pkg.id);
			setExpanded(true);
		} finally {
			setImporting(false);
		}
	};
	const removePet = (id: string): void => {
		const next = petdex.filter(p => p.id !== id);
		savePetdex(next);
		setPetdex(next);
		if (selectedPetId === id) {
			pickPet(DEFAULT_PET_ID);
		}
	};
	const isDesktopShell =
		typeof (window as unknown as { electronAPI?: { importPetdex?: unknown } }).electronAPI?.importPetdex ===
		"function";
	// Preset names/descriptions are i18n keys (English source strings,
	// localized via collab-web zh-CN); imported packages keep their own
	// pet.json text.
	const presetEntries: PetGridEntry[] = BUILTIN_PETDEX.map(p => ({
		id: p.id,
		name: t(p.displayName as TranslationKey),
		description: t(p.description as TranslationKey),
		src: p.spritesheetPath,
		width: p.width,
		height: p.height,
		rows: p.rows,
		contentH: p.contentH,
		source: "preset",
	}));
	const userEntries: PetGridEntry[] = petdex.map(p => ({
		id: p.id,
		name: p.displayName,
		description: p.description ?? "",
		src: p.spritesheet,
		width: p.width,
		height: p.height,
		rows: p.rows,
		contentH: p.contentH,
		source: "user",
	}));
	const allEntries = [...userEntries, ...presetEntries];
	const selectedEntry = allEntries.find(e => e.id === selectedPetId) ?? null;
	return (
		<>
			<h2 className="gui-settings-page-title">{t("agent companion")}</h2>
			<p className="gui-settings-page-desc">{t("pet settings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("pet display")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("show agent companion")}</div>
						<div className="gui-settings-row-desc">{t("show agent companion description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={enabled}
						className={`gui-toggle${enabled ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !enabled;
							setEnabled(next);
							setPref("omp-gui-pet", next ? "1" : "0");
						}}
						aria-label={t("show agent companion")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{enabled && (
					<>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("pet size")}</div>
								<div className="gui-settings-row-desc">{t("pet size description")}</div>
							</div>
							<div className="flex items-center gap-2">
								<input
									type="range"
									min={PET_SCALE_MIN}
									max={PET_SCALE_MAX}
									step={5}
									value={Math.round(sizeScale * 100)}
									className="gui-range"
									onChange={e => {
										const v = Number(e.target.value);
										setSizeScale(v / 100);
										setPetScale(v);
										commit();
									}}
									aria-label={t("pet size")}
								/>
								<span className="w-10 text-right text-[12.5px] tabular-nums text-[var(--color-text-muted)]">
									{Math.round(sizeScale * 100)}%
								</span>
							</div>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("display position")}</div>
								<div className="gui-settings-row-desc">{t("display position description")}</div>
							</div>
							<select
								className="gui-input gui-pet-mode-select"
								value={mode}
								onChange={e => {
									const next = e.target.value as PetDisplayMode;
									setMode(next);
									setPref("omp-gui-pet-mode", next);
								}}
								aria-label={t("display position")}
							>
								<option value="input">{t("pet display input")}</option>
								<option value="desktop">{t("pet display desktop")}</option>
							</select>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("dock to screen edge")}</div>
								<div className="gui-settings-row-desc">{t("dock to screen edge description")}</div>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={dock}
								className={`gui-toggle${dock ? " gui-toggle--on" : ""}`}
								onClick={() => {
									const next = !dock;
									setDock(next);
									localStorage.setItem("omp-gui-pet-dock", next ? "1" : "0");
									commit();
									const api = (
										window as unknown as { electronAPI?: { setPetDock?(v: boolean): Promise<unknown> } }
									).electronAPI;
									void api?.setPetDock?.(next);
								}}
								aria-label={t("dock to screen edge")}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
					</>
				)}
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("pet appearance")}</div>
				{enabled && (
					<>
						{/* Appearance (BitFun parity): header row with refresh +
						 * import, a trigger showing the selected pet, and an
						 * expandable preset grid grouped 预设 / 已导入. */}
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("companion appearance")}</div>
								<div className="gui-settings-row-desc">{t("companion appearance description")}</div>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									aria-label={t("pet refresh")}
									title={t("pet refresh")}
									onClick={() => {
										setPetdex(loadPetdex());
										setSelectedPetId(petId());
									}}
								>
									<Icon name="refresh" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className="gui-btn"
									onClick={() => void importPetdex()}
									disabled={importing || !isDesktopShell}
									title={isDesktopShell ? t("import petdex") : t("desktop pet needs desktop app")}
								>
									<Icon name="add" className="h-3.5 w-3.5" />
									{importing ? "…" : t("import petdex")}
								</button>
							</div>
							{importError && (
								<p className="gui-pet-import-error" role="alert">
									{importError}
								</p>
							)}
						</div>
						<button
							type="button"
							className="gui-pet-trigger"
							aria-expanded={expanded}
							onClick={() => setExpanded(v => !v)}
						>
							<span className="gui-pet-trigger__thumb">
								{selectedEntry ? (
									<PetdexSprite
										mood="rest"
										src={selectedEntry.src}
										width={selectedEntry.width}
										height={selectedEntry.height}
										rows={selectedEntry.rows}
										contentH={selectedEntry.contentH}
									/>
								) : (
									<BuiltinPetSprite mood="rest" />
								)}
							</span>
							<span className="gui-pet-trigger__name">{selectedEntry?.name ?? t("builtin pet")}</span>
							<Icon
								name="arrow-down"
								className={`gui-pet-trigger__chevron${expanded ? " gui-pet-trigger__chevron--open" : ""}`}
							/>
						</button>
						<Reveal open={expanded}>
							<div className="gui-pet-grid" role="radiogroup" aria-label={t("companion appearance")}>
								{userEntries.length > 0 && <div className="gui-pet-group-label">{t("pet imported")}</div>}
								{userEntries.map(entry => (
									<PetCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedPetId}
										onSelect={() => pickPet(entry.id)}
										onDelete={() => removePet(entry.id)}
									/>
								))}
								<div className="gui-pet-group-label">{t("pet presets")}</div>
								{presetEntries.map(entry => (
									<PetCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedPetId}
										onSelect={() => pickPet(entry.id)}
									/>
								))}
							</div>
						</Reveal>
						<PetMarket
							petdex={petdex}
							onInstalled={pkg => {
								const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
								setPetdex(next);
								savePetdex(next);
								pickPet(pkg.id);
							}}
						/>
					</>
				)}
			</div>
		</>
	);
}

/** Desktop notifications + sound — openchamber parity: a delivery switch
 * (master + focused mode), four event toggles (completion / subtask /
 * error / question), per-event title/message templates with {variable}
 * substitution, and the sound palette below. All prefs are renderer-local. */
function NotificationsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [notify, setNotify] = useState<boolean>(() => notifyEnabled());
	const [focused, setFocused] = useState<boolean>(() => notifyWhileFocused());
	const [eventPrefs, setEventPrefs] = useState<Record<NotifyEvent, boolean>>(() => {
		const out = {} as Record<NotifyEvent, boolean>;
		for (const ev of NOTIFY_EVENTS) out[ev] = eventEnabled(ev);
		return out;
	});
	const [templates, setTemplates] = useState<NotifyTemplates>(() => loadNotifyTemplates());
	const [sound, setSound] = useState<boolean>(() => localStorage.getItem("omp-gui-sound") !== "0");
	const [hapticOn, setHapticOn] = useState<boolean>(() => localStorage.getItem("omp-gui-haptic") !== "0");
	const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null);
	// Idle recap (daemon recap.enabled / recap.idleSeconds — TUI parity).
	// Daemon-side settings (config.yml), unlike the renderer-local prefs
	// above; null = still loading.
	const [recapEnabled, setRecapEnabled] = useState<boolean | null>(null);
	const [recapIdleSeconds, setRecapIdleSeconds] = useState<number>(240);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: ["recap.enabled", "recap.idleSeconds"] })
			.then(res => {
				if (!alive) return;
				if (typeof res?.["recap.enabled"] === "boolean") setRecapEnabled(res["recap.enabled"]);
				if (typeof res?.["recap.idleSeconds"] === "number") setRecapIdleSeconds(res["recap.idleSeconds"]);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("notifications & sound")}</h2>
			<p className="gui-settings-page-desc">{t("notifications settings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("notification delivery")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("enable notifications")}</div>
						<div className="gui-settings-row-desc">{t("enable notifications description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={notify}
						className={`gui-toggle${notify ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !notify;
							setNotify(next);
							localStorage.setItem("omp-gui-notify", next ? "1" : "0");
						}}
						aria-label={t("enable notifications")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={notify}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("notify when focused")}</div>
							<div className="gui-settings-row-desc">{t("notify when focused description")}</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={focused}
							className={`gui-toggle${focused ? " gui-toggle--on" : ""}`}
							onClick={() => {
								const next = !focused;
								setFocused(next);
								localStorage.setItem("omp-gui-notify-focused", next ? "1" : "0");
							}}
							aria-label={t("notify when focused")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("send test notification")}</div>
							<div className="gui-settings-row-desc">{t("send test notification description")}</div>
						</div>
						<button
							type="button"
							className="gui-btn"
							onClick={async () => {
								setTestResult(null);
								const result = await sendTestNotification();
								setTestResult(result);
							}}
						>
							<Icon name="notification-3" className="h-3.5 w-3.5" />
							{t("send test notification")}
						</button>
						{testResult && (
							<p
								className={
									testResult.ok
										? "text-[13px] text-[var(--color-ok)]"
										: "text-[13px] text-[var(--color-error)]"
								}
							>
								{testResult.ok ? t("notification sent") : (testResult.reason ?? t("delivery failed"))}
							</p>
						)}
					</div>
				</Reveal>
			</div>
			<Reveal open={notify}>
				<div className="gui-settings-section">
					<div className="gui-settings-section-title">{t("notification events")}</div>
					{NOTIFY_EVENTS.map(ev => (
						<div key={ev} className="gui-settings-row">
							<div className="gui-settings-row-label">{t(`notification event ${ev}`)}</div>
							<button
								type="button"
								role="switch"
								aria-checked={eventPrefs[ev]}
								className={`gui-toggle${eventPrefs[ev] ? " gui-toggle--on" : ""}`}
								onClick={() => {
									const next = { ...eventPrefs, [ev]: !eventPrefs[ev] };
									setEventPrefs(next);
									saveEventPrefs(next);
								}}
								aria-label={t(`notification event ${ev}`)}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
					))}
				</div>
				<div className="gui-settings-section">
					<div className="gui-settings-section-title">{t("notification templates")}</div>
					<div className="gui-settings-row-desc">
						{t("template variables")}:{" "}
						{TEMPLATE_VARIABLES.map(v => (
							<code key={v} className="gui-tpl-var">{`{${v}}`}</code>
						))}
					</div>
					<div className="gui-notify-tpl-grid">
						{NOTIFY_EVENTS.map(ev => (
							<div key={ev} className="gui-notify-tpl-group">
								<div className="gui-notify-tpl-name">{t(`notification event ${ev}`)}</div>
								<div>
									<label className="gui-notify-tpl-label" htmlFor={`omp-tpl-${ev}-title`}>
										{t("title")}
									</label>
									<input
										id={`omp-tpl-${ev}-title`}
										className="gui-input"
										value={templates[ev].title}
										placeholder={defaultTemplate(ev, "title")}
										onChange={e => {
											const next = { ...templates, [ev]: { ...templates[ev], title: e.target.value } };
											setTemplates(next);
											saveNotifyTemplates(next);
										}}
									/>
								</div>
								<div>
									<label className="gui-notify-tpl-label" htmlFor={`omp-tpl-${ev}-message`}>
										{t("message")}
									</label>
									<input
										id={`omp-tpl-${ev}-message`}
										className="gui-input"
										value={templates[ev].message}
										placeholder={defaultTemplate(ev, "message")}
										onChange={e => {
											const next = { ...templates, [ev]: { ...templates[ev], message: e.target.value } };
											setTemplates(next);
											saveNotifyTemplates(next);
										}}
									/>
								</div>
							</div>
						))}
					</div>
				</div>
			</Reveal>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("sound effects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("sound effects")}</div>
						<div className="gui-settings-row-desc">{t("send chime, tool clicks")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={sound}
						className={`gui-toggle${sound ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !sound;
							setSound(next);
							localStorage.setItem("omp-gui-sound", next ? "1" : "0");
						}}
						aria-label={t("sound effects")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("haptic feedback")}</div>
						<div className="gui-settings-row-desc">{t("haptic feedback description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={hapticOn}
						className={`gui-toggle${hapticOn ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !hapticOn;
							setHapticOn(next);
							localStorage.setItem("omp-gui-haptic", next ? "1" : "0");
						}}
						aria-label={t("haptic feedback")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row-desc">{t("sfx choose per activity")}</div>
				<Reveal open={sound}>
					<div className="gui-sfx-event-list">
						{SFX_EVENTS.map(ev => (
							<SoundEventRow key={ev} ev={ev} />
						))}
					</div>
				</Reveal>
				<div className="gui-settings-row-desc">
					{t("preview each effect; dimmed ones are not wired to the UI yet")}
				</div>
				<div className="gui-sound-grid">
					{ALL_SOUNDS.map(name => {
						const wired = WIRED_SOUNDS.has(name);
						return (
							<div key={name} className={`gui-sound-card${wired ? "" : " gui-sound-card--idle"}`}>
								<button
									type="button"
									className="gui-sound-preview"
									onClick={() => previewSound(name)}
									aria-label={`${t("preview")} ${name}`}
									title={`${t("preview")} ${name}`}
								>
									<Icon name="play" className="h-3.5 w-3.5" />
								</button>
								<div className="min-w-0">
									<div className="gui-sound-name">{name}</div>
									<div className="gui-sound-usage">
										{wired ? t(SOUND_USAGE_KEYS[name] ?? "sound palette") : t("not wired to the UI yet")}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{/* Idle recap (TUI 通知组 parity): daemon-side, persisted to
			 * config.yml — the same recap.enabled / recap.idleSeconds keys
			 * the terminal uses. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("idle recap")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("Idle Recap")}</div>
						<div className="gui-settings-row-desc">
							{t("Generate a brief LLM recap of where things stand after the terminal has been idle")}
						</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={recapEnabled === true}
						className={`gui-toggle${recapEnabled === true ? " gui-toggle--on" : ""}`}
						disabled={recapEnabled === null}
						onClick={() => {
							const next = recapEnabled !== true;
							setRecapEnabled(next);
							if (rpc) {
								void rpc
									.request("settings.set", { key: "recap.enabled", value: next })
									.catch(() => setRecapEnabled(recapEnabled));
							}
						}}
						aria-label={t("Idle Recap")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={recapEnabled !== false}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("Idle Recap Delay")}</div>
							<div className="gui-settings-row-desc">
								{t("Seconds to wait while idle before showing the recap")}
							</div>
						</div>
						<select
							className="gui-settings-select"
							value={String(recapIdleSeconds)}
							disabled={recapEnabled === null}
							onChange={e => {
								const next = Number(e.target.value);
								setRecapIdleSeconds(next);
								if (rpc) {
									void rpc.request("settings.set", { key: "recap.idleSeconds", value: next }).catch(() => {});
								}
							}}
							aria-label={t("Idle Recap Delay")}
						>
							{[60, 120, 240, 300, 600].map(seconds => (
								<option key={seconds} value={String(seconds)}>
									{t("idle recap delay option", { count: String(seconds / 60) })}
								</option>
							))}
						</select>
					</div>
				</Reveal>
			</div>
		</>
	);
}

/** Session behavior: auto titles, delete-confirmation toggle, and
 *  auto-cleanup of stale sessions (archive = session.close → daemon
 *  history snapshot; delete = session.delete). New-session model and
 *  thinking defaults live on the model-settings tab (default role) — the
 *  duplicates once kept here were removed. openchamber
 *  DefaultsSettings + SessionRetentionSettings parity. */
function SessionsSection({
	rpc,
	currentSessionId,
}: {
	rpc: RpcClient | null;
	currentSessionId: string | null;
}): ReactNode {
	const [autoTitle, setAutoTitle] = useState<boolean>(() => localStorage.getItem("omp-gui-autotitle") !== "0");
	const [confirmDelete, setConfirmDelete] = useState<boolean>(
		() => localStorage.getItem("omp-gui-confirm-delete") !== "0",
	);
	// ── retention (openchamber SessionRetentionSettings parity) ──────────
	const MIN_DAYS = 1;
	const MAX_DAYS = 365;
	const [cleanupOn, setCleanupOn] = useState<boolean>(cleanupEnabledPref);
	const [cleanupDays, setCleanupDays] = useState<number>(cleanupDaysPref);
	const [cleanupAction, setCleanupAction] = useState<"archive" | "delete">(cleanupActionPref);
	const [candidates, setCandidates] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const lastRunRef = useRef(0);
	// Sessions already acted on this session (archive keeps them in the
	// daemon list as history snapshots — exclude them so the count clears
	// instead of re-offering them forever; openchamber marks them archived).
	const cleanedRef = useRef<Set<string>>(new Set());

	/** Stale sessions = older than the cutoff, excluding the current one and
	 *  the 5 most recently active (openchamber keepRecent parity). Shared
	 *  with the app-shell auto-cleanup (lib/session-cleanup). */
	const computeCandidates = useCallback(async (): Promise<string[]> => {
		if (!rpc) return [];
		const list = await cleanupCandidates(rpc, cleanupDays, currentSessionId);
		return list.map(c => c.id).filter(id => !cleanedRef.current.has(id));
	}, [rpc, cleanupDays, currentSessionId]);

	useEffect(() => {
		void computeCandidates().then(setCandidates);
	}, [computeCandidates]);

	const runCleanup = useCallback(
		async (force = false): Promise<void> => {
			if (running) return;
			if (!cleanupOn && !force) return;
			if (!force && Date.now() - lastRunRef.current < 86_400_000) return;
			setRunning(true);
			try {
				const ids = await computeCandidates();
				if (rpc && ids.length > 0) {
					await runCleanupOnce(rpc, ids, cleanupAction);
					for (const id of ids) cleanedRef.current.add(id);
				}
				lastRunRef.current = Date.now();
				setCandidates(await computeCandidates());
			} finally {
				setRunning(false);
			}
		},
		[running, cleanupOn, rpc, cleanupAction, computeCandidates],
	);

	// Auto mode: hourly check, at most one run per 24h (cooldown parity).
	useEffect(() => {
		if (!cleanupOn) return;
		const id = setInterval(() => void runCleanup(), 3_600_000);
		return () => clearInterval(id);
	}, [cleanupOn, runCleanup]);

	const setDays = (next: number): void => {
		const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, next));
		setCleanupDays(clamped);
		localStorage.setItem("omp-gui-autoclean-days", String(clamped));
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("sessions")}</h2>
			<p className="gui-settings-page-desc">{t("sessions settings")}</p>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("session defaults")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("auto title")}</div>
						<div className="gui-settings-row-desc">{t("auto title description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoTitle}
						className={`gui-toggle${autoTitle ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !autoTitle;
							setAutoTitle(next);
							localStorage.setItem("omp-gui-autotitle", next ? "1" : "0");
						}}
						aria-label={t("auto title")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("show delete dialog")}</div>
						<div className="gui-settings-row-desc">{t("show delete dialog description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={confirmDelete}
						className={`gui-toggle${confirmDelete ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !confirmDelete;
							setConfirmDelete(next);
							localStorage.setItem("omp-gui-confirm-delete", next ? "1" : "0");
						}}
						aria-label={t("show delete dialog")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("session retention")}</div>
				<div className="gui-settings-section-desc">{t("session retention description")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("enable auto cleanup")}</div>
						<div className="gui-settings-row-desc">{t("enable auto cleanup description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={cleanupOn}
						className={`gui-toggle${cleanupOn ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !cleanupOn;
							setCleanupOn(next);
							localStorage.setItem("omp-gui-autoclean", next ? "1" : "0");
						}}
						aria-label={t("enable auto cleanup")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("retention days")}</div>
						<div className="gui-settings-row-desc">{t("retention days description")}</div>
					</div>
					<div className="gui-settings-control">
						<div className="gui-settings-stepper" aria-disabled={!cleanupOn}>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("decrease")}
								onClick={() => setDays(cleanupDays - 1)}
							>
								<Icon name="subtract" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-stepper-value">{cleanupDays}</span>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("increase")}
								onClick={() => setDays(cleanupDays + 1)}
							>
								<Icon name="add" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-settings-stepper-unit">{t("days")}</span>
						</div>
					</div>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("session expiry action")}</div>
						<div className="gui-settings-row-desc">{t("session expiry action description")}</div>
					</div>
					<div className="gui-segmented">
						<button
							type="button"
							className={`gui-seg-btn${cleanupAction === "archive" ? " gui-seg-btn--active" : ""}`}
							onClick={() => {
								setCleanupAction("archive");
								localStorage.setItem("omp-gui-autoclean-action", "archive");
							}}
						>
							{t("archive")}
						</button>
						<button
							type="button"
							className={`gui-seg-btn${cleanupAction === "delete" ? " gui-seg-btn--active" : ""}`}
							onClick={() => {
								setCleanupAction("delete");
								localStorage.setItem("omp-gui-autoclean-action", "delete");
							}}
						>
							{t("delete")}
						</button>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("manual cleanup")}</div>
						<div className="gui-settings-row-desc">
							{running ? t("cleanup running") : t("archivable count", { count: String(candidates.length) })}
						</div>
					</div>
					<button
						type="button"
						className="gui-btn"
						disabled={running || candidates.length === 0}
						onClick={() => void runCleanup(true)}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						{t("run cleanup now")}
					</button>
				</div>
			</div>
		</>
	);
}

/** Read-only keyboard shortcut reference (openchamber parity). */
interface GitAuthState {
	installed?: boolean;
	authenticated?: boolean;
	login?: string;
	email?: string;
	avatarUrl?: string;
	active?: boolean;
	detail?: string;
}

interface GitDeviceFlow {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

interface GitIdentity {
	id: string;
	name: string;
	email: string;
}

/** Git settings (openchamber GitPage parity): GitHub OAuth via the gh CLI
 *  (device flow → gh auth login --with-token, so all gh RPCs pick it up)
 *  plus named commit identities. Identities are stored client-side
 *  (omp-gui-git-identities) — no commit UI consumes them yet, but the
 *  default identity is what a future git commit flow should use. */
function GitSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	// ── GitHub auth ──────────────────────────────────────────────────────
	const [avatarFailed, setAvatarFailed] = useState(false);
	const [auth, setAuth] = useState<GitAuthState | null>(null);
	const [authLoading, setAuthLoading] = useState(false);
	const [flow, setFlow] = useState<GitDeviceFlow | null>(null);
	const [flowError, setFlowError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshAuth = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		setAuthLoading(true);
		try {
			const next = await rpc.request<GitAuthState>("github.authStatus", {});
			setAuth(next);
			// Sync the GitHub avatar to the chat user bubble (UserAvatar
			// reads this key synchronously — zero RPC per message).
			if (next?.avatarUrl) localStorage.setItem("omp-gui-user-avatar", next.avatarUrl);
			else localStorage.removeItem("omp-gui-user-avatar");
		} catch (err) {
			// RPC failure (e.g. daemon predates github.authStatus) is NOT the
			// same as gh missing — keep the detail so the UI can say so.
			setAuth({ installed: false, detail: err instanceof Error ? err.message : String(err) });
		} finally {
			setAuthLoading(false);
		}
	}, [rpc]);

	useEffect(() => {
		void refreshAuth();
		return () => {
			if (pollRef.current) clearTimeout(pollRef.current);
		};
	}, [refreshAuth]);

	// new login → re-enable the avatar image (previous one may have failed)
	useEffect(() => {
		setAvatarFailed(false);
	}, []);

	const stopFlow = (): void => {
		if (pollRef.current) clearTimeout(pollRef.current);
		pollRef.current = null;
		setFlow(null);
		setFlowError(null);
		setCopied(false);
	};

	const [copied, setCopied] = useState(false);
	const copyCode = async (): Promise<void> => {
		if (!flow) return;
		try {
			await navigator.clipboard.writeText(flow.userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable — code stays visible for manual entry
		}
	};

	const pollFlow = useCallback(
		async (flowState: GitDeviceFlow): Promise<void> => {
			if (!rpc) return;
			try {
				const res = await rpc.request<{
					pending?: boolean;
					interval?: number;
					connected?: boolean;
					login?: string;
					error?: string;
				}>("github.authPoll", { deviceCode: flowState.deviceCode, interval: flowState.interval });
				if (res.pending) {
					pollRef.current = setTimeout(
						() => void pollFlow(flowState),
						(res.interval ?? flowState.interval) * 1000,
					);
					return;
				}
				if (res.connected) {
					setFlow(null);
					void refreshAuth();
					return;
				}
				stopFlow();
				setFlowError(res.error ?? t("github auth failed"));
			} catch (err) {
				stopFlow();
				setFlowError(err instanceof Error ? err.message : String(err));
			}
		},
		[rpc, refreshAuth, stopFlow],
	);

	const startFlow = async (): Promise<void> => {
		if (!rpc) return;
		setFlowError(null);
		try {
			const res = await rpc.request<GitDeviceFlow | { error?: string }>("github.authStart", {});
			if ("error" in res && res.error) {
				setFlowError(res.error);
				return;
			}
			const started = res as GitDeviceFlow;
			setFlow(started);
			void openExternalUrl(started.verificationUri);
			pollRef.current = setTimeout(() => void pollFlow(started), Math.max(5, started.interval) * 1000);
		} catch (err) {
			setFlowError(err instanceof Error ? err.message : String(err));
		}
	};

	const disableAuth = async (): Promise<void> => {
		if (!rpc) return;
		const ok = await confirm(t("confirm disable github auth"));
		if (!ok) return;
		setAuthLoading(true);
		try {
			await rpc.request("github.authLogout", {});
		} finally {
			await refreshAuth();
		}
	};

	// ── Identities ───────────────────────────────────────────────────────
	const [identities, setIdentities] = useState<GitIdentity[]>(() => {
		try {
			const raw = localStorage.getItem("omp-gui-git-identities");
			return raw ? (JSON.parse(raw) as GitIdentity[]) : [];
		} catch {
			return [];
		}
	});
	const [defaultIdentity, setDefaultIdentity] = useState<string | null>(() => {
		try {
			return localStorage.getItem("omp-gui-git-default-identity");
		} catch {
			return null;
		}
	});
	const saveIdentities = (next: GitIdentity[]): void => {
		setIdentities(next);
		try {
			localStorage.setItem("omp-gui-git-identities", JSON.stringify(next));
		} catch {
			// storage unavailable
		}
	};
	const addIdentity = async (): Promise<void> => {
		const name = await prompt({ title: t("new identity name"), placeholder: t("identity name") });
		if (!name) return;
		const email = await prompt({ title: t("new identity email"), placeholder: t("identity email") });
		if (!email) return;
		const id = crypto.randomUUID();
		saveIdentities([...identities, { id, name, email }]);
		if (!defaultIdentity) {
			setDefaultIdentity(id);
			try {
				localStorage.setItem("omp-gui-git-default-identity", id);
			} catch {
				// storage unavailable
			}
		}
	};
	const removeIdentity = async (id: string): Promise<void> => {
		const ok = await confirm(t("confirm delete identity"));
		if (!ok) return;
		saveIdentities(identities.filter(i => i.id !== id));
		if (defaultIdentity === id) {
			setDefaultIdentity(null);
			try {
				localStorage.removeItem("omp-gui-git-default-identity");
			} catch {
				// storage unavailable
			}
		}
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("git settings")}</h2>
			<p className="gui-settings-page-desc">{t("git settings description")}</p>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("github oauth token")}</div>
				<div className="gui-settings-section-desc">{t("github oauth token description")}</div>
				{authLoading && !auth ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{t("loading")}</div>
					</div>
				) : auth?.installed === false ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">
							{t("gh cli not installed")}
							{auth.detail && <span className="block text-[12px] opacity-70">({auth.detail})</span>}
						</div>
					</div>
				) : auth?.authenticated ? (
					<div className="gui-github-card">
						{auth.avatarUrl && !avatarFailed ? (
							<img
								src={auth.avatarUrl}
								alt=""
								className="gui-github-avatar-img"
								onError={() => setAvatarFailed(true)}
							/>
						) : (
							<div className="gui-github-avatar">{auth.login?.slice(0, 1).toUpperCase() ?? "?"}</div>
						)}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<Icon name="github" className="h-3.5 w-3.5" />
								<span className="font-medium">{auth.login ?? t("unknown")}</span>
								{auth.email && (
									<span className="text-[12px] text-[var(--color-text-muted)]">· {auth.email}</span>
								)}
							</div>
							<div className="text-[12px] text-[var(--color-text-muted)]">{t("authenticated via gh cli")}</div>
						</div>
						<button type="button" className="gui-btn" disabled={authLoading} onClick={() => void disableAuth()}>
							{t("disable")}
						</button>
					</div>
				) : (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{auth?.detail || t("not authenticated via gh cli")}</div>
					</div>
				)}
				{flow && (
					<div className="gui-github-flow">
						<div className="gui-github-flow-title">{t("authorize device")}</div>
						<div className="gui-github-flow-hint">{t("github device flow hint")}</div>
						<div className="gui-github-flow-code-row">
							<code className="gui-github-flow-code">{flow.userCode}</code>
							<button type="button" className="gui-btn gui-github-flow-copy" onClick={() => void copyCode()}>
								{copied ? t("code copied") : t("copy code")}
							</button>
						</div>
						<div className="gui-github-flow-actions">
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								onClick={() => void openExternalUrl(flow.verificationUri)}
							>
								<Icon name="external-link" className="h-3.5 w-3.5" />
								{t("open github")}
							</button>
							<button type="button" className="gui-link" onClick={stopFlow}>
								{t("cancel")}
							</button>
						</div>
						<div className="gui-github-flow-waiting">
							<span className="gui-flow-spinner" aria-hidden="true" />
							{t("waiting approval")}
						</div>
					</div>
				)}
				{flowError && <div className="mt-2 text-[12.5px] text-[var(--color-danger)]">{flowError}</div>}
				{!auth?.authenticated && !flow && (
					<div className="mt-2 flex justify-center">
						<button type="button" className="gui-btn" disabled={authLoading} onClick={() => void startFlow()}>
							<Icon name="add" className="h-3.5 w-3.5" />
							{t("add account")}
						</button>
					</div>
				)}
			</div>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("git preferences")}</div>
				<div className="gui-settings-section-desc">{t("git preferences description")}</div>
				<GitPrefsRow />
			</div>

			<div className="gui-settings-section">
				<div className="flex items-center justify-between">
					<div>
						<div className="gui-settings-section-title">{t("identities")}</div>
						<div className="gui-settings-section-desc">{t("identities description")}</div>
					</div>
					<button type="button" className="gui-btn" onClick={() => void addIdentity()}>
						<Icon name="add" className="h-3.5 w-3.5" />
						{t("new identity")}
					</button>
				</div>
				{identities.length === 0 ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{t("no identities yet")}</div>
					</div>
				) : (
					identities.map(idt => (
						<div key={idt.id} className="gui-identity-row">
							<Icon name="user-3" className="h-4 w-4 text-[var(--color-text-faint)]" />
							<div className="min-w-0 flex-1">
								<div className="text-[13.5px]">
									{idt.name}
									{defaultIdentity === idt.id && <span className="gui-identity-default">{t("default")}</span>}
								</div>
								<div className="text-[12px] text-[var(--color-text-muted)]">{idt.email}</div>
							</div>
							<button
								type="button"
								className="gui-view-opt"
								title={t("set default")}
								aria-label={t("set default")}
								disabled={defaultIdentity === idt.id}
								onClick={() => {
									setDefaultIdentity(idt.id);
									try {
										localStorage.setItem("omp-gui-git-default-identity", idt.id);
									} catch {
										// storage unavailable
									}
								}}
							>
								<Icon name="check" className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								className="gui-view-opt gui-view-opt--danger"
								title={t("delete")}
								aria-label={t("delete")}
								onClick={() => void removeIdentity(idt.id)}
							>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
							</button>
						</div>
					))
				)}
			</div>
		</>
	);
}

/** openchamber GitSettings parity: changes-view mode, gitmoji picker and
 *  show-gitignored — consumed by the right-pane DiffPane (same keys). */
function GitPrefsRow(): ReactNode {
	const [view, setViewState] = useState<"flat" | "tree">(() =>
		localStorage.getItem("omp-gui-git-view") === "tree" ? "tree" : "flat",
	);
	const [gitmoji, setGitmoji] = useState<boolean>(() => localStorage.getItem("omp-gui-gitmoji") !== "0");
	const [showIgnored, setShowIgnored] = useState<boolean>(
		() => localStorage.getItem("omp-gui-git-show-ignored") === "1",
	);
	return (
		<>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("changes view")}</div>
					<div className="gui-settings-row-desc">{t("changes view description")}</div>
				</div>
				<div className="gui-segmented">
					<button
						type="button"
						className={`gui-seg-btn${view === "flat" ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setViewState("flat");
							localStorage.setItem("omp-gui-git-view", "flat");
						}}
					>
						{t("flat list")}
					</button>
					<button
						type="button"
						className={`gui-seg-btn${view === "tree" ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setViewState("tree");
							localStorage.setItem("omp-gui-git-view", "tree");
						}}
					>
						{t("tree view")}
					</button>
				</div>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("enable gitmoji picker")}</div>
					<div className="gui-settings-row-desc">{t("enable gitmoji picker description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={gitmoji}
					className={`gui-toggle${gitmoji ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !gitmoji;
						setGitmoji(next);
						localStorage.setItem("omp-gui-gitmoji", next ? "1" : "0");
						// Live consumers (ContextPanel gitmojiOn badge) re-read
						// on this event — same-window storage events don't fire.
						window.dispatchEvent(new CustomEvent("omp-gitmoji-changed"));
					}}
					aria-label={t("enable gitmoji picker")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("show gitignored")}</div>
					<div className="gui-settings-row-desc">{t("show gitignored description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={showIgnored}
					className={`gui-toggle${showIgnored ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !showIgnored;
						setShowIgnored(next);
						localStorage.setItem("omp-gui-git-show-ignored", next ? "1" : "0");
					}}
					aria-label={t("show gitignored")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
		</>
	);
}

function ShortcutsSection(): ReactNode {
	const rows: { keys: string; action: string }[] = [
		{ keys: "⌘N", action: t("new task shortcut") },
		{ keys: "⌘K", action: t("search shortcut") },
		{ keys: "⌘,", action: t("settings shortcut") },
		{ keys: "⌘E", action: t("toggle panel shortcut") },
		{ keys: "⌘⇧E", action: t("focus mode shortcut") },
		{ keys: "⌘B", action: t("toggle sidebar shortcut") },
		{ keys: "⌘J", action: t("toggle terminal shortcut") },
		{ keys: "⌘O", action: t("open folder shortcut") },
		{ keys: "⌘L", action: t("quote selection shortcut") },
		{ keys: "⌘⇧L", action: t("ask selection shortcut") },
		{ keys: "⌘↩", action: t("send message shortcut") },
		{ keys: "⌘↓", action: t("scroll transcript shortcut") },
		{ keys: "⎋", action: t("stop agent shortcut") },
	];
	return (
		<>
			<h2 className="gui-settings-page-title">{t("shortcuts")}</h2>
			<p className="gui-settings-page-desc">{t("shortcuts settings")}</p>
			<div className="gui-kbd-table">
				<div className="gui-kbd-row gui-kbd-row--head">
					<span>{t("shortcut")}</span>
					<span>{t("action")}</span>
				</div>
				{rows.map(row => (
					<div key={row.keys} className="gui-kbd-row">
						<kbd className="gui-kbd">{row.keys}</kbd>
						<span>{row.action}</span>
					</div>
				))}
			</div>
		</>
	);
}

/** Settings → 交互: TUI interaction-tab parity (input/approvals/
 *  notifications/speech/collab/magic-keywords/startup/power/agent/
 *  language/git groups), schema driven. */
function InteractionSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("interaction")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} />
		</>
	);
}

/** Settings → 上下文: TUI context-tab parity (general/compaction/
 *  TTSR/experimental groups), schema driven. */
function ContextSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("context")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["context"]} />
		</>
	);
}

/** Settings → Shell: TUI shell-tab parity (bash/eval groups), schema
 *  driven. */
function ShellSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("shell")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["shell"]} />
		</>
	);
}

/** Settings → 工具: TUI tools-tab parity (available tools/todos/grep &
 *  browser/computer/github/output-limits/execution/discovery/dev groups),
 *  schema driven. */
function ToolsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("tools")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["tools"]} />
		</>
	);
}

/** Settings → Files & LSP: every setting with ui metadata on the daemon's
 *  "files" tab (edit/read/summarize/lsp groups), rendered from
 *  settings.schema — the single source of truth the TUI panel uses, so
 *  the GUI can't drift from the underlying implementation. */
function FilesLspSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("files & lsp")}</h2>
			<p className="gui-settings-page-desc">{t("files & lsp settings")}</p>
			<SchemaTabSection rpc={rpc} tabs={["files"]} />
		</>
	);
}

/** Settings → Memory: the full memory subsystem (backend choice,
 *  auto-learn, Mnemopi, Hindsight) — TUI memory-tab parity, schema
 *  driven. */
function MemorySection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("memory settings")}</h2>
			<p className="gui-settings-page-desc">{t("memory settings description")}</p>
			<SchemaTabSection rpc={rpc} tabs={["memory"]} />
		</>
	);
}

/** Schema-driven settings tab: fetches settings.schema + current values
 *  from the daemon and renders every item via {@link SchemaSettings}.
 *  Changes are optimistic settings.set calls (reverted on failure). */
/** Preview of the two task-card styles (display.taskCardStyle settings
 *  row): Swarm = the classic chat-message task tool-call card with the
 *  floating frosted member-grid card beneath it (the composer chip opens
 *  that floating card); Classic = the plain tool-call card only. Static
 *  mock-ups — clicking either card switches the style (the preview IS the
 *  control; the standard select is hidden for this row). */
function TaskCardStylePreview({
	value,
	onPick,
}: {
	value: unknown;
	onPick(style: "swarm" | "classic"): void;
}): ReactNode {
	const active = value === "classic" ? "classic" : "swarm";
	const classicCard = (
		<div className="gui-taskstyle-preview-chat">
			<div className="gui-taskstyle-preview-head">
				<span className="gui-taskstyle-preview-tool">task</span>
				<span className="gui-taskstyle-preview-chip">4 个任务</span>
				<span className="gui-taskstyle-preview-chip">4 / 4</span>
			</div>
		</div>
	);
	const swarm = (
		<div className="gui-taskstyle-preview-stack">
			{classicCard}
			{/* Floating member grid (composer chip → frosted card mock). */}
			<div className="gui-taskstyle-preview-float">
				<div className="gui-taskstyle-preview-head">
					<span className="gui-taskstyle-preview-title">Survey repos</span>
					<span className="gui-taskstyle-preview-chip">4 / 4</span>
				</div>
				<div className="gui-taskstyle-preview-grid">
					{[
						["SD", "ok"],
						["PR", "ok"],
						["OC", "ok"],
						["KC", "err"],
					].map(([ab, tone]) => (
						<div key={ab} className={`gui-taskstyle-preview-member gui-taskstyle-preview-member--${tone}`}>
							<span className={`gui-taskstyle-preview-avatar gui-taskstyle-preview-avatar--${tone}`}>{ab}</span>
							<span className="gui-taskstyle-preview-bar">
								<span className={`gui-taskstyle-preview-fill gui-taskstyle-preview-fill--${tone}`} />
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
	const classic = (
		<div className="gui-taskstyle-preview-stack">
			{classicCard}
		</div>
	);
	return (
		<div className="gui-taskstyle-preview">
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "swarm" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "swarm"}
				onClick={() => onPick("swarm")}
			>
				{swarm}
				<span className="gui-taskstyle-preview-label">Swarm</span>
			</button>
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "classic" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "classic"}
				onClick={() => onPick("classic")}
			>
				{classic}
				<span className="gui-taskstyle-preview-label">Classic</span>
			</button>
		</div>
	);
}

function SchemaTabSection({ rpc, tabs }: { rpc: RpcClient | null; tabs: string[] }): ReactNode {
	const [schema, setSchema] = useState<SchemaItem[] | null>(null);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, SchemaItem[]>>("settings.schema", { tabs })
			.then(async res => {
				if (!alive) return;
				const items = (res[tabs[0] ?? ""] ?? []) as SchemaItem[];
				setSchema(items);
				const vals = await rpc.request<Record<string, unknown>>("settings.get", { keys: items.map(i => i.key) });
				if (alive) {
					setValues(vals ?? {});
					setError(null);
				}
			})
			.catch(err => alive && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			alive = false;
		};
	}, [rpc, tabs]);
	const onChange = (key: string, value: unknown): void => {
		if (!rpc) return;
		// Optimistic flip; revert on failure.
		setValues(prev => ({ ...prev, [key]: value }));
		void rpc
			.request("settings.set", { key, value })
			.then(() => setError(null))
			.catch(err => {
				setValues(prev => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
				setError(err instanceof Error ? err.message : String(err));
			});
	};
	return (
		<SchemaSettings
			items={schema ?? []}
			values={values}
			onChange={onChange}
			error={error}
			renderExtra={(key, value, commit) =>
				key === "display.taskCardStyle" ? (
					<TaskCardStylePreview value={value} onPick={style => commit("display.taskCardStyle", style)} />
				) : null
			}
		/>
	);
}

function GeneralSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [info, setInfo] = useState<{
		version?: string;
		musepiVersion?: string | null;
		engineVersion?: string;
		engine?: string;
		dataRoot?: string;
		configDir?: string;
		runtime?: string;
	} | null>(null);
	const [metaErr, setMetaErr] = useState<string | null>(null);
	const [pickedRoot, setPickedRoot] = useState<string | null>(null);
	const [rootBusy, setRootBusy] = useState(false);
	const [rootMsg, setRootMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [updateStatus, setUpdateStatus] = useState<string>(t("check for updates"));
	const [updateChecking, setUpdateChecking] = useState(false);
	const runUpdateCheck = async (): Promise<void> => {
		const api = (window as unknown as { electronAPI?: { checkUpdates?(): Promise<unknown> } }).electronAPI;
		if (!api?.checkUpdates) {
			setUpdateStatus(t("updates only in the desktop app"));
			return;
		}
		setUpdateChecking(true);
		try {
			const r = (await api.checkUpdates()) as {
				enabled?: boolean;
				newer?: boolean;
				latest?: string;
				current?: string;
				url?: string;
				error?: string;
				reason?: string;
			};
			if (!r.enabled) setUpdateStatus(t("no update source configured"));
			else if (r.error) setUpdateStatus(`⚠ ${r.error}`);
			else if (r.newer) {
				setUpdateStatus(`${t("new version")}: v${r.latest}`);
				if (r.url) window.open(r.url, "_blank");
			} else setUpdateStatus(`${t("up to date")} (v${r.current ?? "?"})`);
		} finally {
			setUpdateChecking(false);
		}
	};
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("omp-gui-dotmatrix") !== "0");
	const [avatarId, setAvatarId] = useState<string>(avatarPresetId);
	// Busy-state plain-Enter behavior (dsh parity): steer (TUI default) or
	// queue; Cmd/Ctrl+Enter uses the opposite.
	const [busyEnter, setBusyEnterState] = useState<"steer" | "queue">("steer");
	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: ["busyEnter"] })
			.then(v => {
				const b = v?.busyEnter;
				if (b === "queue" || b === "steer") setBusyEnterState(b);
			})
			.catch(() => {});
	}, [rpc]);
	const setBusyEnter = (next: "steer" | "queue"): void => {
		setBusyEnterState(next);
		void rpc
			?.request("settings.set", { key: "busyEnter", value: next })
			.then(() => window.dispatchEvent(new CustomEvent("omp-settings-changed", { detail: { key: "busyEnter" } })))
			.catch(() => {});
	};
	const [dotMatrixText, setDotMatrixText] = useState(() => localStorage.getItem("omp-gui-dotmatrix-text") ?? "MusePi");
	const [keepAwake, setKeepAwake] = useState(() => localStorage.getItem("omp-gui-keep-awake") === "1");
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{
					version?: string;
					musepiVersion?: string | null;
					engineVersion?: string;
					engine?: string;
					dataRoot?: string;
					configDir?: string;
					runtime?: string;
				}>("system.meta")
				.then(res => {
					if (alive) {
						setInfo(res ?? null);
						setMetaErr(null);
					}
				})
				.catch(err => alive && setMetaErr(err instanceof Error ? err.message : String(err)));
		};
		load();
		// After a data-root migration the daemon restarts and the WS drops;
		// poll until the reconnect serves the new root.
		const timer = setInterval(load, 4000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc]);
	const daemonUrl = (() => {
		try {
			return localStorage.getItem("omp-gui-url") ?? "ws://127.0.0.1:8300";
		} catch {
			return "ws://127.0.0.1:8300";
		}
	})();
	return (
		<>
			<h2 className="gui-settings-page-title">{t("general")}</h2>
			<p className="gui-settings-page-desc">{t("general settings")}</p>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("busy enter behavior")}</div>
					<div className="gui-settings-row-desc">{t("busy enter behavior description")}</div>
				</div>
				<select
					className="gui-input max-w-[200px]"
					value={busyEnter}
					onChange={e => setBusyEnter(e.target.value === "queue" ? "queue" : "steer")}
					aria-label={t("busy enter behavior")}
				>
					<option value="queue">{t("busy enter queue")}</option>
					<option value="steer">{t("busy enter steer")}</option>
				</select>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("agent avatar style")}</div>
					<div className="gui-settings-row-desc">{t("agent avatar style description")}</div>
				</div>
				<div className="flex items-center gap-1.5">
					{AVATAR_PRESETS.map(p => (
						<button
							key={p.id}
							type="button"
							className={`gui-avatar-opt${avatarId === p.id ? " gui-avatar-opt--active" : ""}`}
							title={t(p.labelKey as TranslationKey)}
							aria-pressed={avatarId === p.id}
							onClick={() => {
								setAvatarId(p.id);
								localStorage.setItem("omp-gui-avatar", p.id);
								window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
							}}
						>
							{p.render("working", 20)}
						</button>
					))}
				</div>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("dot matrix background")}</div>
					<div className="gui-settings-row-desc">{t("dot matrix background description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={dotMatrixOn}
					className={`gui-toggle${dotMatrixOn ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !dotMatrixOn;
						setDotMatrixOn(next);
						localStorage.setItem("omp-gui-dotmatrix", next ? "1" : "0");
						window.dispatchEvent(new CustomEvent("omp-dotmatrix-changed"));
					}}
					aria-label={t("dot matrix background")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			{dotMatrixOn && (
				<div className="gui-settings-row">
					<div className="w-full">
						<div className="gui-settings-row-label">{t("dot matrix text")}</div>
						<div className="gui-settings-row-desc">{t("dot matrix text description")}</div>
						<input
							className="gui-input mt-2 w-full max-w-[320px]"
							value={dotMatrixText}
							maxLength={24}
							placeholder="MusePi"
							onChange={e => {
								const v = e.target.value;
								setDotMatrixText(v);
								localStorage.setItem("omp-gui-dotmatrix-text", v);
								window.dispatchEvent(new CustomEvent("omp-dotmatrix-changed"));
							}}
							aria-label={t("dot matrix text")}
						/>
						<div className="gui-dotmatrix-preview" aria-hidden="true">
							<DotMatrixMark text={dotMatrixText || "MusePi"} fontSize={96} />
						</div>
					</div>
				</div>
			)}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("keep computer awake")}</div>
					<div className="gui-settings-row-desc">{t("keep computer awake description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={keepAwake}
					className={`gui-toggle${keepAwake ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !keepAwake;
						setKeepAwake(next);
						localStorage.setItem("omp-gui-keep-awake", next ? "1" : "0");
						void (
							window as unknown as { electronAPI?: { setKeepAwake?(v: boolean): Promise<unknown> } }
						).electronAPI?.setKeepAwake?.(next);
					}}
					aria-label={t("keep computer awake")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("daemon")}</div>
					<div className="text-[13px] text-[var(--color-text-muted)]">{daemonUrl}</div>
				</div>
			</div>
			{info && (
				<>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("version")}</div>
							{/* MusePi brand version first; the daemon reports the OMP
							 * engine version when it was spawned unbranded. */}
							<div className="text-[13px] text-[var(--color-text-muted)]">
								MusePi {info.musepiVersion ?? info.version}
							</div>
						</div>
					</div>
					{info.engineVersion && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("engine")}</div>
								<div className="text-[13px] text-[var(--color-text-muted)]">OMP {info.engineVersion}</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div className="w-full">
							<div className="gui-settings-row-label">{t("data storage path")}</div>
							<div className="gui-settings-row-desc">{t("data storage path description")}</div>
							<div className="mt-2 flex items-center gap-2">
								<div className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-muted)]">
									{pickedRoot ?? info?.dataRoot ?? info?.configDir ?? "—"}
								</div>
								{typeof window.electronAPI?.dataRootApply === "function" && (
									<>
										<button
											type="button"
											className="gui-btn px-3 py-1.5 text-[12.5px]"
											disabled={rootBusy}
											onClick={() => {
												void window.electronAPI
													?.openDirectory()
													.then(dir => {
														if (typeof dir === "string" && dir !== "") setPickedRoot(dir);
														setRootMsg(null);
													})
													.catch(err =>
														setRootMsg({
															ok: false,
															text: t("data root migrate failed: {error}", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													);
											}}
										>
											{t("select folder")}
										</button>
										<button
											type="button"
											className="gui-btn gui-btn-primary px-3 py-1.5 text-[12.5px]"
											disabled={rootBusy || !pickedRoot}
											onClick={() => {
												if (!pickedRoot) return;
												setRootBusy(true);
												setRootMsg(null);
												void window.electronAPI
													?.dataRootApply(pickedRoot)
													.then(res => {
														if (res?.ok) {
															setPickedRoot(null);
															setRootMsg({ ok: true, text: t("data root migrated") });
														} else {
															setRootMsg({
																ok: false,
																text: t("data root migrate failed: {error}", {
																	error: res?.error ?? "unknown error",
																}),
															});
														}
													})
													.catch(err =>
														setRootMsg({
															ok: false,
															text: t("data root migrate failed: {error}", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													)
													.finally(() => setRootBusy(false));
											}}
										>
											{t("save")}
										</button>
									</>
								)}
							</div>
							{rootMsg && (
								<div
									className={`mt-1.5 text-[12.5px] ${
										rootMsg.ok ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"
									}`}
								>
									{rootMsg.text}
								</div>
							)}
						</div>
					</div>
					{info.runtime && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("runtime")}</div>
								<div className="truncate text-[13px] text-[var(--color-text-muted)]">{info.runtime}</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("check for updates")}</div>
							<div className="gui-settings-row-desc">{updateStatus}</div>
						</div>
						<button
							type="button"
							className="gui-btn"
							disabled={updateChecking}
							onClick={() => void runUpdateCheck()}
						>
							<Icon name="download" className="h-3.5 w-3.5" />
							<span>{updateChecking ? t("checking…") : t("check")}</span>
						</button>
					</div>
				</>
			)}
			{metaErr && (
				<div className="gui-settings-row">
					<div className="text-[13px] text-[var(--color-warning)]">
						{t("daemon meta unavailable: {reason}")} {metaErr}
					</div>
				</div>
			)}
		</>
	);
}

/** Settings → 智能体 → 插件: extensions discovered from .omp/tools,
 *  .claude/plugins etc (daemon plugins.list). */
function PluginsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [plugins, setPlugins] = useState<
		{ path: string; label: string | null; tools: number; commands: number; handlers: number }[] | null
	>(null);
	const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{
					plugins: { path: string; label: string | null; tools: number; commands: number; handlers: number }[];
					errors: { path: string; error: string }[];
				} | null>("plugins.list", {})
				.then(res => {
					if (!alive) return;
					setPlugins(res?.plugins ?? []);
					setErrors(res?.errors ?? []);
				})
				.catch(() => alive && setPlugins([]));
		};
		load();
		const id = setInterval(load, 5000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [rpc]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("plugins")}</h2>
			<p className="gui-settings-page-desc">{t("plugins settings")}</p>
			{plugins === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : plugins.length === 0 ? (
				<div className="gui-settings-row">{t("no plugins loaded")}</div>
			) : (
				plugins.map(p => (
					<div key={p.path} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{p.label ?? p.path}</span>
								<span className="gui-provider-chip">{t("plugin")}</span>
							</div>
							<div className="truncate text-[12px] text-[var(--color-text-faint)]">{p.path}</div>
							<div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-[var(--color-text-muted)]">
								<span>{t("{count} tools", { count: String(p.tools) })}</span>
								<span>{t("{count} commands", { count: String(p.commands) })}</span>
								<span>{t("{count} handlers", { count: String(p.handlers) })}</span>
							</div>
						</div>
					</div>
				))
			)}
			{errors.length > 0 && (
				<>
					<h3 className="gui-settings-group-h">{t("load errors")}</h3>
					{errors.map((e, i) => (
						<div key={i} className="gui-settings-row">
							<div className="truncate text-[12px] text-[var(--color-text-muted)]">
								{e.path}: {e.error}
							</div>
						</div>
					))}
				</>
			)}
		</>
	);
}

/** Settings → 智能体 → 技能: discovered skills (daemon skills.list). */
/** Settings → 智能体 → 技能: 扩展控制中心 (CCEC 形态) — provider tabs +
 *  categorized list + detail pane over skills + context files. The section
 *  fills the settings viewport (gui-skills-section height:100%) so the
 *  center's two panes scroll internally instead of the whole page —
 *  TUI /extensions panel parity. */
function SkillsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<div className="gui-skills-section">
			<h2 className="gui-settings-page-title">{t("extensions control center")}</h2>
			<p className="gui-settings-page-desc">{t("extensions settings")}</p>
			<ExtensionsCenter rpc={rpc} />
		</div>
	);
}

/** Settings → 任务与子智能体: TUI tasks-tab parity (modes, subagent
 *  limits, isolation, commands & skills groups), schema driven — the
 *  live subagent roster lives in the session right rail (AgentsPanel),
 *  not in settings (dedupe 2026-08-11). */
function SubagentsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("tasks & subagents")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["tasks"]} />
		</>
	);
}

/** One stored credential row as exposed by the daemon (providers.credentials). */
interface CredentialInfo {
	id: number;
	accountLabel: string;
	note?: string | null;
}

function ModelSection({
	providers,
	apiProviders,
	custom,
	loginState,
	busy,
	onLogin,
	onLogout,
	onSubmitInput,
	onCancelLogin,
	onChanged,
	rpc,
	sessionId,
}: {
	providers: ProviderInfo[] | null;
	apiProviders: ApiProviderInfo[];
	custom: CustomProvider[];
	loginState: {
		providerId: string;
		url?: string;
		launchUrl?: string;
		instructions?: string;
		message?: string;
		waitingInput?: boolean;
	} | null;
	busy: boolean;
	onLogin(providerId: string): void;
	onLogout(providerId: string): void;
	onSubmitInput(value: string): void;
	onCancelLogin(): void;
	onChanged(): void;
	rpc: RpcClient | null;
	sessionId: string | null;
}): ReactNode {
	const [form, setForm] = useState({
		name: "",
		baseUrl: "",
		apiKey: "",
		api: "openai-completions",
		modelId: "",
		modelName: "",
		compactionModel: "",
	});
	// Section collapse (bitfun parity): show the first few cards, expand on
	// demand — 70 login providers + the full catalog is too much for a grid.
	const [showAll, setShowAll] = useState(false);
	const [providerQuery, setProviderQuery] = useState("");
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [inputValue, setInputValue] = useState("");
	const [copied, setCopied] = useState(false);
	// Per-role model presets (TUI /model parity): role -> model selector.
	const [roleModels, setRoleModels] = useState<Record<string, string> | null>(null);
	// Default model for new sessions (daemon settings "model" key).
	// Role cycle order (TUI ctrl+p cycleOrder) — roles render in this order.
	const [cycleOrder, setCycleOrder] = useState<string[] | null>(null);
	const { prompt } = usePrompt();
	// Stored credentials per provider (multi-account logout dropdown).
	const [credentialsByProvider, setCredentialsByProvider] = useState<Record<string, CredentialInfo[]>>({});
	// Side-channel model override (settings.sideChannelModel): "" = follow
	// the session model (TUI parity for /btw /omfg recap, ephemeral ask).
	const [sideChannelModel, setSideChannelModel] = useState<string>("");
	// Catalog for the side-channel/compaction pickers (models.list).
	const [catalogModels, setCatalogModels] = useState<{ id: string; name?: string }[] | null>(null);
	// Provider id whose credential menu is open (single-open dropdown).
	const [credsMenu, setCredsMenu] = useState<string | null>(null);
	// Provider id whose inline actions menu (login / import API key) is open.
	const [actionsMenu, setActionsMenu] = useState<string | null>(null);
	// Anchor elements for the portal-rendered card menus (credential list /
	// actions). Keyed by `p.id` (creds) and `actions-${p.id}` (actions) so the
	// fixed-position popups can pin to their trigger button.
	const cardMenuAnchors = useRef(new Map<string, HTMLElement>());
	// Close the provider card menus on outside click / Escape. The menus are
	// portal-rendered into the root (fixed position) and carry
	// data-header-menu so clicks inside them are ignored here.
	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<{ id: string; name?: string }[]>("models.list", {})
			.then(list => setCatalogModels(list ?? []))
			.catch(() => {});
		void rpc
			.request<Record<string, unknown> | null>("settings.get", {
				keys: ["modelRoles", "cycleOrder", "sideChannelModel"],
			})
			.then(v => setSideChannelModel((v?.sideChannelModel as string | undefined) ?? ""))
			.catch(() => {});
	}, [rpc]);

	useEffect(() => {
		if (!credsMenu && !actionsMenu) return;
		const onDown = (e: MouseEvent | KeyboardEvent): void => {
			if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
			const target = e.target as Node | null;
			if (target instanceof Node && (target as Element | null)?.closest?.("[data-header-menu]")) return;
			setCredsMenu(null);
			setActionsMenu(null);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onDown);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onDown);
		};
	}, [credsMenu, actionsMenu]);
	// Provider awaiting an imported API key (/setup parity modal).
	const [apiKeyTarget, setApiKeyTarget] = useState<string | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	// Unified provider list: subscription (OAuth) + API-key providers merged
	// by id — subscription wins login state, API model tags merge in.
	const mergedProviders = useMemo(() => {
		const map = new Map<
			string,
			{
				id: string;
				name: string;
				loggedIn: boolean;
				configured: boolean;
				models: string[];
				modelCount: number;
				available: boolean;
				canLogin: boolean;
				canImport: boolean;
			}
		>();
		for (const p of providers ?? []) {
			map.set(p.id, {
				id: p.id,
				name: p.name,
				loggedIn: p.loggedIn,
				configured: false,
				models: [],
				modelCount: 0,
				available: p.available,
				canLogin: true,
				canImport: false,
			});
		}
		for (const p of apiProviders) {
			const existing = map.get(p.id);
			if (existing) {
				existing.configured = p.configured;
				existing.models = p.models;
				existing.modelCount = p.modelCount;
				existing.canImport = true;
			} else {
				map.set(p.id, {
					id: p.id,
					// API-key providers from the daemon may ship an EMPTY name —
					// fall back to the id so the card header never renders blank
					// (user: bottom cards showed no provider name at all).
					name: p.name || p.id,
					loggedIn: false,
					configured: p.configured,
					models: p.models,
					modelCount: p.modelCount,
					available: true,
					canLogin: false,
					canImport: true,
				});
			}
		}
		// Active (logged-in / configured) first, then name order — connected
		// providers stay visible without scrolling.
		return [...map.values()].sort(
			(a, b) =>
				Number(b.loggedIn || b.configured) - Number(a.loggedIn || a.configured) || a.name.localeCompare(b.name),
		);
	}, [providers, apiProviders]);

	const providerQ = providerQuery.trim().toLowerCase();
	const filteredProviders = providerQ
		? mergedProviders.filter(
				p =>
					p.name.toLowerCase().includes(providerQ) ||
					p.id.toLowerCase().includes(providerQ) ||
					p.models.some(m => m.toLowerCase().includes(providerQ)),
			)
		: mergedProviders;
	const visibleProviders = filteredProviders.slice(0, showAll ? undefined : PROVIDER_COLLAPSE_LIMIT);
	// /model-style split pane: active tab id (default | session | roles |
	// providers | custom | add).
	const [activeTab, setActiveTab] = useState<string>("roles");
	// Canonical role list (built-ins + configured extras) — TUI /model
	// knownRoleIds parity.
	const [knownRoleIds, setKnownRoleIds] = useState<string[] | null>(null);
	// Per-role auto-resolved model (TUI model-hub parity): what each role
	// would select — explicit assignment, or the derived default/priority
	// resolution when unset.
	const [resolvedRoleModels, setResolvedRoleModels] = useState<
		Record<string, { id: string; name: string; efforts: string[] } | null>
	>({});
	// Persist a role-assignment change, then re-fetch the daemon's per-role
	// resolution. The "自动选择" lines (SMOL/SLOW/VISION/…) derive from the
	// DEFAULT model — without the re-fetch they keep showing the OLD model
	// until the settings pane remounts.
	const applyRoleModels = (next: Record<string, string>): void => {
		setRoleModels(next);
		if (!rpc) return;
		void rpc
			.request("settings.set", { key: "modelRoles", value: next })
			.then(() =>
				rpc
					.request<{
						resolvedRoleModels?: Record<string, { id: string; name: string; efforts: string[] } | null>;
					}>("settings.get", { keys: ["resolvedRoleModels"] })
					.then(res => setResolvedRoleModels(res?.resolvedRoleModels ?? {})),
			)
			.catch(() => {});
	};
	// Retry fallback chains (TUI /model `f` parity, settings
	// "retry.fallbackChains"): role -> ordered model selectors tried after
	// the assigned model fails.
	const [fallbackChains, setFallbackChains] = useState<Record<string, string[]>>({});
	// Role whose fallback-chain editor is open (inline ModelSelector).
	const [fallbackEditor, setFallbackEditor] = useState<string | null>(null);

	const submitModel = async (): Promise<void> => {
		setFormError(null);
		if (!rpc || !sessionId) return;
		if (!form.name || !form.baseUrl || !form.modelId) {
			setFormError(t("provider name, base URL and model id are required"));
			return;
		}
		setFormBusy(true);
		try {
			await rpc.request("models.add", {
				sessionId,
				provider: {
					name: form.name,
					baseUrl: form.baseUrl,
					...(form.apiKey ? { apiKey: form.apiKey } : {}),
					...(form.api !== "openai" ? { api: form.api } : {}),
					models: [
						{
							id: form.modelId,
							...(form.modelName ? { name: form.modelName } : {}),
							...(form.compactionModel.trim() ? { compactionModel: form.compactionModel.trim() } : {}),
						},
					],
				},
			});
			setForm({
				name: "",
				baseUrl: "",
				apiKey: "",
				api: "openai-completions",
				modelId: "",
				modelName: "",
				compactionModel: "",
			});
			onChanged();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setFormBusy(false);
		}
	};

	const removeProvider = async (name: string): Promise<void> => {
		if (!rpc || !sessionId) return;
		try {
			await rpc.request("models.remove", { sessionId, providerName: name });
			onChanged();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// Role presets only exist on a live session (settings live there).
	useEffect(() => {
		if (!rpc) {
			setRoleModels(null);
			setCycleOrder(null);
			setKnownRoleIds(null);
			setFallbackChains({});
			return;
		}
		void rpc
			.request<{
				modelRoles?: Record<string, string>;
				cycleOrder?: string[];
				knownRoleIds?: string[];
				resolvedRoleModels?: Record<string, { id: string; name: string; efforts: string[] } | null>;
				"retry.fallbackChains"?: Record<string, string[]>;
			}>("settings.get", {
				keys: ["modelRoles", "cycleOrder", "knownRoleIds", "resolvedRoleModels", "retry.fallbackChains"],
			})
			.then(res => {
				setRoleModels(res?.modelRoles ?? {});
				setCycleOrder(res?.cycleOrder ?? null);
				setKnownRoleIds(res?.knownRoleIds ?? null);
				setResolvedRoleModels(res?.resolvedRoleModels ?? {});
				setFallbackChains(res?.["retry.fallbackChains"] ?? {});
			})
			.catch(() => {
				setRoleModels({});
				setCycleOrder(null);
				setKnownRoleIds(null);
				setResolvedRoleModels({});
				setFallbackChains({});
			});
	}, [rpc]);

	// Stored credentials per logged-in provider — powers the multi-account
	// logout dropdown and the logged-in count. Covers both lists: OAuth
	// accounts (providers) and configured API-key providers (apiProviders).
	const loadCredentials = useCallback(async (): Promise<void> => {
		if (!rpc || !providers) return;
		const ids = [
			...providers.filter(p => p.loggedIn).map(p => p.id),
			...apiProviders.filter(p => p.configured).map(p => p.id),
		];
		const entries = await Promise.all(
			ids.map(async id => {
				try {
					const creds = await rpc.request<CredentialInfo[]>("providers.credentials", { providerId: id });
					return [id, creds ?? []] as [string, CredentialInfo[]];
				} catch {
					return [id, []] as [string, CredentialInfo[]];
				}
			}),
		);
		const next: Record<string, CredentialInfo[]> = {};
		for (const [id, list] of entries) next[id] = list;
		setCredentialsByProvider(next);
	}, [rpc, providers, apiProviders]);

	useEffect(() => {
		void loadCredentials();
	}, [loadCredentials]);

	// Remove exactly one stored credential (daemon providers.logout with
	// credentialId) — the provider stays logged in until the last one goes.
	const logoutCredential = async (providerId: string, credentialId: number): Promise<void> => {
		if (!rpc) return;
		setCredsMenu(null);
		try {
			await rpc.request("providers.logout", { sessionId: sessionId ?? undefined, providerId, credentialId });
			onChanged();
			await loadCredentials();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// Credential note editing (multi-account labeling): prompt for the new
	// note, then persist via providers.setCredentialNote (session-less).
	const editCredentialNote = async (
		providerId: string,
		credentialId: number,
		current: string | null,
	): Promise<void> => {
		if (!rpc) return;
		const note = await prompt({ title: t("credential note"), defaultValue: current ?? "" });
		if (note === null) return; // cancelled
		try {
			await rpc.request("providers.setCredentialNote", {
				sessionId: sessionId ?? undefined,
				providerId,
				credentialId,
				note,
			});
			await loadCredentials();
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	// /setup parity: import a provider API key without OAuth.
	const submitApiKey = async (): Promise<void> => {
		if (!rpc || !apiKeyTarget || !apiKeyValue.trim()) return;
		const providerId = apiKeyTarget;
		try {
			await rpc.request("providers.importApiKey", { providerId, apiKey: apiKeyValue.trim() });
			setApiKeyTarget(null);
			setApiKeyValue("");
			onChanged();
		} catch {
			// keep the modal open; the daemon error shows nothing fatal
		}
	};

	const modelTabs = [
		{ id: "roles", label: t("role models") },
		{ id: "behavior", label: t("model behavior") },
		{ id: "providers", label: t("providers") },
		{ id: "custom", label: t("custom providers") },
		{ id: "add", label: t("add custom provider") },
	] as const;

	// One role row (TUI /model roles-panel parity): tag + assignment state,
	// thinking level, cycle membership, model picker + clear; custom roles
	// additionally get a remove button. Fallback chains render as sub-rows
	// with an inline model picker to append.
	const renderRoleRow = (role: string, removable: boolean): ReactNode => {
		if (!rpc) return null;
		const raw = roleModels?.[role] ?? "";
		const { model, level } = splitRoleValue(raw);
		const resolved = resolvedRoleModels[role];
		const chain = fallbackChains[role] ?? [];
		const cycleIndex = cycleOrder?.indexOf(role) ?? -1;
		const editingFallback = fallbackEditor === role;
		return (
			<div key={role} className="gui-settings-row gui-role-row">
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">
						<span className="gui-role-tag">{BUILTIN_ROLE_TAGS[role] ?? role}</span>
						{cycleIndex >= 0 && (
							<span className="gui-role-cycle-badge" title={t("cycle order")}>
								⟳{cycleIndex + 1}
							</span>
						)}
					</div>
					{model ? (
						<div className="truncate text-[12px] text-[var(--color-text-faint)]">{model}</div>
					) : resolved ? (
						<div className="truncate text-[12px] text-[var(--color-text-faint)]">
							{t("auto selection")}: {resolved.name || resolved.id}
						</div>
					) : (
						<div className="text-[12px] text-[var(--color-text-faint)] italic">{t("auto selection applies")}</div>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					{/* Per-role thinking level (rides the selector suffix, TUI
					 * formatModelSelectorValue parity). */}
					<select
						className="gui-input gui-role-thinking"
						value={level ?? "inherit"}
						disabled={!model}
						title={t("role thinking level")}
						aria-label={t("role thinking level")}
						onChange={e => {
							const nextLevel = e.target.value;
							const next = { ...roleModels, [role]: joinRoleValue(model, nextLevel) };
							applyRoleModels(next);
						}}
					>
						<option value="inherit">{t("inherit")}</option>
						<option value="off">{t("thinking off")}</option>
						{/* Model-specific ladder (daemon resolvedRoleModels.efforts,
						 * TUI model-hub parity): the level select offers exactly
						 * the resolved model's supported efforts — not a fixed
						 * seven-rung list, since different models differ. A model
						 * without thinking support offers only inherit + off. */}
						{(() => {
							const efforts = resolvedRoleModels[role]?.efforts;
							return (efforts && efforts.length > 0 ? efforts : []).map(lv => (
								<option key={lv} value={lv}>
									{t(`thinking ${lv}` as TranslationKey)}
								</option>
							));
						})()}
					</select>
					{/* Fallback chain editor toggle (TUI `f` parity) — always
					 * available so the FIRST fallback can be added. */}
					<button
						type="button"
						className="gui-btn"
						title={editingFallback ? t("add fallback") : t("fallback chain")}
						aria-label={editingFallback ? t("add fallback") : t("fallback chain")}
						onClick={() => setFallbackEditor(editingFallback ? null : role)}
					>
						<Icon name="git-branch" className="h-3.5 w-3.5" />
						{chain.length > 0 && <span className="gui-role-fallback-count">{chain.length}</span>}
					</button>
					{/* Cycle membership toggle (TUI ctrl+p cycleOrder parity). */}
					<button
						type="button"
						className="gui-btn"
						title={cycleIndex >= 0 ? t("remove from cycle") : t("add to cycle")}
						aria-label={cycleIndex >= 0 ? t("remove from cycle") : t("add to cycle")}
						onClick={() => {
							const next = [...(cycleOrder ?? [])];
							const at = next.indexOf(role);
							if (at >= 0) next.splice(at, 1);
							else next.push(role);
							setCycleOrder(next);
							void rpc.request("settings.set", { key: "cycleOrder", value: next }).catch(() => {});
						}}
					>
						<Icon name="loop-right-ai" className="h-3.5 w-3.5" />
					</button>
					<ModelSelector
						rpc={rpc}
						sessionId={null}
						presetId={model || undefined}
						maxLabelWidth="230px"
						onSelect={(id, provider) => {
							if (!id) return;
							// Store the provider-qualified reference: the daemon
							// resolves "provider/id" exactly, so assigning
							// opencode-go's deepseek-v4-flash never leaks onto
							// opencode-zen's same-id model.
							const ref = provider ? `${provider}/${id}` : id;
							if (role === "default") {
								// The DEFAULT role IS the default model for new
								// sessions — keep the welcome-composer preselect
								// in sync with the role assignment. The bare ref
								// (no :level suffix) mirrors the daemon's
								// modelRoles.default value.
								try {
									localStorage.setItem("omp-gui-default-model", ref);
								} catch {
									// storage unavailable
								}
								window.dispatchEvent(
									new CustomEvent("omp-gui-default-model-changed", { detail: ref }),
								);
							}
							// Keep the role's thinking suffix when the model
							// changes (TUI assign preserves the level).
							const next = { ...roleModels, [role]: joinRoleValue(ref, level) };
							applyRoleModels(next);
						}}
					/>
					{model && (
						<button
							type="button"
							className="gui-btn"
							title={t("clear role model")}
							aria-label={t("clear role model")}
							onClick={() => {
								const next = { ...roleModels };
								delete next[role];
								applyRoleModels(next);
							}}
						>
							<Icon name="refresh" className="h-3.5 w-3.5" />
						</button>
					)}
					{removable && (
						<button
							type="button"
							className="gui-btn"
							title={t("remove role")}
							aria-label={t("remove role")}
							onClick={() => {
								const next = { ...roleModels };
								delete next[role];
								applyRoleModels(next);
							}}
						>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
				{(chain.length > 0 || editingFallback) && (
					<div className="gui-role-fallbacks">
						{chain.length > 0 && (
							<div className="gui-role-fallbacks-title">
								<Icon name="git-branch" className="h-3 w-3" />
								<span>{t("fallback chain")}</span>
							</div>
						)}
						{chain.map((selector, i) => (
							<div key={selector} className="gui-role-fallback-row">
								<span className="gui-role-fallback-arrow">↳</span>
								<span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]">
									{selector}
								</span>
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									title={t("remove fallback")}
									aria-label={t("remove fallback")}
									onClick={() => {
										const nextChain = chain.filter((_, idx) => idx !== i);
										const next = { ...fallbackChains };
										if (nextChain.length > 0) next[role] = nextChain;
										else delete next[role];
										setFallbackChains(next);
										void rpc
											.request("settings.set", { key: "retry.fallbackChains", value: next })
											.catch(() => {});
									}}
								>
									<Icon name="delete-bin" className="h-3 w-3" />
								</button>
							</div>
						))}
						{editingFallback && (
							<div className="gui-role-fallback-add">
								<ModelSelector
									rpc={rpc}
									sessionId={null}
									onSelect={(id, provider) => {
										setFallbackEditor(null);
										if (!id || !provider) return;
										const selector = `${provider}/${id}`;
										const nextChain = chain.includes(selector) ? chain : [...chain, selector];
										const next = { ...fallbackChains, [role]: nextChain };
										setFallbackChains(next);
										void rpc
											.request("settings.set", { key: "retry.fallbackChains", value: next })
											.catch(() => {});
									}}
								/>
							</div>
						)}
					</div>
				)}
			</div>
		);
	};

	// All known roles: the daemon's canonical list, or — while settings are
	// still loading / on old daemons — the built-ins plus any configured
	// extras (TUI getKnownRoleIds parity: built-ins always show, even
	// unassigned).
	const rolesOrder =
		knownRoleIds ??
		[...Object.keys(BUILTIN_ROLE_TAGS), ...(cycleOrder ?? []), ...Object.keys(roleModels ?? {})].filter(
			(role, index, all) => all.indexOf(role) === index,
		);

	return (
		<>
			<h2 className="gui-settings-page-title">{t("model settings")}</h2>
			<p className="gui-settings-page-desc">{t("model settings description")}</p>

			<div className="gui-model-pane">
				<nav className="gui-model-pane-nav" aria-label={t("model settings")}>
					{modelTabs.map(tab => (
						<button
							key={tab.id}
							type="button"
							className={`gui-model-pane-tab${activeTab === tab.id ? " gui-model-pane-tab--active" : ""}`}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</nav>
				{/* Tab body: HeightMorph eases the pane height between tabs
				 * (different content heights — no more abrupt jump). */}
				<HeightMorph morphKey={activeTab} className="gui-model-pane-body">
					{activeTab === "roles" && rpc && (
						<>
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("role models")}</div>
								<div className="gui-settings-section-desc">
									{t("role models description")}
									{roleModels !== null && (
										<span className="gui-role-count">
											{t("configured count {count}/{total}", {
												count: String(rolesOrder.filter(r => roleModels?.[r]).length),
												total: String(rolesOrder.length),
											})}
										</span>
									)}
								</div>
								{/* No current-session row here: the composer's model
								 * selector already switches the live session's model
								 * (same session.setModel the TUI /switch runs), and
								 * the thinking level sits beside it in the composer —
								 * a per-session override does not belong in global
								 * settings. The DEFAULT role below IS the default
								 * model for new sessions. */}
								{roleModels === null ? (
									<div className="text-[13px] text-[var(--color-text-faint)]">{t("loading")}…</div>
								) : (
									<>
										{rolesOrder.map(role => renderRoleRow(role, BUILTIN_ROLE_TAGS[role] === undefined))}
										<button
											type="button"
											className="gui-connect-add"
											onClick={() => {
												void prompt({ title: t("new role name") }).then((role: string | null) => {
													if (!role?.trim() || !rpc) return;
													const next = { ...roleModels, [role.trim()]: "" };
													applyRoleModels(next);
												});
											}}
										>
											<Icon name="add-circle" className="h-4 w-4" />
											<span>{t("add role")}</span>
										</button>
										{(cycleOrder?.length ?? 0) > 0 && (
											<div className="gui-role-cycle-track">
												<span className="text-[12px] text-[var(--color-text-faint)]">
													{t("cycle order")}:
												</span>
												{cycleOrder!.map(role => (
													<span key={role} className="gui-role-cycle-chip">
														{BUILTIN_ROLE_TAGS[role] ?? role}
													</span>
												))}
											</div>
										)}
									</>
								)}
							</div>
						</>
					)}

					{activeTab === "behavior" && rpc && (
						<>
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("model behavior")}</div>
								<div className="gui-settings-section-desc">{t("model behavior description")}</div>
							</div>
							<div className="gui-schema-card">
								{/* Model behaviour (thinking/sampling/prompt/retry & fallback/
								 * advisor/prewalk/vision) — TUI settings model-tab parity.
								 * Own tab so role assignment stays focused. */}
								<SchemaTabSection rpc={rpc} tabs={["model"]} />
							</div>
							<div className="gui-settings-section mt-4">
								<div className="gui-settings-section-title">{t("side channel model")}</div>
								<div className="gui-settings-section-desc">{t("side channel model description")}</div>
								<div className="gui-settings-row">
									<div>
										<div className="gui-settings-row-label">{t("side channel model")}</div>
										<div className="gui-settings-row-desc">{t("side channel model label desc")}</div>
									</div>
									<select
										className="gui-input max-w-[260px]"
										value={sideChannelModel}
										onChange={e => {
											const next = e.target.value;
											setSideChannelModel(next);
											void rpc
												.request("settings.set", { key: "sideChannelModel", value: next })
												.catch(() => {});
										}}
										aria-label={t("side channel model")}
									>
										<option value="">{t("follow session model")}</option>
										{(catalogModels ?? []).map(m => (
											<option key={m.id} value={m.id}>
												{m.name ?? m.id}
											</option>
										))}
									</select>
								</div>
							</div>
						</>
					)}

					{activeTab === "providers" && (
						<>
							{loginState && (
								<div className="gui-github-flow">
									<div className="gui-github-flow-title flex items-center gap-1.5">
										<Icon name="lock" className="h-3.5 w-3.5" />
										{t("login to {name}", { name: loginState.providerId })}
									</div>
									{loginState.url && (
										<div className="gui-github-flow-actions">
											<button
												type="button"
												className="gui-btn gui-btn-primary"
												onClick={() => void openExternalUrl(loginState.launchUrl ?? loginState.url!)}
											>
												<Icon name="external-link" className="h-3.5 w-3.5" />
												{t("open login page")}
											</button>
											<button
												type="button"
												className="gui-link"
												onClick={() => {
													void navigator.clipboard.writeText(loginState.url ?? "").catch(() => {});
													setCopied(true);
													window.setTimeout(() => setCopied(false), 1500);
												}}
											>
												{copied ? t("link copied") : t("copy link")}
											</button>
											{!loginState.waitingInput && !busy && (
												<button type="button" className="gui-link" onClick={() => void onCancelLogin()}>
													{t("cancel")}
												</button>
											)}
										</div>
									)}
									{loginState.instructions && (
										<div className="gui-github-flow-hint">{loginState.instructions}</div>
									)}
									{loginState.message && <div className="gui-github-flow-hint">{loginState.message}</div>}
									{loginState.waitingInput ? (
										<div className="mt-2 flex items-center gap-2">
											<input
												className="gui-input flex-1"
												value={inputValue}
												onChange={e => setInputValue(e.target.value)}
												placeholder={t("paste the code or redirect URL")}
												onKeyDown={e => {
													if (e.key === "Enter") {
														void onSubmitInput(inputValue);
														setInputValue("");
													}
												}}
											/>
											<button
												type="button"
												className="gui-btn gui-btn-approve"
												onClick={() => void onSubmitInput(inputValue)}
											>
												{t("submit")}
											</button>
										</div>
									) : (
										!busy &&
										loginState.url && (
											<div className="gui-github-flow-waiting">
												<span className="gui-flow-spinner" aria-hidden="true" />
												{t("waiting login")}
											</div>
										)
									)}
								</div>
							)}
							{/* 模型供应商: subscription (OAuth) + API-key providers merged into
							 * one searchable list — active providers first, model tags on
							 * API-backed cards, floating modal for API-key import. */}
							<div className="gui-settings-section">
								<div className="gui-settings-section-title">{t("providers unified")}</div>
								<div className="gui-settings-section-desc">{t("providers unified hint")}</div>
								{providers === null ? (
									<div className="text-[13px] text-[var(--color-text-faint)]">{t("loading")}…</div>
								) : mergedProviders.length === 0 ? (
									<div className="text-[13px] text-[var(--color-text-faint)]">{t("no providers")}</div>
								) : (
									<>
										<div className="gui-provider-search">
											<Icon name="search" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
											<input
												className="gui-input min-w-0 flex-1"
												value={providerQuery}
												onChange={e => setProviderQuery(e.target.value)}
												placeholder={t("search providers…")}
												aria-label={t("search providers…")}
											/>
										</div>
										<HeightMorph morphKey={`${showAll}:${providerQ}`}>
											<ChromaGroup className="gui-provider-grid">
												{visibleProviders.map(p => {
													const creds = credentialsByProvider[p.id] ?? [];
													const active = p.loggedIn || p.configured;
													return (
														<SpotlightCard
															key={p.id}
															className="gui-provider-card"
															spotlightColor="rgba(255, 255, 255, 0.08)"
														>
															<div className="gui-provider-card-head">
																<div className="min-w-0 flex-1">
																	<div className="gui-provider-card-name" title={p.name}>
																		{p.name}
																	</div>
																	<div
																		className={`gui-provider-card-status${
																			active ? " gui-provider-card-status--ok" : ""
																		}`}
																	>
																		<span
																			className={`gui-provider-status-dot${
																				active ? " gui-provider-status-dot--on" : ""
																			}`}
																			aria-hidden="true"
																		/>
																		{p.loggedIn
																			? creds.length > 1
																				? t("logged in · {count}", { count: String(creds.length) })
																				: t("logged in")
																			: p.configured
																				? t("configured")
																				: p.canImport
																					? `${p.modelCount} ${t("models")}`
																					: t("not logged in")}
																	</div>
																</div>
																{active ? (
																	<div className="relative shrink-0">
																		<button
																			type="button"
																			className="gui-btn gui-btn-stop"
																			ref={el => {
																				if (el) cardMenuAnchors.current.set(p.id, el);
																				else cardMenuAnchors.current.delete(p.id);
																			}}
																			aria-expanded={credsMenu === p.id}
																			onClick={() =>
																				setCredsMenu(menu => (menu === p.id ? null : p.id))
																			}
																		>
																			{t("logout")}
																			<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
																		</button>
																		<Pop
																			open={credsMenu === p.id}
																			className="gui-creds-menu"
																			anchor={cardMenuAnchors.current.get(p.id) ?? null}
																			portal
																			align="right"
																			onOpenChange={open => {
																				if (!open && credsMenu === p.id) setCredsMenu(null);
																			}}
																		>
																			<div className="gui-creds-menu-label">{t("accounts")}</div>
																			{creds.map(c => (
																				<div key={c.id} className="gui-creds-row">
																					<div className="min-w-0 flex-1">
																						<div className="truncate text-[13px] text-[var(--color-text)]">
																							{c.accountLabel}
																						</div>
																						{c.note && (
																							<div className="truncate text-[12px] text-[var(--color-text-faint)]">
																								{c.note}
																							</div>
																						)}
																					</div>
																					<button
																						type="button"
																						className="gui-btn gui-btn--icon"
																						title={t("edit credential note")}
																						aria-label={t("edit credential note")}
																						onClick={() =>
																							void editCredentialNote(p.id, c.id, c.note ?? null)
																						}
																					>
																						<Icon name="pencil" className="h-3 w-3" />
																					</button>
																					<button
																						type="button"
																						className="gui-btn gui-btn--icon"
																						title={t("remove credential")}
																						aria-label={t("remove credential")}
																						onClick={() => void logoutCredential(p.id, c.id)}
																					>
																						<Icon name="delete-bin" className="h-3 w-3" />
																					</button>
																				</div>
																			))}
																			<div className="gui-creds-menu-sep" />
																			<button
																				type="button"
																				className="gui-view-opt"
																				onClick={() => {
																					setCredsMenu(null);
																					if (p.canImport) {
																						setApiKeyTarget(p.id);
																						setApiKeyValue("");
																					} else {
																						void onLogin(p.id);
																					}
																				}}
																			>
																				<Icon name="add-circle" className="h-3.5 w-3.5" />
																				<span className="min-w-0 flex-1">
																					{t("add another credential")}
																				</span>
																			</button>
																			<button
																				type="button"
																				className="gui-view-opt gui-view-opt--danger"
																				onClick={() => {
																					setCredsMenu(null);
																					void onLogout(p.id);
																				}}
																			>
																				<span className="min-w-0 flex-1">{t("logout all")}</span>
																			</button>
																		</Pop>
																	</div>
																) : (
																	<div className="relative shrink-0">
																		<button
																			type="button"
																			className="gui-btn gui-btn--icon"
																			ref={el => {
																				if (el) cardMenuAnchors.current.set(`actions-${p.id}`, el);
																				else cardMenuAnchors.current.delete(`actions-${p.id}`);
																			}}
																			aria-expanded={actionsMenu === p.id}
																			aria-label={t("provider actions")}
																			title={t("provider actions")}
																			onClick={() =>
																				setActionsMenu(menu => (menu === p.id ? null : p.id))
																			}
																		>
																			<Icon name="more" className="h-3.5 w-3.5" />
																		</button>
																		<Pop
																			open={actionsMenu === p.id}
																			className="gui-creds-menu"
																			anchor={cardMenuAnchors.current.get(`actions-${p.id}`) ?? null}
																			portal
																			align="right"
																			onOpenChange={open => {
																				if (!open && actionsMenu === p.id) setActionsMenu(null);
																			}}
																		>
																			{p.canLogin && (
																				<button
																					type="button"
																					className="gui-view-opt"
																					disabled={!p.available || busy}
																					onClick={() => {
																						setActionsMenu(null);
																						void onLogin(p.id);
																					}}
																				>
																					<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
																					<span className="min-w-0 flex-1">{t("login")}</span>
																				</button>
																			)}
																			{p.canImport && (
																				<button
																					type="button"
																					className="gui-view-opt"
																					onClick={() => {
																						setActionsMenu(null);
																						setApiKeyTarget(p.id);
																						setApiKeyValue("");
																					}}
																				>
																					<Icon name="key" className="h-3.5 w-3.5" />
																					<span className="min-w-0 flex-1">
																						{t("import api key")}
																					</span>
																				</button>
																			)}
																		</Pop>
																	</div>
																)}
															</div>
															{p.models.length > 0 && (
																<div className="gui-provider-tags">
																	{p.models.map(m => (
																		<span key={m} className="gui-provider-tag">
																			{m}
																		</span>
																	))}
																	{p.modelCount > p.models.length && (
																		<span className="gui-provider-tag gui-provider-tag--more">
																			+{p.modelCount - p.models.length}
																		</span>
																	)}
																</div>
															)}
														</SpotlightCard>
													);
												})}
											</ChromaGroup>
										</HeightMorph>
										{filteredProviders.length > PROVIDER_COLLAPSE_LIMIT && (
											<button
												type="button"
												className="gui-provider-more"
												onClick={() => setShowAll(v => !v)}
											>
												{showAll
													? t("collapse")
													: t("show all {count}", { count: String(filteredProviders.length) })}
												<Icon name={showAll ? "arrow-up-s" : "arrow-down-s"} className="h-3.5 w-3.5" />
											</button>
										)}
										{providerQ && filteredProviders.length === 0 && (
											<div className="text-[13px] text-[var(--color-text-faint)]">
												{t("no matching providers")}
											</div>
										)}
									</>
								)}
							</div>
							{/* Provider behaviour (services, tiny-model, protocol,
							 * timeouts, privacy) — TUI providers-tab parity. Merged
							 * here (previously a duplicated sidebar 供应商 section /
							 * page-bottom flat block) so the providers tab is the
							 * single home for everything provider-side. */}
							<div className="gui-schema-card">
								<SchemaTabSection rpc={rpc} tabs={["providers"]} />
							</div>
						</>
					)}

					{/* Floating API-key import (DialogFrame modal) — mounted
					 * unconditionally so the enter/exit animation plays. */}
					<DialogFrame
						open={apiKeyTarget !== null}
						onClose={() => setApiKeyTarget(null)}
						label={t("import api key")}
						className="w-[420px] max-w-[90vw]"
					>
						{apiKeyTarget && (
							<div className="gui-login-panel">
								<div className="gui-login-title">
									<Icon name="key" className="h-3.5 w-3.5" />
									<span>{t("import api key for {name}", { name: apiKeyTarget })}</span>
								</div>
								<div className="flex items-center gap-2">
									<input
										className="gui-input flex-1"
										type="password"
										value={apiKeyValue}
										placeholder="sk-…"
										autoFocus
										onChange={e => setApiKeyValue(e.target.value)}
										onKeyDown={e => {
											if (e.key === "Enter" && apiKeyValue.trim()) void submitApiKey();
										}}
									/>
									<button
										type="button"
										className="gui-btn gui-btn-approve"
										disabled={!apiKeyValue.trim()}
										onClick={() => void submitApiKey()}
									>
										{t("import")}
									</button>
									<button type="button" className="gui-btn" onClick={() => setApiKeyTarget(null)}>
										{t("cancel")}
									</button>
								</div>
							</div>
						)}
					</DialogFrame>

					{activeTab === "custom" && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("custom providers")}</div>
							<div className="gui-settings-section-desc">{t("custom providers hint")}</div>
							{custom.length === 0 ? (
								<div className="text-[13px] text-[var(--color-text-faint)]">{t("no custom providers")}</div>
							) : (
								custom.map(c => (
									<div key={c.name} className="gui-settings-row">
										<div className="min-w-0 flex-1">
											<div className="gui-settings-row-label">{c.name}</div>
											<div className="truncate text-[13px] text-[var(--color-text-faint)]">
												{c.models.map(m => m.id).join(", ")}
											</div>
										</div>
										<button type="button" className="gui-btn" onClick={() => void removeProvider(c.name)}>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
									</div>
								))
							)}
							{/* Explicit entry to the add-form tab — the only custom-config
							 * entry point now (the old dashed card inside the providers
							 * tab duplicated this tab). */}
							<button type="button" className="gui-connect-add" onClick={() => setActiveTab("add")}>
								<Icon name="add-circle" className="h-4 w-4" />
								<span>{t("add custom provider")}</span>
							</button>
						</div>
					)}

					{activeTab === "add" && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("add custom provider")}</div>
							<div className="flex flex-col gap-2">
								<input
									className="gui-input"
									placeholder={t("provider name")}
									value={form.name}
									onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
								/>
								<input
									className="gui-input"
									placeholder="https://api.example.com/v1"
									value={form.baseUrl}
									onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))}
								/>
								<input
									className="gui-input"
									placeholder={t("api key (optional)")}
									type="password"
									value={form.apiKey}
									onChange={e => setForm(v => ({ ...v, apiKey: e.target.value }))}
								/>
								<div className="flex gap-2">
									<input
										className="gui-input flex-1"
										placeholder={t("model id")}
										value={form.modelId}
										onChange={e => setForm(v => ({ ...v, modelId: e.target.value }))}
									/>
									<input
										className="gui-input flex-1"
										placeholder={t("model name (optional)")}
										value={form.modelName}
										onChange={e => setForm(v => ({ ...v, modelName: e.target.value }))}
									/>
								</div>
								<input
									className="gui-input"
									placeholder={t("compaction model id (optional)")}
									value={form.compactionModel}
									onChange={e => setForm(v => ({ ...v, compactionModel: e.target.value }))}
								/>
								<select
									className="gui-input"
									value={form.api}
									onChange={e => setForm(v => ({ ...v, api: e.target.value }))}
								>
									<option value="openai-completions">openai</option>
									<option value="openai-responses">openai responses</option>
									<option value="anthropic-messages">anthropic</option>
									<option value="google-generative-ai">google</option>
								</select>
								{formError && <div className="text-[13px] text-[var(--color-error)]">{formError}</div>}
								<button
									type="button"
									className="gui-btn gui-btn-approve"
									disabled={formBusy}
									onClick={() => void submitModel()}
								>
									{formBusy ? `${t("saving")}…` : t("add provider")}
								</button>
							</div>
						</div>
					)}
				</HeightMorph>
			</div>
		</>
	);
}

interface SlashCommandItem {
	name: string;
	description?: string;
	subcommands?: { name: string; description?: string }[];
	kind: "command" | "skill";
	category: string;
}

/** Settings → 智能体 → 命令: read-only slash-command catalog (commands.list
 * — same source of truth as the composer's / completion and the TUI). */
function CommandsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [items, setItems] = useState<SlashCommandItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<SlashCommandItem[]>("commands.list", {})
			.then(res => {
				if (alive) setItems(res ?? []);
			})
			.catch(() => alive && setItems([]));
		return () => {
			alive = false;
		};
	}, [rpc]);
	const groups = useMemo(() => {
		const map = new Map<string, SlashCommandItem[]>();
		for (const it of items ?? []) {
			const key = it.category || "command";
			const list = map.get(key) ?? [];
			list.push(it);
			map.set(key, list);
		}
		return [...map.entries()];
	}, [items]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("commands")}</h2>
			<p className="gui-settings-page-desc">{t("commands settings")}</p>
			{items === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : (
				groups.map(([cat, list]) => (
					<div key={cat} className="mb-2">
						<div className="gui-settings-nav-group">{cat}</div>
						{list.map(c => (
							<div key={c.name} className="gui-agent-card">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="font-mono text-[12.5px] font-medium">{c.name}</span>
										<span className="gui-provider-chip">{c.kind}</span>
									</div>
									{c.description && (
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">{c.description}</div>
									)}
									{c.subcommands && c.subcommands.length > 0 && (
										<div className="mt-0.5 flex flex-wrap gap-1">
											{c.subcommands.map(sc => (
												<span key={sc.name} className="gui-provider-chip">
													{sc.name}
												</span>
											))}
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				))
			)}
		</>
	);
}

interface McpItem {
	id: string;
	name: string;
	displayName: string;
	description?: string;
	kind: string;
	state: "active" | "disabled" | "shadowed";
	source: { provider: string; providerName: string; level: "user" | "project" | "native" };
}

/** Settings → 智能体 → MCP 服务器: mcp-kind extensions with enable toggles
 * (extensions.list / extensions.setEnabled — the mcp.json denylist path). */
function McpSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [mcps, setMcps] = useState<McpItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ extensions: McpItem[] }>("extensions.list", {})
				.then(res => {
					if (alive) setMcps((res?.extensions ?? []).filter(e => e.kind === "mcp"));
				})
				.catch(() => alive && setMcps([]));
		};
		load();
		let id = setInterval(load, 3000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				load();
				id = setInterval(load, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			alive = false;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc]);
	const toggle = (e: McpItem, next: boolean): void => {
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next }).then(() => {
			setMcps(prev => prev?.map(m => (m.id === e.id ? { ...m, state: next ? "active" : "disabled" } : m)) ?? prev);
		});
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("mcp servers")}</h2>
			<p className="gui-settings-page-desc">{t("mcp settings")}</p>
			{mcps === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : mcps.length === 0 ? (
				<div className="gui-settings-row">{t("no mcp servers")}</div>
			) : (
				mcps.map(m => (
					<div key={m.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{m.displayName || m.name}</span>
								<span className="gui-provider-chip">MCP</span>
							</div>
							{m.description && (
								<div className="truncate text-[12px] text-[var(--color-text-muted)]">{m.description}</div>
							)}
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={m.state === "active"}
							className={`gui-toggle${m.state === "active" ? " gui-toggle--on" : ""}`}
							onClick={() => {
								tapFeedback();
								toggle(m, m.state !== "active");
							}}
						/>
					</div>
				))
			)}
		</>
	);
}

/* ============ 数据与统计: 使用统计 / 索引库 / 钩子 ============ */

/** Compact number formatting (K/M/B — always en-US per user preference). */
function fmtCompact(n: number): string {
	if (!Number.isFinite(n)) return "—";
	const abs = Math.abs(n);
	if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(Math.round(n));
}

function fmtCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function fmtMs(n: number | null): string {
	return n == null ? "—" : `${Math.round(n)}ms`;
}

/** Stats wire shapes (subset of @musepi/omp-stats shared-types). */
interface UsageAggregated {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}
interface UsageModel extends UsageAggregated {
	model: string;
	provider: string;
}
interface UsageFolder extends UsageAggregated {
	folder: string;
}
interface UsagePoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}
interface ModelUsagePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	tokens: number;
}
interface UsageDashboard {
	overall: UsageAggregated;
	byModel: UsageModel[];
	byFolder: UsageFolder[];
	timeSeries: UsagePoint[];
	modelSeries: ModelUsagePoint[];
	sessionCount: number;
}

/** Settings → 数据与统计 → 使用统计: daemon stats.dashboard (packages/stats
 * aggregation over every session file) + stats.sync (incremental rescan).
 * The CLI `omp stats` dashboard is the parity reference; here the same
 * numbers render natively in the settings surface. */
function UsageSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [stats, setStats] = useState<UsageDashboard | null>(null);
	const [heatSeries, setHeatSeries] = useState<UsageDashboard["timeSeries"]>([]);
	const [range, setRange] = useState<"7d" | "30d">("7d");
	// Blur-morphs the trend chart on range switch (new/removed bars would
	// otherwise pop in abruptly). Cleared on animation end.
	const [trendMorph, setTrendMorph] = useState(false);
	useEffect(() => {
		setTrendMorph(true);
	}, []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(
		async (doSync: boolean, rng: "7d" | "30d"): Promise<void> => {
			if (!rpc) return;
			setBusy(true);
			setError(null);
			try {
				if (doSync) await rpc.request("stats.sync");
				const [main, yearly] = await Promise.all([
					rpc.request<UsageDashboard>("stats.dashboard", { range: rng }),
					// Yearly view for the contribution-graph heatmap — the range
					// toggle only refocuses which days are highlighted.
					rpc.request<UsageDashboard>("stats.dashboard", { range: "1y" }),
				]);
				setStats(main);
				setHeatSeries(yearly.timeSeries ?? []);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setStats(null);
			} finally {
				setBusy(false);
			}
		},
		[rpc],
	);
	useEffect(() => {
		void load(true, range);
	}, [load, range]);
	const overall = stats?.overall;
	const series = stats?.timeSeries ?? [];
	const modelSeries = stats?.modelSeries ?? [];
	// ── ZCode-parity summary cards (user-facing metrics) ──────────────────
	const tokensTotal = overall
		? overall.totalInputTokens +
			overall.totalOutputTokens +
			overall.totalCacheReadTokens +
			overall.totalCacheWriteTokens
		: 0;
	const msgTotal = series.reduce((a, p) => a + p.requests, 0);
	const activeDays = series.filter(p => p.requests > 0).length;
	let streak = 0;
	for (let i = series.length - 1; i >= 0; i--) {
		if (series[i].requests > 0) streak++;
		else break;
	}
	const byRequests = [...(stats?.byModel ?? [])].sort((a, b) => b.totalRequests - a.totalRequests);
	const topModel = byRequests[0];
	const topShare =
		topModel && overall?.totalRequests ? Math.round((topModel.totalRequests / overall.totalRequests) * 100) : 0;
	// ── Shared calendar window ──────────────────────────────────────────
	// Fixed 7/30 calendar days (zero-value days kept) so the heatmap grid
	// and trend bars follow real dates. `series`/`modelSeries` are day
	// buckets that only contain days with activity; they are mapped onto
	// the calendar window rather than compressed.
	const DAY_MS = 86400000;
	const rangeDays = range === "30d" ? 30 : 7;
	const keyOf = (ts: number): string => new Date(ts).toDateString();
	const dayIndex = new Map<string, (typeof series)[number]>();
	for (const p of series) {
		const k = keyOf(p.timestamp);
		if (!dayIndex.has(k)) dayIndex.set(k, p);
	}
	const todayStart = (() => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	})();
	const windowStart = todayStart - (rangeDays - 1) * DAY_MS;
	const windowDays: number[] = Array.from({ length: rangeDays }, (_, i) => windowStart + i * DAY_MS);
	const inWindow = (ts: number): boolean => ts >= windowStart && ts <= todayStart;
	// ── Heatmap: full-year contribution graph (GitHub parity) ───────────
	// One cell per calendar day over the last 365 days; columns are
	// calendar weeks (Mon..Sun, Monday top), today bottom-right. The
	// 7d/30d range toggle does NOT resize the graph — it refocuses which
	// days are highlighted (full color) versus dimmed history, so the
	// switch reads as a color morph over a stable grid.
	const heatMax = Math.max(1, ...heatSeries.map(p => p.tokens));
	const heatIndex = new Map<string, (typeof heatSeries)[number]>();
	for (const p of heatSeries) {
		const k = keyOf(p.timestamp);
		if (!heatIndex.has(k)) heatIndex.set(k, p);
	}
	const yearStart = todayStart - 364 * DAY_MS;
	const gridStart = yearStart - ((new Date(yearStart).getDay() + 6) % 7) * DAY_MS; // Monday of the year's first week
	const totalSlots = Math.floor((todayStart - gridStart) / DAY_MS) + 1; // ≤ 371 → ≤ 53 columns
	const heatCols = Math.ceil(totalSlots / 7);
	const heatGrid: ((typeof heatSeries)[number] | null | undefined)[][] = Array.from({ length: heatCols }, () =>
		Array(7).fill(undefined),
	);
	for (let i = 0; i < totalSlots; i++) {
		const ts = gridStart + i * DAY_MS;
		heatGrid[Math.floor(i / 7)][i % 7] = heatIndex.get(keyOf(ts)) ?? null;
	}
	const heatRowLabels = ["一", "三", "五"];
	const fmtDay = (ts: number): string =>
		new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
	// ── Per-model daily token trend (stacked bars) ───────────────────────
	const trendModels: string[] = [];
	for (const p of modelSeries) if (!trendModels.includes(p.model)) trendModels.push(p.model);
	const MODEL_COLORS = ["#4c8dff", "#34b97c", "#9b7bff", "#f5a742", "#e0688a", "#3ec6c8", "#8a9db5"];
	const byDay = new Map<string, Map<string, number>>();
	for (const p of modelSeries) {
		const k = keyOf(p.timestamp);
		let day = byDay.get(k);
		if (!day) {
			day = new Map();
			byDay.set(k, day);
		}
		day.set(p.model, (day.get(p.model) ?? 0) + p.tokens);
	}
	const days = windowDays;
	const dayTotal = (d: number): number => [...(byDay.get(keyOf(d))?.values() ?? [])].reduce((a, b) => a + b, 0);
	const trendMax = Math.max(1, ...days.map(dayTotal));
	// ── Trend-bar FLIP morph ─────────────────────────────────────────────
	// 7d↔30d switching changes bar count/width/height. Bars are keyed by
	// day and reused across ranges, so after every render we capture their
	// rects; when a range switch changes geometry, bars FLIP from the old
	// rect to the new one via a transform morph (not a cross-fade).
	const barRefs = useRef(new Map<number, HTMLDivElement>());
	const prevBarRects = useRef(new Map<number, { x: number; y: number; w: number; h: number }>());
	useLayoutEffect(() => {
		const next = new Map<number, { x: number; y: number; w: number; h: number }>();
		for (const [ts, el] of barRefs.current) {
			const r = el.getBoundingClientRect();
			const prev = prevBarRects.current.get(ts);
			if (prev) {
				const dx = prev.x - r.x;
				const dy = prev.y - r.y;
				const sx = r.width > 0 ? prev.w / r.width : 1;
				const sy = r.height > 0 ? prev.h / r.height : 1;
				if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
					el.style.transformOrigin = "bottom left";
					el.style.transform = `translate(${dx}px, ${dy}px) scaleX(${sx}) scaleY(${sy})`;
					el.style.transition = "none";
					requestAnimationFrame(() => {
						el.style.transition = "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)";
						el.style.transform = "";
					});
				}
			}
			next.set(ts, { x: r.x, y: r.y, w: r.width, h: r.height });
		}
		prevBarRects.current = next;
	});
	return (
		<>
			<h2 className="gui-settings-page-title">{t("usage statistics")}</h2>
			<p className="gui-settings-page-desc">{t("usage statistics description")}</p>
			<div className="flex items-center justify-between">
				<div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
					{(["7d", "30d"] as const).map(r => (
						<button
							key={r}
							type="button"
							className={`rounded-md px-3 py-1 text-[12.5px] transition-colors duration-150${
								range === r ? " bg-[var(--color-accent)] shadow-sm" : " hover:bg-[var(--color-surface-raised)]"
							}`}
							style={
								range === r
									? { color: "var(--color-accent-fg)", fontWeight: 600 }
									: { color: "var(--color-text-muted)" }
							}
							onClick={() => {
								tapFeedback();
								setRange(r);
							}}
						>
							{t(r === "7d" ? "last 7 days" : "last 30 days")}
						</button>
					))}
				</div>
				<button
					type="button"
					className="gui-btn min-w-[92px] justify-center"
					disabled={busy || !rpc}
					onClick={() => {
						tapFeedback();
						void load(true, range);
					}}
				>
					{/* MorphIcon springs refresh-cw ↔ loader-circle on state change;
					 * busy spins the loader. Label stays constant so the button
					 * never changes size. */}
					<MorphIcon
						icon={busy ? LoaderCircleIconData : RefreshCwIconData}
						size={14}
						spring="snappy"
						className={busy ? "gui-spin" : undefined}
					/>
					<span>{t("refresh")}</span>
				</button>
			</div>
			{error ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-error)]">{error}</div>
			) : !stats || !overall ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">…</div>
			) : (
				<>
					<div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
						{[
							{ icon: "flashlight", label: t("token usage"), value: fmtCompact(tokensTotal), sub: null },
							{ icon: "chat-3", label: t("session count"), value: String(stats.sessionCount ?? 0), sub: null },
							{ icon: "chat-4", label: t("message count"), value: fmtCompact(msgTotal), sub: null },
							{ icon: "calendar-schedule", label: t("active days"), value: String(activeDays), sub: null },
							{ icon: "bar-chart-box", label: t("current streak"), value: String(streak), sub: null },
							{
								icon: "equalizer-2",
								label: t("most used model"),
								value: topModel ? topModel.model : "—",
								sub: topModel ? `${t("usage share")} ${topShare}%` : null,
							},
						].map(card => (
							<div key={card.label} className="gui-stats-card">
								<div
									className="truncate font-mono text-[17px] font-semibold leading-none"
									title={typeof card.value === "string" && card.value.length > 18 ? card.value : undefined}
								>
									{card.value}
								</div>
								<div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--color-text-faint)]">
									<span className="flex min-w-0 items-center gap-1.5">
										<Icon name={card.icon as never} className="h-3 w-3 shrink-0" />
										<span className="truncate">{card.label}</span>
									</span>
									{card.sub && <span className="shrink-0 text-[var(--color-text-muted)]">{card.sub}</span>}
								</div>
							</div>
						))}
					</div>
					{/* Active heatmap (ZCode parity): one cell per day, depth = tokens */}
					<div className="gui-settings-section">
						<div className="flex items-center justify-between">
							<div className="gui-settings-section-title">{t("active heatmap")}</div>
							<div className="flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]">
								<span>{t("less activity")}</span>
								<span className="flex gap-0.5">
									{[0.08, 0.2, 0.4, 0.65, 1].map(a => (
										<span
											key={a}
											className="h-2.5 w-2.5 rounded-[3px]"
											style={{
												background: `color-mix(in oklab, var(--color-accent) ${a * 100}%, transparent)`,
											}}
										/>
									))}
								</span>
								<span>{t("more activity")}</span>
							</div>
						</div>
						<div className="mt-2">
							{/* Month labels: shown when a column's data first rolls into a
							 * new month (GitHub contribution-graph style). */}
							<div className="flex gap-[2px] pl-[13px]">
								{heatGrid.map((_col, ci) => {
									// GitHub rule: the column containing the 1st of a month
									// shows that month — independent of data, so all 12
									// months label the year view.
									const firstOfMonth = Array.from(
										{ length: 7 },
										(_, r) => gridStart + (ci * 7 + r) * DAY_MS,
									).find(ts => new Date(ts).getDate() === 1);
									const label = firstOfMonth ? `${new Date(firstOfMonth).getMonth() + 1}月` : "";
									return (
										<div
											key={ci}
											className="w-[11px] whitespace-nowrap text-center text-[8.5px] leading-[11px] text-[var(--color-text-faint)]"
										>
											{label}
										</div>
									);
								})}
							</div>
							<div className="mt-[2px] flex gap-[2px]">
								{/* Weekday row labels: Mon / Wed / Fri (GitHub parity). */}
								<div
									className="grid pr-[4px] text-[8.5px] leading-none text-[var(--color-text-faint)]"
									style={{ gridTemplateRows: "repeat(7, 11px)", gap: "2px" }}
								>
									<span className="flex items-center">{heatRowLabels[0]}</span>
									<span />
									<span className="flex items-center">{heatRowLabels[1]}</span>
									<span />
									<span className="flex items-center">{heatRowLabels[2]}</span>
								</div>
								{heatGrid.map((col, ci) => (
									<div key={ci} className="flex flex-col gap-[2px]">
										{col.map((d, ri) =>
											d === undefined ? (
												// Future day (beyond today) — no cell at all.
												<div key={ri} className="h-[11px] w-[11px]" />
											) : (
												<div
													key={ri}
													title={
														d
															? `${fmtDay(d.timestamp)}: ${fmtCompact(d.tokens)} Tokens · ${d.requests} 轮`
															: undefined
													}
													className="h-[11px] w-[11px] rounded-[2px] hover:scale-110"
													style={{
														background: d
															? d.requests > 0
																? `color-mix(in oklab, var(--color-accent) ${Math.max(12, (d.tokens / heatMax) * 100)}%, transparent)`
																: "color-mix(in oklab, var(--color-text) 6%, transparent)"
															: "color-mix(in oklab, var(--color-text) 3%, transparent)",
														// Selected range (last 7/30 days) stays full color; older
														// history dims — the 7d↔30d switch morphs which days are lit.
														opacity: d && !inWindow(d.timestamp) ? 0.35 : 1,
														transition: "background 200ms ease, opacity 200ms ease, transform 100ms ease",
													}}
												/>
											),
										)}
									</div>
								))}
							</div>
						</div>
					</div>
					{/* Daily token trend, stacked per model (ZCode parity) */}
					{days.length > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("daily token trend")}</div>
							<div
								className={trendMorph ? "gui-blur-morph" : undefined}
								onAnimationEnd={() => setTrendMorph(false)}
							>
								<div className="flex h-24 items-end gap-[3px] pt-2">
									{days.map(d => (
										<div
											key={d}
											ref={el => {
												if (el) barRefs.current.set(d, el);
												else barRefs.current.delete(d);
											}}
											title={`${fmtDay(d)}: ${fmtCompact(dayTotal(d))} Tokens`}
											className="flex min-w-[3px] flex-1 flex-col justify-end gap-px overflow-hidden rounded-t-[2px]"
											style={{ height: `${Math.max(4, (dayTotal(d) / trendMax) * 100)}%` }}
										>
											{trendModels.map((m, i) => {
												const v = byDay.get(keyOf(d))?.get(m) ?? 0;
												if (!v) return null;
												return (
													<div
														key={m}
														style={{
															height: `${(v / dayTotal(d)) * 100}%`,
															background: MODEL_COLORS[i % MODEL_COLORS.length],
														}}
													/>
												);
											})}
										</div>
									))}
								</div>
								<div className="mt-1 flex gap-[3px]">
									{days.map((d, i) => {
										// Label roughly every ceil(n/7)th day (7-8 ticks
										// regardless of range) plus the last day.
										const step = Math.max(1, Math.ceil(days.length / 7));
										const show = i % step === 0 || i === days.length - 1;
										return (
											<div
												key={d}
												className="flex-1 overflow-hidden text-center text-[10px] leading-none text-[var(--color-text-muted)]"
											>
												{show ? fmtDay(d) : ""}
											</div>
										);
									})}
								</div>
							</div>
							{trendModels.length > 1 && (
								<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
									{trendModels.map((m, i) => (
										<span
											key={m}
											className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"
										>
											<span
												className="h-2 w-2 rounded-full"
												style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
											/>
											<span className="max-w-[140px] truncate">{m}</span>
										</span>
									))}
								</div>
							)}
						</div>
					)}
					{(stats.byModel?.length ?? 0) > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("by model")}</div>
							{stats.byModel.map(m => (
								<div key={`${m.provider}:${m.model}`} className="gui-agent-card">
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium">{m.model}</div>
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">
											{m.provider} · {fmtCompact(m.totalRequests)} {t("requests")} ·{" "}
											{fmtCompact(m.totalInputTokens + m.totalOutputTokens)} tok · {fmtCost(m.totalCost)}
										</div>
									</div>
									<div className="text-right font-mono text-[12px] text-[var(--color-text-muted)]">
										{fmtMs(m.avgDuration)}
									</div>
								</div>
							))}
						</div>
					)}
					{(stats.byFolder?.length ?? 0) > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("by folder")}</div>
							{stats.byFolder.map(f => (
								<div key={f.folder} className="gui-agent-card">
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium">{f.folder}</div>
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">
											{fmtCompact(f.totalRequests)} {t("requests")} ·{" "}
											{fmtCompact(f.totalInputTokens + f.totalOutputTokens)} tok · {fmtCost(f.totalCost)}
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</>
			)}
		</>
	);
}

/** One hit from daemon session.search (view-store materialized tables). */
interface SearchHit {
	sessionId: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}
interface SearchResult {
	matches: SearchHit[];
	sessions: { sessionId: string; messageCount: number }[];
}

/** Message content rows are stored as JSON block arrays — flatten to text. */
function hitText(content: string): string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (Array.isArray(parsed)) {
			return parsed
				.map(b => (b && typeof b === "object" && "text" in b ? String((b as { text: string }).text) : ""))
				.filter(Boolean)
				.join("\n");
		}
		if (parsed && typeof parsed === "object" && "text" in parsed) return String((parsed as { text: string }).text);
	} catch {
		// not JSON — raw text
	}
	return content;
}

/** File-index service status (daemon file-index RPC). */
interface IndexStatus {
	enabled: boolean;
	dir: string | null;
	files: number;
	lastScan: number | null;
	scanning: boolean;
	skipped: number;
	truncated: boolean;
}

interface IndexHit {
	path: string;
	snippet: string;
}

/** Settings → 数据与统计 → 索引库: Zed-style code-library index — workspace
 * file contents → daemon FTS5 → instant search. (History-session search
 * lives in its own 历史会话 tab now.) */
function IndexesSection({ rpc, cwd }: { rpc: RpcClient | null; cwd?: string | null }): ReactNode {
	const [idxStatus, setIdxStatus] = useState<IndexStatus | null>(null);
	const [idxEnabled, setIdxEnabled] = useState(() => {
		try {
			return localStorage.getItem("omp-gui-index-enabled") !== "0";
		} catch {
			return true;
		}
	});
	const [autoFolders, setAutoFolders] = useState(() => {
		try {
			return localStorage.getItem("omp-gui-index-newfolders") !== "0";
		} catch {
			return true;
		}
	});
	const [idxQuery, setIdxQuery] = useState("");
	const [idxHits, setIdxHits] = useState<IndexHit[] | null>(null);
	const [idxSearching, setIdxSearching] = useState(false);

	// Status + (when enabled) background scan of the active workspace.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const tick = (): void => {
			void rpc
				.request<IndexStatus>("index.status")
				.then(st => {
					if (!alive) return;
					setIdxStatus(st);
					// Mirror the renderer's switch into the daemon (the DB
					// default is off; the switch reads localStorage).
					if (!st.enabled && idxEnabled) {
						void rpc.request("index.setEnabled", { enabled: true }).catch(() => {});
					}
					// Incremental scan — mtime/offset skip makes this cheap.
					// No session cwd? The daemon falls back to its launch dir.
					if (st.enabled && !st.scanning) {
						void rpc.request("index.scan", cwd ? { cwd } : {}).catch(() => {});
					}
				})
				.catch(() => alive && setIdxStatus(null));
		};
		tick();
		const id = setInterval(tick, 2000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [rpc, cwd, idxEnabled]);

	// Instant code search (debounced).
	useEffect(() => {
		const q = idxQuery.trim();
		if (q.length < 2) {
			setIdxHits(null);
			return;
		}
		const id = setTimeout(() => {
			if (!rpc) return;
			setIdxSearching(true);
			void rpc
				.request<IndexHit[]>("index.search", { query: q, limit: 30 })
				.then(hits => setIdxHits(hits ?? []))
				.catch(() => setIdxHits([]))
				.finally(() => setIdxSearching(false));
		}, 250);
		return () => clearTimeout(id);
	}, [idxQuery, rpc]);

	const toggleIndex = (next: boolean): void => {
		setIdxEnabled(next);
		try {
			localStorage.setItem("omp-gui-index-enabled", next ? "1" : "0");
		} catch {
			// ignore
		}
		tapFeedback();
		if (next && rpc) {
			void rpc.request("index.setEnabled", { enabled: true }).then(() => {
				if (cwd) void rpc.request("index.scan", { cwd }).catch(() => {});
			});
		} else {
			void rpc?.request("index.setEnabled", { enabled: false }).catch(() => {});
		}
	};

	const lastScanLabel = idxStatus?.lastScan ? new Date(idxStatus.lastScan).toLocaleTimeString() : "—";

	// Snippet highlight: the daemon wraps matches in \u0001..\u0002.
	const renderSnippet = (snip: string): ReactNode => {
		const parts = snip.split(/\u0001|\u0002/);
		return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("index library")}</h2>
			<p className="gui-settings-page-desc">{t("index library description")}</p>

			<div className="gui-settings-section-title">{t("code library")}</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("index new folders")}</div>
					<div className="gui-settings-row-desc">{t("index new folders description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={autoFolders}
					className={`gui-toggle${autoFolders ? " gui-toggle--on" : ""}`}
					onClick={() => {
						tapFeedback();
						setAutoFolders(v => {
							const next = !v;
							try {
								localStorage.setItem("omp-gui-index-newfolders", next ? "1" : "0");
							} catch {
								// ignore
							}
							return next;
						});
					}}
				/>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("index repositories")}</div>
					<div className="gui-settings-row-desc">{t("index repositories description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={idxEnabled}
					className={`gui-toggle${idxEnabled ? " gui-toggle--on" : ""}`}
					onClick={() => toggleIndex(!idxEnabled)}
				/>
			</div>
			<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">
				{idxStatus
					? idxStatus.scanning
						? `${t("indexing")}…`
						: `${t("indexed files")}: ${idxStatus.files} · ${t("last scan")}: ${lastScanLabel}${idxStatus.truncated ? ` · ${t("index truncated")}` : ""}`
					: t("index unavailable")}
			</div>
			<div className="gui-settings-row">
				<input
					type="search"
					className="gui-settings-input w-full"
					placeholder={t("instant search placeholder")}
					value={idxQuery}
					onChange={e => setIdxQuery(e.target.value)}
				/>
			</div>
			{idxSearching ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">…</div>
			) : idxHits && idxHits.length === 0 ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-muted)]">{t("no results")}</div>
			) : (
				(idxHits ?? []).map(h => (
					<div key={h.path} className="gui-agent-card">
						<div className="truncate font-mono text-[12px] text-[var(--color-text-muted)]">{h.path}</div>
						<div className="mt-0.5 line-clamp-2 text-[13px]">{renderSnippet(h.snippet)}</div>
					</div>
				))
			)}
		</>
	);
}

/** One row from daemon session.list (history viewer left pane). */
interface SessionRow {
	id: string;
	title?: string;
	timestamp?: string;
	messageCount?: number;
	model?: string;
	cwd?: string;
}

/** Settings → 数据与统计 → 历史会话: two-pane history browser (like the
 * extensions center) — session list left, message stream right; the search
 * box filters sessions to those containing a message match and the right
 * pane shows the hits. */
function HistorySection({
	rpc,
	onOpenSession,
}: {
	rpc: RpcClient | null;
	onOpenSession?: (sessionId: string) => void;
}): ReactNode {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [query, setQuery] = useState("");
	const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [messages, setMessages] = useState<SearchHit[] | null>(null);
	const [loadingMsgs, setLoadingMsgs] = useState(false);
	// Cross-session message-search in-flight flag (the debounced search
	// effect below sets it; was referenced without a declaration).
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<SessionRow[]>("session.list", {})
			.then(rows => {
				if (!alive) return;
				setSessions(rows ?? []);
				// Preselect the most recent session WITH messages when
				// nothing is open yet (fresh/empty sessions have no
				// materialized rows and would show an empty right pane).
				setSelected(prev => prev ?? rows?.find(r => (r.messageCount ?? 0) > 0)?.id ?? rows?.[0]?.id ?? null);
			})
			.catch(() => alive && setSessions([]));
		return () => {
			alive = false;
		};
	}, [rpc]);

	// Cross-session message search (debounced).
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setSearchRes(null);
			return;
		}
		const id = setTimeout(() => {
			if (!rpc) return;
			setSearching(true);
			void rpc
				.request<SearchResult>("session.search", { query: q, limit: 200 })
				.then(res => setSearchRes(res ?? null))
				.catch(() => setSearchRes(null))
				.finally(() => setSearching(false));
		}, 300);
		return () => clearTimeout(id);
	}, [query, rpc]);

	// Selected session's message stream.
	useEffect(() => {
		if (!selected || !rpc) {
			setMessages(null);
			return;
		}
		let alive = true;
		setLoadingMsgs(true);
		void rpc
			.request<SearchHit[]>("history.messages", { sessionId: selected, limit: 500 })
			.then(rows => {
				if (!alive) return;
				setMessages(rows ?? []);
				// Some sessions have a journal/messageCount but no rows in
				// the materialized messages table — hop to the next session
				// that does (once; never loop on an all-empty list).
				if ((!rows || rows.length === 0) && !searchRes) {
					const all = sessions ?? [];
					const idx = all.findIndex(s => s.id === selected);
					const next = all.slice(idx + 1).find(s => (s.messageCount ?? 0) > 0);
					if (next) setSelected(next.id);
				}
			})
			.catch(() => alive && setMessages([]))
			.finally(() => alive && setLoadingMsgs(false));
		return () => {
			alive = false;
		};
	}, [selected, rpc, searchRes, sessions]);

	const bySession = new Map<string, SearchHit[]>();
	for (const m of searchRes?.matches ?? []) {
		const list = bySession.get(m.sessionId) ?? [];
		list.push(m);
		bySession.set(m.sessionId, list);
	}
	// Searching: only sessions with hits (plus the selected one so the right
	// pane keeps a stable anchor). Not searching: the full list.
	const visibleSessions = searchRes
		? (sessions ?? []).filter(s => bySession.has(s.id) || s.id === selected)
		: (sessions ?? []);
	// Search hits land on a session with matches (jump off a stale pick).
	useEffect(() => {
		if (searchRes && selected && !bySession.has(selected) && bySession.size > 0) {
			setSelected([...bySession.keys()][0] ?? null);
		}
	}, [searchRes, selected, bySession]);
	const visibleMsgs = selected ? (searchRes ? (bySession.get(selected) ?? []) : (messages ?? [])) : [];

	return (
		<>
			<h2 className="gui-settings-page-title">{t("session history")}</h2>
			<p className="gui-settings-page-desc">{t("session history description")}</p>
			<div className="gui-ext-body" style={{ gridTemplateColumns: "minmax(0, 34%) minmax(0, 1fr)" }}>
				<div className="gui-ext-list">
					<div className="gui-ext-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
						<input
							type="search"
							className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
							placeholder={t("search messages placeholder")}
							value={query}
							onChange={e => setQuery(e.target.value)}
						/>
					</div>
					<div className="gui-ext-list-scroll">
						{sessions === null ? (
							<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-faint)]">…</div>
						) : visibleSessions.length === 0 ? (
							<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-muted)]">{t("no results")}</div>
						) : (
							visibleSessions.map(s => (
								<button
									key={s.id}
									type="button"
									className={`gui-history-item${selected === s.id ? " gui-history-item--active" : ""}`}
									onClick={() => {
										tapFeedback();
										setSelected(s.id);
									}}
								>
									<div className="truncate text-[12.5px] font-medium" title={s.title || s.id}>
										{s.title || s.id.slice(0, 10)}
									</div>
									<div className="truncate text-[11px] text-[var(--color-text-muted)]">
										{s.timestamp ? new Date(s.timestamp).toLocaleString() : ""}
										{s.messageCount != null ? ` · ${s.messageCount} ${t("messages")}` : ""}
										{searchRes ? ` · ${bySession.get(s.id)?.length ?? 0}` : ""}
									</div>
								</button>
							))
						)}
					</div>
				</div>
				<div className="gui-ext-list">
					<div className="gui-ext-search flex items-center justify-between gap-2">
						<span
							className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
							title={sessions?.find(s => s.id === selected)?.title || selected || ""}
						>
							{sessions?.find(s => s.id === selected)?.title || selected?.slice(0, 10) || "—"}
						</span>
						{selected && onOpenSession && (
							<button
								type="button"
								className="gui-btn gui-btn--small shrink-0"
								onClick={() => {
									tapFeedback();
									onOpenSession(selected);
								}}
							>
								{t("open")}
							</button>
						)}
					</div>
					<div className="gui-ext-list-scroll">
						<div key={selected ?? "none"} className="gui-history-swap">
							{loadingMsgs ? (
								<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-faint)]">…</div>
							) : visibleMsgs.length === 0 ? (
								<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-muted)]">
									{searchRes ? t("no results") : t("no messages")}
								</div>
							) : (
								visibleMsgs.map(m => (
									<div key={`${m.sessionId}:${m.seq}`} className="gui-history-msg">
										<div className="flex items-center gap-2">
											<span className={`gui-history-role gui-history-role--${m.role}`}>{m.role}</span>
											<span className="text-[11px] text-[var(--color-text-faint)]">
												{new Date(m.timestamp).toLocaleTimeString()}
											</span>
											{m.model && (
												<span className="truncate font-mono text-[11px] text-[var(--color-text-faint)]">
													{m.model}
												</span>
											)}
										</div>
										<div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
											{hitText(m.content)}
										</div>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>
		</>
	);
}

/** Settings → 智能体 → 钩子: hook-capability extensions (pre/post tool
 * scripts) with enable toggles — same extensions.list/setEnabled path the
 * skills center and MCP tab use. */
function HooksSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [hooks, setHooks] = useState<McpItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ extensions: McpItem[] }>("extensions.list", {})
				.then(res => {
					if (alive) setHooks((res?.extensions ?? []).filter(e => e.kind === "hook"));
				})
				.catch(() => alive && setHooks([]));
		};
		load();
		let id = setInterval(load, 3000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				load();
				id = setInterval(load, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			alive = false;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc]);
	const toggle = (e: McpItem, next: boolean): void => {
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next }).then(() => {
			setHooks(prev => prev?.map(m => (m.id === e.id ? { ...m, state: next ? "active" : "disabled" } : m)) ?? prev);
		});
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("hooks")}</h2>
			<p className="gui-settings-page-desc">{t("hooks description")}</p>
			{hooks === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : hooks.length === 0 ? (
				<div className="gui-settings-row">{t("no hooks")}</div>
			) : (
				hooks.map(h => (
					<div key={h.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{h.displayName || h.name}</span>
								<span className="gui-provider-chip">hook</span>
							</div>
							{h.description && (
								<div className="truncate text-[12px] text-[var(--color-text-muted)]">{h.description}</div>
							)}
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={h.state === "active"}
							className={`gui-toggle${h.state === "active" ? " gui-toggle--on" : ""}`}
							onClick={() => {
								tapFeedback();
								toggle(h, h.state !== "active");
							}}
						/>
					</div>
				))
			)}
		</>
	);
}

interface BrowserTabInfo {
	targetId: string;
	title: string;
	url: string;
}

interface BrowserExtensionInfo {
	id: string;
	name: string;
	version: string;
}

/** 浏览器 section: shared automation Chromium status + defaults + the
 *  MusePi Browser Relay extension (chrome.debugger bridge into the user's own
 *  Chrome — kimi webbridge 同款) install entry. */
function BrowserSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [headless, setHeadless] = useState<boolean | null>(null);
	const [relay, setRelay] = useState<boolean | null>(null);
	const [gui, setGui] = useState<boolean | null>(null);
	const [restrictToPublic, setRestrictToPublic] = useState<boolean | null>(null);
	const [endpoint, setEndpoint] = useState<string | null>(null);
	const [profileDir, setProfileDir] = useState<string | null>(null);
	const [tabCount, setTabCount] = useState<number | null>(null);
	const [extensions, setExtensions] = useState<BrowserExtensionInfo[] | null>(null);
	const [relayDir, setRelayDir] = useState<string | null>(null);
	const [installing, setInstalling] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);
	const [glow, setGlow] = useState<boolean | null>(null);

	const refresh = (): void => {
		if (!rpc) return;
		void rpc
			.request<{ [k: string]: unknown }>("settings.get", {
				keys: [
					"browser.headless",
					"browser.relay",
					"browser.gui",
					"browser.policy.restrictToPublic",
					"computer.glow",
				],
			})
			.then(res => {
				setHeadless(res["browser.headless"] === true);
				setRelay(res["browser.relay"] === true);
				setGui(res["browser.gui"] === true);
				setRestrictToPublic(res["browser.policy.restrictToPublic"] === true);
				setGlow(res["computer.glow"] !== false);
			})
			.catch(() => {});
		void rpc
			.request<{ wsEndpoint?: string; profileDir?: string }>("browser.endpoint", {})
			.then(res => {
				setEndpoint(res?.wsEndpoint ?? null);
				setProfileDir(res?.profileDir ?? null);
			})
			.catch(() => setEndpoint(null));
		void rpc
			.request<{ tabs?: BrowserTabInfo[] }>("browser.tabs", {})
			.then(res => setTabCount(res?.tabs?.length ?? 0))
			.catch(() => setTabCount(0));
		void rpc
			.request<{ extensions?: BrowserExtensionInfo[] }>("browser.extensions", {})
			.then(res => setExtensions(res?.extensions ?? []))
			.catch(() => setExtensions([]));
	};

	useEffect(() => {
		refresh();
		const id = setInterval(refresh, 4000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	const setBool = (
		key: "browser.headless" | "browser.relay" | "browser.gui" | "browser.policy.restrictToPublic" | "computer.glow",
		next: boolean,
	): void => {
		void rpc?.request("settings.set", { key, value: next }).then(() => {
			refresh();
			// The app's glow latch caches this setting — poke it to re-read.
			if (key === "computer.glow") window.dispatchEvent(new Event("omp-glow-setting"));
		});
	};

	const installRelay = (): void => {
		if (!rpc || installing) return;
		setInstalling(true);
		void rpc
			.request<{ dir: string }>("browser.relayInstall", {})
			.then(res => setRelayDir(res?.dir ?? null))
			.finally(() => setInstalling(false));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("browser")}</h2>
			<p className="gui-settings-page-desc">{t("browser settings description")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("browser engine")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("headless browser")}</div>
						<div className="gui-settings-row-desc">{t("headless browser description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={headless === true}
						className={`gui-toggle${headless === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.headless", !(headless === true))}
						aria-label={t("headless browser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("browser relay")}</div>
						<div className="gui-settings-row-desc">{t("browser relay description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={relay === true}
						className={`gui-toggle${relay === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.relay", !(relay === true))}
						aria-label={t("browser relay")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("managed browser")}</div>
						<div className="gui-settings-row-desc">{t("managed browser description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={gui === true}
						className={`gui-toggle${gui === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.gui", !(gui === true))}
						aria-label={t("managed browser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("public internet only")}</div>
						<div className="gui-settings-row-desc">{t("public internet only description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={restrictToPublic === true}
						className={`gui-toggle${restrictToPublic === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.policy.restrictToPublic", !(restrictToPublic === true))}
						aria-label={t("public internet only")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{/* Relay extension install (chrome.debugger bridge — the agent
				 * drives your own Chrome tabs, kimi webbridge 同款). */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("browser relay extension")}</div>
						<div className="gui-settings-row-desc">
							{relayDir ? (
								<span className="break-all">{t("browser relay installed at {dir}", { dir: relayDir })}</span>
							) : (
								t("browser relay extension description")
							)}
						</div>
					</div>
					<button type="button" className="gui-btn gui-btn--small" disabled={installing} onClick={installRelay}>
						{installing ? "…" : t("install")}
					</button>
				</div>
			</div>
			{/* Computer-use screen glow: full-screen edge + target highlight
			 * while the agent operates the desktop (computer.glow) — its own
			 * section, this tab covers desktop automation too. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("desktop operation hints")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("computer glow")}</div>
						<div className="gui-settings-row-desc">{t("computer glow description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={glow === true}
						className={`gui-toggle${glow === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("computer.glow", !(glow === true))}
						aria-label={t("computer glow")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{glow === true && (
					<div className="gui-computer-glow-preview" aria-hidden="true">
						<div className="gui-cgp-edge" />
						<div className="gui-cgp-badge">
							<span className="gui-cgp-dot" />
							<span>AI 正在操作桌面</span>
						</div>
						<div className="gui-cgp-finder">
							<div className="gui-cgp-finder-bar">
								<span className="gui-cgp-light gui-cgp-light--close" />
								<span className="gui-cgp-light gui-cgp-light--min" />
								<span className="gui-cgp-light gui-cgp-light--max" />
								<span className="gui-cgp-finder-title">Finder</span>
							</div>
							<div className="gui-cgp-finder-body">
								<div className="gui-cgp-finder-side" />
								<div className="gui-cgp-finder-files">
									<i />
									<i />
									<i />
									<i />
									<i />
									<i />
								</div>
							</div>
						</div>
						<div className="gui-cgp-ring" />
					</div>
				)}
			</div>
			{/* Browser data (zcode 浏览器数据 parity): one-time Chrome
			 * import, cache clear, full clear. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("browser data")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("import chrome data")}</div>
						<div className="gui-settings-row-desc">{t("import chrome data description")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={importing}
						onClick={() => {
							if (!rpc || importing) return;
							setImporting(true);
							void rpc
								.request<{ ok?: boolean; importedFrom?: string; error?: string }>("browser.importChrome", {})
								.then(res => setImportMsg(res?.ok ? (res.importedFrom ?? "") : (res?.error ?? "")))
								.finally(() => setImporting(false));
						}}
					>
						{importing ? "…" : t("import browser data")}
					</button>
				</div>
				{importMsg && <div className="px-3 pb-2 text-[11.5px] text-[var(--color-text-faint)]">{importMsg}</div>}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("clear browser cache")}</div>
						<div className="gui-settings-row-desc">{t("clear browser cache description")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={clearing}
						onClick={() => {
							if (!rpc || clearing) return;
							setClearing(true);
							void rpc.request("browser.clearCache", {}).finally(() => setClearing(false));
						}}
					>
						{clearing ? "…" : t("clear cache")}
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("clear all browser data")}</div>
						<div className="gui-settings-row-desc">{t("clear all browser data description")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small gui-btn--danger"
						disabled={clearing}
						onClick={() => {
							if (!rpc || clearing) return;
							setClearing(true);
							void rpc.request("browser.clearAll", {}).finally(() => setClearing(false));
						}}
					>
						{clearing ? "…" : t("clear all")}
					</button>
				</div>
			</div>
			{/* Shared browser status + installed extensions */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("running state")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("shared browser")}</div>
						<div className="gui-settings-row-desc">
							{endpoint
								? t("shared browser running · {tabs} tabs", { tabs: tabCount ?? 0 })
								: t("shared browser idle")}
						</div>
					</div>
					{endpoint && <span className="gui-provider-chip">{t("running")}</span>}
				</div>
				{profileDir && (
					<div className="px-3 pb-2">
						<div className="truncate text-[11px] text-[var(--color-text-faint)]" title={profileDir}>
							{profileDir}
						</div>
					</div>
				)}
				<div className="gui-group-label px-3 pb-1 pt-2">{t("extensions")}</div>
				{extensions === null ? (
					<div className="px-3 text-[12px] text-[var(--color-text-faint)]">…</div>
				) : extensions.length === 0 ? (
					<div className="px-3 pb-2 text-[12px] text-[var(--color-text-faint)]">{t("no extensions")}</div>
				) : (
					extensions.map(ext => (
						<div key={ext.id} className="gui-agent-card">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="truncate text-[13px] font-medium">{ext.name}</span>
									<span className="gui-provider-chip">{ext.version}</span>
								</div>
								<div className="truncate text-[11px] text-[var(--color-text-faint)]">{ext.id}</div>
							</div>
						</div>
					))
				)}
			</div>
		</>
	);
}
