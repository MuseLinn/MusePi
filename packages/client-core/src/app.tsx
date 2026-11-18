import type { AssistantMessage, AttachmentGetResult, AttachmentStatResult } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { MarketplacePanel } from "./components/marketplace/MarketplacePanel";
import { BoardPanel } from "./components/panels/BoardPanel";
import { ScheduledPanel } from "./components/panels/ScheduledPanel";
import { VoicePanel } from "./components/panels/VoicePanel";
import { WorkspacePanel } from "./components/panels/WorkspacePanel";
import { ApprovalCard } from "./components/shell/ApprovalCard";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { type GuestPanel, HeaderBar } from "./components/shell/HeaderBar";
import { MobileSettings } from "./components/shell/MobileSettings";
import { type MobileTab, MobileTabBar } from "./components/shell/MobileTabBar";
import { PullToRefresh } from "./components/shell/PullToRefresh";
import { Toasts } from "./components/shell/Toasts";
import { TranscriptSkeleton } from "./components/shell/TranscriptSkeleton";
import { WelcomeHint } from "./components/shell/WelcomeHint";
import { WorkspaceView } from "./components/shell/WorkspaceView";
import { msgText, Transcript } from "./components/transcript/Transcript";
import { deriveTreeOutline } from "./components/transcript/tree-outline";
import { TreeOutlineNav } from "./components/transcript/tree-outline-nav";
import { t } from "./i18n/index.js";
import { pushActionToast } from "./lib/action-toast";
import { useBackLayer } from "./lib/back-stack";
import {
	clearBadge,
	consumePendingDeepLink,
	DEEP_LINK_EVENT,
	incrementBadge,
	isHarmonyShell,
	isMobileShell,
	isNativeShell,
} from "./lib/capacitor";
import { GuestClient } from "./lib/client";
import { isCompatShell } from "./lib/compat-shell";
import { CompatSlotHost } from "./lib/compat-slot-host";
import { useConnectionHealth } from "./lib/connection-health";
import { HostClient } from "./lib/host-client";
import { loadResolvedHosts, rememberHost } from "./lib/hosts";
import { enableNativeGlass } from "./lib/native-glass";
import { useShellLayout } from "./lib/responsive-shell";
import { cacheMorphRects, stageLeavingScene } from "./lib/scene-morph";
import { isMobileSurface } from "./lib/surface";
import { useTts } from "./lib/tts";
import { type SessionClient, useGuestSelector } from "./lib/use-guest";
import { useMobileSurface } from "./lib/use-mobile-surface";
import type { ToolRenderHost } from "./tool-render";
import { UI_BLOCK_ANSWER_EVENT } from "./ui-blocks/answers.js";
import "./components/shell/shell.css";

// Compat shell + Electron bridge → opt the served renderer into the native
// window glass (transparent root + translucent shell scrims + material
// mirroring). Runs at import time so the first paint is already glass —
// a plain-browser guest no-ops (no bridge, no marker).
enableNativeGlass();

