import { SessionErrorDock } from "@musepi/client-core";
import { Transcript, type TranscriptProps } from "@musepi/client-core/src/components/transcript/Transcript";
import { t } from "@musepi/client-core/src/i18n/index.js";
import { fmtCost, fmtDuration, fmtTokens } from "@musepi/client-core/src/lib/format";
import { decideTranscriptPoll } from "@musepi/client-core/src/lib/transcript-poll";
import type { AgentSnapshot, SessionEntry } from "@musepi/pi-wire";
import { ExternalLink, OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFocusTrap } from "../lib/use-focus-trap";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;

/** RPC mirror of the collab client's TranscriptResult (not exported from
 *  transcript-poll.ts; the shape is the contract both sides share). */
type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

/** Stats strip values, as GuiSessionState carries them per agent. */
export interface SubagentSessionProgress {
	tokens: number;
	cost: number;
	toolCount: number;
	durationMs: number;
	resolvedModel?: string;
	contextTokens?: number;
	contextWindow?: number;
}

/**
 * Live subagent conversation: header actions, stats strip, incremental
 * transcript, error dock and the chat form. This is the content both hosts
 * render — the docked drawer (SubagentPanel) and the agent panel tab — so they
 * can never disagree about polling or actions.
 *
 * RPC-backed: the daemon's agents.transcript incremental read mirrors the
 * collab host's fetch-transcript frame, and the same pure polling decision
 * (transcript-poll.ts) drives the cursor. kill/revive/chat go through the
 * existing agents.* RPCs.
 */
export function SubagentSessionView(props: {
	agent: AgentSnapshot;
	progress?: SubagentSessionProgress | null;
	rpc: RpcClient;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	/** Child session id of this agent — when present, the header shows an
	 *  upgrade action that opens the sub conversation as the main chat
	 *  surface (openchamber mini-chat parity: embedded preview → full view). */
	sessionId?: string | null;
	/** Owning (parent) session: the daemon resolves the transcript from its
	 *  product directory when the agent is no longer in the registry. */
	parentSessionId?: string | null;
	onOpenSession?(id: string): void;
	/** Drawer hosts close first; a tab body has no close affordance. */
	onClose?(): void;
	/** Drives the transcript poll. False keeps the rows already read but
	 *  stops the interval (closed drawer / folded panel). */
	pollEnabled?: boolean;
}): ReactNode {
	const {
		agent,
		progress: p,
		rpc,
		host,
		sessionId,
		parentSessionId,
		onOpenSession,
		onClose,
		pollEnabled = true,
	} = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	/**
	 * The live poll, hoisted so the session dock's no-reply check can re-read the
	 * transcript on demand. It is the same reader the interval uses, so the check
	 * cannot disagree with what the view is showing.
	 */
	const pollRef = useRef<(() => Promise<void>) | null>(null);
	const verifyTranscript = useCallback(async (): Promise<void> => {
		await pollRef.current?.();
	}, []);

	// Live transcript: poll the daemon's agents.transcript RPC while the view
	// is enabled, appending parsed JSONL entries. Same cursor semantics as the
	// collab drawer — a terminal `error` reply stops polling and surfaces the
	// message (retrying would loop hot). Disabling keeps the entries: clearing
	// them here would blank the drawer's exit animation.
	const agentId = agent.id;
	const hasSessionFile = agent.hasSessionFile;
	useEffect(() => {
		if (!pollEnabled || !hasSessionFile) return;
		setEntries([]);
		setFetchError(null);
		let disposed = false;
		let inFlight = false;
		let cursor = 0;
		let carry = "";
		let acc: readonly SessionEntry[] = [];
		let timer: Timer | null = null;
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const poll = async (): Promise<void> => {
			if (disposed || inFlight) return;
			inFlight = true;
			try {
				const res = await rpc.request<{ text: string; newSize: number; error?: string }>("agents.transcript", {
					agentId,
					parentSessionId: parentSessionId ?? undefined,
					fromByte: cursor,
				});
				if (disposed) return;
				const reply: TranscriptResult | null = res
					? typeof res.error === "string" && res.error !== ""
						? { kind: "error", message: res.error }
						: { kind: "rows", text: res.text, newSize: res.newSize }
					: null;
				const decision = decideTranscriptPoll(reply, carry);
				switch (decision.action) {
					case "retry":
						return; // transient (missing file / race) → keep polling
					case "stop":
						stopPolling();
						setFetchError(decision.message);
						return;
					case "advance":
						cursor = decision.newSize;
						carry = decision.carry;
						if (decision.fresh.length > 0) {
							acc = [...acc, ...decision.fresh];
							setEntries(acc);
						}
						return;
				}
			} finally {
				inFlight = false;
			}
		};
		// The poll is the only reader of this transcript, so the session dock's
		// no-reply check re-runs it rather than opening a second reader on the same
		// file. Held in a ref because the poll's lifetime is the effect's.
		pollRef.current = poll;
		void poll();
		timer = setInterval(() => {
			void poll();
		}, POLL_MS);
		return () => {
			disposed = true;
			stopPolling();
		};
	}, [pollEnabled, agentId, hasSessionFile, rpc, parentSessionId]);

	const sendChat = (): void => {
		const text = draft.trim();
		if (!text) return;
		void rpc.request("agents.chat", { agentId, text }).catch(() => {});
		setDraft("");
	};

	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;

	return (
		<>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{agent.displayName}</span>
					<span className={`ag-chip ag-chip--${agent.status}`}>{agent.status}</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{agent.status === "running" ? (
						<button
							type="button"
							className="ag-btn ag-btn--danger"
							onClick={() => void rpc.request("agents.kill", { agentId }).catch(() => {})}
						>
							<OctagonX size={13} aria-hidden />
							{t("settings.kill")}
						</button>
					) : null}
					{agent.status === "parked" || agent.status === "aborted" ? (
						<button
							type="button"
							className="ag-btn"
							onClick={() => void rpc.request("agents.revive", { agentId }).catch(() => {})}
						>
							<RotateCcw size={13} aria-hidden />
							{t("settings.revive")}
						</button>
					) : null}
					{sessionId && onOpenSession ? (
						<button
							type="button"
							className="ag-iconbtn"
							title={t("general.openSubagentSession")}
							aria-label={t("general.openSubagentSession")}
							onClick={() => {
								onClose?.();
								if (sessionId) onOpenSession(sessionId);
							}}
						>
							<ExternalLink size={14} aria-hidden />
						</button>
					) : null}
					{onClose ? (
						<button type="button" className="ag-iconbtn" aria-label={t("settings.close")} onClick={onClose}>
							<X size={15} aria-hidden />
						</button>
					) : null}
				</div>
			</header>
			{p ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">{t("settings.tok")}</span>
						<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span
							className="ag-stat"
							title={t("agents.contextWithCount", { count: fmtTokens(p.contextTokens ?? 0) })}
						>
							<span className="ag-stat-label">{t("settings.ctx")}</span>
							<span className="ag-gauge">
								<span
									className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
									style={{ width: `${ctxPct}%` }}
								/>
							</span>
						</span>
					) : null}
					<span className="ag-stat">
						<span className="ag-stat-label">{t("settings.cost")}</span>
						<span className="ag-stat-value">{fmtCost(p.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">{t("settings.tools")}</span>
						<span className="ag-stat-value">{p.toolCount}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
					</span>
				</div>
			) : null}
			<div className="ag-drawer-body">
				{agent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={agent.status === "running" && fetchError === null}
							host={host}
						/>
						<SessionErrorDock
							entries={entries}
							working={agent.status === "running" && fetchError === null}
							verifyTranscript={verifyTranscript}
						/>
						{fetchError !== null ? (
							<div className="ag-fetch-error" role="alert">
								{t("agents.transcriptUnavailableWithReason", { reason: fetchError })}
							</div>
						) : null}
					</>
				) : (
					<div className="ag-empty">{t("agents.noTranscriptAvailable")}</div>
				)}
			</div>
			<form
				className="ag-chat"
				onSubmit={e => {
					e.preventDefault();
					sendChat();
				}}
			>
				<input
					className="ag-chat-input"
					value={draft}
					placeholder={t("agents.messageWithName", { name: agent.displayName })}
					onChange={e => setDraft(e.target.value)}
				/>
				<button
					type="submit"
					className="ag-iconbtn"
					aria-label={t("settings.send2")}
					disabled={draft.trim().length === 0}
				>
					<SendHorizontal size={15} aria-hidden />
				</button>
			</form>
		</>
	);
}

