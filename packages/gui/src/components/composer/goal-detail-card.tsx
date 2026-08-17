import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/** Full goal record from session.goal show (TUI /goal show parity). */
export interface GoalDetail {
	enabled: boolean;
	objective: string;
	status: string;
	tokensUsed?: number;
	tokenBudget?: number;
	timeUsedSeconds?: number;
	createdAt?: number;
	updatedAt?: number;
}

function statusLabel(status: string): string {
	switch (status) {
		case "active":
			return t("goal status active");
		case "paused":
			return t("goal status paused");
		case "complete":
			return t("goal status complete");
		case "budget-limited":
			return t("goal status budget limited");
		case "dropped":
			return t("goal status dropped");
		default:
			return status;
	}
}

/**
 * Floating goal card (TUI /goal menu + show parity): opens from the goal
 * chip and shows the full objective, usage/budget, and the lifecycle
 * actions (pause/resume/drop + inline budget edit) that the terminal
 * reaches via /goal subcommands. Self-fetches session.goal show and
 * re-polls after every action.
 */
export function GoalDetailCard({
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
	const [detail, setDetail] = useState<GoalDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [budgetEditing, setBudgetEditing] = useState(false);
	const [budgetValue, setBudgetValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const budgetRef = useRef<HTMLInputElement | null>(null);

	const fetchDetail = (): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<GoalDetail>("session.goal", { sessionId, op: "show" })
			.then(d => {
				setDetail(d);
				setBudgetValue(d?.tokenBudget != null ? String(d.tokenBudget) : "");
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	};
	useEffect(fetchDetail, [rpc, sessionId]);

	const act = (op: "pause" | "resume" | "drop"): void => {
		if (!rpc) return;
		setError(null);
		void rpc
			.request("session.goal", { sessionId, op })
			.then(() => {
				fetchDetail();
				onChanged();
			})
			.catch(e => setError(e?.message ?? String(e)));
	};

	const saveBudget = (): void => {
		if (!rpc) return;
		setError(null);
		const value = budgetValue.trim();
		if (value !== "off" && !/^[1-9]\d*$/.test(value)) {
			setError(t("goal budget invalid"));
			return;
		}
		void rpc
			.request("session.goal", { sessionId, op: "budget", budget: value })
			.then(() => {
				setBudgetEditing(false);
				fetchDetail();
				onChanged();
			})
			.catch(e => setError(e?.message ?? String(e)));
	};

	const status = detail?.status ?? "";
	const isActive = status === "active";
	const isPaused = status === "paused";

	return (
		<div className="gui-goal-panel" role="dialog" aria-label={t("goal mode")}>
			<button type="button" className="gui-quota-close" onClick={onClose} aria-label={t("close")}>
				<Icon name="close" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-quota-title">
				<Icon name="target" className="h-3.5 w-3.5" />
				{t("goal mode")}
				{detail && (
					<span className={`gui-goal-status gui-goal-status--${status}`}>{statusLabel(status)}</span>
				)}
			</div>
			{loading ? (
				<div className="gui-quota-note">…</div>
			) : detail ? (
				<div className="gui-goal-body">
					<div className="gui-goal-objective">{detail.objective}</div>
					{(detail.tokensUsed != null || detail.tokenBudget != null) && (
						<div className="gui-goal-meta">
							{t("goal tokens used")}: {detail.tokensUsed ?? 0}
							{detail.tokenBudget != null ? ` / ${detail.tokenBudget}` : ""}
						</div>
					)}
					{error && <div className="gui-goal-error">{error}</div>}
					<div className="gui-goal-actions">
						{isActive && (
							<button type="button" className="gui-goal-btn" onClick={() => act("pause")}>
								<Icon name="pause" className="h-3.5 w-3.5" />
								{t("goal pause")}
							</button>
						)}
						{isPaused && (
							<button type="button" className="gui-goal-btn gui-goal-btn--primary" onClick={() => act("resume")}>
								<Icon name="play" className="h-3.5 w-3.5" />
								{t("goal resume")}
							</button>
						)}
						{(isActive || isPaused) && (
							<button
								type="button"
								className="gui-goal-btn"
								onClick={() => {
									setBudgetEditing(v => !v);
									window.setTimeout(() => budgetRef.current?.focus(), 0);
								}}
							>
								<Icon name="timer" className="h-3.5 w-3.5" />
								{t("goal adjust budget")}
							</button>
						)}
						{(isActive || isPaused) && (
							<button type="button" className="gui-goal-btn gui-goal-btn--danger" onClick={() => act("drop")}>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
								{t("goal drop")}
							</button>
						)}
					</div>
					{budgetEditing && (
						<div className="gui-goal-budget">
							<input
								ref={budgetRef}
								value={budgetValue}
								placeholder={t("goal budget placeholder")}
								onChange={e => setBudgetValue(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter") saveBudget();
									if (e.key === "Escape") setBudgetEditing(false);
								}}
							/>
							<button type="button" className="gui-goal-btn gui-goal-btn--primary" onClick={saveBudget}>
								{t("goal budget save")}
							</button>
						</div>
					)}
				</div>
			) : (
				<div className="gui-quota-note">{t("no goal")}</div>
			)}
		</div>
	);
}
