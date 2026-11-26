import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { workspaceKeyLabels } from "../../lib/project-label";
import { useConfirm } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
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
	lastRecall?: boolean;
	database?: string;
	projectLessons?: number;
	globalLessons?: number;
	summaryBytes?: number;
	globalScope?: boolean;
	message?: string;
	error?: string;
	/** Which optional maintenance calls the daemon's backend actually implements. */
	capabilities?: {
		stats?: boolean;
		diagnose?: boolean;
		queue?: boolean;
		clearGlobal?: boolean;
	};
}

interface MemoryStatusResponse {
	id: string;
	status: MemoryBackendStatus;
}

/** Localized display name for the active backend. */
function backendLabel(id: string): string {
	switch (id) {
		case "musemem":
			return t("settings.memoryBackendMusemem");
		case "local":
			return t("settings.memoryBackendLocal");
		case "mnemopi":
			return t("settings.memoryBackendMnemopi");
		case "hindsight":
			return t("settings.memoryBackendHindsight");
		case "sharpshooter":
			return t("settings.memoryBackendSharpshooter");
		case "off":
			return t("settings.memoryBackendOff");
		default:
			// A plugin-contributed backend: the provider's own id is the only
			// name the host has for it.
			return id;
	}
}

/** One-line explanation of what the active backend does. */
function backendHint(id: string): string {
	switch (id) {
		case "musemem":
			return t("settings.memoryHintMusemem");
		case "local":
			return t("settings.memoryHintLocal");
		case "mnemopi":
			return t("settings.memoryHintMnemopi");
		case "hindsight":
			return t("settings.memoryHintHindsight");
		case "sharpshooter":
			return t("settings.memoryHintSharpshooter");
		case "off":
			return t("settings.memoryHintOff");
		default:
			return "";
	}
}

/** Compact size label for the summary metric. */
function formatMemoryBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Settings → Memory: backend schema first, then the local-only workspace
 *  browser, then live status and maintenance. */
export function MemorySection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [statusError, setStatusError] = useState<string | null>(null);

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

	const backend = status?.status?.backend;
	return (
		<>
			{/* The schema owns the backend picker and each backend's own groups;
			 *  no page-level heading sits above them, so the first group reads as
			 *  the page's first level instead of a nested duplicate. */}
			<SchemaTabSection
				rpc={rpc}
				tabs={["memory"]}
				onChanged={key => {
					if (/^(memory|mnemopi|hindsight|sharpshooter)\./.test(key)) {
						// Let the daemon finish its backend transition before re-reading.
						setTimeout(loadStatus, 200);
					}
				}}
			/>
			{backend === "off" ? null : (
				<MemoryMaintenance
					rpc={rpc}
					status={status}
					loading={loading}
					statusError={statusError}
					onReload={loadStatus}
				/>
			)}
			{backend === "musemem" || backend === "local" ? <WorkspaceMemory rpc={rpc} /> : null}
		</>
	);
}

/** memory.workspace file-list entry (daemon wire shape). */
interface WorkspaceMemoryFile {
	name: string;
	size: number;
	mtimeMs: number;
}

interface WorkspaceMemoryResponse {
	root: string;
	slug: string;
	workspaces: string[];
	files: WorkspaceMemoryFile[];
}

/** Compact age label for a memory file (transcript-domain relative keys;
 *  older than a week falls back to the locale date). */
function memoryAgeLabel(mtimeMs: number): string {
	const s = Math.floor((Date.now() - mtimeMs) / 1000);
	if (s < 60) return t("transcript.justNow");
	if (s < 3600) return t("transcript.minAgoWithCount", { count: Math.floor(s / 60) });
	if (s < 86400) return t("transcript.hAgoWithCount", { count: Math.floor(s / 3600) });
	if (s < 7 * 86400) return t("transcript.dAgoWithCount", { count: Math.floor(s / 86400) });
	return new Date(mtimeMs).toLocaleDateString();
}

/** Workspace memory browser for the local summary backend: per-workspace
 *  memory directory, name search, refresh, and click-to-read rows. */
