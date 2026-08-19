import {
	t,
} from "@musepi/desktop-web";
import type {
	ReactNode,
} from "react";
import {
	useCallback,
	useEffect,
	useState,
} from "react";
import {
	useConfirm,
} from "../../lib/prompt-dialog";
import type {
	RpcClient,
} from "../../lib/rpc";
import { SchemaTabSection } from "./schema";

/** memory.status wire contract (daemon MemoryBackendStatus). */
interface MemoryBackendStatus {
	backend: string;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: string;
	database?: string;
	message?: string;
	error?: string;
}

interface MemoryStatusResponse {
	id: string;
	status: MemoryBackendStatus;
}

/** Settings → Memory: the full memory subsystem (backend choice,
 *  auto-learn, Mnemopi, Hindsight) — TUI memory-tab parity, schema
 *  driven. */
export function MemorySection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("memory settings")}</h2>
			<p className="gui-settings-page-desc">{t("memory settings description")}</p>
			<SchemaTabSection rpc={rpc} tabs={["memory"]} />
			<MemoryMaintenance rpc={rpc} />
		</>
	);
}

/** Maintenance card below the schema config: live backend status
 *  (memory.status) + action buttons (memory.enqueue / memory.clear /
 *  memory.view / memory.stats / memory.diagnose). */
