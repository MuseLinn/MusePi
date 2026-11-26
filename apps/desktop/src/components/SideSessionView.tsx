import { Transcript } from "@musepi/client-core/src/components/transcript/Transcript";
import { t } from "@musepi/client-core/src/i18n/index.js";
import type { DisplayContext, MessageDisplayContext } from "@musepi/client-core/src/messages/display-context";
import { useScrollShadow } from "@musepi/client-ui-primitives/client";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentSignalsFromSnapshot } from "../lib/agent-signals";
import { useAvatarPreference } from "../lib/avatar-preference";
import { thinkingOrbStateFromSession } from "../lib/companion";
import type { RpcClient } from "../lib/rpc";
import { subscribeSideSessionEvents } from "../lib/side-session-stores";
import { useSideSessionStore } from "../lib/use-side-session-store";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { type AskAnswer, AskCard, type AskRequest } from "./AskCard";
import { Composer } from "./Composer";
import { ScrollEdgeBlur } from "./ScrollEdgeBlur";
import { type SecretAnswer, SecretCard, type SecretRequest } from "./SecretCard";

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
	const [secretRequests, setSecretRequests] = useState<readonly SecretRequest[]>([]);
	// Requests this view already answered. The daemon's `secret-request-end`
	// broadcast comes back to the answering connection too; a local id keeps
	// its resolved line until SecretCard's linger calls onSettled, while a
	// foreign end (other device answered, or timeout) drops the card at once.
	const answeredSecretRequestsRef = useRef<Set<string>>(new Set());
	const [quotes, setQuotes] = useState<DisplayContext[]>([]);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(bodyRef);
	// Same avatar contract as the main chat: one orb per turn, state from the
	// side store (Sessions and Subagents read one transcript shape).
	const showAvatars = useAvatarPreference();
	const orb = thinkingOrbStateFromSession(snap);
	const agentSignals = agentSignalsFromSnapshot(snap, { now: Date.now() });

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

	// Secret requests arrive on the same session-scoped stream, one card per
	// requestId. The card answers through secret.answer; the value never
	// leaves its own state.
	useEffect(() => {
		setSecretRequests([]);
		answeredSecretRequestsRef.current.clear();
	}, [sessionId]);
	useEffect(() => {
		if (!rpc) return;
		return rpc.addEventListener(event => {
			if (event.sessionId !== sessionId) return;
			if (event.kind === "secret-request") {
				const payload = event.payload as Partial<SecretRequest> | undefined;
				if (
					!payload ||
					typeof payload.requestId !== "string" ||
					typeof payload.name !== "string" ||
					typeof payload.purpose !== "string" ||
					(payload.kind !== "fill" && payload.kind !== "allow")
				) {
					return;
				}
				const next: SecretRequest = {
					requestId: payload.requestId,
					name: payload.name,
					purpose: payload.purpose,
					kind: payload.kind,
				};
				setSecretRequests(current =>
					current.some(item => item.requestId === next.requestId) ? current : [...current, next],
				);
				return;
			}
			// Another device answered, or the request timed out as cancel.
			if (event.kind === "secret-request-end") {
				const requestId = (event.payload as { requestId?: unknown } | undefined)?.requestId;
				// This view's own answer comes back as an end too — leave it
				// to the card's linger instead of flashing the line away.
				if (typeof requestId === "string" && !answeredSecretRequestsRef.current.has(requestId)) {
					setSecretRequests(current => current.filter(item => item.requestId !== requestId));
				}
			}
		});
	}, [rpc, sessionId]);

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

	const answerSecret = (value: SecretAnswer): Promise<void> => {
		if (!rpc) return Promise.reject(new Error(t("general.sideSessionError")));
		// Mark before the send: the end broadcast can arrive before the RPC
		// result resolves. Failure rolls the mark back.
		answeredSecretRequestsRef.current.add(value.requestId);
		return rpc
			.request("secret.answer", {
				requestId: value.requestId,
				action: value.action,
				...(value.value !== undefined ? { value: value.value } : {}),
				...(value.scope !== undefined ? { scope: value.scope } : {}),
			})
			.then(() => undefined)
			.catch((err: unknown) => {
				answeredSecretRequestsRef.current.delete(value.requestId);
				throw err;
			});
	};

	const send = (
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		_deliverAs?: "prompt" | "steer" | "followUp" | "continue",
		displayContext?: MessageDisplayContext,
		videos?: { type: "video"; mimeType: string; url?: string; data?: string }[],
		correlation?: { clientId: string; clientRequestId: string },
	): void => {
		if (!text.trim() || !rpc) return;
		// The side session does not fly, but its row is keyed by the same
		// identity, so the ack must not remount that row either.
		const clientRequestId = correlation?.clientRequestId ?? crypto.randomUUID();
		const resolvedClientId = correlation?.clientId ?? clientId();
		store.optimisticEcho(text, images, displayContext, null, `msg:${resolvedClientId}:${clientRequestId}`);
		void rpc
			.request("session.send", {
				sessionId,
				text,
				clientId: resolvedClientId,
				clientRequestId,
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
						agentGutter={
							showAvatars ? <AgentAvatar state={orb} size={32} signals={agentSignals} seed={sessionId} /> : ""
						}
					/>
				</div>
				<ScrollEdgeBlur edge="top" />
				<ScrollEdgeBlur edge="end" />
			</div>

			{snap.approvals.length > 0 || asks.length > 0 || secretRequests.length > 0 ? (
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
					{secretRequests.map(request => (
						<SecretCard
							key={request.requestId}
							request={request}
							onAnswer={answerSecret}
							onSettled={requestId => {
								answeredSecretRequestsRef.current.delete(requestId);
								setSecretRequests(current => current.filter(item => item.requestId !== requestId));
							}}
						/>
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
