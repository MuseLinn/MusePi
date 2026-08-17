import { Transcript, type TranscriptProps } from "@musepi/collab-web/src/components/transcript/Transcript";
import { t } from "@musepi/collab-web/src/i18n/index.js";
import { fmtCost, fmtDuration, fmtTokens } from "@musepi/collab-web/src/lib/format";
import { decideTranscriptPoll } from "@musepi/collab-web/src/lib/transcript-poll";
import type { AgentSnapshot, SessionEntry } from "@musepi/pi-wire";
import { OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;

/** RPC mirror of the collab client's TranscriptResult (not exported from
 *  transcript-poll.ts; the shape is the contract both sides share). */
type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

/**
 * Desktop subagent trajectory panel (kimiwork parity: click a swarm-card
 * member → this slides out on the right showing the subagent's own
 * transcript). RPC-backed — the daemon's agents.transcript incremental read
 * mirrors the collab host's fetch-transcript frame, and the same pure
 * polling decision (transcript-poll.ts) drives the cursor. kill/revive/chat
 * go through the existing agents.* RPCs (same semantics as AgentControls).
 */
export function SubagentPanel(props: {
	agent: AgentSnapshot;
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
	const { agent, rpc, progress: p, host, onClose } = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Live transcript: poll the daemon's agents.transcript RPC while the
	// panel is open, appending parsed JSONL entries. Same cursor semantics
	// as the collab drawer — a terminal `error` reply stops polling and
	// surfaces the message (retrying would loop hot).
	useEffect(() => {
		setEntries([]);
		setFetchError(null);
		if (!agent.hasSessionFile) return;
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
					agentId: agent.id,
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
	}, [agent.id, agent.hasSessionFile, rpc]);

	const sendChat = (): void => {
		const text = draft.trim();
		if (!text) return;
		void rpc.request("agents.chat", { agentId: agent.id, text }).catch(() => {});
		setDraft("");
	};

	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;

	return (
		<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
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
							onClick={() => void rpc.request("agents.kill", { agentId: agent.id }).catch(() => {})}
						>
							<OctagonX size={13} aria-hidden />
							{t("kill")}
						</button>
					) : null}
					{agent.status === "parked" || agent.status === "aborted" ? (
						<button
							type="button"
							className="ag-btn"
							onClick={() => void rpc.request("agents.revive", { agentId: agent.id }).catch(() => {})}
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
			{p ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">{t("tok")}</span>
						<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span className="ag-stat" title={t("context {count}", { count: fmtTokens(p.contextTokens ?? 0) })}>
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
						<span className="ag-stat-value">{fmtCost(p.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">{t("tools")}</span>
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
					placeholder={t("message {name}…", { name: agent.displayName })}
					onChange={e => setDraft(e.target.value)}
				/>
				<button type="submit" className="ag-iconbtn" aria-label={t("send")} disabled={draft.trim().length === 0}>
					<SendHorizontal size={15} aria-hidden />
				</button>
			</form>
		</aside>
	);
}
