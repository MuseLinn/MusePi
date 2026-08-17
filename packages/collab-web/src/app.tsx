import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { BoardPanel } from "./components/panels/BoardPanel";
import { FilePanel } from "./components/panels/FilePanel";
import { ScheduledPanel } from "./components/panels/ScheduledPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { type GuestPanel, HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { WorkspaceView } from "./components/shell/WorkspaceView";
import { Transcript } from "./components/transcript/Transcript";
import { t } from "./i18n/index.js";
import { GuestClient } from "./lib/client";
import { useGuestSelector } from "./lib/use-guest";
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
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);

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

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

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

	useEffect(() => {
		if (!client) document.title = t("musepi collab");
	}, [client]);

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
	return <Session client={client} onLeave={leave} onRejoin={rejoin} />;
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
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
}

/**
 * Message-plane fields only: entries/stream/activeTools change on every
 * transcript frame, so this pane is the only thing that re-renders during
 * a stream — never the shell, header, composer, or toasts.
 */
function TranscriptPane({ client, host }: { client: GuestClient; host: ToolRenderHost }): ReactNode {
	const entries = useGuestSelector(client, s => s.entries);
	const stream = useGuestSelector(client, s => s.stream);
	const streamDone = useGuestSelector(client, s => s.streamDone);
	const activeTools = useGuestSelector(client, s => s.activeTools);
	const working = useGuestSelector(client, s => s.working);
	const roundDurations = useGuestSelector(client, s => s.roundDurations);
	return (
		<Transcript
			entries={entries}
			stream={stream}
			streamDone={streamDone}
			activeTools={activeTools}
			working={working}
			roundDurations={roundDurations}
			host={host}
		/>
	);
}

/** Subagent rail state: agents/progress/lifecycle change independently of the transcript. */
function AgentsRail({
	client,
	selectedId,
	onSelect,
}: {
	client: GuestClient;
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

function Session({ client, onLeave, onRejoin }: SessionProps): ReactNode {
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

	return (
		<div className="sh-app">
			<HeaderBar
				client={client}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
				onBack={inWorkspace ? undefined : workspace !== null ? backToWorkspace : undefined}
				activePanel={activePanel}
				onSelectPanel={setActivePanel}
			/>
			{client.plaintext && <PlaintextBanner />}
			<main className="sh-main">
				{inWorkspace && workspace !== null ? (
					<WorkspaceView client={client} sessions={workspace} onSelect={id => client.selectWorkspaceSession(id)} />
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