function MemoryMaintenance({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const { confirm } = useConfirm();
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [outputLabel, setOutputLabel] = useState<string | null>(null);
	const [output, setOutput] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const loadStatus = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<MemoryStatusResponse>("memory.status", {})
			.then(res => {
				setStatus(res ?? null);
				setStatusError(null);
			})
			.catch(err => setStatusError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [rpc]);

	useEffect(() => {
		loadStatus();
	}, [loadStatus]);

	/** view/stats/diagnose → { text } rendered in the scrollable <pre>. */
	const runText = (method: "memory.view" | "memory.stats" | "memory.diagnose", label: string): void => {
		if (!rpc || busy) return;
		setBusy(method);
		setOutputLabel(null);
		setOutput(null);
		setActionError(null);
		void rpc
			.request<{ text: string }>(method, {})
			.then(res => {
				setOutputLabel(label);
				setOutput(res?.text ?? "");
			})
			.catch(err => setActionError(err instanceof Error ? err.message : String(err)))
			.finally(() => setBusy(null));
	};

	/** enqueue/clear → { ok }; clear asks for confirmation first. */
	const runOk = (method: "memory.enqueue" | "memory.clear", label: string, confirmText?: string): void => {
		if (!rpc || busy) return;
		const go = (): void => {
			setBusy(method);
			setOutputLabel(null);
			setOutput(null);
			setActionError(null);
			void rpc
				.request<{ ok: boolean }>(method, {})
				.then(res => {
					if (res?.ok) {
						setOutputLabel(label);
						setOutput("ok");
						// counts / writability may have changed — re-read.
						loadStatus();
					} else {
						setActionError(`${t("failed")}: ${label}`);
					}
				})
				.catch(err => setActionError(err instanceof Error ? err.message : String(err)))
				.finally(() => setBusy(null));
		};
		if (confirmText) void confirm(confirmText).then(ok => {
			if (ok) go();
		});
		else go();
	};

	const s = status?.status;
	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("memory status")}</div>
			{loading ? (
				<div className="gui-settings-row-desc">{t("loading")}</div>
			) : statusError ? (
				<div className="text-[12.5px] text-[var(--color-warning)]">{statusError}</div>
			) : s ? (
				<div className="gui-memory-card">
					<div className="gui-memory-status-head">
						<span className="gui-memory-backend">{t("memory backend {id}", { id: status?.id ?? s.backend })}</span>
						<span className="flex items-center gap-1.5">
							<span className={`gui-provider-status-dot${s.active ? " gui-provider-status-dot--on" : ""}`} />
							<span className="text-[12px] text-[var(--color-text-muted)]">
								{t("memory active")}: {s.active ? t("on") : t("off")}
							</span>
						</span>
						<span className="flex items-center gap-1.5">
							<span className={`gui-provider-status-dot${s.writable ? " gui-provider-status-dot--on" : ""}`} />
							<span className="text-[12px] text-[var(--color-text-muted)]">
								{t("memory writable")}: {s.writable ? t("on") : t("off")}
							</span>
						</span>
						<span className="flex items-center gap-1.5">
							<span className={`gui-provider-status-dot${s.searchable ? " gui-provider-status-dot--on" : ""}`} />
							<span className="text-[12px] text-[var(--color-text-muted)]">
								{t("memory searchable")}: {s.searchable ? t("on") : t("off")}
							</span>
						</span>
					</div>
					<div className="gui-memory-status-grid">
						{s.workingCount !== undefined && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory working count")}</span>
								<span className="gui-memory-status-value">{s.workingCount}</span>
							</div>
						)}
						{s.episodicCount !== undefined && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory episodic count")}</span>
								<span className="gui-memory-status-value">{s.episodicCount}</span>
							</div>
						)}
						{s.tripleCount !== undefined && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory triple count")}</span>
								<span className="gui-memory-status-value">{s.tripleCount}</span>
							</div>
						)}
						{s.recallBanks && s.recallBanks.length > 0 && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory recall banks")}</span>
								<span className="gui-memory-status-value">{s.recallBanks.join(", ")}</span>
							</div>
						)}
						{s.retainBank && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory retain bank")}</span>
								<span className="gui-memory-status-value">{s.retainBank}</span>
							</div>
						)}
						{s.lastMemory && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory last memory")}</span>
								<span className="gui-memory-status-value">{s.lastMemory}</span>
							</div>
						)}
						{s.lastRecall && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory last recall")}</span>
								<span className="gui-memory-status-value">{s.lastRecall}</span>
							</div>
						)}
						{s.database && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory database")}</span>
								<span className="gui-memory-status-value gui-memory-status-value--mono">{s.database}</span>
							</div>
						)}
						{s.scope && (
							<div className="gui-memory-status-item">
								<span className="gui-memory-status-label">{t("memory scope")}</span>
								<span className="gui-memory-status-value">{s.scope}</span>
							</div>
						)}
					</div>
					{s.message && <div className="gui-memory-status-note">{t("memory message")}: {s.message}</div>}
					{s.error && <div className="gui-memory-status-note gui-memory-status-note--error">{t("memory error")}: {s.error}</div>}
				</div>
			) : null}
			<div className="gui-memory-actions">
				<button
					type="button"
					className="gui-btn"
					disabled={busy !== null}
					onClick={() => runOk("memory.enqueue", t("memory enqueue"))}
				>
					{t("memory enqueue")}
				</button>
				<button
					type="button"
					className="gui-btn gui-btn--danger"
					disabled={busy !== null}
					onClick={() => runOk("memory.clear", t("memory clear"), t("memory clear confirm"))}
				>
					{t("memory clear")}
				</button>
				<button
					type="button"
					className="gui-btn"
					disabled={busy !== null}
					onClick={() => runText("memory.view", t("memory view"))}
				>
					{t("memory view")}
				</button>
				<button
					type="button"
					className="gui-btn"
					disabled={busy !== null}
					onClick={() => runText("memory.stats", t("memory stats"))}
				>
					{t("memory stats")}
				</button>
				<button
					type="button"
					className="gui-btn"
					disabled={busy !== null}
					onClick={() => runText("memory.diagnose", t("memory diagnose"))}
				>
					{t("memory diagnose")}
				</button>
			</div>
			{actionError && <div className="text-[12.5px] text-[var(--color-warning)]">{actionError}</div>}
			{output !== null && (
				<div className="gui-ext-detail-label">{outputLabel}</div>
			)}
			{output !== null && (
				<div className="gui-ext-detail-code gui-memory-code">
					<pre>{output}</pre>
				</div>
			)}
		</div>
	);
}
