import type { AssistantMessage } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { BoardPanel } from "./components/panels/BoardPanel";
import { FilePanel } from "./components/panels/FilePanel";
import { ScheduledPanel } from "./components/panels/ScheduledPanel";
import { Banners } from "./components/shell/Banners";
import { ApprovalCard } from "./components/shell/ApprovalCard";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { type GuestPanel, HeaderBar } from "./components/shell/HeaderBar";
import { WelcomeHint } from "./components/shell/WelcomeHint";
import { Toasts } from "./components/shell/Toasts";
import { WorkspaceView } from "./components/shell/WorkspaceView";
import { msgText, Transcript } from "./components/transcript/Transcript";
import { t } from "./i18n/index.js";
import {
	BACK_EVENT,
	clearBadge,
	consumePendingDeepLink,
	DEEP_LINK_EVENT,
	incrementBadge,
	isMobileShell,
	isNativeShell,
} from "./lib/capacitor";
import { GuestClient } from "./lib/client";
import { isCompatShell } from "./lib/compat-shell";
import { HostClient } from "./lib/host-client";
import { useGuestSelector, type SessionClient } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

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
	const credsRef = useRef<Creds | null>(null);
	const hostRef = useRef<{ wsUrl: string; token?: string } | null>(null);

	const connect = useCallback((link: string, name: string): void => {
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
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	/** Host-mode: connect to the serving daemon's own session (compat shell).
	 *  No collab link, no E2E — the daemon's WS is loopback + token-gated. */
	const connectHost = useCallback((wsUrl: string, token?: string): void => {
		const next = new HostClient(wsUrl, token);
		next.connect();
		hostRef.current = { wsUrl, token };
		credsRef.current = null;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		hostRef.current = null;
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

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	// Host-mode boot config: when served by `musepi serve --web-port`, the
	// daemon also serves /__daemon.json with the JSON-RPC WS origin + token.
	// Auto-connect as host (skip ConnectScreen) unless a collab deep link is
	// present. Absent config (dev server / static host) → ConnectScreen.
	useEffect(() => {
		if (hashLink()) return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch("/__daemon.json");
				if (!res.ok) return;
				const config = (await res.json()) as { wsUrl?: string; token?: string };
				if (config.wsUrl && !cancelled) connectHost(config.wsUrl, config.token);
			} catch {
				// Not served by a daemon — ConnectScreen below handles it.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [connectHost]);

	// Deep link: a native musepi:// URL (notification tap / QR / external link)
	// delivered by the Capacitor App plugin — connect directly, same as hash.
	useEffect(() => {
		if (!isMobileShell()) return;
		const onLink = (e: Event): void => {
			const link = (e as CustomEvent<{ link: string }>).detail?.link;
			if (link) connect(link, storedName());
		};
		// Cold start: the link arrived before this listener mounted (boot
		// splash) — the stash drains it exactly once.
		const stashed = consumePendingDeepLink();
		if (stashed) connect(stashed, storedName());
		window.addEventListener(DEEP_LINK_EVENT, onLink);
		return () => window.removeEventListener(DEEP_LINK_EVENT, onLink);
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = t("musepi collab");
	}, [client]);

	useMobileNotifications(client, credsRef.current?.link ?? null);

	if (!client) {
		return (
			<ConnectScreen
				defaultName={storedName()}
				defaultLink={hashLink() ?? undefined}
				error={connectError}
				onConnect={connect}
			/>
		);
	}
	return (
		<Session
			client={client}
			onLeave={leave}
			onRejoin={rejoin}
			currentLink={credsRef.current?.link ?? ""}
			onSwitchTo={connect}
		/>
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
								title: t("musepi session update"),
								body: text.slice(0, 140) || t("session update"),
								smallIcon: "ic_stat_musepi",
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
			{t("plaintext session: not encrypted — anyone on this network can read it")}
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
}

/**
 * Message-plane fields only: entries/stream/activeTools change on every
 * transcript frame, so this pane is the only thing that re-renders during
 * a stream — never the shell, header, composer, or toasts.
 */
function TranscriptPane({ client, host }: { client: SessionClient; host: ToolRenderHost }): ReactNode {
	const entries = useGuestSelector(client, s => s.entries);
	const stream = useGuestSelector(client, s => s.stream);
	const streamDone = useGuestSelector(client, s => s.streamDone);
	const activeTools = useGuestSelector(client, s => s.activeTools);
	const working = useGuestSelector(client, s => s.working);
	const roundDurations = useGuestSelector(client, s => s.roundDurations);
	// Mobile empty state gets the time-aware greeting + rotating tip in place
	// of the bare "no activity yet" line (gui WelcomeComposer parity).
	const emptySlot = isMobileShell() ? <WelcomeHint /> : undefined;
	return (
		<Transcript
			entries={entries}
			stream={stream}
			streamDone={streamDone}
			activeTools={activeTools}
			working={working}
			roundDurations={roundDurations}
			host={host}
			emptySlot={emptySlot}
		/>
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

function Session({ client, onLeave, onRejoin, currentLink, onSwitchTo }: SessionProps): ReactNode {
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [activePanel, setActivePanel] = useState<GuestPanel | null>(null);
	const autoOpenedRef = useRef(false);

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

	const subCount = agents.filter(a => a.kind === "sub").length;
	const agentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
			sendPrompt: text => client.sendPrompt(text),
		}),
		[agentIds, client],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = header?.title ?? state?.sessionName ?? t("session");
	useEffect(() => {
		document.title = `${title} · ${t("musepi collab")}`;
	}, [title]);

	const drawerAgent = selectedId != null ? agents.find(a => a.id === selectedId) : undefined;
	const inWorkspace = workspace !== null && focusedSessionId === null;
	const backToWorkspace = useCallback(() => client.selectWorkspaceSession(null), [client]);
	const sessionCwd = state?.cwd ?? null;
	// Android back key: close the topmost layer (agent drawer → rail → panel →
	// workspace focus) before the shell is allowed to exit. The mobile entry
	// dispatches `musepi:back`; preventDefault marks the press consumed so
	// setupAndroidBackHandler won't exit the app.
	useEffect(() => {
		const onBack = (e: Event): void => {
			if (selectedId !== null) {
				setSelectedId(null);
				e.preventDefault();
				return;
			}
			if (railOpen) {
				setRailOpen(false);
				e.preventDefault();
				return;
			}
			if (activePanel !== null) {
				setActivePanel(null);
				e.preventDefault();
				return;
			}
			if (workspace !== null && focusedSessionId !== null) {
				backToWorkspace();
				e.preventDefault();
			}
		};
		window.addEventListener(BACK_EVENT, onBack);
		return () => window.removeEventListener(BACK_EVENT, onBack);
	}, [selectedId, railOpen, activePanel, workspace, focusedSessionId, backToWorkspace]);

	return (
		<div className={isCompatShell() ? "sh-app sh-app--compat" : "sh-app"}>
			{isCompatShell() && <div className="compat-titlebar" aria-hidden="true" />}
			<HeaderBar
				client={client}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
				onBack={inWorkspace ? undefined : workspace !== null ? backToWorkspace : undefined}
				activePanel={activePanel}
				currentLink={currentLink}
				onSwitchTo={onSwitchTo}
				onSelectPanel={setActivePanel}
				sessions={workspace}
				focusedSessionId={focusedSessionId}
				onSelectSession={id => client.selectWorkspaceSession(id)}
			/>
			{client.plaintext && <PlaintextBanner />}
			<main className="sh-main">
				{inWorkspace && workspace !== null ? (
					<WorkspaceView
						client={client}
						sessions={workspace}
						onSelect={id => client.selectWorkspaceSession(id)}
						onCreateSession={() => client.rpc("session.create", {})}
						onDeleteSession={id => client.rpc("session.delete", { sessionId: id })}
						onRenameSession={(id, title) => client.rpc("session.rename", { sessionId: id, title })}
						onStopSession={id => client.rpc("session.abort", { sessionId: id })}
					/>
				) : activePanel !== null ? (
					<section className="sh-content" data-rail="false">
						<div className="sh-panel">
							{activePanel === "board" && <BoardPanel client={client} />}
							{activePanel === "scheduled" && (
								<ScheduledPanel client={client} cwd={sessionCwd} readOnly={readOnly} />
							)}
							{activePanel === "files" && <FilePanel client={client} cwd={sessionCwd} readOnly={readOnly} />}
						</div>
					</section>
				) : (
					<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
						<div className="sh-transcript">
							<TranscriptPane client={client} host={toolHost} />
						</div>
					</section>
				)}
				{railOpen && !inWorkspace && activePanel === null && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsRail client={client} selectedId={selectedId} onSelect={setSelectedId} />
						</aside>
					</>
				)}
			</main>
			{!inWorkspace && activePanel === null && <Composer client={client} />}
			{!inWorkspace && activePanel === null && <ApprovalCard client={client} />}
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
			<Banners phase={phase} endedReason={endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			<Toasts client={client} />
		</div>
	);
}
