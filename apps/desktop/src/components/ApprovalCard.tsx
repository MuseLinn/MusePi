import { t } from "@musepi/client-core";
import { ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { haptic } from "../lib/haptic";
import { sfxFor } from "../lib/sfx";
import { BorderBeam } from "../vendor/border-beam";

/**
 * The approval prompt, split into what it actually carries.
 *
 * `formatApprovalPrompt` emits labelled lines in the daemon's interface
 * language, so the labels are read through `t()` rather than matched as English
 * text: a translated prompt would otherwise fall through to the raw block. The
 * tool name is the card's heading and never appears here; the rest is a reason,
 * an optional origin, and the tool's own detail lines (`Command:`, `File:`, …),
 * which stay verbatim because their label says what the value is.
 */
interface ApprovalDetail {
	/** Why the agent is asking, as a sentence. */
	reason?: string;
	/** Where the tool comes from, when it is not this host ("MCP server tool"). */
	origin?: string;
	/** The tool's own labelled detail lines, kept verbatim in a monospace well. */
	details?: string;
}

function splitPrompt(prompt: string | undefined): ApprovalDetail {
	if (!prompt) return {};
	const lines = prompt
		.split("\n")
		.slice(1)
		.filter(line => line.trim().length > 0);
	const reasonLabel = t("Reason");
	// The origin line is a whole localized sentence, not a `label: value` pair.
	const originLine = t("Origin: MCP server tool");
	let reason: string | undefined;
	let origin: string | undefined;
	const details: string[] = [];
	for (const line of lines) {
		if (line.startsWith(`${reasonLabel}: `)) {
			reason = line.slice(reasonLabel.length + 2);
			continue;
		}
		if (line === originLine) {
			origin = line;
			continue;
		}
		details.push(line);
	}
	return {
		...(reason ? { reason } : {}),
		...(origin ? { origin } : {}),
		...(details.length > 0 ? { details: details.join("\n") } : {}),
	};
}

/**
 * Inline approval card — an L2 float (docs/gui-design.md). It is an alert: the
 * only surface where one click widens what the agent may do, so it carries the
 * glass material, not a painted tint of its own.
 *
 * Reading order is the decision order: what is being asked (identity), why and
 * what it would run (evidence), then the actions. Anything decorative — a
 * second title, a repeated tool name — is dropped rather than stacked.
 */
export function ApprovalCard({
	requestId,
	tool,
	prompt,
	onDecide,
	onAllowForSession,
}: {
	requestId: string;
	tool: string;
	/** Full approval prompt body (Allow tool / Reason / command+args). */
	prompt?: string;
	onDecide(requestId: string, approved: boolean, note?: string): void;
	/** Approve now and stop asking about this tool for the rest of the session.
	 *  Omitted when the caller cannot scope an allowance to a session. */
	onAllowForSession?(requestId: string, tool: string, note?: string): void;
}): ReactNode {
	// Notify once per pending card (browser blocks audio before a gesture).
	// requestId is the per-card identity — the effect must re-run when the
	// card swaps even though the body doesn't read it.
	useEffect(() => {
		sfxFor("approval");
	}, [requestId]);
	// Note is per-card: a fresh approval starts with an empty field.
	const [note, setNote] = useState("");
	const { reason, origin, details } = splitPrompt(prompt);
	return (
		<div className="gui-approval-wrap">
			<BorderBeam size="pulse-inner" colorVariant="ocean" theme="auto" borderRadius={14}>
				<div className="gui-approval-card gui-liquid-glass" role="alert">
					<div className="gui-approval-head">
						<ShieldAlert size={14} className="gui-approval-icon" aria-hidden />
						<div className="gui-approval-id">
							<span className="gui-approval-title">{t("settings.approvalRequired")}</span>
							<span className="gui-approval-tool">{tool}</span>
							{origin && <span className="gui-approval-origin">{origin}</span>}
						</div>
					</div>
					{reason && <p className="gui-approval-reason">{reason}</p>}
					{details && <pre className="gui-approval-prompt">{details}</pre>}
					<textarea
						className="gui-approval-note"
						value={note}
						rows={1}
						placeholder={t("general.addNote")}
						onChange={e => setNote(e.target.value)}
						onKeyDown={e => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								sfxFor("approval-ok");
								haptic(1);
								onDecide(requestId, true, note);
							}
						}}
						spellCheck={false}
					/>
					<div className="gui-approval-actions">
						<button
							type="button"
							className="gui-btn gui-btn-approve"
							onClick={() => {
								sfxFor("approval-ok");
								haptic(1);
								onDecide(requestId, true, note);
							}}
						>
							{t("settings.approve")}
						</button>
						{onAllowForSession ? (
							// A quieter control than Approve: it is the same decision
							// extended in time, not a bigger one, and its scope is what
							// the title says — this session, this tool.
							<button
								type="button"
								className="gui-btn gui-btn-quiet"
								title={t("settings.approveForSessionHint")}
								onClick={() => {
									sfxFor("approval-ok");
									haptic(1);
									onAllowForSession(requestId, tool, note);
								}}
							>
								{t("settings.approveForSession")}
							</button>
						) : null}
						<button
							type="button"
							className="gui-btn gui-btn-stop"
							onClick={() => {
								sfxFor("approval-deny");
								haptic(2);
								onDecide(requestId, false, note);
							}}
						>
							{t("settings.deny")}
						</button>
					</div>
				</div>
			</BorderBeam>
		</div>
	);
}
