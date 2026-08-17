import {
	CodeHighlightProvider,
	DARK_THEME_PRESETS,
	DiffBlock,
	getLocaleSnapshot,
	highlightToCodeHtml,
	LIGHT_THEME_PRESETS,
	renderMermaidHtml,
	setLocale,
	subscribeLocale,
	type TranslationKey,
	t,
	type UiThemeId,
	UNIFIED_THEME_PRESETS,
	useAccentPreference,
	useThemePreference,
	useUiThemePreferences,
} from "@musepi/collab-web";
import type { SoundName } from "cuelume";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useChatHighlight } from "../lib/highlight";
import { tapFeedback } from "../lib/haptic";
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
import { type ElectronApi, nativeHighlight } from "../lib/highlight";
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
import {
	cleanupCandidates,
	cleanupDays as cleanupDaysPref,
	cleanupEnabled as cleanupEnabledPref,
	cleanupAction as cleanupActionPref,
	runCleanupOnce,
} from "../lib/session-cleanup";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import {
	ALL_SOUNDS,
	DEFAULT_SFX,
	previewSound,
	SFX_EVENTS,
	setSoundFor,
	soundFor,
	WIRED_SOUNDS,
	type SfxEvent,
} from "../lib/sfx";
import { Icon, type IconName } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { AgentStatusLine } from "./Composer";
import { DialogFrame } from "./DialogFrame";
import { DotMatrixMark } from "./DotMatrixMark";
import { ExtensionsCenter } from "./ExtensionsCenter";
import { HeightMorph } from "./HeightMorph";
import { ModelSelector } from "./ModelSelector";
import { BuiltinPetSprite, PetdexSprite } from "./PetSprite";
import { Pop } from "./Pop";
import { Reveal } from "./Reveal";
import { SpotlightCard } from "./SpotlightCard";
import { type SchemaItem, SchemaSettings } from "./SchemaSettings";
import { ThinkingSelector } from "./ThinkingSelector";
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
	| "about"
	| "chat"
	| "notifications"
	| "pet"
	| "sessions"
	| "git"
	| "shortcuts"
	| "agents"
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

/** ZCode-style grouped navigation: 基础设置 / 智能体 / 数据与统计. The
 * openchamber-parity tabs (chat / notifications / sessions / shortcuts /
 * agents) are backed by live settings; hooks (extensions RPC), 索引库
 * (session.search) and 使用统计 (packages/stats) complete the capability
 * groups. */
