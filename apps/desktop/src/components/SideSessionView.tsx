import { Transcript } from "@musepi/client-core/src/components/transcript/Transcript";
import { t } from "@musepi/client-core/src/i18n/index.js";
import { useScrollShadow } from "@musepi/client-core/src/lib/scroll-shadow";
import type { DisplayContext, MessageDisplayContext } from "@musepi/client-core/src/messages/display-context";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RpcClient } from "../lib/rpc";
import { subscribeSideSessionEvents } from "../lib/side-session-stores";
import { useSideSessionStore } from "../lib/use-side-session-store";
import { Icon } from "../vendor/oc-icons";
import { ApprovalCard } from "./ApprovalCard";
import { type AskAnswer, AskCard, type AskRequest } from "./AskCard";
import { Composer } from "./Composer";
import { ScrollEdgeBlur } from "./ScrollEdgeBlur";

function clientId(): string {
	let id = localStorage.getItem("musepi-gui-client-id");
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem("musepi-gui-client-id", id);
	}
	return id;
}

/**
 * A normal session rendered beside the active chat.
 *
 * The tab is an address (session id), not a copy of the main chat: the view
 * creates its own store, the app's event pump routes that session's
 * envelopes to it, and the composer/approval/ask actions call the same
 * daemon RPCs the main chat uses. A side session therefore remains fully
 * steerable instead of becoming a read-only transcript.
 */
export function SideSessionView({
	sessionId,
	label,
	readOnly = false,
	rpc,
	activeSessionId,
	onOpenSession,
}: {
	sessionId: string | null;
	label: string;
	/** Advisor transcripts are documentation, not a conversation: the main
	 *  chat replaces its composer with the same read-only note. */
	readOnly?: boolean;
	rpc: RpcClient | null;
	activeSessionId: string | null;
	onOpenSession?(id: string): void;
}): ReactNode {
	const { store, loading, error, retry } = useSideSessionStore(sessionId, rpc, activeSessionId);

	if (!sessionId) {
		return <div className="gui-side-session-empty">{t("general.sideSessionMissing")}</div>;
	}
	if (sessionId === activeSessionId) {
		return (
			<div className="gui-side-session-empty">
				<span>{t("general.sideSessionActive")}</span>
				{onOpenSession ? (
					<button type="button" className="gui-btn" onClick={() => onOpenSession(sessionId)}>
						{t("general.openInMain")}
					</button>
				) : null}
			</div>
		);
	}
	if (loading) {
		return <div className="gui-side-session-empty">{t("general.sideSessionLoading")}</div>;
	}
	if (error || !store) {
		return (
			<div className="gui-side-session-empty">
				<span>{t("general.sideSessionError")}</span>
				{error ? <span className="gui-side-session-error">{error}</span> : null}
				<button type="button" className="gui-btn" onClick={retry}>
					{t("general.retry")}
				</button>
			</div>
		);
	}
	return (
		<SideSessionBody
			store={store}
			sessionId={sessionId}
			label={label}
			readOnly={readOnly}
			rpc={rpc}
			onOpenSession={onOpenSession}
		/>
	);
}

