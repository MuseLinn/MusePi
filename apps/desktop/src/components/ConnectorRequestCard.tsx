import { t } from "@musepi/client-core";
import { Check, Link2, Plug } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** One parked connector request, as the daemon pushes it on the session stream. */
export interface ConnectorRequest {
	requestId: string;
	/** Catalog id, exactly as the catalog reports it. */
	id: string;
	name: string;
	/** Why the agent wants it, in its own words. */
	purpose: string;
	authMode: "oauth" | "none" | "token";
}

export type ConnectorRequestDecision = "connect" | "decline";

/** How long a settled line stays before the host clears it. */
const SETTLED_LINGER_MS = 1600;

/**
 * Inline card for `connector_catalog` action `request`.
 *
 * The card carries the agent's reason and one decision. It never shows a URL or
 * a credential: an OAuth connector opens its own sign-in dialog in Settings, and
 * a token connector needs a form this card cannot provide — the answer says so
 * and the agent tells the user where to go.
 *
 * Placement is the session container's decision (the pending-interaction slot
 * above the composer, shared with approval/ask/secret), so this component owns
 * only content and state.
 */
export function ConnectorRequestCard({
	request,
	onAnswer,
	onSettled,
}: {
	request: ConnectorRequest;
	/** Resolves after the daemon accepts the answer; rejects with an Error
	 *  whose message is shown verbatim. */
	onAnswer(decision: ConnectorRequestDecision): Promise<void>;
	/** Called once the outcome line has been shown — the host clears it. */
	onSettled?(requestId: string): void;
}): ReactNode {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [settled, setSettled] = useState<ConnectorRequestDecision | null>(null);
	// onSettled identity changes every parent render; bind once via ref so the
	// linger timer never fires a stale callback.
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	useEffect(() => {
		setBusy(false);
		setError("");
		setSettled(null);
	}, [request.requestId]);

	useEffect(() => {
		if (!settled) return;
		const timer = window.setTimeout(() => onSettledRef.current?.(request.requestId), SETTLED_LINGER_MS);
		return () => window.clearTimeout(timer);
	}, [settled, request.requestId]);

	const submit = async (decision: ConnectorRequestDecision): Promise<void> => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		try {
			await onAnswer(decision);
			setSettled(decision);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			busyRef.current = false;
			setBusy(false);
		}
	};

	if (settled) {
		return (
			<div className="gui-mcp-auth gui-mcp-auth--ok" role="status">
				<div className="gui-mcp-auth-head">
					<Check size={14} className="gui-mcp-auth-icon" />
					<div className="gui-mcp-auth-body">
						<span className="gui-mcp-auth-title">
							<span className="gui-mcp-auth-server">{request.name}</span>
						</span>
						<span className="gui-mcp-auth-desc">
							{settled === "connect" ? t("connectorRequest.connected") : t("connectorRequest.declined")}
						</span>
					</div>
				</div>
			</div>
		);
	}

	// An OAuth connector finishes in Settings, where the flow owns its callback
	// and its own dialog. The card says so before the click instead of opening a
	// page that cannot complete from here.
	const needsSettings = request.authMode !== "none";

	return (
		<div className="gui-mcp-auth" role="dialog" aria-label={t("connectorRequest.title")}>
			<div className="gui-mcp-auth-head">
				<Plug size={14} className="gui-mcp-auth-icon" />
				<div className="gui-mcp-auth-body">
					<span className="gui-mcp-auth-title">
						<span className="gui-mcp-auth-server">{request.name}</span>
						<span className="gui-mcp-auth-kind">{t("connectorRequest.title")}</span>
					</span>
					<span className="gui-mcp-auth-desc">{request.purpose}</span>
					{needsSettings && <span className="gui-mcp-auth-desc">{t("connectorRequest.needsSettings")}</span>}
				</div>
			</div>
			{error && <div className="gui-mcp-auth-error">{error}</div>}
			<div className="gui-mcp-auth-actions">
				<button
					type="button"
					className="gui-btn gui-btn-primary"
					disabled={busy}
					onClick={() => void submit("connect")}
				>
					<Link2 size={13} aria-hidden="true" />
					{t("connectorRequest.connect")}
				</button>
				<button type="button" className="gui-btn" disabled={busy} onClick={() => void submit("decline")}>
					{t("connectorRequest.decline")}
				</button>
			</div>
		</div>
	);
}