/**
 * Subagent trajectory detail docked over the agents pane (kimiwork parity: a
 * swarm-card member row opens the subagent's own transcript).
 *
 * Hosts dock this layer and keep it mounted, driving it with `open` (the
 * DialogFrame rule): closing plays the same slide as opening. Because the
 * host clears its selection on close, the last snapshot is retained here so
 * the exiting layer never blanks.
 */
export function SubagentPanel(props: {
	/** null while the host is closed — the previous snapshot is retained. */
	agent: AgentSnapshot | null;
	/** Drives the transcript poll, Esc and the focus trap; position/motion
	 *  live in the host's .gui-agent-dock wrapper. */
	open: boolean;
	rpc: RpcClient;
	progress?: SubagentSessionProgress | null;
	host?: TranscriptProps["host"];
	sessionId?: string | null;
	parentSessionId?: string | null;
	onOpenSession?(id: string): void;
	onClose(): void;
}): ReactNode {
	const { agent, open, rpc, progress: p, host, sessionId, parentSessionId, onOpenSession, onClose } = props;
	// Written during render (not in an effect) so the snapshot is already
	// retained in the commit that clears it.
	const retained = useRef<{ agent: AgentSnapshot; progress: typeof p; sessionId: string | null | undefined } | null>(
		null,
	);
	if (agent !== null) retained.current = { agent, progress: p, sessionId };
	const shownAgent = agent ?? retained.current?.agent ?? null;
	const shownProgress = agent !== null ? p : (retained.current?.progress ?? null);
	const shownSessionId = agent !== null ? sessionId : (retained.current?.sessionId ?? null);

	// Esc closes the layer (modal panel parity with TaskModal) — gated on
	// open, since the layer stays mounted through the exit animation.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	// Focus trap: Tab stays inside the layer while it is open.
	const trapRef = useFocusTrap<HTMLElement>(open);
	if (shownAgent === null) return null;
	return (
		<aside ref={trapRef} className="ag-drawer" role="dialog" aria-hidden={!open} aria-label={shownAgent.displayName}>
			<SubagentSessionView
				agent={shownAgent}
				progress={shownProgress}
				rpc={rpc}
				host={host}
				sessionId={shownSessionId}
				parentSessionId={parentSessionId}
				onOpenSession={onOpenSession}
				onClose={onClose}
				pollEnabled={open}
			/>
		</aside>
	);
}