function SideSessionBody({
	store,
	sessionId,
	label,
	readOnly,
	rpc,
	onOpenSession,
}: {
	store: NonNullable<ReturnType<typeof useSideSessionStore>["store"]>;
	sessionId: string;
	label: string;
	readOnly: boolean;
	rpc: RpcClient | null;
	onOpenSession?(id: string): void;
}): ReactNode {
	const subscribe = useMemo(() => (listener: () => void) => store.subscribe(listener), [store]);
	const getSnapshot = useMemo(() => () => store.getSnapshot(), [store]);
	const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const [asks, setAsks] = useState<readonly AskRequest[]>([]);
	const [quotes, setQuotes] = useState<DisplayContext[]>([]);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(bodyRef);

	useEffect(
		() =>
			subscribeSideSessionEvents(sessionId, event => {
				if (event.kind === "ask-request") {
					const ask = event.payload as AskRequest;
					setAsks(previous =>
						previous.some(item => item.requestId === ask.requestId) ? previous : [...previous, ask],
					);
					return;
				}
				if (event.kind === "ask-request-end") {
					const requestId = (event.payload as { requestId?: unknown } | undefined)?.requestId;
					if (typeof requestId === "string") {
						setAsks(previous => previous.filter(item => item.requestId !== requestId));
					}
				}
			}),
		[sessionId],
	);

	const decide = (requestId: string, approved: boolean, note?: string): void => {
		if (!rpc) return;
		const trimmed = note?.trim();
		void rpc
			.request(approved ? "tool.approve" : "tool.deny", {
				sessionId,
				requestId,
				...(trimmed ? { note: trimmed } : {}),
			})
			.then(() => store.dismissApproval(requestId))
			.catch(() => {});
	};

	const answer = (ask: AskRequest, value: AskAnswer): void => {
		if (!rpc) return;
		setAsks(previous => previous.filter(item => item.requestId !== ask.requestId));
		void rpc
			.request("session.askAnswer", {
				sessionId,
				requestId: ask.requestId,
				answer: value,
			})
			.catch(() => {});
	};

	const send = (
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		_deliverAs?: "prompt" | "steer" | "followUp" | "continue",
		displayContext?: MessageDisplayContext,
		videos?: { type: "video"; mimeType: string; url?: string; data?: string }[],
	): void => {
		if (!text.trim() || !rpc) return;
		store.optimisticEcho(text, images, displayContext);
		void rpc
			.request("session.send", {
				sessionId,
				text,
				clientId: clientId(),
				clientRequestId: crypto.randomUUID(),
				...(displayContext ? { displayContext } : {}),
				...(images && images.length > 0 ? { images } : {}),
				...(videos && videos.length > 0 ? { videos } : {}),
			})
			.catch(() => store.discardOptimisticEcho(text, images));
	};

	const stop = (): void => {
		if (!rpc) return;
		void rpc.request("session.abort", { sessionId }).catch(() => {});
	};

	return (
		<div className="gui-side-session">
			<header className="gui-side-session-head">
				<span className="gui-side-session-title" title={label}>
					{label}
				</span>
				<span className={`gui-side-session-status${snap.working ? " gui-side-session-status--working" : ""}`}>
					{snap.working ? t("settings.inProgress") : t("general.sideSessionIdle")}
				</span>
				{snap.approvals.length > 0 ? <span className="gui-side-session-count">{snap.approvals.length}</span> : null}
				{onOpenSession ? (
					<button
						type="button"
						className="gui-btn gui-btn--icon"
						title={t("general.openInMain")}
						aria-label={t("general.openInMain")}
						onClick={() => onOpenSession(sessionId)}
					>
						↗
					</button>
				) : null}
			</header>

			<div className="gui-scroll-frame gui-side-session-frame">
				<div ref={bodyRef} className="gui-side-session-body">
					<Transcript
						compact
						entries={snap.entries}
						stream={null}
						streamDone={false}
						activeTools={snap.activeTools}
						working={snap.working}
					/>
				</div>
				<ScrollEdgeBlur edge="top" />
				<ScrollEdgeBlur edge="end" />
			</div>

			{snap.approvals.length > 0 || asks.length > 0 ? (
				<div className="gui-side-session-approvals">
					{snap.approvals.map(approval => (
						<ApprovalCard
							key={approval.requestId}
							requestId={approval.requestId}
							tool={approval.tool}
							prompt={approval.prompt}
							onDecide={decide}
						/>
					))}
					{asks.map(ask => (
						<AskCard key={ask.requestId} ask={ask} onAnswer={value => answer(ask, value)} />
					))}
				</div>
			) : null}

			{readOnly ? (
				<div className="gui-readonly-bar" role="note">
					<Icon name="sparkling" className="h-3.5 w-3.5" />
					<span>{t("general.advisorTranscriptReadonly")}</span>
				</div>
			) : rpc ? (
				<Composer
					working={snap.working}
					onSend={send}
					onStop={stop}
					rpc={rpc}
					sessionId={sessionId}
					cwd={store.cwd}
					entries={snap.entries}
					thinkingLevel={snap.state?.thinkingLevel ?? null}
					quotes={quotes}
					onQuotesChange={setQuotes}
				/>
			) : null}
		</div>
	);
}
