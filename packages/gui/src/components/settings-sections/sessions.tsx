import {
	t,
} from "@musepi/desktop-web";
import type {
	ReactNode,
} from "react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	RpcClient,
} from "../../lib/rpc";
import {
	cleanupAction as cleanupActionPref,
	cleanupCandidates,
	cleanupDays as cleanupDaysPref,
	cleanupEnabled as cleanupEnabledPref,
	runCleanupOnce,
} from "../../lib/session-cleanup";
import {
	Icon,
} from "../../vendor/oc-icons";

/** Session behavior: auto titles, delete-confirmation toggle, and
 *  auto-cleanup of stale sessions (archive = session.close → daemon
 *  history snapshot; delete = session.delete). New-session model and
 *  thinking defaults live on the model-settings tab (default role) — the
 *  duplicates once kept here were removed. openchamber
 *  DefaultsSettings + SessionRetentionSettings parity. */
export function SessionsSection({
	rpc,
	currentSessionId,
}: {
	rpc: RpcClient | null;
	currentSessionId: string | null;
}): ReactNode {
	const [autoTitle, setAutoTitle] = useState<boolean>(() => localStorage.getItem("omp-gui-autotitle") !== "0");
	const [confirmDelete, setConfirmDelete] = useState<boolean>(
		() => localStorage.getItem("omp-gui-confirm-delete") !== "0",
	);
	// ── retention (openchamber SessionRetentionSettings parity) ──────────
	const MIN_DAYS = 1;
	const MAX_DAYS = 365;
	const [cleanupOn, setCleanupOn] = useState<boolean>(cleanupEnabledPref);
	const [cleanupDays, setCleanupDays] = useState<number>(cleanupDaysPref);
	const [cleanupAction, setCleanupAction] = useState<"archive" | "delete">(cleanupActionPref);
	const [candidates, setCandidates] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const lastRunRef = useRef(0);
	// Sessions already acted on this session (archive keeps them in the
	// daemon list as history snapshots — exclude them so the count clears
	// instead of re-offering them forever; openchamber marks them archived).
	const cleanedRef = useRef<Set<string>>(new Set());

	/** Stale sessions = older than the cutoff, excluding the current one and
	 *  the 5 most recently active (openchamber keepRecent parity). Shared
	 *  with the app-shell auto-cleanup (lib/session-cleanup). */
	const computeCandidates = useCallback(async (): Promise<string[]> => {
		if (!rpc) return [];
		const list = await cleanupCandidates(rpc, cleanupDays, currentSessionId);
		return list.map(c => c.id).filter(id => !cleanedRef.current.has(id));
	}, [rpc, cleanupDays, currentSessionId]);

	useEffect(() => {
		void computeCandidates().then(setCandidates);
	}, [computeCandidates]);

	const runCleanup = useCallback(
		async (force = false): Promise<void> => {
			if (running) return;
			if (!cleanupOn && !force) return;
			if (!force && Date.now() - lastRunRef.current < 86_400_000) return;
			setRunning(true);
			try {
				const ids = await computeCandidates();
				if (rpc && ids.length > 0) {
					await runCleanupOnce(rpc, ids, cleanupAction);
					for (const id of ids) cleanedRef.current.add(id);
				}
				lastRunRef.current = Date.now();
				setCandidates(await computeCandidates());
			} finally {
				setRunning(false);
			}
		},
		[running, cleanupOn, rpc, cleanupAction, computeCandidates],
	);

	// Auto mode: hourly check, at most one run per 24h (cooldown parity).
	useEffect(() => {
		if (!cleanupOn) return;
		const id = setInterval(() => void runCleanup(), 3_600_000);
		return () => clearInterval(id);
	}, [cleanupOn, runCleanup]);

	const setDays = (next: number): void => {
		const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, next));
		setCleanupDays(clamped);
		localStorage.setItem("omp-gui-autoclean-days", String(clamped));
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("sessions")}</h2>
			<p className="gui-settings-page-desc">{t("sessions settings")}</p>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("session defaults")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("auto title")}</div>
						<div className="gui-settings-row-desc">{t("auto title description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoTitle}
						className={`gui-toggle${autoTitle ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !autoTitle;
							setAutoTitle(next);
							localStorage.setItem("omp-gui-autotitle", next ? "1" : "0");
						}}
						aria-label={t("auto title")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("show delete dialog")}</div>
						<div className="gui-settings-row-desc">{t("show delete dialog description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={confirmDelete}
						className={`gui-toggle${confirmDelete ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !confirmDelete;
							setConfirmDelete(next);
							localStorage.setItem("omp-gui-confirm-delete", next ? "1" : "0");
						}}
						aria-label={t("show delete dialog")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("session retention")}</div>
				<div className="gui-settings-section-desc">{t("session retention description")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("enable auto cleanup")}</div>
						<div className="gui-settings-row-desc">{t("enable auto cleanup description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={cleanupOn}
						className={`gui-toggle${cleanupOn ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !cleanupOn;
							setCleanupOn(next);
							localStorage.setItem("omp-gui-autoclean", next ? "1" : "0");
						}}
						aria-label={t("enable auto cleanup")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("retention days")}</div>
						<div className="gui-settings-row-desc">{t("retention days description")}</div>
					</div>
					<div className="gui-settings-control">
						<div className="gui-settings-stepper" aria-disabled={!cleanupOn}>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("decrease")}
								onClick={() => setDays(cleanupDays - 1)}
							>
								<Icon name="subtract" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-stepper-value">{cleanupDays}</span>
							<button
								type="button"
								className="gui-stepper-btn"
								disabled={!cleanupOn}
								aria-label={t("increase")}
								onClick={() => setDays(cleanupDays + 1)}
							>
								<Icon name="add" className="h-3.5 w-3.5" />
							</button>
							<span className="gui-settings-stepper-unit">{t("days")}</span>
						</div>
					</div>
				</div>
				<div className={`gui-settings-row${cleanupOn ? "" : " gui-settings-row--disabled"}`}>
					<div>
						<div className="gui-settings-row-label">{t("session expiry action")}</div>
						<div className="gui-settings-row-desc">{t("session expiry action description")}</div>
					</div>
					<div className="gui-segmented">
						<button
							type="button"
							className={`gui-seg-btn${cleanupAction === "archive" ? " gui-seg-btn--active" : ""}`}
							onClick={() => {
								setCleanupAction("archive");
								localStorage.setItem("omp-gui-autoclean-action", "archive");
							}}
						>
							{t("archive")}
						</button>
						<button
							type="button"
							className={`gui-seg-btn${cleanupAction === "delete" ? " gui-seg-btn--active" : ""}`}
							onClick={() => {
								setCleanupAction("delete");
								localStorage.setItem("omp-gui-autoclean-action", "delete");
							}}
						>
							{t("delete")}
						</button>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("manual cleanup")}</div>
						<div className="gui-settings-row-desc">
							{running ? t("cleanup running") : t("archivable count", { count: String(candidates.length) })}
						</div>
					</div>
					<button
						type="button"
						className="gui-btn"
						disabled={running || candidates.length === 0}
						onClick={() => void runCleanup(true)}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						{t("run cleanup now")}
					</button>
				</div>
			</div>
		</>
	);
}
