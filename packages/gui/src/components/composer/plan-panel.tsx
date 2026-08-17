import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/** Plan file record from session.plan show (TUI plan-approval parity). */
export interface PlanShowResult {
	enabled: boolean;
	planFilePath: string | null;
	content: string | null;
	title: string | null;
}

/**
 * Plan review panel (TUI plan-approval overlay parity, AskCard desktop
 * styling): opens from the plan chip and shows the plan file + title with
 * the approval actions — Approve and execute, Refine (feedback fed back
 * into the planning conversation), or exit plan mode. The terminal's
 * in-overlay section edits/annotations are chat-side in the GUI: the plan
 * file is read-only here, and refinement is a text prompt.
 */
export function PlanPanel({
	rpc,
	sessionId,
	onClose,
	onChanged,
}: {
	rpc: RpcClient | null;
	sessionId: string;
	onClose(): void;
	/** Called after any mutation so the composer's mode chips refresh. */
	onChanged(): void;
}): ReactNode {
	const [plan, setPlan] = useState<PlanShowResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [refineText, setRefineText] = useState("");
	const [busy, setBusy] = useState<"refine" | "approve" | "exit" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refineRef = useRef<HTMLTextAreaElement | null>(null);

	const fetchPlan = (): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<PlanShowResult>("session.plan", { sessionId, op: "show" })
			.then(setPlan)
			.catch(() => {})
			.finally(() => setLoading(false));
	};
	useEffect(fetchPlan, [rpc, sessionId]);

	const run = (op: "refine" | "approve" | "exit", params: Record<string, unknown> = {}): void => {
		if (!rpc || busy) return;
		setBusy(op);
		setError(null);
		void rpc
			.request("session.plan", { sessionId, op, ...params })
			.then(() => {
				if (op === "approve" || op === "exit") {
					onChanged();
					onClose();
					return;
				}
				setRefineText("");
				fetchPlan();
				onChanged();
			})
			.catch(e => setError(e?.message ?? String(e)))
			.finally(() => setBusy(null));
	};

	return (
		<div className="gui-plan-panel" role="dialog" aria-label={t("plan mode")}>
			<button type="button" className="gui-quota-close" onClick={onClose} aria-label={t("close")}>
				<Icon name="close" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-quota-title">
				<Icon name="compass-3" className="h-3.5 w-3.5" />
				{t("plan mode")}
				{plan?.title ? <span className="gui-plan-title">{plan.title}</span> : null}
			</div>
			{loading ? (
				<div className="gui-quota-note">…</div>
			) : plan?.content ? (
				<div className="gui-plan-body">
					{plan.planFilePath && <div className="gui-plan-path">{plan.planFilePath}</div>}
					<pre className="gui-plan-content">{plan.content}</pre>
					{error && <div className="gui-goal-error">{error}</div>}
					<div className="gui-plan-refine">
						<textarea
							ref={refineRef}
							value={refineText}
							placeholder={t("plan refine placeholder")}
							rows={2}
							onChange={e => setRefineText(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run("refine", { feedback: refineText });
							}}
						/>
						<button
							type="button"
							className="gui-goal-btn"
							disabled={busy !== null || !refineText.trim()}
							onClick={() => run("refine", { feedback: refineText })}
						>
							<Icon name="refresh" className="h-3.5 w-3.5" />
							{t("plan refine")}
						</button>
					</div>
					<div className="gui-goal-actions">
						<button
							type="button"
							className="gui-goal-btn gui-goal-btn--primary"
							disabled={busy !== null}
							onClick={() => run("approve")}
						>
							<Icon name="check" className="h-3.5 w-3.5" />
							{t("plan approve execute")}
						</button>
						<button
							type="button"
							className="gui-goal-btn"
							disabled={busy !== null}
							onClick={() => run("exit")}
						>
							<Icon name="close" className="h-3.5 w-3.5" />
							{t("plan exit")}
						</button>
					</div>
				</div>
			) : (
				<div className="gui-quota-note">
					{plan?.enabled ? t("plan not written yet") : t("plan mode off")}
				</div>
			)}
		</div>
	);
}