const NAME_KEY = "omp.collab.name";

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | HostClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	// Presentation surface, not native capability: a phone browser gets the
	// same bottom destinations and draft-first flow as the shells, while a
	// narrow desktop window keeps the workspace directory. Re-evaluated on
	// rotation, folding and resize, so a foldable moving between postures
	// swaps IA instead of leaving a floating bar over a wide layout.
	const mobileSurface = useMobileSurface();
	// Latest-ref mirror for the morph gate below: the connect callbacks are
	// memoized empty, so they can't read `client` from their closure.
	const clientRef = useRef<GuestClient | HostClient | null>(null);
	clientRef.current = client;
	const credsRef = useRef<Creds | null>(null);
	const hostRef = useRef<{ wsUrl: string; token?: string } | null>(null);

	// Scene morph (M1.10 §3.3 批次 B): ConnectScreen → 会话. Only when the
	// connect screen is actually the visible scene (client still null —
	// server switching / rejoin happen inside the session view and must not
	// flash a collapsing connect card). Staged synchronously here, before
	// the setClient commit, so the next paint already shows the morph.
	const stageConnectMorph = useCallback((): void => {
		if (clientRef.current !== null) return;
		const root = document.querySelector<HTMLElement>(".sh-connect");
		if (!root) return;
		cacheMorphRects(document);
		stageLeavingScene(root);
	}, []);

	const connectionGenerationRef = useRef(0);
	const autoRestoreRef = useRef(true);

	const connect = useCallback(
		(link: string, name: string): void => {
			const generation = ++connectionGenerationRef.current;
			autoRestoreRef.current = true;
			// WebCrypto only exists in secure contexts (https or localhost). On
			// plain http (a LAN IP) the guest degrades to plaintext mode — no E2E
			// sealing, but also no self-signed-cert warning to dismiss.
			const plaintext = typeof crypto === "undefined" || !crypto.subtle;
			let next: GuestClient;
			try {
				next = new GuestClient(link, name, { plaintext });
			} catch (err) {
				setConnectError(err instanceof Error ? err.message : String(err));
				return;
			}
			// A failed connect (above) leaves the connect screen up — no morph.
			stageConnectMorph();
			// Save only a welcomed host. A late welcome from a replaced client
			// must not overwrite the user's newer connection or URL.
			next.onWelcome = (): void => {
				if (generation !== connectionGenerationRef.current) return;
				void rememberHost(link, name);
				try {
					window.location.hash = link;
				} catch {
					// non-fatal
				}
			};
			next.connect();
			try {
				localStorage.setItem(NAME_KEY, name);
			} catch {
				// storage unavailable (private mode) — non-fatal
			}
			credsRef.current = { link, name };
			hostRef.current = null;
			clientRef.current = next;
			setConnectError(null);
			setClient(prev => {
				prev?.close();
				return next;
			});
		},
		[stageConnectMorph],
	);

	/** Host-mode: connect to the serving daemon's own session (compat shell).
	 *  No collab link, no E2E — the daemon's WS is loopback + token-gated. */
	const connectHost = useCallback(
		(wsUrl: string, token?: string): void => {
			++connectionGenerationRef.current;
			autoRestoreRef.current = true;
			const next = new HostClient(wsUrl, token);
			next.connect();
			hostRef.current = { wsUrl, token };
			credsRef.current = null;
			setConnectError(null);
			stageConnectMorph();
			clientRef.current = next;
			setClient(prev => {
				prev?.close();
				return next;
			});
		},
		[stageConnectMorph],
	);

	const leave = useCallback((): void => {
		++connectionGenerationRef.current;
		autoRestoreRef.current = false;
		clientRef.current = null;
		setClient(prev => {
			prev?.close();
			return null;
		});
		hostRef.current = null;
		credsRef.current = null;
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const host = hostRef.current;
		if (host) {
			connectHost(host.wsUrl, host.token);
			return;
		}
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect, connectHost]);

	// Liveness (bitfun useConnectionHealth parity): a socket the OS tore down
	// during suspension never fires `close`, so the shell would keep claiming
	// "live" while every frame vanished — and the next prompt would land in a
	// dead link with the composer stuck on "sending". Two missed probes run the
	// same recovery as an ended session (full re-hello + snapshot), and every
	// foreground return probes immediately.
	useConnectionHealth(client, rejoin);

	// Shell height. Native WebViews keep a fixed layout viewport (Capacitor
	// Keyboard resize:'none', ArkWeb full-window Web component), so
	// documentElement.clientHeight is the real available height there.
	// visualViewport.height can disagree by a few px once the window is
	// immersive (it counts the system strips the component does not own),
	// which made the connect screen scroll slightly even though every element
	// was visible. Browser/PWA keeps the visual-viewport contract instead:
	// there the layout viewport does not shrink when the IME opens, so
	// vv.height remains the only correct number.
	useEffect(() => {
		const vv = window.visualViewport;
		const root = document.documentElement;
		const updateHeight = (): void => {
			const height = isMobileShell() ? root.clientHeight : (vv?.height ?? root.clientHeight);
			root.style.setProperty("--viewport-height", `${height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		window.addEventListener("resize", updateHeight);
		vv?.addEventListener("resize", updateHeight);
		vv?.addEventListener("scroll", updateHeight);
		return () => {
			window.removeEventListener("resize", updateHeight);
			vv?.removeEventListener("resize", updateHeight);
			vv?.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Boot precedence: explicit hash / native deep link → local daemon config →
	// latest saved guest host. Generation checks keep slow probes from winning
	// over a connection the user started while they were in flight.
	useEffect(() => {
		const generation = connectionGenerationRef.current;
		const link = hashLink();
		if (link) {
			connect(link, storedName());
			return;
		}
		const stashed = isMobileShell() ? consumePendingDeepLink() : null;
		if (stashed) {
			connect(stashed, storedName());
			return;
		}
		let cancelled = false;
		const current = (): boolean =>
			!cancelled && generation === connectionGenerationRef.current && clientRef.current === null;
		void (async () => {
			try {
				const res = await fetch("/__daemon.json");
				if (res.ok) {
					const config = (await res.json()) as { wsUrl?: string; token?: string };
					if (config.wsUrl && current()) {
						connectHost(config.wsUrl, config.token);
						return;
					}
				}
			} catch {
				// A static or mobile host has no local daemon config; restore below.
			}
			const hosts = await loadResolvedHosts();
			const latest = hosts[0];
			if (latest && current()) connect(latest.link, latest.deviceName);
		})();
		return () => {
			cancelled = true;
		};
	}, [connect, connectHost]);

	// Native links arriving after boot replace the current session directly.
	useEffect(() => {
		if (!isMobileShell()) return;
		const onLink = (event: Event): void => {
			const link = (event as CustomEvent<{ link: string }>).detail?.link;
			if (link) connect(link, storedName());
		};
		window.addEventListener(DEEP_LINK_EVENT, onLink);
		return () => window.removeEventListener(DEEP_LINK_EVENT, onLink);
	}, [connect]);

	// CollabSocket owns live reconnect backoff. This application-level path is
	// only for an ended guest (or the initial empty restore), so foreground and
	// online events can never create a second socket around a live client.
	useEffect(() => {
		let settling: Timer | null = null;
		const recover = (): void => {
			if (document.hidden || !navigator.onLine || settling !== null) return;
			const active = clientRef.current;
			if (active instanceof HostClient) return;
			if (active instanceof GuestClient && active.getSnapshot().phase !== "ended") return;
			if (active === null && !autoRestoreRef.current) return;
			const generation = connectionGenerationRef.current;
			const creds = credsRef.current;
			settling = setTimeout(() => {
				settling = null;
			}, 0);
			if (creds) {
				connect(creds.link, creds.name);
				return;
			}
			void loadResolvedHosts().then(hosts => {
				const latest = hosts[0];
				if (
					latest &&
					generation === connectionGenerationRef.current &&
					clientRef.current === null &&
					autoRestoreRef.current
				) {
					connect(latest.link, latest.deviceName);
				}
			});
		};
		const onVisible = (): void => {
			if (!document.hidden) recover();
		};
		window.addEventListener("online", recover);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			if (settling !== null) clearTimeout(settling);
			window.removeEventListener("online", recover);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = t("shell.musepiCollab");
	}, [client]);

	useMobileNotifications(client, credsRef.current?.link ?? null);

	// The bottom tab bar belongs to App, not Session: the connect screen had
	// no settings destination at all before, and a tab bar that disappears on
	// disconnect reads as a broken app rather than a two-state layout.
	const [mobileTab, setMobileTab] = useState<MobileTab>("connect");
	const showTabBar = mobileSurface;

	useEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("sh-has-tabbar", showTabBar);
		// ArkWeb does not composite backdrop-filter over scrolling content, so
		// the glass header would show crisp half-clipped bubbles through it.
		// Mark the shell so CSS can swap glass for a solid bar on HarmonyOS.
		root.classList.toggle("sh-harmony", isHarmonyShell());
		// HarmonyOS floats a NATIVE bar (its own height plus the gesture inset)
		// over the web view; Android / PWA float the web pill (76px). Neither
		// owns layout, so every full-height surface reserves this through CSS.
		// A rail owns the width, not the bottom strip; the chrome handler below
		// replaces this provisional number with the bar's real geometry.
		root.style.setProperty(
			"--sh-tabbar-space",
			root.dataset.harmonyChrome === "rail" ? "0px" : isHarmonyShell() ? "96px" : "76px",
		);
		return () => {
			root.classList.remove("sh-has-tabbar");
			root.classList.remove("sh-harmony");
			root.style.removeProperty("--sh-tabbar-space");
		};
	}, [showTabBar]);

	useEffect(() => {
		if (client) setMobileTab(prev => (prev === "connect" ? "chat" : prev));
		else setMobileTab(prev => (prev === "chat" ? "connect" : prev));
	}, [client]);

	// Mirror every tab change — including the connect / disconnect switches
	// above, which do not come from a tap — into the HarmonyOS native bar.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		const index = mobileTab === "connect" ? 0 : mobileTab === "chat" ? 1 : 2;
		try {
			window.harmonyNative?.setActiveTab?.(index);
		} catch {
			// bridge missing — nothing to mirror
		}
	}, [mobileTab, client]);

	const selectTab = useCallback(
		(tab: MobileTab): void => {
			setMobileTab(tab);
			if (isHarmonyShell()) {
				// Keep the native Tabs bar in sync. ArkTS marks this as
				// page-originated so its onChange never echoes back.
				const index = tab === "connect" ? 0 : tab === "chat" ? 1 : 2;
				try {
					window.harmonyNative?.setActiveTab?.(index);
				} catch {
					// bridge missing — nothing to mirror
				}
			}
			// On a live session, "Connect" means going back to the connect
			// screen (the same explicit leave MobileSettings offers).
			if (tab === "connect" && clientRef.current !== null) leave();
		},
		[leave],
	);

	// HarmonyOS native bar → page. The page stays the source of truth for
	// connect/session state: a tap in the native bar only requests a
	// destination, and the page decides what that renders.
	useEffect(() => {
		const handler = (name: string): void => {
			if (name === "connect" || name === "chat" || name === "settings") selectTab(name);
		};
		(window as unknown as Record<string, unknown>).__musepiTab = handler;
		return () => {
			delete (window as unknown as Record<string, unknown>).__musepiTab;
		};
	}, [selectTab]);

	if (!client) {
		return (
			<>
				{/* key on the destination so every tab switch replays the enter
				 * beat — without it the two screens swapped instantly. */}
				<div className="sh-tab-scene" key={mobileTab}>
					{mobileTab === "settings" ? (
						<div className="sh-tab-page">
							{/* Saved computers work offline: `connect` is the same
							 * path the connect screen uses, so retrying one from
							 * here needs neither a session nor a detour. */}
							<MobileSettings onConnectHost={connect} />
						</div>
					) : mobileTab === "chat" ? (
						/* Chat while offline: a real destination with an empty state,
						 * not a bounce back. Bouncing made the native bar's icon and
						 * label disagree for a frame. */
						<div className="sh-tab-page sh-tab-page--empty">
							<div className="sh-not-connected">
								<p>{t("settings.notConnectedYetConnect")}</p>
								<button type="button" className="sh-btn sh-btn-primary" onClick={() => selectTab("connect")}>
									{t("settings.connectComputer")}
								</button>
							</div>
						</div>
					) : (
						<ConnectScreen
							defaultName={storedName()}
							defaultLink={hashLink() ?? undefined}
							error={connectError}
							onConnect={connect}
						/>
					)}
				</div>
				{showTabBar && <MobileTabBar active={mobileTab} chatAvailable={false} onChange={selectTab} />}
			</>
		);
	}
	return (
		<>
			<Session
				client={client}
				onLeave={leave}
				onRejoin={rejoin}
				currentLink={credsRef.current?.link ?? ""}
				onSwitchTo={connect}
				mobileTab={mobileTab}
			/>
			{showTabBar && <MobileTabBar active={mobileTab} chatAvailable onChange={selectTab} />}
		</>
	);
}

/**
 * Local notifications for the Capacitor shell: when the app is backgrounded,
 * a newly settled assistant message fires a native notification (session
 * update while away from the desk). Desktop web and foreground shells no-op —
 * the plugin is lazily imported and never touches non-Capacitor builds.
 * This is the LAN-architecture equivalent of openchamber's APNs/FCM relay
 * (which requires a cloud server we do not have).
 */
function useMobileNotifications(client: SessionClient | null, link: string | null): void {
	const lastNotifiedRef = useRef(0);
	// Android 13+ requires an explicit POST_NOTIFICATIONS grant before
	// schedule() does anything; without it the call silently no-ops. Request
	// once on the first live connection (native shell only — browsers have no
	// notification permission here, and the plugin import is lazy anyway).
	const permissionRequestedRef = useRef(false);
	useEffect(() => {
		if (!client) return;
		if (!permissionRequestedRef.current && isNativeShell()) {
			permissionRequestedRef.current = true;
			void (async () => {
				try {
					const { LocalNotifications } = await import("@capacitor/local-notifications");
					const status = await LocalNotifications.checkPermissions();
					if (status.display !== "granted") {
						await LocalNotifications.requestPermissions();
					}
				} catch {
					// permission prompt unavailable (older Android / browser) — silent;
					// scheduling below still no-ops rather than crashing
				}
			})();
		}
		let disposed = false;
		/** Timestamp of the newest settled assistant reply in the transcript. */
		const latestAssistantTs = (): number => {
			const entries = client.getSnapshot().entries;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "message" && e.message.role === "assistant") return e.message.timestamp;
			}
			return 0;
		};
		// Baseline: whatever is already in the transcript when we start
		// listening has been on screen — only replies that land after this point
		// are worth a notification. Starting from 0 (the old behaviour) meant the
		// FIRST background state frame — a progress/agents update, not a message
		// at all — re-announced the last old reply.
		lastNotifiedRef.current = Math.max(lastNotifiedRef.current, latestAssistantTs());
		const unsub = client.subscribe(() => {
			if (disposed) return;
			// Foreground: the transcript itself is the notification.
			if (typeof document !== "undefined" && !document.hidden) return;
			const snap = client.getSnapshot();
			let lastAssistant: AssistantMessage | null = null;
			for (let i = snap.entries.length - 1; i >= 0; i--) {
				const e = snap.entries[i];
				if (e.type === "message" && e.message.role === "assistant") {
					lastAssistant = e.message;
					break;
				}
			}
			if (!lastAssistant) return;
			const ts = lastAssistant.timestamp;
			if (ts <= lastNotifiedRef.current) return;
			lastNotifiedRef.current = ts;
			// Extract synchronously (TS closure narrowing); the plugin call is
			// the only async part. msgText mirrors the transcript's own
			// content extraction (runtime shape check — wire content is
			// consumed as unknown across the guest layer).
			const text = msgText(lastAssistant);
			void (async () => {
				try {
					// Platform-specific module: the Capacitor plugin only exists in
					// the shell — static import would pull it into the desktop web
					// bundle.
					const { LocalNotifications } = await import("@capacitor/local-notifications");
					await LocalNotifications.schedule({
						notifications: [
							{
								id: ts % 2147483647,
								title: t("settings.musepiSessionUpdate"),
								body: text.slice(0, 140) || t("settings.sessionUpdate"),
								smallIcon: "ic_stat_musepi",
								// Must match `SESSION_CHANNEL_ID` in the Android
								// MainActivity, which creates the branded channel.
								// Without it the plugin falls back to its own generic
								// "Default" channel and the brand colours are lost.
								channelId: "musepi-session",
								// Deep-link payload: tapping the notification routes
								// back to this session via DEEP_LINK_EVENT (see
								// setupDeepLinkHandler) even after a cold start.
								extra: link ? { link } : undefined,
							},
						],
					});
					// Launcher badge rides the notification (ShortcutBadger —
					// Samsung/Xiaomi/Huawei/Oppo; no-op on unsupported launchers).
					void incrementBadge();
				} catch {
					// notifications unavailable (permission/plugin) — silent
				}
			})();
		});
		return () => {
			disposed = true;
			unsub();
		};
	}, [client]);

	// Foreground return: the user has seen the app — clear the badge.
	useEffect(() => {
		if (!isMobileShell()) return;
		const onVisible = (): void => {
			if (!document.hidden) void clearBadge();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);
}

/** Persistent warning strip for plaintext (no-E2E) sessions. */
function PlaintextBanner(): ReactNode {
	return (
		<div className="plaintext-banner" role="alert">
			{t("collab.plaintextSessionNot.info")}
		</div>
	);
}

interface SessionProps {
	client: SessionClient;
	onLeave(): void;
	onRejoin(): void;
	/** Current connection link (switcher highlight). */
	currentLink: string;
	onSwitchTo(link: string, name: string): void;
	/** Selected bottom tab, owned by App so it survives connect/disconnect. */
	mobileTab: MobileTab;
}

/**
 * Message-plane fields only: entries/stream/activeTools change on every
 * transcript frame, so this pane is the only thing that re-renders during
 * a stream — never the shell, header, composer, or toasts.
 */
function TranscriptPane({ client, host }: { client: SessionClient; host: ToolRenderHost }): ReactNode {
	const mobileSurface = useMobileSurface();
	const entries = useGuestSelector(client, s => s.entries);
	const stream = useGuestSelector(client, s => s.stream);
	const streamDone = useGuestSelector(client, s => s.streamDone);
	const activeTools = useGuestSelector(client, s => s.activeTools);
	const working = useGuestSelector(client, s => s.working);
	const roundDurations = useGuestSelector(client, s => s.roundDurations);
	const phase = useGuestSelector(client, s => s.phase);
	// A one-to-one session (one owner + one agent) does not need "HOST"/"AGENT"
	// over every message: the bubble side already says who spoke. Labels return
	// as soon as another participant joins.
	const participants = useGuestSelector(client, s => s.state?.participants);
	// Distinct names, not list length: a reconnecting guest can appear twice.
	const singleParty = new Set((participants ?? []).map(p => p.name.trim() || p.role)).size <= 2;

	const focusedSessionId = useGuestSelector(client, s => s.focusedSessionId);
	const workspace = useGuestSelector(client, s => s.workspace);
	// Read-aloud wiring (design 「语音输出四帧」): the Transcript's onSpeak slot
	// was always there — this is the shell side that was never connected. The
	// controller is shared with the composer mini-player/barge-in via the
	// per-client singleton; only the speaking id subscribes here.
	const tts = useTts(client);
	const speakingId = useSyncExternalStore(
		tts.subscribe,
		() => tts.getSnapshot().speakingId,
		() => tts.getSnapshot().speakingId,
	);
	// Mobile empty state gets the time-aware greeting + rotating tip in place
	// of the bare "no activity yet" line (gui DraftComposer parity). While a
	// session is still hydrating the transcript is empty too, and the greeting
	// would announce an existing conversation as brand new — the skeleton owns
	// that window instead. The new-session draft is the one genuinely empty
	// state: it keeps the greeting.
	const draftSession = workspace !== null && focusedSessionId === null;
	const hydrating = entries.length === 0 && stream === null && !draftSession && phase !== "live";
	const emptySlot = mobileSurface ? hydrating ? <TranscriptSkeleton /> : <WelcomeHint /> : undefined;
	// Revert (撤回) is a session-tree operation: branchAt moves the leaf IN
	// PLACE at the target node (TUI /tree parity) — the old leaf and its
	// subtree stay reachable as a sibling branch, never truncated. Nothing is
	// re-sent: the user is parked at the branch point, which is what makes
	// the fork hint and the undo row meaningful (same contract as the desktop
	// 撤回; auto-resending the prompt here would commit the new branch and
	// leave undo with nothing to undo).
	//
	// The RPC answer carries the post-move leaf; the session's own events do
	// not (a tree move appends no entry), so the leaf is tracked locally.
	// `leafPin` is scoped to the session that produced it — switching sessions
	// falls back to the tip instead of pinning an id the new tree lacks.
	interface BranchResult {
		ok?: boolean;
		leafId?: string | null;
	}
	const [leafPin, setLeafPin] = useState<{
		sessionId: string | null;
		/** 移动之前转录尖端的 id:尖端一变,说明用户已从该节点继续。 */
		tipId: string | null;
		leaf: { mode: "tip" } | { mode: "root" } | { mode: "node"; id: string };
	} | null>(null);
	// 撤回后可撤销:原 leaf 变成兄弟分支,再发一次 branchAt 就能回去。
	// `tipId` 与 leafPin 同理 —— 用户从撤回点继续发送就提交了新分支,
	// 撤销窗口随之关闭。
	const [reverted, setReverted] = useState<{
		sessionId: string | null;
		tipId: string | null;
		fromLeafId: string;
		label: string;
	} | null>(null);
	const requestBranch = (messageId: string): Promise<BranchResult> => {
		if (!focusedSessionId) return Promise.reject(new Error("no focused session"));
		return client.rpc<BranchResult>("session.branchAt", {
			sessionId: focusedSessionId,
			messageId,
		});
	};
	// Retry (重试) on an assistant reply regenerates it IN PLACE: the daemon
	// truncates to just before the reply (old reply + tail stay as a sibling
	// branch) and re-runs the agent — no user text re-send (re-sending the
	// producing user message duplicated the turn, user report 2026-10-01).
	const regenerateAt = (messageId: string): void => {
		if (!focusedSessionId) return;
		void client
			.rpc<{ ok?: boolean }>("session.regenerateAt", {
				sessionId: focusedSessionId,
				messageId,
			})
			.catch(err => {
				console.error("[transcript] regenerateAt failed:", err);
			});
	};
	// Fork (分叉): copy the session truncated at this message into a NEW
	// session (non-destructive — original untouched). User messages re-answer
	// via backfilled text; assistant/toolResult nodes pass includeTarget to
	// keep the node and continue from it. The daemon returns the new session
	// id; the GUI switches the workspace focus to it.
	const forkAt = (messageId: string, _text: string | undefined, includeTarget?: boolean): void => {
		if (!focusedSessionId) return;
		void client
			.rpc<{ sessionId?: string | null; sessionFile?: string | null }>("session.forkAt", {
				sessionId: focusedSessionId,
				messageId,
				includeTarget,
			})
			.then(result => {
				if (result.sessionId) client.selectWorkspaceSession(result.sessionId);
			})
			.catch(err => {
				console.error("[transcript] forkAt failed:", err);
			});
	};
	// Branch topology for the transcript's session-tree nav (layer-1 branch
	// bars + sibling switching): child counts keyed by entry id from
	// parentId links, the active path (root → leaf), and switch → branchAt.
	// The branch bar and the mobile breadcrumb consume ONE derivation, so the
	// highlighted path and the breadcrumb can never disagree.
	const tipId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
	// A pin survives only while the transcript tip is still where it was when
	// the branch moved: the daemon moves the leaf without appending, so the
	// first new entry is the user continuing from that node — at which point
	// the view must follow the tip again, not stay on the branch point.
	const pin = leafPin && leafPin.sessionId === focusedSessionId && leafPin.tipId === tipId ? leafPin.leaf : null;
	const outline = useMemo(() => deriveTreeOutline(entries, pin ?? { mode: "tip" }), [entries, pin]);
	const messageLabel = (id: string): string => {
		const entry = entries.find(candidate => candidate.id === id);
		if (entry?.type !== "message") return "";
		const message = entry.message;
		if (message.role === "bashExecution") return message.command.replace(/\s+/g, " ").trim().slice(0, 60);
		return msgText(message).replace(/\s+/g, " ").trim().slice(0, 60);
	};
	/** 把 leaf 移到 `id`。撤回要留撤销入口,面包屑与分支条切换不留(与桌面端
	 *  显式节点切换会清掉撤销浮层一致)。 */
	const moveLeaf = (messageId: string, remember = false): void => {
		const fromLeafId = outline.leafId;
		void requestBranch(messageId)
			.then(result => {
				if (result.ok === false) {
					pushActionToast({ kind: "error", message: t("general.branchFailed") });
					return;
				}
				setLeafPin({
					sessionId: focusedSessionId,
					tipId,
					leaf: result.leafId ? { mode: "node", id: result.leafId } : { mode: "root" },
				});
				setReverted(
					remember && fromLeafId
						? { sessionId: focusedSessionId, tipId, fromLeafId, label: messageLabel(messageId) }
						: null,
				);
			})
			.catch(err => {
				pushActionToast({
					kind: "error",
					message: `${t("general.branchFailed")}: ${err instanceof Error ? err.message : String(err)}`,
				});
			});
	};
	const branchInfo = useMemo(() => {
		if (!focusedSessionId || entries.length === 0) return undefined;
		return {
			childCount: outline.childCount,
			activePathIds: new Set(outline.path.map(node => node.id)),
			onSwitchBranch: (leafEntryId: string) => moveLeaf(leafEntryId),
		};
		// moveLeaf 每次渲染都是新函数,但它只读当次渲染的 outline/entries,
		// 而这两者已在依赖里;把它列为依赖只会让 memo 每次都失效。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entries, focusedSessionId, client, outline]);
	// 撤销:原 leaf 仍在树上(撤回从不截断),再发一次 branchAt 就回去了。
	const undoRevert = (): void => {
		const target = reverted;
		if (!target) return;
		void client
			.rpc<{ ok?: boolean; leafId?: string | null }>("session.branchAt", {
				sessionId: target.sessionId ?? focusedSessionId,
				messageId: target.fromLeafId,
			})
			.then(result => {
				if (result.ok === false) {
					pushActionToast({ kind: "error", message: t("general.branchFailed") });
					return;
				}
				setLeafPin({ sessionId: focusedSessionId, tipId, leaf: { mode: "tip" } });
				setReverted(null);
			})
			.catch(err => {
				pushActionToast({
					kind: "error",
					message: `${t("general.branchFailed")}: ${err instanceof Error ? err.message : String(err)}`,
				});
			});
	};
	return (
		<>
			{mobileSurface && (
				<TreeOutlineNav
					outline={outline}
					undo={
						reverted && reverted.sessionId === focusedSessionId && reverted.tipId === tipId
							? { label: reverted.label, onUndo: undoRevert, onDismiss: () => setReverted(null) }
							: null
					}
					// 面包屑点击 = 把 leaf 移到该节点(旧尾部保留为兄弟分支),与
					// 桌面端 switchToNode 同一语义;不滚动到该行。
					onJump={id => moveLeaf(id)}
				/>
			)}
			<Transcript
				entries={entries}
				stream={stream}
				streamDone={streamDone}
				activeTools={activeTools}
				working={working}
				roundDurations={roundDurations}
				host={host}
				emptySlot={emptySlot}
				userGutter={singleParty ? "" : undefined}
				agentGutter={singleParty ? "" : undefined}
				onRevert={id => moveLeaf(id, true)}
				onRetry={(id, _text) => regenerateAt(id)}
				onFork={(id, text, includeTarget) => forkAt(id, text, includeTarget)}
				onSpeak={(text, id) => tts.speak(text, id)}
				speakingId={speakingId}
				onStopSpeak={() => tts.stop()}
				branchInfo={branchInfo}
			/>
		</>
	);
}

/** Subagent rail state: agents/progress/lifecycle change independently of the transcript. */
function AgentsRail({
	client,
	selectedId,
	onSelect,
}: {
	client: SessionClient;
	selectedId: string | null;
	onSelect(id: string | null): void;
}): ReactNode {
	const agents = useGuestSelector(client, s => s.agents);
	const progress = useGuestSelector(client, s => s.progress);
	const lifecycle = useGuestSelector(client, s => s.lifecycle);
	return (
		<AgentsPanel
			agents={agents}
			progress={progress}
			lifecycle={lifecycle}
			selectedId={selectedId}
			onSelect={onSelect}
		/>
	);
}

function Session({ client, onLeave, onRejoin, currentLink, onSwitchTo, mobileTab }: SessionProps): ReactNode {
	const layout = useShellLayout();
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [activePanel, setActivePanel] = useState<GuestPanel | null>(mobileTab === "settings" ? "settings" : null);

	// Mirror the App-owned tab into the session's panel stack. HeaderBar panel
	// switches stay local — the tab bar represents the two destinations, not
	// every transient panel (board / files / voice …).
	useEffect(() => {
		setActivePanel(current => {
			if (mobileTab === "settings") return "settings";
			if (mobileTab === "chat") return null;
			return current;
		});
	}, [mobileTab]);
	const autoOpenedRef = useRef(false);
	/** Whether the currently open rail came from the wide-layout auto-reveal
	 * rather than a user action. Only the auto-revealed one is retracted when
	 * rotation or folding narrows the window: on compact/medium the rail turns
	 * into an overlay whose backdrop covers the transcript. */
	const railAutoOwnedRef = useRef(false);
	const refreshTranscript = useCallback(() => onRejoin(), [onRejoin]);

	// Low-frequency fields only. The shell never subscribes to the message
	// plane (entries/stream/activeTools) — those live in TranscriptPane.
	const phase = useGuestSelector(client, s => s.phase);
	const endedReason = useGuestSelector(client, s => s.endedReason);
	const header = useGuestSelector(client, s => s.header);
	const state = useGuestSelector(client, s => s.state);
	const agents = useGuestSelector(client, s => s.agents);
	const workspace = useGuestSelector(client, s => s.workspace);
	const focusedSessionId = useGuestSelector(client, s => s.focusedSessionId);
	const readOnly = useGuestSelector(client, s => s.readOnly);
	const working = useGuestSelector(client, s => s.working);

	// HarmonyOS Live View（实况窗）: a running turn stays visible in the status
	// bar / notification centre while the app is backgrounded. The native side
	// no-ops without the AGC entitlement, so this costs nothing on other shells.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		try {
			window.harmonyNative?.setLiveView?.(
				working,
				header?.title?.trim() || t("shell.musepiCollab"),
				working ? t("agents.agentStatusRunning") : "",
			);
		} catch {
			// bridge missing — nothing to mirror
		}
	}, [working, header]);

	// HarmonyOS shell pushes its window form, not the device name: the chrome
	// layout (`rail` on a tablet / unfolded foldable / landscape, `bottom` on a
	// phone), the left gutter the rail occupies, and the bottom strip the
	// floating bar occupies. The page swaps one reservation for the other and
	// exposes the breakpoints so the stylesheet can pick a reading column.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		const root = document.documentElement;
		const applyChrome = (layout: string, rail: number, reserve?: number): void => {
			if (layout === "rail") {
				root.dataset.harmonyChrome = "rail";
				root.style.setProperty("--harmony-rail", `${rail > 0 ? rail : 84}px`);
			} else {
				delete root.dataset.harmonyChrome;
			}
			// The bar strip is inline (inline beats the stylesheet), so the rail
			// layout clears it here instead of fighting it from CSS. `reserve` is
			// the native bar's own geometry (gesture inset + bar + gaps) so the
			// composer dock and the bar can never drift apart.
			root.style.setProperty(
				"--sh-tabbar-space",
				layout === "rail" ? "0px" : `${reserve && reserve > 0 ? reserve : 96}px`,
			);
		};
		const applyForm = (raw: string): void => {
			try {
				const form = JSON.parse(raw) as { width?: string; height?: string; fold?: string; rail?: number };
				root.dataset.harmonyWindow = form.width ?? "";
				root.dataset.harmonyHeight = form.height ?? "";
				root.dataset.harmonyFold = form.fold ?? "";
				// The rail gutter travels with the form because it depends on the
				// breakpoint (72/84/96vp) plus any landscape cutout on the left.
				if (root.dataset.harmonyChrome === "rail" && form.rail && form.rail > 0) {
					root.style.setProperty("--harmony-rail", `${form.rail}px`);
				}
			} catch {
				// Malformed payload — the previous form keeps describing the window.
			}
		};
		const host = window as unknown as Record<string, unknown>;
		host.__harmonyChrome = applyChrome;
		host.__harmonyWindow = applyForm;
		// The shell pushes on every window change, but a push that lands before
		// this effect registers is simply lost — and unfolding the phone once
		// left the rail overlapping the content because exactly that happened.
		// Re-read the two bridge answers here too: they are synchronous, cheap,
		// and make the page recover on any resize it survives.
		const syncFromShell = (): void => {
			const native = window.harmonyNative;
			if (!native) return;
			// Chrome first, then the form: the form carries the breakpoint-exact
			// rail width and only overrides it once the layout is already `rail`.
			applyChrome(native.getChromeLayout?.() ?? "bottom", 84);
			const form = native.getWindowForm?.();
			if (form) applyForm(form);
		};
		syncFromShell();
		window.addEventListener("resize", syncFromShell);
		window.addEventListener("orientationchange", syncFromShell);
		return () => {
			window.removeEventListener("resize", syncFromShell);
			window.removeEventListener("orientationchange", syncFromShell);
			delete host.__harmonyChrome;
			delete host.__harmonyWindow;
		};
	}, []);

	// A block's collected choice arrives as one message (see ui-blocks/answers):
	// the guest shell delivers it exactly like a typed prompt.
	useEffect(() => {
		const onAnswer = (event: Event): void => {
			const detail = (event as CustomEvent<{ text?: unknown }>).detail;
			const text = typeof detail?.text === "string" ? detail.text : "";
			if (!text) return;
			void client.sendPrompt(text).catch(error => {
				console.error("[ui-block] answer failed:", error);
			});
		};
		window.addEventListener(UI_BLOCK_ANSWER_EVENT, onAnswer);
		return () => window.removeEventListener(UI_BLOCK_ANSWER_EVENT, onAnswer);
	}, [client]);

	const subCount = agents.filter(a => a.kind === "sub").length;
	const agentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
			sendPrompt: text => {
				void client.sendPrompt(text).catch(error => {
					console.error("[transcript] prompt failed:", error);
				});
			},
			// User-message attachment cards: size probe and paged text preview.
			// Both methods already exist on the daemon; the host only exposes them.
			attachment: {
				stat: hash => client.rpc<AttachmentStatResult>("attachment.stat", { hash }),
				read: (hash, offset, limit) =>
					client.rpc<AttachmentGetResult | { error: string }>("attachment.get", { hash, offset, limit }),
			},
		}),
		[agentIds, client],
	);

	// Wide screens can reveal the first subagent without covering the transcript.
	// Compact and medium rails are overlays, so only an explicit action opens them.
	// Retract the auto-revealed rail when the window narrows (rotation, folding or
	// a desktop resize): leaving it open swaps the split column for a backdrop
	// that hides the transcript and clips messages at the overlay's edge.
	useEffect(() => {
		if (layout === "wide") {
			if (subCount > 0 && !autoOpenedRef.current) {
				autoOpenedRef.current = true;
				railAutoOwnedRef.current = true;
				setRailOpen(true);
			}
			return;
		}
		if (railAutoOwnedRef.current) {
			railAutoOwnedRef.current = false;
			// Re-arm so returning to a wide layout reveals the rail again.
			autoOpenedRef.current = false;
			setRailOpen(false);
		}
	}, [layout, subCount]);

	const mobile = useMobileSurface();
	const draftSession = mobile && workspace !== null && focusedSessionId === null;
	const title = draftSession
		? t("settings.newSession")
		: (header?.title ?? state?.sessionName ?? t("settings.session2"));
	useEffect(() => {
		document.title = `${title} · ${t("shell.musepiCollab")}`;
	}, [title]);

	const drawerAgent = selectedId != null ? agents.find(a => a.id === selectedId) : undefined;
	const inWorkspace = workspace !== null && focusedSessionId === null && !mobile;
	// Mobile 列表↔会话 morph (M1.10 §3.3 批次 B): freeze + collapse the
	// outgoing scene and cache the shared-element rects before the state
	// flip commits. Desktop/web shells keep the plain hard switch — the
	// navigation paths outside the mobile shell never change.
	const stageMobileSceneMorph = useCallback((): void => {
		if (!isMobileSurface()) return;
		const root =
			document.querySelector<HTMLElement>(".sh-workspace") ?? document.querySelector<HTMLElement>(".sh-content");
		if (!root) return;
		cacheMorphRects(document);
		stageLeavingScene(root);
	}, []);
	const selectSession = useCallback(
		(id: string): void => {
			if (inWorkspace) stageMobileSceneMorph();
			client.selectWorkspaceSession(id);
		},
		[client, inWorkspace, stageMobileSceneMorph],
	);
	const backToWorkspace = useCallback((): void => {
		// Back is only reachable while a session is focused (workspace →
		// session direction), and only the transcript scene morphs — a panel
		// occupies .sh-content when one is open.
		if (!inWorkspace && activePanel === null) stageMobileSceneMorph();
		client.selectWorkspaceSession(null);
	}, [activePanel, client, inWorkspace, stageMobileSceneMorph]);
	const newSession = useCallback((): void => {
		setActivePanel(null);
		setRailOpen(false);
		client.selectWorkspaceSession(null);
	}, [client]);
	const sessionCwd = state?.cwd ?? null;
	// Android back key: each layer registers its own close handler on the
	// shared back stack (lib/back-stack). dispatchBack() walks from the
	// topmost modal down; the first handler returning true consumes the
	// press, so exactly one layer closes per back press (never two).
	useBackLayer(
		100,
		selectedId !== null,
		useCallback(() => {
			setSelectedId(null);
			return true;
		}, []),
	);
	useBackLayer(
		80,
		railOpen,
		useCallback(() => {
			setRailOpen(false);
			return true;
		}, []),
	);
	useBackLayer(
		60,
		activePanel !== null,
		useCallback(() => {
			setActivePanel(null);
			return true;
		}, []),
	);
	useBackLayer(
		40,
		workspace !== null && focusedSessionId !== null,
		useCallback(() => {
			backToWorkspace();
			return true;
		}, [backToWorkspace]),
	);

	const hostMode = client instanceof HostClient;
	return (
		<div
			className={["sh-app", isCompatShell() ? "sh-app--compat" : null, hostMode ? "sh-app--host" : null]
				.filter(Boolean)
				.join(" ")}
			data-layout={layout}
			data-surface={mobile ? "mobile" : undefined}
		>
			{isCompatShell() && <div className="compat-titlebar" aria-hidden="true" />}
			<HeaderBar
				client={client}
				railOpen={railOpen}
				onToggleRail={() => {
					// The user owns the rail from here on; a later resize must not
					// close it behind their back.
					railAutoOwnedRef.current = false;
					setRailOpen(open => !open);
				}}
				onLeave={onLeave}
				onBack={focusedSessionId !== null && workspace !== null ? backToWorkspace : undefined}
				activePanel={activePanel}
				currentLink={currentLink}
				onSwitchTo={onSwitchTo}
				onSelectPanel={setActivePanel}
				sessions={workspace}
				focusedSessionId={focusedSessionId}
				onSelectSession={selectSession}
				onNewSession={newSession}
			/>
			{client.plaintext && <PlaintextBanner />}
			<main className="sh-main">
				{inWorkspace && workspace !== null ? (
					<WorkspaceView
						client={client}
						sessions={workspace}
						onSelect={selectSession}
						onCreateSession={() => client.rpc("session.create", {})}
						onDeleteSession={id => client.rpc("session.delete", { sessionId: id })}
						onRenameSession={(id, title) => client.rpc("session.rename", { sessionId: id, title })}
						onStopSession={id => client.rpc("session.abort", { sessionId: id })}
						mobile={mobile}
					/>
				) : activePanel !== null ? (
					<section className="sh-content" data-rail="false">
						<div className="sh-panel">
							{activePanel === "board" && <BoardPanel client={client} />}
							{activePanel === "scheduled" && (
								<ScheduledPanel client={client} cwd={sessionCwd} readOnly={readOnly} />
							)}
							{activePanel === "files" && (
								<WorkspacePanel client={client} cwd={sessionCwd} readOnly={readOnly} />
							)}
							{activePanel === "marketplace" && <MarketplacePanel client={client} />}
							{activePanel === "workbench" && (
								<CompatSlotHost slot="panel.tab.workbench" className="sh-compat-panel" />
							)}
							{activePanel === "voice" && <VoicePanel client={client} />}
							{activePanel === "settings" && (
								<MobileSettings
									client={client}
									currentLink={currentLink}
									phase={phase}
									onSwitchTo={onSwitchTo}
									onLeave={onLeave}
								/>
							)}
						</div>
					</section>
				) : (
					<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
						<div className="sh-transcript">
							<PullToRefresh onRefresh={refreshTranscript}>
								<TranscriptPane client={client} host={toolHost} />
							</PullToRefresh>
						</div>
					</section>
				)}
				{railOpen && !inWorkspace && activePanel === null && (
					<>
						<div
							className="sh-rail-backdrop"
							onClick={() => {
								railAutoOwnedRef.current = false;
								setRailOpen(false);
							}}
						/>
						<aside className="sh-rail">
							<AgentsRail client={client} selectedId={selectedId} onSelect={setSelectedId} />
						</aside>
					</>
				)}
			</main>
			{!inWorkspace && activePanel === null && (
				<>
					<CompatSlotHost slot="conversation.composer.dock" className="sh-compat-dock" />
					<Composer client={client} draftScope={currentLink} />
				</>
			)}
			{!inWorkspace && activePanel === null && <ApprovalCard client={client} />}
			{!inWorkspace && activePanel === null && <CompatSlotHost slot="statusbar" className="sh-compat-statusbar" />}
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						client={client}
						readOnly={readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			<Banners
				phase={phase}
				endedReason={endedReason}
				onRejoin={onRejoin}
				onNewLink={onLeave}
				// On a phone the ended card belongs to the chat destination; over
				// 连接/设置 it was a modal with no dismiss covering live controls.
				blocking={!mobile || mobileTab === "chat"}
			/>
			<Toasts />
		</div>
	);
}