function WorkspaceMemory({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [workspaces, setWorkspaces] = useState<string[]>([]);
	const [slug, setSlug] = useState<string>("");
	const [files, setFiles] = useState<WorkspaceMemoryFile[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
	const [viewLoading, setViewLoading] = useState(false);
	const [open, setOpen] = useState(false);

	const load = useCallback(
		(slugArg?: string): void => {
			if (!rpc) return;
			setBusy(true);
			void rpc
				.request<WorkspaceMemoryResponse>("memory.workspace", slugArg ? { slug: slugArg } : {})
				.then(res => {
					setWorkspaces(res?.workspaces ?? []);
					setSlug(res?.slug ?? "");
					setFiles(res?.files ?? []);
					setLoadError(null);
				})
				.catch(err => setLoadError(err instanceof Error ? err.message : String(err)))
				.finally(() => {
					setLoading(false);
					setBusy(false);
				});
		},
		[rpc],
	);

	useEffect(() => {
		load();
	}, [load]);

	const openFile = (name: string): void => {
		if (!rpc || viewLoading) return;
		setViewLoading(true);
		void rpc
			.request<{ content: string }>("memory.workspaceRead", { slug: slug || undefined, name })
			.then(res => setViewing({ name, content: res?.content ?? "" }))
			.catch(err =>
				setViewing({ name, content: `${t("tools.failed")}: ${err instanceof Error ? err.message : String(err)}` }),
			)
			.finally(() => setViewLoading(false));
	};

	const reveal = (name?: string): void => {
		if (!rpc) return;
		void rpc
			.request("memory.workspaceReveal", { slug: slug || undefined, ...(name ? { name } : {}) })
			.catch(() => {});
	};

	const filtered = query.trim() ? files.filter(f => f.name.toLowerCase().includes(query.trim().toLowerCase())) : files;
	// The selector names the folder; the raw on-disk directory key stays on the
	// select's title. Two workspaces sharing a basename widen to their parent.
	const workspaceOptions = slug && !workspaces.includes(slug) ? [slug, ...workspaces] : workspaces;
	const workspaceLabels = workspaceKeyLabels(workspaceOptions);
	return (
		<div className="gui-settings-section gui-memory-workspace">
			<button
				type="button"
				className="gui-memory-workspace-toggle"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<span className="gui-memory-workspace-title">{t("settings.workspaceMemory")}</span>
				<span className="gui-memory-workspace-count">{t("settings.memoriesCount", { count: files.length })}</span>
				<span className={`gui-memory-caret${open ? " gui-memory-caret--open" : ""}`} aria-hidden />
			</button>
			{open && (
				<>
					<div className="gui-settings-row-desc gui-memory-workspace-desc">
						{t("settings.workspaceMemoryDescription")}
					</div>
					{loadError && <div className="text-[12.5px] text-[var(--color-warning)]">{loadError}</div>}
					<div className="gui-memory-workspace-card">
						<div className="gui-memory-workspace-bar">
							<select
								className="gui-settings-select"
								value={slug}
								onChange={e => load(e.target.value)}
								aria-label={t("settings.workspaceMemory")}
								title={slug}
							>
								{workspaceOptions.map(w => (
									<option key={w} value={w}>
										{workspaceLabels.get(w) ?? w}
									</option>
								))}
							</select>
							<input
								className="gui-input gui-memory-workspace-search"
								value={query}
								onChange={e => setQuery(e.target.value)}
								placeholder={t("settings.searchMemoryFiles")}
								aria-label={t("settings.searchMemoryFiles")}
								spellCheck={false}
							/>
							<button
								type="button"
								className="gui-memory-workspace-refresh"
								onClick={() => load(slug || undefined)}
								disabled={busy}
								aria-label={t("settings.refresh")}
								title={t("settings.refresh")}
							>
								<Icon name="refresh" className="h-3.5 w-3.5" />
							</button>
						</div>
						{loading ? (
							<div className="gui-settings-row-desc">{t("settings.loading")}</div>
						) : (
							<div className="gui-memory-workspace-list">
								{filtered.map(f => (
									<div key={f.name} className="gui-memory-workspace-row">
										<button
											type="button"
											className="gui-memory-workspace-open"
											onClick={() => openFile(f.name)}
											title={f.name}
										>
											<span className="gui-memory-workspace-fileicon">
												<Icon name="file-text" className="h-3.5 w-3.5" />
											</span>
											<span className="gui-memory-workspace-filemeta">
												<span className="gui-memory-workspace-filename truncate">{f.name}</span>
												<span className="gui-memory-workspace-filetime">{memoryAgeLabel(f.mtimeMs)}</span>
											</span>
										</button>
										<button
											type="button"
											className="gui-memory-workspace-reveal"
											onClick={() => reveal(f.name)}
											aria-label={t("settings.revealFolder")}
											title={t("settings.revealFolder")}
										>
											<Icon name="folder-open" className="h-3.5 w-3.5" />
										</button>
									</div>
								))}
								{filtered.length === 0 && (
									<div className="gui-settings-row-desc">
										{files.length === 0
											? t("settings.memoryWorkspaceEmptyHint")
											: t("settings.noMemoryFiles")}
									</div>
								)}
							</div>
						)}
						{viewing && (
							<>
								<div className="gui-ext-detail-label">
									{viewing.name}
									{viewLoading ? ` · ${t("settings.loading")}` : ""}
								</div>
								<div className="gui-ext-detail-code gui-memory-code">
									<pre>{viewing.content}</pre>
								</div>
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
}

interface MemoryMaintenanceProps {
	rpc: RpcClient | null;
	status: MemoryStatusResponse | null;
	loading: boolean;
	statusError: string | null;
	onReload: () => void;
}

/** Live backend status plus maintenance actions. */
function MemoryMaintenance({ rpc, status, loading, statusError, onReload }: MemoryMaintenanceProps): ReactNode {
	const { confirm } = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	const [outputLabel, setOutputLabel] = useState<string | null>(null);
	const [output, setOutput] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

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
	const runOk = (
		method: "memory.enqueue" | "memory.clear",
		label: string,
		confirmText?: string,
		params?: Record<string, unknown>,
	): void => {
		if (!rpc || busy) return;
		const go = (): void => {
			setBusy(method);
			setOutputLabel(null);
			setOutput(null);
			setActionError(null);
			void rpc
				.request<{ ok: boolean }>(method, params ?? {})
				.then(res => {
					if (res?.ok) {
						setOutputLabel(label);
						setOutput("ok");
						onReload();
					} else {
						setActionError(`${t("tools.failed")}: ${label}`);
					}
				})
				.catch(err => setActionError(err instanceof Error ? err.message : String(err)))
				.finally(() => setBusy(null));
		};
		if (confirmText)
			void confirm(confirmText, undefined, { destructive: true }).then(ok => {
				if (ok) go();
			});
		else go();
	};

	const s = status?.status;
	const facts: Array<{ label: string; value: string }> = [];
	if (s?.summaryBytes !== undefined) {
		facts.push({ label: t("settings.memorySummary"), value: formatMemoryBytes(s.summaryBytes) });
	}
	if (s?.projectLessons !== undefined) {
		facts.push({ label: t("settings.memoryProjectLessons"), value: String(s.projectLessons) });
	}
	if (s?.globalLessons !== undefined) {
		facts.push({
			label: t("settings.memoryGlobalLessons"),
			value: s.globalScope === false ? t("settings.memoryOff") : String(s.globalLessons),
		});
	}
	const hasGrid = Boolean(
		s &&
			(s.workingCount !== undefined ||
				s.episodicCount !== undefined ||
				s.tripleCount !== undefined ||
				s.recallBanks?.length ||
				s.retainBank ||
				s.lastMemory ||
				s.lastRecall ||
				s.database ||
				s.scope),
	);
	const hint = s ? backendHint(s.backend) : "";
	return (
		<div className="gui-settings-section gui-memory-maintenance">
			{loading ? (
				<div className="gui-settings-row-desc">{t("settings.loading")}</div>
			) : statusError ? (
				<div className="text-[12.5px] text-[var(--color-warning)]">{statusError}</div>
			) : s ? (
				<>
					<div className="gui-memory-strip">
						<div className="gui-memory-identity">
							<span className="gui-memory-backend">{backendLabel(s.backend)}</span>
							<span className={`gui-memory-state${s.active ? " gui-memory-state--on" : ""}`}>
								<span className="gui-memory-state-dot" />
								{s.active ? t("settings.memoryRunning") : t("settings.memoryInactive")}
							</span>
							{!s.writable && <span className="gui-memory-state">{t("settings.memoryReadOnly")}</span>}
							{facts.length > 0 && (
								<span className="gui-memory-facts">
									{facts.map(fact => (
										<span key={fact.label} className="gui-memory-fact">
											<span className="gui-memory-fact-label">{fact.label}</span>
											<span className="gui-memory-fact-value">{fact.value}</span>
										</span>
									))}
								</span>
							)}
						</div>
						<div className="gui-memory-toolbar">
							<button
								type="button"
								className="gui-memory-action"
								disabled={busy !== null}
								onClick={() => runOk("memory.enqueue", t("settings.memoryEnqueue"))}
							>
								{t("settings.memoryEnqueue")}
							</button>
							<button
								type="button"
								className="gui-memory-action"
								disabled={busy !== null}
								onClick={() => runText("memory.view", t("settings.memoryView"))}
							>
								{t("settings.memoryView")}
							</button>
							{s.capabilities?.stats === true && (
								<button
									type="button"
									className="gui-memory-action"
									disabled={busy !== null}
									onClick={() => runText("memory.stats", t("settings.memoryStats"))}
								>
									{t("settings.memoryStats")}
								</button>
							)}
							{s.capabilities?.diagnose === true && (
								<button
									type="button"
									className="gui-memory-action"
									disabled={busy !== null}
									onClick={() => runText("memory.diagnose", t("settings.memoryDiagnose"))}
								>
									{t("settings.memoryDiagnose")}
								</button>
							)}
							<span className="gui-memory-toolbar-sep" aria-hidden />
							{s.capabilities?.clearGlobal === true && (
								<button
									type="button"
									className="gui-memory-action gui-memory-action--danger"
									disabled={busy !== null}
									onClick={() =>
										runOk(
											"memory.clear",
											t("settings.memoryClearGlobal"),
											t("settings.memoryClearGlobalConfirm"),
											{ scope: "global" },
										)
									}
								>
									{t("settings.memoryClearGlobal")}
								</button>
							)}
							<button
								type="button"
								className="gui-memory-action gui-memory-action--danger"
								disabled={busy !== null}
								onClick={() =>
									runOk("memory.clear", t("settings.memoryClear"), t("settings.memoryClearConfirm"))
								}
							>
								{t("settings.memoryClear")}
							</button>
						</div>
					</div>
					{hint ? <div className="gui-memory-hint">{hint}</div> : null}
					{hasGrid && (
						<div className="gui-memory-status-grid">
							{s.workingCount !== undefined && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryWorkingCount")}</span>
									<span className="gui-memory-status-value">{s.workingCount}</span>
								</div>
							)}
							{s.episodicCount !== undefined && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryEpisodicCount")}</span>
									<span className="gui-memory-status-value">{s.episodicCount}</span>
								</div>
							)}
							{s.tripleCount !== undefined && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryTripleCount")}</span>
									<span className="gui-memory-status-value">{s.tripleCount}</span>
								</div>
							)}
							{s.recallBanks && s.recallBanks.length > 0 && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryRecallBanks")}</span>
									<span className="gui-memory-status-value">{s.recallBanks.join(", ")}</span>
								</div>
							)}
							{s.retainBank && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryRetainBank")}</span>
									<span className="gui-memory-status-value">{s.retainBank}</span>
								</div>
							)}
							{s.lastMemory && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryLastMemory")}</span>
									<span className="gui-memory-status-value">{s.lastMemory}</span>
								</div>
							)}
							{s.lastRecall && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryLastRecall")}</span>
									<span className="gui-memory-status-value">{t("settings.memoryYes")}</span>
								</div>
							)}
							{s.database && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryDatabase")}</span>
									<span className="gui-memory-status-value gui-memory-status-value--mono">{s.database}</span>
								</div>
							)}
							{s.scope && (
								<div className="gui-memory-status-item">
									<span className="gui-memory-status-label">{t("settings.memoryScope")}</span>
									<span className="gui-memory-status-value">{s.scope}</span>
								</div>
							)}
						</div>
					)}
					{!hint && !hasGrid && facts.length === 0 && s.message ? (
						<div className="gui-memory-hint">{s.message}</div>
					) : null}
					{s.error && (
						<div className="gui-memory-status-note gui-memory-status-note--error">
							{t("settings.memoryError")}: {s.error}
						</div>
					)}
				</>
			) : null}
			{actionError && <div className="text-[12.5px] text-[var(--color-warning)]">{actionError}</div>}
			{output !== null && (
				<div className="gui-memory-output">
					<div className="gui-memory-output-head">
						<span className="gui-ext-detail-label">{outputLabel}</span>
						<button
							type="button"
							className="gui-memory-output-close"
							onClick={() => {
								setOutput(null);
								setOutputLabel(null);
							}}
							aria-label={t("settings.memoryOutputClose")}
							title={t("settings.memoryOutputClose")}
						>
							×
						</button>
					</div>
					<div className="gui-ext-detail-code gui-memory-code">
						<pre>{output}</pre>
					</div>
				</div>
			)}
		</div>
	);
}