const NAV_GROUPS: { title: string; items: SectionDef[] }[] = [
	{
		title: t("basic settings"),
		items: [
			{ id: "general", icon: "settings-3", label: t("general"), enabled: true },
			{ id: "appearance", icon: "palette", label: t("appearance"), enabled: true },
			{ id: "chat", icon: "chat-ai-3", label: t("chat settings"), enabled: true },
			{ id: "notifications", icon: "notification-3", label: t("notifications & sound"), enabled: true },
			{ id: "pet", icon: "robot-2", label: t("agent companion"), enabled: true },
			{ id: "sessions", icon: "history", label: t("sessions"), enabled: true },
			{ id: "git", icon: "git-branch", label: t("git settings"), enabled: true },
			{ id: "shortcuts", icon: "command", label: t("shortcuts"), enabled: true },
			{ id: "model", icon: "ai-agent", label: t("model settings"), enabled: true },
			{ id: "files", icon: "file-text", label: t("files & lsp"), enabled: true },
			{ id: "memory", icon: "brain", label: t("memory settings"), enabled: true },
			{ id: "about", icon: "information", label: t("about"), enabled: true },
		],
	},
	{
		title: t("agent capabilities"),
		items: [
			{ id: "agents", icon: "robot", label: t("agents"), enabled: true },
			{ id: "plugins", icon: "plug", label: t("plugins"), enabled: true },
			{ id: "skills", icon: "sparkling", label: t("extensions"), enabled: true },
			{ id: "subagents", icon: "user", label: t("sub agents"), enabled: true },
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
	const [showAvatars, setShowAvatars] = useState(() => localStorage.getItem("omp-gui-avatars") !== "0");
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [apiProviders, setApiProviders] = useState<ApiProviderInfo[]>([]);
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
	const [custom, setCustom] = useState<CustomProvider[]>([]);
	const [loginState, setLoginState] = useState<{
		providerId: string;
		url?: string;
		message?: string;
		waitingInput?: boolean;
	} | null>(null);
	const [busy, setBusy] = useState(false);

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
		const p = providerEvent.payload as { providerId?: string; url?: string; message?: string; placeholder?: string };
		if (providerEvent.kind === "provider-auth") {
			setLoginState({
				providerId: p.providerId ?? "",
				url: p.url,
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
					<div className="gui-settings-nav-scroll">
						{NAV_GROUPS.map(group => (
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
					{/* Bottom: onboarding + daemon status (user-area slot). */}
					<div className="flex flex-col gap-0.5 border-t border-[var(--border)] px-2 py-2">
						<button
							type="button"
							className="gui-settings-nav"
							onClick={() => window.dispatchEvent(new CustomEvent("omp-open-onboarding"))}
						>
							<Icon name="rocket" className="h-4 w-4" />
							<span className="gui-settings-nav-label">{t("onboarding")}</span>
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
						<HeightMorph morphKey={section} className="gui-settings-content">
							{section === "general" && <GeneralSection rpc={rpc} />}
							{section === "appearance" && (
								<AppearanceSection
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
							{section === "chat" && <ChatSection />}
							{section === "notifications" && <NotificationsSection rpc={rpc} />}
							{section === "pet" && <PetSection />}
							{section === "sessions" && <SessionsSection rpc={rpc} currentSessionId={sessionId} />}
							{section === "git" && <GitSection rpc={rpc} />}
							{section === "shortcuts" && <ShortcutsSection />}
							{section === "files" && <FilesLspSection rpc={rpc} />}
							{section === "memory" && <MemorySection rpc={rpc} />}
							{section === "agents" && <AgentsSection rpc={rpc} />}
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
							{section === "about" && (
								<>
									<h2 className="gui-settings-page-title">{t("about")}</h2>
									<p className="gui-settings-page-desc">MusePi GUI</p>
									<div className="gui-settings-row">
										<div className="gui-settings-row-label">v0.1.0 — openchamber-inspired shell</div>
									</div>
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
						</HeightMorph>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Accent preset → swatch color (light scheme; tokens own the real value). */
const ACCENT_SWATCH: Record<string, string> = {
	brand: "#7c5cff",
	mono: "#8a8a93",
	ocean: "#38bdf8",
	jade: "#34d399",
};

const THEME_OPTIONS = [
	{ id: "system", label: t("follow system") },
	{ id: "light", label: t("light") },
	{ id: "dark", label: t("dark") },
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
}: {
	showAvatars: boolean;
	onToggleAvatars(): void;
}): ReactNode {
	const { preference, resolved, setPreference } = useThemePreference();
	const { accent, setAccent, customAccent, setCustomAccent } = useAccentPreference();
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
	const [statusBarIndicator, setStatusBarIndicator] = useState<"braille" | "orb">(() => {
		const v = localStorage.getItem("omp-gui-statusbar-indicator");
		return v === "orb" ? "orb" : "braille";
	});
	const [sweepColor, setSweepColor] = useState<"default" | "accent">(() => {
		const v = localStorage.getItem("omp-gui-statusbar-kitt-color");
		return v === "accent" ? "accent" : "default";
	});
	const [inlineImages, setInlineImages] = useState<boolean>(() => localStorage.getItem("omp-gui-images") !== "0");
	const [fontScale, setFontScale] = useState<number>(() => Number(localStorage.getItem("omp-gui-font-scale") ?? 14));
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
					<select className="gui-settings-select" value={locale} onChange={e => setLocale(e.target.value)}>
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
						<select
							className="gui-settings-select"
							value={preference}
							onChange={e => setPreference(e.target.value as "system" | "light" | "dark")}
						>
							{THEME_OPTIONS.map(o => (
								<option key={o.id} value={o.id}>
									{o.label}
								</option>
							))}
						</select>
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
					<>
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
					</>
				</Reveal>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface font size")}</div>
					<NumberStepper
						label={t("interface font size")}
						value={fontScale}
						min={12}
						max={18}
						unit="px"
						defaultValue={14}
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
									aria-label={id}
									title={id}
									onClick={() => setAccent(id as "brand" | "mono" | "ocean" | "jade")}
								/>
							))}
							<label
								className={`gui-accent-swatch gui-accent-swatch--custom${accent === "custom" ? " gui-accent-swatch--active" : ""}`}
								style={{ background: customAccent }}
								title={t("custom accent")}
							>
								<input
									type="color"
									className="gui-accent-picker"
									value={customAccent}
									aria-label={t("custom accent")}
									onChange={e => {
										setAccent("custom");
										setCustomAccent(e.target.value);
									}}
								/>
							</label>
						</div>
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
								{(["braille", "orb"] as const).map(s => (
									<button
										key={s}
										type="button"
										className={`gui-seg-btn${statusBarIndicator === s ? " gui-seg-btn--active" : ""}`}
										onClick={() => {
											setStatusBarIndicator(s);
											localStorage.setItem("omp-gui-statusbar-indicator", s);
										}}
									>
										{s === "braille" ? t("braille") : t("orb")}
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
}: {
	label: string;
	description: string;
	storageKey: string;
	/** Optional class toggled on <html> while the pref is OFF. */
	onClass?: string;
	/** Default value when the key is unset. */
	on?: boolean;
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
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{label}</div>
				<div className="gui-settings-row-desc">{description}</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={onState}
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

/** openchamber-parity chat display settings (transcript rendering). */
function ChatSection(): ReactNode {
	const [mermaidModeState, setMermaidModeState] = useState<"svg" | "ascii">(() => {
		try {
			return localStorage.getItem("omp-gui-chat-mermaid") === "ascii" ? "ascii" : "svg";
		} catch {
			return "svg";
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
	// Live previews re-render with the segments (mermaid svg/ascii + diff
	// layout) — same renderers the transcript uses, sample content only.
	const mermaidPreviewHtml = useMemo(() => renderMermaidHtml(MERMAID_SAMPLE, mermaidModeState), [mermaidModeState]);
	// Same highlighter the chat transcript uses (Electron IPC → tree-sitter
	// natives); the provider makes the preview's DiffBlock highlight too.
	const chatHighlight = useChatHighlight();
	return (
		<>
			<h2 className="gui-settings-page-title">{t("chat settings")}</h2>
			<p className="gui-settings-page-desc">{t("chat settings description")}</p>
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
				label={t("widgets expanded")}
				description={t("widgets expanded description")}
				storageKey="omp-gui-widget-expanded"
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
			<PrefToggle
				label={t("smooth streaming")}
				description={t("smooth streaming description")}
				storageKey="omp-gui-chat-smooth"
				onClass="gui-chat-no-smooth"
			/>
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
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("chat preview")}</div>
				<div className="gui-settings-section-desc">{t("chat preview description")}</div>
				<CodeHighlightProvider highlight={chatHighlight}>
					<div className="gui-chat-preview">
						<div className="gui-chat-preview-label">{t("mermaid")}</div>
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: built by renderMermaidHtml (escaped source) */}
						<div className="gui-chat-preview-mermaid" dangerouslySetInnerHTML={{ __html: mermaidPreviewHtml }} />
						<div className="gui-chat-preview-label">{t("diff")}</div>
						{/* tr-card--diff container: same aicss file-diff tinting the transcript
						 * ToolCard applies (accent bar + green/red row tints). */}
						<div className="tr-card--diff">
							<DiffBlock diff={DIFF_SAMPLE} layout={diffLayoutState} />
						</div>
					</div>
				</CodeHighlightProvider>
			</div>
		</>
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
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
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
		try {
			const raw = await electronAPI.importPetdex();
			if (!raw) return;
			if ("error" in raw) {
				console.error("[pet] import failed:", raw.error);
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
	const presetEntries: PetGridEntry[] = BUILTIN_PETDEX.map(p => ({
		id: p.id,
		name: p.displayName,
		description: p.description,
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
										scale={sizeScale}
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
						<button type="button" className="gui-btn" onClick={() => sendTestNotification()}>
							<Icon name="notification-3" className="h-3.5 w-3.5" />
							{t("send test notification")}
						</button>
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
	}, [auth?.avatarUrl]);

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
		[rpc, refreshAuth],
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
		{ keys: "⌘⇧E", action: t("toggle sidebar shortcut") },
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

/** Agent Control Center (TUI /agents parity): live roster from the
 *  daemon — kind chips, subagent parent links, and a 2s live refresh so
 *  the status/activity columns track running turns. */
function AgentsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [agents, setAgents] = useState<
		| {
				id: string;
				displayName: string;
				kind: string;
				parentId: string | null;
				status: string;
				activity: string | null;
		  }[]
		| null
	>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{
					agents: {
						id: string;
						displayName: string;
						kind: string;
						parentId: string | null;
						status: string;
						activity: string | null;
					}[];
				}>("agents.list", {})
				.then(res => {
					if (alive) setAgents(res?.agents ?? []);
				})
				.catch(() => {
					if (alive) setAgents([]);
				});
		};
		load();
		// Visibility guard (parity with the other settings polls): never
		// poll the daemon from a hidden window.
		let id = setInterval(load, 2000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				load();
				id = setInterval(load, 2000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			alive = false;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc]);
	const byId = new Map((agents ?? []).map(a => [a.id, a]));
	const list = agents ?? [];
	const mains = list.filter(a => a.kind === "main");
	const subs = list.filter(a => a.kind !== "main");
	const Card = (a: (typeof list)[number]): ReactNode => (
		<div key={a.id} className="gui-agent-card">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-[13px] font-medium">{a.displayName}</span>
					<span className="gui-provider-chip">{a.kind}</span>
				</div>
				<div className="truncate text-[12px] text-[var(--color-text-faint)]">
					{a.id}
					{a.parentId && byId.has(a.parentId) && ` · ${t("subagent of")} ${byId.get(a.parentId)?.displayName}`}
				</div>
			</div>
			<span className={`gui-agent-status gui-agent-status--${a.status ?? "idle"}`}>{a.status}</span>
			{a.activity && <div className="truncate text-[12px] text-[var(--color-text-muted)]">{a.activity}</div>}
		</div>
	);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("agents")}</h2>
			<p className="gui-settings-page-desc">{t("agents settings")}</p>
			{agents === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : agents.length === 0 ? (
				<div className="gui-settings-row">{t("no running agents")}</div>
			) : (
				<>
					{mains.length > 0 && (
						<h3 className="gui-settings-group-h">
							{t("main agents")} · {mains.length}
						</h3>
					)}
					{mains.map(Card)}
					{subs.length > 0 && (
						<h3 className="gui-settings-group-h">
							{t("subagents")} · {subs.length}
						</h3>
					)}
					{subs.length === 0 && <div className="gui-settings-row">{t("no subagents running")}</div>}
				</>
			)}
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
	}, [rpc, tabs.join(",")]);
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
	return <SchemaSettings items={schema ?? []} values={values} onChange={onChange} error={error} />;
}

function GeneralSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [info, setInfo] = useState<{
		version?: string;
		engine?: string;
		dataRoot?: string;
		configDir?: string;
		runtime?: string;
	} | null>(null);
	const [metaErr, setMetaErr] = useState<string | null>(null);
	const [pickedRoot, setPickedRoot] = useState<string | null>(null);
	const [rootBusy, setRootBusy] = useState(false);
	const [rootMsg, setRootMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("omp-gui-dotmatrix") !== "0");
	const [dotMatrixText, setDotMatrixText] = useState(() => localStorage.getItem("omp-gui-dotmatrix-text") ?? "MusePi");
	const [keepAwake, setKeepAwake] = useState(() => localStorage.getItem("omp-gui-keep-awake") === "1");
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ version?: string; engine?: string; dataRoot?: string; configDir?: string; runtime?: string }>(
					"system.meta",
				)
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
						void (window as unknown as { electronAPI?: { setKeepAwake?(v: boolean): Promise<unknown> } })
							.electronAPI?.setKeepAwake?.(next);
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
							<div className="text-[13px] text-[var(--color-text-muted)]">{info.version}</div>
						</div>
					</div>
					{info.engine && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("engine")}</div>
								<div className="text-[13px] text-[var(--color-text-muted)]">{info.engine}</div>
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

/** Settings → 智能体 → 子代理: live subagent list (agents.list, kind filter). */
function SubagentsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [agents, setAgents] = useState<
		| {
				id: string;
				displayName: string;
				kind: string;
				parentId: string | null;
				status: string;
				activity: string | null;
		  }[]
		| null
	>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{
					agents: {
						id: string;
						displayName: string;
						kind: string;
						parentId: string | null;
						status: string;
						activity: string | null;
					}[];
				}>("agents.list", {})
				.then(res => {
					if (alive) setAgents(res?.agents ?? []);
				})
				.catch(() => alive && setAgents([]));
		};
		load();
		// Visibility guard (parity with the other settings polls): never
		// poll the daemon from a hidden window.
		let id = setInterval(load, 2000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				load();
				id = setInterval(load, 2000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			alive = false;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc]);
	const subs = (agents ?? []).filter(a => a.kind !== "main");
	return (
		<>
			<h2 className="gui-settings-page-title">{t("sub agents")}</h2>
			<p className="gui-settings-page-desc">{t("subagents settings")}</p>
			{agents === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : subs.length === 0 ? (
				<div className="gui-settings-row">{t("no subagents running")}</div>
			) : (
				subs.map(a => (
					<div key={a.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{a.displayName}</span>
								<span className="gui-provider-chip">{a.kind}</span>
							</div>
							<div className="truncate text-[12px] text-[var(--color-text-faint)]">{a.id}</div>
						</div>
						<span className={`gui-agent-status gui-agent-status--${a.status ?? "idle"}`}>{a.status}</span>
						{a.activity && (
							<div className="truncate text-[12px] text-[var(--color-text-muted)]">{a.activity}</div>
						)}
					</div>
				))
			)}
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
	loginState: { providerId: string; url?: string; message?: string; waitingInput?: boolean } | null;
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
	});
	// Section collapse (bitfun parity): show the first few cards, expand on
	// demand — 70 login providers + the full catalog is too much for a grid.
	const [showAll, setShowAll] = useState(false);
	const [providerQuery, setProviderQuery] = useState("");
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [inputValue, setInputValue] = useState("");
	// Current-session thinking effort (TUI /model parity): seeded once from
	// the live session (session.thinkingInfo), then tracks what was last
	// applied here via session.setThinkingLevel.
	const [liveThinking, setLiveThinking] = useState<string | null>(null);
	// Per-role model presets (TUI /model parity): role -> model selector.
	const [roleModels, setRoleModels] = useState<Record<string, string> | null>(null);
	// Default model for new sessions (daemon settings "model" key).
	// Role cycle order (TUI ctrl+p cycleOrder) — roles render in this order.
	const [cycleOrder, setCycleOrder] = useState<string[] | null>(null);
	const { prompt } = usePrompt();
	const liveThinkingSeeded = useRef(false);
	// Per-model effort ceiling (TUI parity): rungs above it are disabled in
	// the ThinkingSelector, same as the composer.
	const [thinkingCeiling, setThinkingCeiling] = useState<string | null>(null);
	// Live session's current model — shown as a label + preselected.
	const [currentModel, setCurrentModel] = useState<{ id: string; name: string; provider: string } | null>(null);
	// Current model's exact thinking ladder (session.thinkingInfo efforts) —
	// the settings thinking selector mirrors the composer's rungs.
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	// Stored credentials per provider (multi-account logout dropdown).
	const [credentialsByProvider, setCredentialsByProvider] = useState<Record<string, CredentialInfo[]>>({});
	// Provider id whose credential menu is open (single-open dropdown).
	const [credsMenu, setCredsMenu] = useState<string | null>(null);
	// Provider awaiting an imported API key (/setup parity modal).
	const [apiKeyTarget, setApiKeyTarget] = useState<string | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	// Unified provider list: subscription (OAuth) + API-key providers merged
	// by id — subscription wins login state, API model tags merge in.
	const mergedProviders = useMemo(() => {
		const map = new Map<string, {
			id: string;
			name: string;
			loggedIn: boolean;
			configured: boolean;
			models: string[];
			modelCount: number;
			available: boolean;
			canLogin: boolean;
			canImport: boolean;
		}>();
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
					name: p.name,
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
				Number(b.loggedIn || b.configured) - Number(a.loggedIn || a.configured) ||
				a.name.localeCompare(b.name),
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
	const [resolvedRoleModels, setResolvedRoleModels] = useState<Record<string, { id: string; name: string } | null>>(
		{},
	);
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
					models: [{ id: form.modelId, ...(form.modelName ? { name: form.modelName } : {}) }],
				},
			});
			setForm({ name: "", baseUrl: "", apiKey: "", api: "openai-completions", modelId: "", modelName: "" });
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

	// Live session controls: thinking ceiling + current model. One RPC keeps
	// the card in lockstep with what the composer sees (TUI parity).
	const refreshThinking = useCallback(async (): Promise<void> => {
		if (!rpc || !sessionId) return;
		try {
			const info = await rpc.request<{
				ceiling?: string | null;
				level?: string | null;
				efforts?: string[];
				model?: { id: string; name: string; provider: string } | null;
			}>("session.thinkingInfo", { sessionId });
			setThinkingCeiling(info?.ceiling ?? null);
			setCurrentModel(info?.model ?? null);
			setThinkingEfforts(info?.efforts?.length ? info.efforts : []);
			if (!liveThinkingSeeded.current) {
				liveThinkingSeeded.current = true;
				setLiveThinking(info?.level ?? null);
			}
		} catch {
			// session not live — the current-session card just doesn't show
		}
	}, [rpc, sessionId]);

	useEffect(() => {
		void refreshThinking();
	}, [refreshThinking]);

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
				resolvedRoleModels?: Record<string, { id: string; name: string } | null>;
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
							setRoleModels(next);
							void rpc.request("settings.set", { key: "modelRoles", value: next }).catch(() => {});
							if (role === "default") {
								// The DEFAULT role IS the new-session thinking default —
								// keep the welcome-composer preselect in sync with the
								// role assignment (same pattern as the model sync).
								try {
									if (nextLevel === "inherit") localStorage.removeItem("omp-gui-default-thinking");
									else localStorage.setItem("omp-gui-default-thinking", nextLevel);
								} catch {
									// storage unavailable
								}
							}
						}}
					>
						<option value="inherit">{t("inherit")}</option>
						{ROLE_THINK_LEVELS.map(lv => (
							<option key={lv} value={lv}>
								{lv === "off" ? t("thinking off") : t(`thinking ${lv}`)}
							</option>
						))}
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
						onSelect={id => {
							if (!id) return;
							if (role === "default") {
								// The DEFAULT role IS the default model for new
								// sessions — keep the welcome-composer preselect
								// in sync with the role assignment.
								try {
									localStorage.setItem("omp-gui-default-model", id);
								} catch {
									// storage unavailable
								}
							}
							// Keep the role's thinking suffix when the model
							// changes (TUI assign preserves the level).
							const next = { ...roleModels, [role]: joinRoleValue(id, level) };
							setRoleModels(next);
							void rpc.request("settings.set", { key: "modelRoles", value: next }).catch(() => {});
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
								setRoleModels(next);
								void rpc.request("settings.set", { key: "modelRoles", value: next }).catch(() => {});
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
								setRoleModels(next);
								void rpc.request("settings.set", { key: "modelRoles", value: next }).catch(() => {});
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
			<h2 className="gui-settings-page-title">{t("model")}</h2>
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
							{/* Current session sits above the roles: the DEFAULT role IS
							 * the default model for new sessions (same modelRoles
							 * storage key the TUI /model panel writes), so the whole
							 * model decision chain lives on this one page. */}
							{sessionId && (
								<div className="gui-settings-row">
									<div>
										<div className="gui-settings-row-label">{t("current session")}</div>
										<div className="gui-settings-row-desc">{t("current session model hint")}</div>
										{currentModel && (
											<div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
												{t("current model")}: {currentModel.name || currentModel.id}
											</div>
										)}
									</div>
									<div className="flex items-center gap-1.5">
										<ModelSelector
											rpc={rpc}
											sessionId={sessionId}
											presetId={currentModel?.id ?? null}
											onSelect={id => {
												if (!id) return;
												void rpc
													.request("session.setModel", { sessionId, model: { id } })
													.then(() => {
														// Ceiling + level follow the new model.
														liveThinkingSeeded.current = false;
														return refreshThinking();
													})
													.catch(() => {});
											}}
										/>
										<ThinkingSelector
											value={liveThinking}
											ceiling={thinkingCeiling}
											efforts={thinkingEfforts}
											onChange={level => {
												setLiveThinking(level);
												void rpc
													.request("session.setThinkingLevel", {
														sessionId,
														thinkingLevel: level ?? undefined,
													})
													.catch(() => {});
											}}
										/>
									</div>
								</div>
							)}
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
												setRoleModels(next);
												void rpc
													.request("settings.set", { key: "modelRoles", value: next })
													.catch(() => {});
											});
										}}
									>
										<Icon name="add-circle" className="h-4 w-4" />
										<span>{t("add role")}</span>
									</button>
									{(cycleOrder?.length ?? 0) > 0 && (
										<div className="gui-role-cycle-track">
											<span className="text-[12px] text-[var(--color-text-faint)]">{t("cycle order")}:</span>
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
												onClick={() => void openExternalUrl(loginState.url!)}
											>
												<Icon name="external-link" className="h-3.5 w-3.5" />
												{t("open login page")}
											</button>
											{!loginState.waitingInput && !busy && (
												<button type="button" className="gui-link" onClick={() => void onCancelLogin()}>
													{t("cancel")}
												</button>
											)}
										</div>
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
										<HeightMorph morphKey={`${showAll}:${providerQ}`} className="gui-provider-grid">
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
																		aria-expanded={credsMenu === p.id}
																		onClick={() =>
																			setCredsMenu(menu => (menu === p.id ? null : p.id))
																		}
																	>
																		{t("logout")}
																		<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
																	</button>
																	<Pop open={credsMenu === p.id} className="gui-creds-menu">
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
																<div className="flex shrink-0 items-center gap-2">
																	{p.canLogin && (
																		<button
																			type="button"
																			className="gui-btn gui-btn-approve shrink-0"
																			disabled={!p.available || busy}
																			onClick={() => void onLogin(p.id)}
																		>
																			{t("login")}
																		</button>
																	)}
																	{p.canImport && (
																		<button
																			type="button"
																			className="gui-btn shrink-0"
																			onClick={() => {
																				setApiKeyTarget(p.id);
																				setApiKeyValue("");
																			}}
																		>
																			<Icon name="key" className="h-3.5 w-3.5" />
																			<span>{t("import api key")}</span>
																		</button>
																	)}
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

							{/* 自定义配置 dashed card → add-tab (bitfun custom-option parity). */}
							<button type="button" className="gui-provider-custom" onClick={() => setActiveTab("add")}>
								<Icon name="settings-3" className="h-4 w-4 shrink-0" />
								<span className="min-w-0 flex-1 text-start">
									<span className="block text-[13px] font-semibold text-[var(--color-text)]">
										{t("custom configuration")}
									</span>
									<span className="block text-[12px] text-[var(--color-text-faint)]">
										{t("custom configuration description")}
									</span>
								</span>
								<Icon name="arrow-right" className="h-3.5 w-3.5 shrink-0 opacity-60" />
							</button>
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
	const [range, setRange] = useState<"7d" | "30d">("7d");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(
		async (doSync: boolean, rng: "7d" | "30d"): Promise<void> => {
			if (!rpc) return;
			setBusy(true);
			setError(null);
			try {
				if (doSync) await rpc.request("stats.sync");
				setStats(await rpc.request<UsageDashboard>("stats.dashboard", { range: rng }));
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
		? overall.totalInputTokens + overall.totalOutputTokens + overall.totalCacheReadTokens + overall.totalCacheWriteTokens
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
	// ── Heatmap (per-day buckets, depth = tokens) ────────────────────────
	const heatMax = Math.max(1, ...series.map(p => p.tokens));
	const fmtDay = (ts: number): string =>
		new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
	// ── Per-model daily token trend (stacked bars) ───────────────────────
	const trendModels: string[] = [];
	for (const p of modelSeries) if (!trendModels.includes(p.model)) trendModels.push(p.model);
	const MODEL_COLORS = ["#4c8dff", "#34b97c", "#9b7bff", "#f5a742", "#e0688a", "#3ec6c8", "#8a9db5"];
	const byDay = new Map<number, Map<string, number>>();
	for (const p of modelSeries) {
		let day = byDay.get(p.timestamp);
		if (!day) {
			day = new Map();
			byDay.set(p.timestamp, day);
		}
		day.set(p.model, (day.get(p.model) ?? 0) + p.tokens);
	}
	const days = [...byDay.keys()].sort((a, b) => a - b);
	const dayTotal = (d: number): number => [...(byDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0);
	const trendMax = Math.max(1, ...days.map(dayTotal));
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
								range === r ? " bg-[var(--color-surface-raised)] font-semibold text-[var(--color-text)]" : " text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
							}`}
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
					className="gui-btn"
					disabled={busy || !rpc}
					onClick={() => {
						tapFeedback();
						void load(true, range);
					}}
				>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{busy ? t("syncing…") : t("refresh")}</span>
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
							<div key={card.label} className="gui-agent-card">
								<div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--color-text-faint)]">
									<Icon name={card.icon as never} className="h-3 w-3" />
									<span className="truncate">{card.label}</span>
								</div>
								<div
									className="mt-1 truncate font-mono text-[15px] font-medium"
									title={typeof card.value === "string" && card.value.length > 18 ? card.value : undefined}
								>
									{card.value}
								</div>
								{card.sub && <div className="text-[11px] text-[var(--color-text-muted)]">{card.sub}</div>}
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
											style={{ background: `color-mix(in oklab, var(--color-accent) ${a * 100}%, transparent)` }}
										/>
									))}
								</span>
								<span>{t("more activity")}</span>
							</div>
						</div>
						<div className="mt-2 grid grid-cols-7 gap-[3px]">
							{series.map(p => {
								const a = p.tokens / heatMax;
								return (
									<div
										key={p.timestamp}
										title={`${fmtDay(p.timestamp)}: ${fmtCompact(p.tokens)} Tokens · ${p.requests} 轮`}
										className="h-4 w-4 rounded-[4px] transition-transform duration-100 hover:scale-110"
										style={{
											background:
												p.requests > 0
													? `color-mix(in oklab, var(--color-accent) ${Math.max(12, a * 100)}%, transparent)`
													: "color-mix(in oklab, var(--color-text) 6%, transparent)",
										}}
									/>
								);
							})}
						</div>
					</div>
					{/* Daily token trend, stacked per model (ZCode parity) */}
					{days.length > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("daily token trend")}</div>
							<div className="flex h-24 items-end gap-[3px] pt-2">
								{days.map(d => (
									<div
										key={d}
										title={`${fmtDay(d)}: ${fmtCompact(dayTotal(d))} Tokens`}
										className="flex min-w-[3px] flex-1 flex-col justify-end gap-px overflow-hidden rounded-t-[2px]"
										style={{ height: `${Math.max(4, (dayTotal(d) / trendMax) * 100)}%` }}
									>
										{trendModels.map((m, i) => {
											const v = byDay.get(d)?.get(m) ?? 0;
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
							{trendModels.length > 1 && (
								<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
									{trendModels.map((m, i) => (
										<span key={m} className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
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
											{m.provider} · {fmtCompact(m.totalRequests)} {t("requests")} · {fmtCompact(m.totalInputTokens + m.totalOutputTokens)} tok · {fmtCost(m.totalCost)}
										</div>
									</div>
									<div className="text-right font-mono text-[12px] text-[var(--color-text-muted)]">{fmtMs(m.avgDuration)}</div>
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
											{fmtCompact(f.totalRequests)} {t("requests")} · {fmtCompact(f.totalInputTokens + f.totalOutputTokens)} tok · {fmtCost(f.totalCost)}
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
function IndexesSection({
	rpc,
	cwd,
}: {
	rpc: RpcClient | null;
	cwd?: string | null;
}): ReactNode {
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
	const [searching, setSearching] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [messages, setMessages] = useState<SearchHit[] | null>(null);
	const [loadingMsgs, setLoadingMsgs] = useState(false);

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
		: sessions ?? [];
	// Search hits land on a session with matches (jump off a stale pick).
	useEffect(() => {
		if (searchRes && selected && !bySession.has(selected) && bySession.size > 0) {
			setSelected([...bySession.keys()][0] ?? null);
		}
	}, [searchRes, selected, bySession]);
	const visibleMsgs = selected
		? searchRes
			? (bySession.get(selected) ?? [])
			: (messages ?? [])
		: [];

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
 *  OMP Browser Relay extension (chrome.debugger bridge into the user's own
 *  Chrome — kimi webbridge 同款) install entry. */
function BrowserSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [headless, setHeadless] = useState<boolean | null>(null);
	const [relay, setRelay] = useState<boolean | null>(null);
	const [endpoint, setEndpoint] = useState<string | null>(null);
	const [profileDir, setProfileDir] = useState<string | null>(null);
	const [tabCount, setTabCount] = useState<number | null>(null);
	const [extensions, setExtensions] = useState<BrowserExtensionInfo[] | null>(null);
	const [relayDir, setRelayDir] = useState<string | null>(null);
	const [installing, setInstalling] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);

	const refresh = (): void => {
		if (!rpc) return;
		void rpc
			.request<{ [k: string]: unknown }>("settings.get", { keys: ["browser.headless", "browser.relay"] })
			.then(res => {
				setHeadless(res["browser.headless"] === true);
				setRelay(res["browser.relay"] === true);
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
	}, [rpc]);

	const setBool = (key: "browser.headless" | "browser.relay", next: boolean): void => {
		void rpc?.request("settings.set", { key, value: next }).then(() => refresh());
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
				{/* Relay extension install (chrome.debugger bridge — the agent
				 * drives your own Chrome tabs, kimi webbridge 同款). */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("browser relay extension")}</div>
						<div className="gui-settings-row-desc">
							{relayDir ? (
								<span className="break-all">
									{t("browser relay installed at {dir}", { dir: relayDir })}
								</span>
							) : (
								t("browser relay extension description")
							)}
						</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={installing}
						onClick={installRelay}
					>
						{installing ? "…" : t("install")}
					</button>
				</div>
			</div>
			{/* Browser data (zcode 浏览器数据 parity): one-time Chrome
			 * import, cache clear, full clear. */}
			<div className="gui-settings-section">
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
								.then(res => setImportMsg(res?.ok ? res.importedFrom ?? "" : res?.error ?? ""))
								.finally(() => setImporting(false));
						}}
					>
						{importing ? "…" : t("import browser data")}
					</button>
				</div>
				{importMsg && (
					<div className="px-3 pb-2 text-[11.5px] text-[var(--color-text-faint)]">{importMsg}</div>
				)}
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
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("shared browser")}</div>
						<div className="gui-settings-row-desc">
							{endpoint
								? t("shared browser running · {tabs} tabs", { tabs: tabCount ?? 0 })
								: t("shared browser idle")}
						</div>
					</div>
					{endpoint && (
						<span className="gui-provider-chip">
							{t("running")}
						</span>
					)}
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
