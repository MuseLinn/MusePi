import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import { PROVIDER_LOGIN_TIMEOUT_MS } from "../lib/rpc";
import { resolveActiveSection, type SectionId, type SectionRequest } from "../lib/settings-nav";
import {
	SETTINGS_ACTION_SLOT_PREFIX,
	SETTINGS_TAB_SLOT_PREFIX,
	SlotComponentMount,
	useSlotComponentsByPrefix,
} from "../lib/slot-host";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { HeightMorph } from "./HeightMorph";
import { MigrationSection } from "./MigrationSection";
import { navGroups, SettingsNav } from "./SettingsNav";

/** Entry points address a section by CAPABILITY, the nav addresses it by
 *  PAGE — `providers`/`plugins` are resolved through SECTION_ALIAS (see
 *  lib/settings-nav.ts, which owns the contract + its unit test) so the nav
 *  row highlight and the content branch always agree on one id. Landing on an
 *  alias verbatim used to render a BLANK pane (`providers` has no content
 *  branch) that only a nav click could fill in. */

/** Conditional settings fields animate in/out per the shared standard —
 * see components/Reveal.tsx (useCollapse px height + outer fade). */

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
 * Settings view (ZCode-style, not a modal) — since the 2026-09-24 slot
 * replacement it REUSES the main layout instead of overlaying the chat
 * column: the grouped category tree (SettingsNav) portals into the app
 * sidebar's slot (`.gui-settings-nav-slot`, rendered by app.tsx while the
 * shell is active; collapses to an icon rail on narrow windows) and this
 * component fills the chat column with the section content + the 48px
 * window-drag strip. Closing settings unmounts both and the workspace
 * keepers unhide (sidebar + session list restore in place). The model
 * section is the real credential manager: provider login/logout runs the
 * daemon's OAuth flow and custom OpenAI-compatible providers are written to
 * models.yml.
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
	/** Section to land on when the pane opens (sidebar 技能 entry, composer
	 *  添加供应商 entry). A capability alias is accepted and resolved to its
	 *  page — see lib/settings-nav.ts. */
	initialSection?: SectionRequest;
	/** Open a session from the 索引库 search results (app layer owns openSession). */
	onOpenSession?: (sessionId: string) => void;
	/** DSH creation-flow entry: settings preset 新建 sends a natural-language
	 *  description to a Creator session that designs & saves the preset. */
	onCreateChat?: (text: string) => void;
	/** Active session's workspace dir — the 代码库 index scans this. */
	cwd?: string | null;
}): ReactNode {
	const [section, setSection] = useState<SectionRequest>(initialSection ?? "appearance");
	// 内核级 slot(P1):`settings.tab.<id>` 槽位组件自动挂载为设置页导航项
	// (扩展声明即出现——设置面板=宿主壳,内容由插件贡献)。
	const extSettingsTabs = useSlotComponentsByPrefix(rpc, SETTINGS_TAB_SLOT_PREFIX);
	// 单行偏好槽:settings.action.<id> 组件。
	const actionItems = useSlotComponentsByPrefix(rpc, SETTINGS_ACTION_SLOT_PREFIX);
	// Nav groups are the single source of truth for "which section ids exist":
	// resolved ONCE per render (the nav below AND the id validation read it) so
	// a section can never be active without a nav row — and every nav row is
	// guaranteed to have a content branch.
	const groups = navGroups(extSettingsTabs);
	const navSectionIds = new Set(groups.flatMap(g => g.items.map(i => i.id)));
	// The id actually rendered: aliases resolve to their page, anything unknown
	// (a DOM event that reached `initialSection` through `onX={openSettings}`,
	// a retired id) falls back to the default section instead of rendering an
	// empty content pane. Contract + tests: lib/settings-nav.ts.
	const activeSection = resolveActiveSection(section, navSectionIds);
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
		section: activeSection,
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
		const scroll = q !== prev.q || activeSection !== prev.section;
		prevSearchRef.current = { q, section: activeSection };
		if (scroll && rows.length > 0) rows[0].scrollIntoView({ block: "center", behavior: "smooth" });
	}, [settingsQuery, activeSection]);
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
	// Provider ids whose OAuth/API login is in flight. Kept per-provider so a
	// pending login only disables THAT provider's buttons (user report: "设置
	// 界面的模型登录按钮有时点击没反应").
	const [pendingLogins, setPendingLogins] = useState<string[]>([]);
	// Content-boundary feather (transcript parity): the section content
	// scrolls inside the settings surface — the shared hook flips its
	// data-top-scroll / data-bottom-scroll mask attrs. (The nav column owns
	// its own scroller since the slot-replacement refactor.)
	const settingsContentRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(settingsContentRef);
	// The app sidebar's slot filler (app.tsx renders `.gui-settings-nav-slot`
	// while the settings shell is active). The nav column portals into it so
	// the shell shares the main layout — discovered after mount because the
	// slot div and this view land in the SAME commit.
	const [navSlot, setNavSlot] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		setNavSlot(document.getElementById("gui-settings-nav-slot"));
	}, []);

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
		setPendingLogins(p => (p.includes(providerId) ? p : [...p, providerId]));
		setLoginState({ providerId });
		try {
			const result = await rpc.request<{ ok: boolean }>(
				"providers.login",
				{ sessionId, providerId },
				{ timeoutMs: PROVIDER_LOGIN_TIMEOUT_MS },
			);
			if (result?.ok) {
				// Only clear the login panel if THIS provider's flow is still
				// the one being shown (a later login may have taken the spot).
				setLoginState(s => (s?.providerId === providerId ? null : s));
				await loadProviders();
			}
		} catch (err) {
			// Keep the auth URL/instructions on screen so the user can still
			// open the link or cancel — the daemon flow may still be running.
			setLoginState(s =>
				s?.providerId === providerId ? { ...s, message: err instanceof Error ? err.message : String(err) } : s,
			);
		} finally {
			setPendingLogins(p => p.filter(x => x !== providerId));
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
				{/* Left navigation column — mounted into the app sidebar's slot
				 * (.gui-settings-nav-slot, rendered by app.tsx while the settings
				 * shell is active) so the settings shell shares the main layout
				 * geometry instead of floating a second column beside the session
				 * list (slot replacement, 2026-09-24). Falls back to inline
				 * rendering when no slot host exists (standalone/test mounts). */}
				{(() => {
					const nav = (
						<SettingsNav
							extTabs={extSettingsTabs}
							activeSection={activeSection}
							onSelect={id => setSection(id as SectionRequest)}
							onBack={onBack}
							query={settingsQuery}
							onQueryChange={setSettingsQuery}
						/>
					);
					return navSlot ? createPortal(nav, navSlot) : nav;
				})()}
				{/* Right column: the detail card floats over the same glassy
				 * backdrop as the nav (chat-surface parity; no divider line). */}
				<div className="gui-settings-main">
					<div className="gui-settings-surface">
						{/* Section switch: HeightMorph in a fixed-height scroll
						 * container animates nothing (height is constant), but
						 * the keyed inner supplies the standard 160ms fade-in
						 * instead of an abrupt content swap. */}
						<HeightMorph
							morphKey={activeSection}
							innerRef={settingsContentRef}
							className={`gui-settings-content${
								activeSection === "history" || activeSection === "model" || activeSection === "skills"
									? " gui-settings-content--fill"
									: ""
							}`}
						>
							{activeSection === "general" && (
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
							{activeSection === "appearance" && (
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
							{activeSection === "model" && (
								<ModelSection
									providers={providers}
									apiProviders={apiProviders}
									custom={custom}
									loginState={loginState}
									pendingLogins={pendingLogins}
									onLogin={login}
									onLogout={logout}
									onSubmitInput={submitLoginInput}
									onCancelLogin={cancelLogin}
									onChanged={loadProviders}
									rpc={rpc}
									sessionId={sessionId}
									// Only the capability entry (`providers`) opens the add
									// form — arriving from the nav is a plain visit.
									openAddProvider={section === "providers"}
								/>
							)}
							{activeSection === "shell" && <ShellSection rpc={rpc} />}
							{activeSection === "tools" && <ToolsSection rpc={rpc} />}
							{activeSection === "media" && (
								<MediaSection rpc={rpc} onLogin={login} pendingLogins={pendingLogins} />
							)}
							{activeSection === "notifications" && <NotificationsSection rpc={rpc} />}
							{activeSection === "pet" && <PetSection />}
							{activeSection === "sessions" && <SessionsSection rpc={rpc} currentSessionId={sessionId} />}
							{activeSection === "git" && <GitSection rpc={rpc} />}
							{activeSection === "shortcuts" && <ShortcutsSection />}
							{activeSection === "interaction" && <InteractionSection rpc={rpc} />}
							{activeSection === "voice" && <VoiceSection rpc={rpc} />}
							{activeSection === "context" && <ContextSection rpc={rpc} />}
							{activeSection === "files" && <FilesLspSection rpc={rpc} />}
							{activeSection === "memory" && <MemorySection rpc={rpc} />}
							{activeSection === "skills" && <SkillsSection rpc={rpc} />}
							{activeSection.startsWith("ext:")
								? (() => {
										const item = extSettingsTabs.find(x => `ext:${x.slot}` === activeSection);
										return item ? (
											<div className="px-3 py-2">
												<SlotComponentMount item={item} rpc={rpc} />
											</div>
										) : null;
									})()
								: null}
							{activeSection === "suggestions" && <PromptsSection />}
							{activeSection === "modes" && <ModesSection rpc={rpc} onCreateChat={onCreateChat} />}
							{activeSection === "migration" && <MigrationSection rpc={rpc} />}
							{activeSection === "subagents" && <SubagentsSection rpc={rpc} />}
							{activeSection === "commands" && <CommandsSection rpc={rpc} />}
							{activeSection === "mcp" && <McpSection rpc={rpc} />}
							{activeSection === "hooks" && <HooksSection rpc={rpc} />}
							{activeSection === "browser" && <BrowserSection rpc={rpc} />}
							{activeSection === "indexes" && <IndexesSection rpc={rpc} cwd={cwd} />}
							{activeSection === "history" && <HistorySection rpc={rpc} onOpenSession={onOpenSession} />}
							{activeSection === "usage" && <UsageSection rpc={rpc} />}
						</HeightMorph>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Accent preset → swatch color (display tints readable on both schemes;
 *  the tokens own the real values: brand = gold #d9a441). */
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
	MediaSection,
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
