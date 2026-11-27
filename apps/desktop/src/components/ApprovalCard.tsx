import { t } from "@musepi/client-core";
import { ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { haptic } from "../lib/haptic";
import { sfxFor } from "../lib/sfx";
import { BorderBeam } from "../vendor/border-beam";

/**
 * One line of the approval prompt, split by its own label.
 *
 * The daemon renders the prompt as labelled lines (`Allow tool: …`,
 * `Reason: …`, the command block). The tool name is shown as the card's
 * identity, so the rest is parsed into a reason line and a body — a single
 * `<pre>` of the whole thing read as one undifferentiated wall.
 */
interface ApprovalDetail {
	reason?: string;
	/** The command or payload about to run — the evidence to judge. */
	body?: string;
	/** Bounds the request declares about itself ("no network, no destructive
	 *  flags"). Kept apart from the command: it is the claim, the command is the
	 *  act, and mixing them made the safety line read as part of the script. */
	safety?: string;
}

const LABELLED = /^(Reason|Safety|Command|Args|Note):\s*(.*)$/;

function splitPrompt(prompt: string | undefined): ApprovalDetail {
	if (!prompt) return {};
	const lines = prompt
		.split("\n")
		.slice(1)
		.filter(line => line.trim().length > 0);
	const reason: string[] = [];
	const safety: string[] = [];
	const body: string[] = [];
	for (const line of lines) {
		const labelled = LABELLED.exec(line);
		// Reason and Safety read as sentences around the command; everything else
		// (the command, its output, an indented block) keeps its line breaks.
		if (labelled && labelled[1] === "Reason") reason.push(labelled[2] ?? "");
		else if (labelled && labelled[1] === "Safety") safety.push(labelled[2] ?? "");
		else body.push(line);
	}
	return {
		...(reason.length > 0 ? { reason: reason.join(" ") } : {}),
		...(safety.length > 0 ? { safety: safety.join(" ") } : {}),
		...(body.length > 0 ? { body: body.join("\n") } : {}),
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
	const { reason, body, safety } = splitPrompt(prompt);
	return (
		<div className="gui-approval-wrap">
			<BorderBeam size="pulse-inner" colorVariant="ocean" theme="auto" borderRadius={14}>
				<div className="gui-approval-card gui-liquid-glass" role="alert">
					<div className="gui-approval-head">
						<ShieldAlert size={14} className="gui-approval-icon" aria-hidden />
						<div className="gui-approval-id">
							<span className="gui-approval-title">{t("settings.approvalRequired")}</span>
							<span className="gui-approval-tool">{tool}</span>
						</div>
					</div>
					{reason && <p className="gui-approval-reason">{reason}</p>}
					{body && <pre className="gui-approval-prompt">{body}</pre>}
					{safety && <p className="gui-approval-safety">{safety}</p>}
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
