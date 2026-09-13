import { t } from "@musepi/guest-client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
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
			<WorkspaceMemory rpc={rpc} />
			<SchemaTabSection rpc={rpc} tabs={["memory"]} />
			<MemoryMaintenance rpc={rpc} />
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
	if (s < 60) return t("just now");
	if (s < 3600) return t("{count} min ago", { count: Math.floor(s / 60) });
	if (s < 86400) return t("{count} h ago", { count: Math.floor(s / 3600) });
	if (s < 7 * 86400) return t("{count} d ago", { count: Math.floor(s / 86400) });
	return new Date(mtimeMs).toLocaleDateString();
}

/** Workspace label from a memory-dir slug: `encodeProjectPath` is lossy
 *  (`--` ⇄ separators), so this is cosmetic — decode to a path-ish string
 *  and show the FOLDER NAME; when several workspaces share a basename,
 *  disambiguate with the parent segment. */
function workspaceLabel(slug: string, all: readonly string[]): string {
	const decoded = `${slug.slice(2, -2).replace(/--/g, "/")}`;
	const segments = decoded.split("/");
	const base = segments[segments.length - 1] || slug;
	const siblings = all.filter(w => {
		const segs = `${w.slice(2, -2).replace(/--/g, "/")}`.split("/");
		return segs[segs.length - 1] === base;
	});
	if (siblings.length > 1 && segments.length >= 2) return `${segments[segments.length - 2]}/${base}`;
	return base;
}

/** Workspace memory browser (ZCode 记忆面板 parity): per-workspace memory
 *  directory — workspace selector (folder names), entry count, name
 *  search, refresh, and file rows (click → in-panel viewer; folder button
 *  → reveal in the OS file manager). The backend on/off choice lives in
 *  the schema select below — no duplicate toggle here. */
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
				setViewing({ name, content: `${t("failed")}: ${err instanceof Error ? err.message : String(err)}` }),
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
	return (
		<div className="gui-settings-section">
			{/* Section head — title + desc only. The backend on/off lives in the
			 * schema select below; a second toggle here would be a duplicate
			 * control over the same setting. */}
			<div className="gui-memory-workspace-head">
				<div className="min-w-0">
					<div className="gui-settings-section-title">{t("workspace memory")}</div>
					<div className="gui-settings-row-desc">{t("workspace memory description")}</div>
				</div>
			</div>
			{loadError && <div className="text-[12.5px] text-[var(--color-warning)]">{loadError}</div>}
			<div className="gui-memory-workspace-bar">
				<select
					className="gui-settings-select"
					value={slug}
					onChange={e => load(e.target.value)}
					aria-label={t("workspace memory")}
					title={slug}
				>
					{(slug && !workspaces.includes(slug) ? [slug, ...workspaces] : workspaces).map(w => (
						<option key={w} value={w}>
							{workspaceLabel(w, workspaces)}
						</option>
					))}
				</select>
				<span className="gui-memory-workspace-count">{t("memories count", { count: files.length })}</span>
				<input
					className="gui-input gui-memory-workspace-search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={t("search memory files")}
					spellCheck={false}
				/>
			</div>
			<div className="gui-memory-workspace-head">
				<span className="gui-memory-workspace-title">{t("memory files")}</span>
				<button
					type="button"
					className="gui-memory-workspace-refresh"
					onClick={() => load(slug || undefined)}
					disabled={busy}
					aria-label={t("refresh")}
					title={t("refresh")}
				>
					<Icon name="refresh" className="h-3.5 w-3.5" />
				</button>
			</div>
			{loading ? (
				<div className="gui-settings-row-desc">{t("loading")}</div>
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
								<span className="gui-memory-workspace-fileicon">M↓</span>
								<span className="gui-memory-workspace-filemeta">
									<span className="gui-memory-workspace-filename truncate">{f.name}</span>
									<span className="gui-memory-workspace-filetime">{memoryAgeLabel(f.mtimeMs)}</span>
								</span>
							</button>
							<button
								type="button"
								className="gui-memory-workspace-reveal"
								onClick={() => reveal(f.name)}
								aria-label={t("reveal in folder")}
								title={t("reveal in folder")}
							>
								<Icon name="folder-open" className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
					{filtered.length === 0 && <div className="gui-settings-row-desc">{t("no memory files")}</div>}
				</div>
			)}
			{viewing && (
				<>
					<div className="gui-ext-detail-label">
						{viewing.name}
						{viewLoading ? ` · ${t("loading")}` : ""}
					</div>
					<div className="gui-ext-detail-code gui-memory-code">
						<pre>{viewing.content}</pre>
					</div>
				</>
			)}
		</div>
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
		if (confirmText)
			void confirm(confirmText).then(ok => {
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
						<span className="gui-memory-backend">
							{t("memory backend {id}", { id: status?.id ?? s.backend })}
						</span>
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
					{s.message && (
						<div className="gui-memory-status-note">
							{t("memory message")}: {s.message}
						</div>
					)}
					{s.error && (
						<div className="gui-memory-status-note gui-memory-status-note--error">
							{t("memory error")}: {s.error}
						</div>
					)}
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
			{output !== null && <div className="gui-ext-detail-label">{outputLabel}</div>}
			{output !== null && (
				<div className="gui-ext-detail-code gui-memory-code">
					<pre>{output}</pre>
				</div>
			)}
		</div>
	);
}
