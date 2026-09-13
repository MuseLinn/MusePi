import { Transcript, type TranscriptProps } from "@musepi/guest-client/src/components/transcript/Transcript";
import { t } from "@musepi/guest-client/src/i18n/index.js";
import { fmtCost, fmtDuration, fmtTokens } from "@musepi/guest-client/src/lib/format";
import { decideTranscriptPoll } from "@musepi/guest-client/src/lib/transcript-poll";
import type { AgentSnapshot, SessionEntry } from "@musepi/pi-wire";
import { OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFocusTrap } from "../lib/use-focus-trap";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;

/** RPC mirror of the collab client's TranscriptResult (not exported from
 *  transcript-poll.ts; the shape is the contract both sides share). */
type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

/**
 * Subagent trajectory detail (kimiwork parity: a swarm-card member row or an
 * agents-roster row opens the subagent's own transcript). RPC-backed — the
 * daemon's agents.transcript incremental read mirrors the collab host's
 * fetch-transcript frame, and the same pure polling decision
 * (transcript-poll.ts) drives the cursor. kill/revive/chat go through the
 * existing agents.* RPCs.
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
	progress?: {
		tokens: number;
		cost: number;
		toolCount: number;
		durationMs: number;
		resolvedModel?: string;
		contextTokens?: number;
		contextWindow?: number;
	} | null;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	onClose(): void;
}): ReactNode {
	const { agent, open, rpc, progress: p, host, onClose } = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	// Written during render (not in an effect) so the snapshot is already
	// retained in the commit that clears it.
	const retained = useRef<{ agent: AgentSnapshot; progress: typeof p } | null>(null);
	if (agent !== null) retained.current = { agent, progress: p };
	const shownAgent = agent ?? retained.current?.agent ?? null;
	const shownProgress = agent !== null ? p : (retained.current?.progress ?? null);

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

	// Live transcript: poll the daemon's agents.transcript RPC while the
	// layer is open, appending parsed JSONL entries. Same cursor semantics
	// as the collab drawer — a terminal `error` reply stops polling and
	// surfaces the message (retrying would loop hot). Closing keeps the
	// entries: clearing them here would blank the exit animation.
	const shownId = shownAgent?.id ?? null;
	const shownHasSessionFile = shownAgent?.hasSessionFile === true;
	useEffect(() => {
		if (!open || shownId === null || !shownHasSessionFile) return;
		// The RPC closure outlives this render's narrowing — capture the id.
		const agentId = shownId;
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
		void poll();
		timer = setInterval(() => {
			void poll();
		}, POLL_MS);
		return () => {
			disposed = true;
			stopPolling();
		};
	}, [open, shownId, shownHasSessionFile, rpc]);

	const sendChat = (): void => {
		const text = draft.trim();
		if (!text || shownAgent === null) return;
		void rpc.request("agents.chat", { agentId: shownAgent.id, text }).catch(() => {});
		setDraft("");
	};

	const model = shownProgress?.resolvedModel;
	const ctxPct =
		shownProgress?.contextTokens !== undefined && shownProgress.contextWindow
			? Math.min(100, (shownProgress.contextTokens / shownProgress.contextWindow) * 100)
			: null;

	// Focus trap: Tab stays inside the layer while it is open.
	const trapRef = useFocusTrap<HTMLElement>(open);
	if (shownAgent === null) return null;
	return (
		<aside ref={trapRef} className="ag-drawer" role="dialog" aria-hidden={!open} aria-label={shownAgent.displayName}>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{shownAgent.displayName}</span>
					<span className={`ag-chip ag-chip--${shownAgent.status}`}>{shownAgent.status}</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{shownAgent.status === "running" ? (
						<button
							type="button"
							className="ag-btn ag-btn--danger"
							onClick={() => void rpc.request("agents.kill", { agentId: shownAgent.id }).catch(() => {})}
						>
							<OctagonX size={13} aria-hidden />
							{t("kill")}
						</button>
					) : null}
					{shownAgent.status === "parked" || shownAgent.status === "aborted" ? (
						<button
							type="button"
							className="ag-btn"
							onClick={() => void rpc.request("agents.revive", { agentId: shownAgent.id }).catch(() => {})}
						>
							<RotateCcw size={13} aria-hidden />
							{t("revive")}
						</button>
					) : null}
					<button type="button" className="ag-iconbtn" aria-label={t("close")} onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			{shownProgress ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">{t("tok")}</span>
						<span className="ag-stat-value">{fmtTokens(shownProgress.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span
							className="ag-stat"
							title={t("context {count}", { count: fmtTokens(shownProgress.contextTokens ?? 0) })}
						>
							<span className="ag-stat-label">{t("ctx")}</span>
							<span className="ag-gauge">
								<span
									className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
									style={{ width: `${ctxPct}%` }}
								/>
							</span>
						</span>
					) : null}
					<span className="ag-stat">
						<span className="ag-stat-label">{t("cost")}</span>
						<span className="ag-stat-value">{fmtCost(shownProgress.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">{t("tools")}</span>
						<span className="ag-stat-value">{shownProgress.toolCount}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-value">{fmtDuration(shownProgress.durationMs)}</span>
					</span>
				</div>
			) : null}
			<div className="ag-drawer-body">
				{shownAgent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={shownAgent.status === "running" && fetchError === null}
							host={host}
						/>
						{fetchError !== null ? (
							<div className="ag-fetch-error" role="alert">
								{t("transcript unavailable: {reason}", { reason: fetchError })}
							</div>
						) : null}
					</>
				) : (
					<div className="ag-empty">{t("no transcript available")}</div>
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
					placeholder={t("message {name}…", { name: shownAgent.displayName })}
					onChange={e => setDraft(e.target.value)}
				/>
				<button type="submit" className="ag-iconbtn" aria-label={t("send")} disabled={draft.trim().length === 0}>
					<SendHorizontal size={15} aria-hidden />
				</button>
			</form>
		</aside>
	);
}
