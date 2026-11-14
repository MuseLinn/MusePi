import { t } from "@musepi/client-core";
import { formatWhen } from "@musepi/client-core/src/lib/format";
import {
	ArrowLeft,
	Bot,
	Braces,
	Check,
	Download,
	Flower2,
	FolderClosed,
	LoaderCircle,
	Minus,
	MoonStar,
	Plus,
	ScanSearch,
	Search,
	ShieldCheck,
	Sparkles,
	SquareTerminal,
	Terminal,
	TriangleAlert,
	Zap,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { projectLabels } from "../lib/project-label";
import type { RpcClient } from "../lib/rpc";
import "../styles/gui-import.css";
import type { CustomGroup } from "./CustomGroups";
import { FadeScroll } from "./FadeScroll";

interface AgentSource {
	source: string;
	name: string;
}

interface ForeignSessionRow {
	id: string;
	title: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** New MusePi session id when this foreign session was already copied. */
	importedSessionId?: string | null;
}

interface ImportSource {
	source: string;
	name: string;
	count: number;
	sessions: ForeignSessionRow[];
}

interface WorkspaceGroup {
	cwd: string;
	sessions: ForeignSessionRow[];
}

/** Selection key — source and workspace the session lives in. */
const selKey = (source: string, cwd: string): string => `${source}\u0000${cwd}`;

/** Per-agent glyph for the source picker; unknown sources keep the generic bot. */
const SOURCE_ICONS: Record<string, typeof Bot> = {
	musepi: Sparkles,
	omp: Terminal,
	pi: Bot,
	opencode: SquareTerminal,
	grok: Zap,
	kimicode: MoonStar,
	claude: Flower2,
	codex: Braces,
};

const sourceIcon = (source: string): typeof Bot => SOURCE_ICONS[source] ?? Bot;

const workspaceName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

/**
 * Import sessions from other agents (omp/pi/opencode/grok/kimi/claude/codex).
 *
 * Explicit two-step flow — nothing scans on entry:
 *   1. import.agents lists the candidate agents (no session scan); the user
 *      picks sources and presses scan → import.sources scans ONLY those;
 *   2. results are grouped by source and workspace (session cwd), searchable,
 *      with per-workspace select-all; import.session copies the picked
 *      sessions into MusePi (each keeps its original workspace directory).
 *
 * Presentation only: RPC calls and the idempotent skip of already-imported
 * sessions are unchanged. `embedded` drops the dialog header so the same flow
 * reads correctly inside the onboarding sheet's import branch.
 */
export function ImportSessionsSetup({
	rpc,
	embedded = false,
}: {
	rpc: RpcClient | null;
	embedded?: boolean;
}): ReactNode {
	const [agents, setAgents] = useState<AgentSource[] | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	/** null = picker phase (not scanned yet); [] = scanned, nothing found. */
	const [scanned, setScanned] = useState<ImportSource[] | null>(null);
	const [selected, setSelected] = useState<Record<string, Set<string>>>({});
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [failedItems, setFailedItems] = useState<Array<{ source: string; title: string }>>([]);
	const [done, setDone] = useState<{ ok: number; skipped: number; failed: number; grouped?: number } | null>(null);
	/** Sessions copied in this run, so the list reflects the result immediately. */
	const [importedNow, setImportedNow] = useState<Set<string>>(new Set());

	const isImported = (source: string, session: ForeignSessionRow): boolean =>
		Boolean(session.importedSessionId) || importedNow.has(`${source}\u0000${session.id}`);

	// Agent list only — deliberately cheap, no session store scan.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<AgentSource[]>("import.agents", {})
			.then(list => {
				if (alive) setAgents(list ?? []);
			})
			.catch(() => {
				if (alive) setAgents([]);
			});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const toggleAgent = (source: string): void => {
		setPicked(prev => {
			const next = new Set(prev);
			if (next.has(source)) next.delete(source);
			else next.add(source);
			return next;
		});
	};

	const scan = async (): Promise<void> => {
		if (!rpc || picked.size === 0 || scanning) return;
		setScanning(true);
		setScanError(null);
		setScanned(null);
		setSelected({});
		setDone(null);
		setFilter("");
		setProgress(null);
		setFailedItems([]);
		setImportedNow(new Set());
		try {
			const list = await rpc.request<ImportSource[]>("import.sources", { sources: [...picked] });
			setScanned(list ?? []);
		} catch (err) {
			setScanError(err instanceof Error ? err.message : String(err));
		} finally {
			setScanning(false);
		}
	};

	const changeAgents = (): void => {
		setScanned(null);
		setSelected({});
		setScanError(null);
		setDone(null);
		setFilter("");
		setProgress(null);
		setFailedItems([]);
		setImportedNow(new Set());
	};

	/** Per-source sessions grouped by workspace; empty cwd last. */
	const groupsBySource = useMemo(() => {
		const out: Record<string, WorkspaceGroup[]> = {};
		const q = filter.trim().toLowerCase();
		for (const src of scanned ?? []) {
			const byCwd = new Map<string, ForeignSessionRow[]>();
			for (const s of src.sessions) {
				if (q.length > 0 && !`${s.title} ${s.firstMessage} ${s.cwd} ${s.id}`.toLowerCase().includes(q)) {
					continue;
				}
				const arr = byCwd.get(s.cwd) ?? [];
				arr.push(s);
				byCwd.set(s.cwd, arr);
			}
			out[src.source] = [...byCwd.entries()]
				.map(([cwd, sessions]) => ({ cwd, sessions }))
				.sort((a, b) => {
					if (!a.cwd && b.cwd) return 1;
					if (a.cwd && !b.cwd) return -1;
					return a.cwd.localeCompare(b.cwd);
				});
		}
		return out;
	}, [scanned, filter]);

	const toggleSession = (source: string, cwd: string, session: ForeignSessionRow): void => {
		if (isImported(source, session)) return;
		setSelected(prev => {
			const key = selKey(source, cwd);
			const next = new Set(prev[key] ?? []);
			if (next.has(session.id)) next.delete(session.id);
			else next.add(session.id);
			return { ...prev, [key]: next };
		});
	};

	const toggleWorkspace = (source: string, group: WorkspaceGroup): void => {
		setSelected(prev => {
			const key = selKey(source, group.cwd);
			const cur = prev[key] ?? new Set();
			const selectable = group.sessions.filter(s => !isImported(source, s)).map(s => s.id);
			const allChecked = selectable.length > 0 && selectable.every(id => cur.has(id));
			const next = new Set(cur);
			for (const id of selectable) {
				if (allChecked) next.delete(id);
				else next.add(id);
			}
			return { ...prev, [key]: next };
		});
	};

	const totalSelected = useMemo(() => Object.values(selected).reduce((sum, set) => sum + set.size, 0), [selected]);

	const visibleCount = useMemo(
		() =>
			(scanned ?? []).reduce(
				(sum, src) => sum + (groupsBySource[src.source] ?? []).reduce((n, g) => n + g.sessions.length, 0),
				0,
			),
		[scanned, groupsBySource],
	);

	const importedTotal = (scanned ?? []).reduce(
		(sum, src) => sum + src.sessions.filter(s => isImported(src.source, s)).length,
		0,
	);

	const importSelected = async (): Promise<void> => {
		if (!rpc || totalSelected === 0 || busy) return;
		setBusy(true);
		setDone(null);
		setFailedItems([]);
		let ok = 0;
		let skipped = 0;
		let failed = 0;
		const failures: Array<{ source: string; title: string }> = [];
		const copied: string[] = [];
		// Imported session ids per workspace — the 引导归纳 below folds them
		// into editable custom groups (one per workspace) after the copy loop.
		const byCwd = new Map<string, string[]>();
		const rows = new Map<string, ForeignSessionRow>();
		for (const src of scanned ?? []) for (const row of src.sessions) rows.set(`${src.source}\u0000${row.id}`, row);
		const work: Array<{ source: string; cwd: string; id: string }> = [];
		for (const [key, ids] of Object.entries(selected)) {
			const source = key.split("\u0000")[0] ?? "";
			const cwd = key.split("\u0000")[1] ?? "";
			for (const id of ids) work.push({ source, cwd, id });
		}
		setProgress({ done: 0, total: work.length });
		for (const [index, item] of work.entries()) {
			const { source, cwd, id } = item;
			const row = rows.get(`${source}\u0000${id}`);
			if (row?.importedSessionId) {
				skipped += 1;
				setProgress({ done: index + 1, total: work.length });
				continue;
			}
			try {
				// No cwd param: the daemon keeps the session's original
				// workspace directory (fallbackCwd = daemon cwd).
				const res = await rpc.request<{ sessionId?: string; skipped?: boolean }>("import.session", {
					source,
					id,
				});
				if (res?.skipped) {
					skipped += 1;
				} else {
					ok += 1;
					copied.push(`${source}\u0000${id}`);
					if (res?.sessionId) {
						const list = byCwd.get(cwd) ?? [];
						list.push(res.sessionId);
						byCwd.set(cwd, list);
					}
				}
			} catch {
				failed += 1;
				failures.push({ source, title: row?.title || row?.firstMessage || id });
			}
			setProgress({ done: index + 1, total: work.length });
		}
		setFailedItems(failures);
		// Auto-group the imports (引导归纳): one custom group per workspace,
		// folder-basename named, merged into the sidebar's persisted group
		// store — a plain editable group the user can rename/recolor/drag,
		// NOT a separate "spaces" section (that would duplicate the projects
		// tab). Regular (non-imported) sessions are never auto-grouped.
		let grouped = 0;
		if (byCwd.size > 0) {
			try {
				const raw = localStorage.getItem("musepi-gui-groups");
				const groups = raw ? (JSON.parse(raw) as CustomGroup[]) : [];
				// Issue #15: group identity is the WORKSPACE, not its folder
				// name. Two folders both called `demo` under different parents
				// used to land in one shared group (and shared its open/closed
				// state); the label is disambiguated separately.
				const cwds = [...byCwd.keys()].filter((p): p is string => typeof p === "string" && p.length > 0);
				const labels = projectLabels(cwds);
				for (const [cwd, ids] of byCwd) {
					const name = cwd
						? (labels.get(cwd) ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd)
						: t("settings.noWorkspace");
					const existing = cwd ? groups.find(g => g.cwd === cwd) : groups.find(g => !g.cwd && g.name === name);
					if (existing) {
						for (const id of ids) if (!existing.sessions.includes(id)) existing.sessions.push(id);
					} else {
						groups.push(cwd ? { name, cwd, sessions: [...ids] } : { name, sessions: [...ids] });
					}
					grouped += 1;
				}
				localStorage.setItem("musepi-gui-groups", JSON.stringify(groups));
				window.dispatchEvent(new CustomEvent("musepi-gui-groups-changed"));
			} catch {
				// storage unavailable — imports still succeeded, grouping skipped
			}
		}
		setBusy(false);
		setProgress(null);
		setDone({ ok, skipped, failed, grouped });
		setSelected({});
		if (copied.length > 0) {
			setImportedNow(prev => {
				const next = new Set(prev);
				for (const key of copied) next.add(key);
				return next;
			});
		}
	};

	const sourcesStep = scanned === null;
	const scanningPct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

	return (
		<div
			className={`gui-import${embedded ? " gui-import--embedded" : ""}`}
			data-step={sourcesStep ? "sources" : "sessions"}
		>
			{!embedded && (
				<div className="gui-import-head">
					<span className="gui-import-head-icon">
						<MorphIcon icon={sourcesStep ? ScanSearch : Search} size={16} spring="snappy" reducedMotion="user" />
					</span>
					<span className="gui-import-head-text">
						<span className="gui-import-head-title">{t("settings.importSessions")}</span>
						<span className="gui-import-head-step">
							{sourcesStep ? t("settings.importStepSources") : t("settings.importStepSessions")}
						</span>
					</span>
					<span className="gui-import-step-count">{sourcesStep ? "1 / 2" : "2 / 2"}</span>
				</div>
			)}

			<div className="gui-import-body">
				{sourcesStep ? (
					agents === null ? (
						<div className="gui-import-empty">
							<MorphIcon icon={LoaderCircle} size={14} className="gui-import-spin" />
							<span>{t("settings.loading2")}</span>
						</div>
					) : agents.length === 0 ? (
						<div className="gui-import-empty">{t("settings.noAgents")}</div>
					) : (
						<FadeScroll className="gui-import-sources">
							{agents.map(agent => {
								const on = picked.has(agent.source);
								return (
									<button
										key={agent.source}
										type="button"
										className={`gui-import-source${on ? " is-on" : ""}`}
										aria-pressed={on}
										onClick={() => toggleAgent(agent.source)}
									>
										<span className="gui-import-source-glyph">
											<MorphIcon icon={sourceIcon(agent.source)} size={15} spring="snappy" />
										</span>
										<span className="gui-import-source-name">{agent.name}</span>
										<span className="gui-import-tick">
											<MorphIcon icon={on ? Check : Plus} size={11} spring="snappy" />
										</span>
									</button>
								);
							})}
						</FadeScroll>
					)
				) : (
					<>
						<div className="gui-import-toolbar">
							<label className="gui-import-search">
								<MorphIcon icon={Search} size={13} className="gui-import-search-icon" />
								<input
									type="search"
									className="gui-import-search-input"
									value={filter}
									placeholder={t("settings.searchSessions")}
									aria-label={t("settings.searchSessions")}
									onChange={e => setFilter(e.target.value)}
								/>
							</label>
							{importedTotal > 0 && (
								<span className="gui-import-imported-total">
									{t("settings.importImportedCount", { count: importedTotal })}
								</span>
							)}
						</div>
						{scanned.length === 0 ? (
							<div className="gui-import-empty">{t("settings.noSessionsFoundSelected")}</div>
						) : visibleCount === 0 ? (
							<div className="gui-import-empty">{t("general.noResults")}</div>
						) : (
							<FadeScroll className="gui-import-sessions">
								{scanned.map(src => {
									const groups = groupsBySource[src.source] ?? [];
									if (groups.length === 0) return null;
									const visible = groups.reduce((n, g) => n + g.sessions.length, 0);
									const importedCount = src.sessions.filter(s => isImported(src.source, s)).length;
									return (
										<section key={src.source} className="gui-import-group">
											<div className="gui-import-group-head">
												<MorphIcon icon={sourceIcon(src.source)} size={12} />
												<span className="gui-import-group-name">{src.name}</span>
												<span className="gui-import-group-count">{visible}</span>
												{importedCount > 0 && (
													<span className="gui-import-group-imported">
														<MorphIcon icon={Check} size={10} />
														{importedCount}
													</span>
												)}
											</div>
											{groups.map(group => {
												const key = selKey(src.source, group.cwd);
												const cur = selected[key] ?? new Set<string>();
												const selectable = group.sessions.filter(s => !isImported(src.source, s));
												const allChecked = selectable.length > 0 && selectable.every(s => cur.has(s.id));
												const someChecked = selectable.some(s => cur.has(s.id));
												const name = group.cwd ? workspaceName(group.cwd) : t("settings.noWorkspace");
												return (
													<div key={group.cwd || "no-workspace"} className="gui-import-ws">
														<div className="gui-import-ws-head">
															<button
																type="button"
																className={`gui-import-tick gui-import-tick--ws${
																	allChecked || someChecked ? " is-on" : ""
																}${someChecked && !allChecked ? " is-partial" : ""}`}
																role="checkbox"
																aria-checked={allChecked ? true : someChecked ? "mixed" : false}
																aria-label={
																	allChecked ? t("settings.deselectAll") : t("settings.selectAll")
																}
																title={allChecked ? t("settings.deselectAll") : t("settings.selectAll")}
																disabled={selectable.length === 0}
																onClick={() => toggleWorkspace(src.source, group)}
															>
																<MorphIcon
																	icon={allChecked ? Check : someChecked ? Minus : Plus}
																	size={10}
																	spring="snappy"
																/>
															</button>
															<MorphIcon icon={FolderClosed} size={12} className="gui-import-ws-icon" />
															<span className="gui-import-ws-name" title={group.cwd || undefined}>
																{name}
															</span>
															{group.cwd && (
																<span className="gui-import-ws-path" title={group.cwd}>
																	{group.cwd}
																</span>
															)}
															<span className="gui-import-ws-count">{group.sessions.length}</span>
														</div>
														{group.sessions.map(s => {
															const imported = isImported(src.source, s);
															const checked = cur.has(s.id);
															return (
																<button
																	key={s.id}
																	type="button"
																	className={`gui-import-session${
																		imported ? " is-imported" : checked ? " is-on" : ""
																	}`}
																	disabled={imported}
																	aria-pressed={imported || checked}
																	title={s.cwd}
																	onClick={() => toggleSession(src.source, group.cwd, s)}
																>
																	<span className="gui-import-tick gui-import-tick--row">
																		<MorphIcon
																			icon={imported || checked ? Check : Plus}
																			size={10}
																			spring="snappy"
																		/>
																	</span>
																	<span className="gui-import-session-title">
																		{s.title || s.firstMessage || s.id}
																	</span>
																	{imported && (
																		<span className="gui-import-tag">
																			<MorphIcon icon={Check} size={9} />
																			{t("settings.importAlreadyImported")}
																		</span>
																	)}
																	<span className="gui-import-session-meta">
																		{formatWhen(new Date(s.modified).getTime())}
																		{s.messageCount > 0
																			? ` · ${t("settings.importMessageCount", { count: s.messageCount })}`
																			: ""}
																	</span>
																</button>
															);
														})}
													</div>
												);
											})}
										</section>
									);
								})}
							</FadeScroll>
						)}
					</>
				)}
			</div>

			<div className="gui-import-foot">
				{busy && progress && (
					<div
						className="gui-import-progress"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={progress.total}
						aria-valuenow={progress.done}
						aria-label={t("settings.importProgress", {
							done: String(progress.done),
							total: String(progress.total),
						})}
					>
						<span className="gui-import-progress-track">
							<span className="gui-import-progress-fill" style={{ width: `${scanningPct}%` }} />
						</span>
						<span className="gui-import-progress-text">
							{t("settings.importProgress", {
								done: String(progress.done),
								total: String(progress.total),
							})}
						</span>
					</div>
				)}
				<div
					className={`gui-import-foot-row${
						done || failedItems.length > 0 || scanError ? " gui-import-foot-row--stack" : ""
					}`}
				>
					<span className="gui-import-status">
						{done ? (
							<span className="gui-import-status-line gui-import-status-line--ok">
								<MorphIcon icon={Check} size={12} />
								<span>
									{t("settings.importDone", { count: done.ok })}
									{done.skipped > 0 ? ` · ${t("settings.importSkipped", { count: done.skipped })}` : ""}
									{done.grouped ? ` · ${t("settings.importGrouped", { count: done.grouped })}` : ""}
								</span>
							</span>
						) : null}
						{failedItems.length > 0 ? (
							<span
								className="gui-import-status-line gui-import-status-line--error"
								title={failedItems.map(item => `${item.source}: ${item.title}`).join("\n")}
							>
								<MorphIcon icon={TriangleAlert} size={12} />
								<span>
									{t("settings.importFailed", { count: failedItems.length })} · {failedItems[0]?.title}
									{failedItems.length > 1 ? ` +${failedItems.length - 1}` : ""}
								</span>
							</span>
						) : null}
						{scanError ? (
							<span className="gui-import-status-line gui-import-status-line--error" title={scanError}>
								<MorphIcon icon={TriangleAlert} size={12} />
								<span>{scanError}</span>
							</span>
						) : null}
						{!done && failedItems.length === 0 && !scanError && (
							<span className="gui-import-hint" title={t("settings.importSafety")}>
								<MorphIcon icon={ShieldCheck} size={12} />
								<span>{t("settings.importSafety")}</span>
							</span>
						)}
					</span>
					<span className="gui-import-actions">
						{!sourcesStep && (
							<button
								type="button"
								className="gui-btn gui-btn-ghost"
								disabled={busy || scanning}
								onClick={changeAgents}
							>
								<MorphIcon icon={ArrowLeft} size={12} spring="snappy" />
								{t("settings.changeSelection")}
							</button>
						)}
						{sourcesStep ? (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={scanning || picked.size === 0}
								onClick={() => void scan()}
							>
								<MorphIcon
									icon={scanning ? LoaderCircle : ScanSearch}
									size={13}
									spring="snappy"
									className={scanning ? "gui-import-spin" : undefined}
								/>
								{scanning ? t("settings.scanning") : t("settings.scan")}
							</button>
						) : !done || totalSelected > 0 ? (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={busy || totalSelected === 0}
								onClick={() => void importSelected()}
							>
								<MorphIcon
									icon={busy ? LoaderCircle : Download}
									size={13}
									spring="snappy"
									className={busy ? "gui-import-spin" : undefined}
								/>
								{busy
									? progress
										? t("settings.importProgress", {
												done: String(progress.done),
												total: String(progress.total),
											})
										: t("settings.importing")
									: t("settings.importSelected", { count: totalSelected })}
							</button>
						) : null}
					</span>
				</div>
			</div>
		</div>
	);
}
