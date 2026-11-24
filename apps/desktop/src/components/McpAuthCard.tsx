import { t } from "@musepi/client-core";
import { Check, ExternalLink, Lock, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/** One parked MCP authorization, as the daemon pushes it on the session stream. */
export interface McpAuthRequest {
	requestId: string;
	serverName: string;
	flowId: string;
	authorizationUrl: string;
}

export type McpAuthCardState = "pending" | "success" | "error" | "cancelled";

/**
 * Inline card for a tool call parked on an MCP server's browser grant.
 *
 * Placement is the session container's decision (the pending-interaction slot
 * above the composer, shared with approval/ask/secret), so this component owns
 * only content and state. The `opened` flag is local: it describes the browser
 * this card triggered, not the server, and resets when a new request replaces
 * the old one.
 */
export function McpAuthCard({
	request,
	state = "pending",
	error,
	onAuthorize,
	onCancel,
	onDismiss,
}: {
	request: McpAuthRequest;
	state?: McpAuthCardState;
	error?: string;
	onAuthorize(request: McpAuthRequest): void;
	onCancel(request: McpAuthRequest): void;
	onDismiss(request: McpAuthRequest): void;
}): ReactNode {
	const [opened, setOpened] = useState(false);
	useEffect(() => setOpened(false), [request.requestId]);

	const title = (
		<span className="gui-mcp-auth-title">
			<span className="gui-mcp-auth-server">{request.serverName}</span>
			<span className="gui-mcp-auth-kind">{t("mcpAuth.serverLabel")}</span>
		</span>
	);

	if (state === "success") {
		return (
			<div className="gui-mcp-auth gui-mcp-auth--ok" role="status">
				<div className="gui-mcp-auth-head">
					<Check size={14} className="gui-mcp-auth-icon" />
					<div className="gui-mcp-auth-body">
						{title}
						<span className="gui-mcp-auth-desc">{t("mcpAuth.success")}</span>
					</div>
				</div>
			</div>
		);
	}

	if (state === "error" || state === "cancelled") {
		const reason = error?.trim() || t("mcpAuth.cancelled");
		return (
			<div className="gui-mcp-auth gui-mcp-auth--failed" role="alert">
				<div className="gui-mcp-auth-head">
					<TriangleAlert size={14} className="gui-mcp-auth-icon" />
					<div className="gui-mcp-auth-body">
						{title}
						<span className="gui-mcp-auth-desc">{t("mcpAuth.failed", { error: reason })}</span>
					</div>
				</div>
				<div className="gui-mcp-auth-actions">
					<span className="gui-mcp-auth-grow" />
					<button type="button" className="gui-btn" onClick={() => onDismiss(request)}>
						{t("mcpAuth.dismiss")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="gui-mcp-auth" role="alert">
			<div className="gui-mcp-auth-head">
				<Lock size={14} className="gui-mcp-auth-icon" />
				<div className="gui-mcp-auth-body">
					{title}
					<span className="gui-mcp-auth-desc">
						{opened ? t("mcpAuth.waitingDesc") : t("mcpAuth.requiresAuth")}
					</span>
					{opened ? null : <span className="gui-mcp-auth-hint">{t("mcpAuth.autoRetry")}</span>}
				</div>
			</div>
			<div className="gui-mcp-auth-actions">
				{opened && (
					<span className="gui-mcp-auth-status">
						<span className="gui-mcp-auth-dot" aria-hidden="true" />
						{t("mcpAuth.waiting")}
					</span>
				)}
				<span className="gui-mcp-auth-grow" />
				<button
					type="button"
					className="gui-btn gui-btn-primary"
					onClick={() => {
						setOpened(true);
						onAuthorize(request);
					}}
				>
					{opened ? t("mcpAuth.reopen") : t("mcpAuth.authorize")}
					<ExternalLink size={12} />
				</button>
				<button type="button" className="gui-btn" onClick={() => onCancel(request)}>
					{t("mcpAuth.cancel")}
				</button>
			</div>
		</div>
	);
}
