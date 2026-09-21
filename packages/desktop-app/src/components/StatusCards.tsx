import { t } from "@musepi/client-core";
import { agentProgressFraction } from "@musepi/client-core/src/tool-render/tools/task";
import type { SessionEntry, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { HeightMorph } from "./HeightMorph";
import { Reveal } from "./Reveal";
import { StateIcon } from "./StateIcon";

/** Collapse preference (renderer-local): "1" → slim pill. */
const COLLAPSE_KEY = "musepi-gui-status-cards";

/** One working-tree row from `git.status` (`status` is the porcelain code:
 *  `M`/`A`/`D`/`R` staged, `??` untracked, …). */
interface GitFile {
	path: string;
	status: string;
}

/** Files listed before the "+N more" rollup. */
const CHANGED_FILES_CAP = 6;

/** Transcript-column width under which the expanded panel auto-folds to its
 *  header card (ZCode display-mode "auto"). */
const AUTO_FOLD_WIDTH = 560;

/** Latest todo-tool snapshot from the transcript (result details carry
 *  `{ phases: [{ name, tasks: [{ content, status }] }] }`). Returns null
 *  when the session has no todo board yet. */
function latestTodo(entries: readonly SessionEntry[]): { done: number; total: number; current: string | null } | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo" || msg.isError) continue;
		const phases = (msg.details as { phases?: unknown } | null)?.phases;
		if (!Array.isArray(phases)) continue;
		let total = 0;
		let done = 0;
		let current: string | null = null;
		for (const phase of phases) {
			if (!phase || typeof phase !== "object") continue;
			const tasks = (phase as { tasks?: unknown }).tasks;
			if (!Array.isArray(tasks)) continue;
			for (const task of tasks) {
				if (!task || typeof task !== "object") continue;
				const { content, status } = task as { content?: unknown; status?: unknown };
				if (typeof content !== "string") continue;
				total++;
				if (status === "completed") done++;
				else if (status === "in_progress" && current === null) current = content;
			}
		}
		if (total > 0) return { done, total, current };
	}
	return null;
}

const isLiveAgent = (p: SubagentProgressPayload): boolean =>
	p.progress.status === "pending" || p.progress.status === "running";

/** Collapsible section inside the status panel (ZCode status-panel parity):
 *  a subtle title row whose chevron only surfaces on hover; the body hides
 *  through the standard Reveal height collapse. */
function StatusSection({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: ReactNode;
	children: ReactNode;
}): ReactNode {
	const [open, setOpen] = useState(true);
	return (
		<section className="gui-status-section">
			<button
				type="button"
				className="gui-status-section-head"
				onClick={() => setOpen(v => !v)}
				aria-expanded={open}
			>
				<span className="gui-status-section-title">{title}</span>
				{trailing && <span className="gui-status-section-count">{trailing}</span>}
				<Icon
					name="arrow-down-s"
					className={`gui-status-section-chev${open ? "" : " gui-status-section-chev--closed"}`}
				/>
			</button>
			<Reveal open={open}>
				<div className="gui-status-section-body">{children}</div>
			</Reveal>
		</section>
	);
}

/**
 * Floating status panel pinned to the transcript's top-right corner (ZCode
 * 悬浮卡 parity): one frosted card with collapsible sections — live git
 * state (changes + diff stats, branch switcher, commit jump), running/ended
 * subagents with elapsed timers, and the todo-board progress. Collapses to
 * a slim capsule through the HeightMorph standard (same mounted element
 * morphs between the two sizes); the capsule's leading icon swaps to an
 * expand glyph on hover. Hidden entirely when there is nothing to show.
 * Cards are launchers — clicking through opens the matching right-panel
 * surface rather than duplicating it.
 */
export function StatusCards({
	rpc,
	cwd,
	progress,
	entries,
	working,
	onOpenSurface,
}: {
	rpc: RpcClient | null;
	cwd: string;
	progress: ReadonlyMap<string, SubagentProgressPayload> | null;
	entries: readonly SessionEntry[];
	working: boolean;
	onOpenSurface: (view: "git" | "trajectory") => void;
}): ReactNode {
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
	const toggleCollapsed = useCallback((): void => {
		setCollapsed(prev => {
			localStorage.setItem(COLLAPSE_KEY, prev ? "0" : "1");
			return !prev;
		});
	}, []);

	// ── Git: 15s poll (branch + ahead/behind + per-file lists + numstat) ───
	const [git, setGit] = useState<{
		branch: string | null;
		ahead: number;
		behind: number;
		staged: GitFile[];
		unstaged: GitFile[];
		untracked: GitFile[];
		added: number;
		deleted: number;
	} | null>(null);
	// A checkout invalidates every readout at once: the numbers already on
	// screen describe the branch we just left. Hide them until the next
	// status lands instead of flashing the old diff under the new name
	// (openchamber's stale-dirty gate).
	const [gitStale, setGitStale] = useState(false);
	const gitLoadRef = useRef<(() => void) | null>(null);
	const [changesOpen, setChangesOpen] = useState(false);
	useEffect(() => {
		if (!rpc || !cwd) return;
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{
					branch?: string | null;
					ahead?: number;
					behind?: number;
					staged?: GitFile[];
					unstaged?: GitFile[];
					untracked?: GitFile[];
					added?: number;
					deleted?: number;
					error?: string;
				}>("git.status", { cwd, numstat: true })
				.then(res => {
					if (cancelled) return;
					if (res?.error) {
						setGit(null);
						setGitStale(false);
						return;
					}
					setGit({
						branch: res.branch ?? null,
						ahead: res.ahead ?? 0,
						behind: res.behind ?? 0,
						staged: res.staged ?? [],
						unstaged: res.unstaged ?? [],
						untracked: res.untracked ?? [],
						added: res.added ?? 0,
						deleted: res.deleted ?? 0,
					});
					setGitStale(false);
				})
				.catch(() => {});
		};
		gitLoadRef.current = load;
		load();
		const id = window.setInterval(load, 15_000);
		return () => {
			cancelled = true;
			gitLoadRef.current = null;
			window.clearInterval(id);
		};
	}, [rpc, cwd]);
	// Flat, staged-first file list for the disclosure (a path can appear in
	// both lists — staged and then edited again; show the marker that matters
	// most, staged).
	const changedFiles = useMemo((): GitFile[] => {
		if (!git) return [];
		const seen = new Set<string>();
		const out: GitFile[] = [];
		for (const f of git.staged) {
			if (seen.has(f.path)) continue;
			seen.add(f.path);
			out.push(f);
		}
		for (const f of git.unstaged) {
			if (seen.has(f.path)) continue;
			seen.add(f.path);
			out.push(f);
		}
		for (const f of git.untracked) {
			if (seen.has(f.path)) continue;
			seen.add(f.path);
			out.push(f);
		}
		return out;
	}, [git]);

	// Branch switcher inside the git section (ZCode branch-popover parity:
	// search filter, current-branch block with the dirty-file count, and a
	// create-and-checkout action — checkout errors surface the shared toast).
	const [branchOpen, setBranchOpen] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [switching, setSwitching] = useState(false);
	const [branchQuery, setBranchQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const { anchorRef, renderMenu } = useFloatingMenu(branchOpen, setBranchOpen, { align: "right" });
	// Toggle: useFloatingMenu skips a mousedown that lands on the anchor (it
	// expects the caller's own click to close), so an open-only handler left
	// the menu impossible to dismiss from the button that opened it.
	const openBranches = useCallback((): void => {
		if (branchOpen) {
			setBranchOpen(false);
			return;
		}
		// Menu-local state resets per open (a stale filter would hide the
		// freshly loaded list).
		setBranchQuery("");
		setCreating(false);
		setNewBranchName("");
		setBranchOpen(true);
		if (!rpc || !cwd) return;
		void rpc
			.request<{ current?: string | null; branches?: string[]; error?: string }>("git.branches", { cwd })
			.then(res => {
				if (res?.error) return;
				setBranches((res?.branches ?? []).filter(b => b !== res?.current));
			})
			.catch(() => {});
	}, [branchOpen, rpc, cwd]);
	const switchBranch = useCallback(
		async (branch: string, create = false): Promise<void> => {
			const name = branch.trim();
			if (!rpc || !cwd || switching || !name) return;
			setSwitching(true);
			try {
				const res = (await rpc.request<{ ok?: boolean; error?: string }>("git.checkout", {
					cwd,
					branch: name,
					create,
				})) as { ok?: boolean; error?: string } | undefined;
				if (res?.error) {
					window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: res.error }));
				} else if (res?.ok) {
					// Every readout below describes the branch we just left.
					setGitStale(true);
					gitLoadRef.current?.();
					setBranchOpen(false);
				}
			} catch {
				// rpc error → silent (daemon offline)
			} finally {
				setSwitching(false);
			}
		},
		[rpc, cwd, switching],
	);

	// ── Subagents: live/ended split + per-agent elapsed timers ─────────────
	const live = useMemo(() => (progress ? [...progress.entries()].filter(([, p]) => isLiveAgent(p)) : []), [progress]);
	const endedCount = useMemo(
		() => (progress ? [...progress.values()].filter(p => !isLiveAgent(p)).length : 0),
		[progress],
	);
	const [endedOpen, setEndedOpen] = useState(false);
	const ended = useMemo(
		() => (progress && endedOpen ? [...progress.entries()].filter(([, p]) => !isLiveAgent(p)) : []),
		[progress, endedOpen],
	);
	// Elapsed seconds per agent id, measured from first sighting in this
	// mount (the wire payload carries no start timestamp).
	const firstSeenRef = useRef<Map<string, number>>(new Map());
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!progress) return;
		const now = Date.now();
		for (const [id, p] of progress) {
			if (isLiveAgent(p) && !firstSeenRef.current.has(id)) firstSeenRef.current.set(id, now);
		}
		const id = window.setInterval(() => setTick(n => n + 1), 1000);
		return () => window.clearInterval(id);
	}, [progress]);
	const elapsed = useCallback((agentId: string): string => {
		const start = firstSeenRef.current.get(agentId);
		if (!start) return "";
		const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
	}, []);

	// ── Todo board progress ────────────────────────────────────────────────
	const todo = useMemo(() => latestTodo(entries), [entries]);

	// Auto-fold observation (ZCode display-mode "auto"): track the transcript
	// column's width — below the threshold the EXPANDED state presents as the
	// folded header card instead of the full panel. offsetParent is the
	// positioned transcript container the stack pins to. A click on the card
	// forces the full panel until the column widens again.
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [narrow, setNarrow] = useState(false);
	const [forceFull, setForceFull] = useState(false);
	useEffect(() => {
		const host = rootRef.current?.offsetParent;
		if (!host || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(entries => {
			const w = entries[0]?.contentRect.width ?? 0;
			setNarrow(w > 0 && w < AUTO_FOLD_WIDTH);
			if (w >= AUTO_FOLD_WIDTH) setForceFull(false);
		});
		ro.observe(host);
		return () => ro.disconnect();
	}, []);

	const hasGitSection = git !== null;
	const hasAgentsSection = live.length > 0 || endedCount > 0;
	const hasTodoSection = Boolean(todo && (todo.current || working) && todo.done < todo.total);
	if (!hasGitSection && !hasAgentsSection && !hasTodoSection) return null;

	// ── Expanded panel ─────────────────────────────────────────────────────
	// ZCode status-panel parity: sectioned rows inside ONE frosted card; the
	// ⋯-strategy menu ZCode also sports has no musepi counterpart (a single
	// persisted boolean), so the panel carries just the collapse control.
	const panel =
		!collapsed && (hasGitSection || hasAgentsSection || hasTodoSection) ? (
			<HeightMorph morphKey="panel" className="gui-status-card">
				<div className="gui-status-tools">
					<button
						type="button"
						className="gui-status-tool"
						onClick={toggleCollapsed}
						aria-label={t("collapse to capsule")}
						title={t("collapse to capsule")}
					>
						<Icon name="fullscreen-exit" className="h-3.5 w-3.5" />
					</button>
				</div>
				<div className="gui-status-body">
					{hasGitSection && git && (
						<StatusSection title={t("git tools")}>
							<button
								type="button"
								className="gui-status-row"
								onClick={() => setChangesOpen(v => !v)}
								disabled={!gitStale && changedFiles.length === 0}
								aria-expanded={changesOpen}
							>
								<Icon name="file-check" className="gui-status-row-icon" />
								<span className="min-w-0 flex-1 truncate text-left">{t("workspace changes")}</span>
								{!gitStale && changedFiles.length > 0 && (
									<span className="gui-status-nums">
										{git.added > 0 && <span className="gui-status-num-add">+{git.added}</span>}
										{git.deleted > 0 && <span className="gui-status-num-del">−{git.deleted}</span>}
										{git.added === 0 && git.deleted === 0 && (
											<span className="gui-status-num-add">{changedFiles.length}</span>
										)}
									</span>
								)}
								{/* Stale window (a checkout just landed): the counts on
								    screen describe the branch we left, so this row waits
								    instead. */}
								{gitStale ? (
									<Icon name="loader-4" className="gui-status-row-icon gui-status-spin" />
								) : (
									changedFiles.length > 0 && (
										<StateIcon
											on={changesOpen}
											pair={["arrow-down-s", "arrow-right-s"]}
											className="gui-status-caret"
										/>
									)
								)}
							</button>
							<Reveal open={changesOpen && changedFiles.length > 0}>
								<div className="gui-status-files">
									{changedFiles.slice(0, CHANGED_FILES_CAP).map(f => (
										<button
											key={`${f.status}:${f.path}`}
											type="button"
											className="gui-status-file"
											onClick={() => onOpenSurface("git")}
											title={f.path}
										>
											<span
												className={`gui-status-file-badge${f.status === "??" ? " gui-status-file-badge--new" : ""}`}
											>
												{f.status.trim() || "M"}
											</span>
											<span className="min-w-0 flex-1 truncate text-left">{f.path}</span>
										</button>
									))}
									{changedFiles.length > CHANGED_FILES_CAP && (
										<button
											type="button"
											className="gui-status-file gui-status-file--more"
											onClick={() => onOpenSurface("git")}
										>
											{t("and more files", { count: changedFiles.length - CHANGED_FILES_CAP })}
										</button>
									)}
								</div>
							</Reveal>
							<div className="gui-status-row" ref={anchorRef}>
								<button type="button" className="gui-status-branch" onClick={openBranches} disabled={switching}>
									<Icon name="git-branch" className="gui-status-row-icon" />
									<span className="min-w-0 flex-1 truncate text-left">{git.branch ?? "—"}</span>
									{/* Tracking position vs upstream — the readout that makes a
									    "nothing to commit" state interpretable (openchamber
									    work-status parity). Hidden at 0/0. */}
									{!gitStale && (git.ahead > 0 || git.behind > 0) && (
										<span className="gui-status-tracks">
											{git.ahead > 0 && (
												<span className="gui-status-track-up" title={t("commits to push")}>
													↑{git.ahead}
												</span>
											)}
											{git.behind > 0 && (
												<span className="gui-status-track-down" title={t("commits to pull")}>
													↓{git.behind}
												</span>
											)}
										</span>
									)}
									<Icon name="arrow-down-s" className="gui-status-caret" />
								</button>
							</div>
							<button type="button" className="gui-status-row" onClick={() => onOpenSurface("git")}>
								<Icon name="git-commit" className="gui-status-row-icon" />
								<span className="min-w-0 flex-1 truncate text-left">{t("commit or push")}</span>
								{!gitStale && changedFiles.length > 0 && (
									<Icon name="arrow-right-s" className="gui-status-caret" />
								)}
							</button>
						</StatusSection>
					)}
					{hasAgentsSection && (
						<StatusSection
							title={t("agents")}
							trailing={
								live.length > 0 ? (
									<span className="gui-status-count gui-status-count--live">{live.length}</span>
								) : undefined
							}
						>
							{live.slice(0, 4).map(([id, p]) => {
								// Same fraction the TUI task card and the guest swarm card use,
								// so a row reads the same progress everywhere.
								const pct = Math.round(agentProgressFraction(p.progress) * 100);
								return (
									<button
										key={id}
										type="button"
										className="gui-status-row"
										onClick={() => onOpenSurface("trajectory")}
									>
										<Icon name="loader-4" className="gui-status-row-icon gui-status-spin" />
										<span className="min-w-0 flex-1 truncate text-left" title={p.task}>
											{p.agent}
											{p.task ? ` · ${p.task}` : ""}
										</span>
										<span className="gui-status-bar" aria-hidden="true">
											<span className="tv-swarm-bar-fill" style={{ width: `${pct}%` }} />
										</span>
										<span className="gui-status-elapsed">{elapsed(id)}</span>
									</button>
								);
							})}
							{endedCount > 0 && (
								<button type="button" className="gui-status-row" onClick={() => setEndedOpen(v => !v)}>
									<StateIcon
										on={endedOpen}
										pair={["arrow-down-s", "arrow-right-s"]}
										className="gui-status-row-icon"
									/>
									<span className="min-w-0 flex-1 truncate text-left">{t("ended")}</span>
									<span className="gui-status-count">{endedCount}</span>
								</button>
							)}
							{ended.map(([id, p]) => (
								<button
									key={id}
									type="button"
									className="gui-status-row gui-status-row--ended"
									onClick={() => onOpenSurface("trajectory")}
								>
									<Icon name="check" className="gui-status-row-icon" />
									<span className="min-w-0 flex-1 truncate text-left" title={p.task}>
										{p.agent}
									</span>
									<span className="gui-status-elapsed">{elapsed(id)}</span>
								</button>
							))}
						</StatusSection>
					)}
					{hasTodoSection && todo && (
						<StatusSection
							title={t("todo progress")}
							trailing={<span className="gui-status-count">{`${todo.done}/${todo.total}`}</span>}
						>
							<button type="button" className="gui-status-row" onClick={() => onOpenSurface("trajectory")}>
								<Icon name="list-check-2" className="gui-status-row-icon" />
								<span className="min-w-0 flex-1 truncate text-left" title={todo.current ?? undefined}>
									{todo.current ?? t("todo progress")}
								</span>
							</button>
						</StatusSection>
					)}
				</div>
				{renderMenu(
					<div className="gui-status-branch-menu">
						<div className="gui-status-branch-search">
							<Icon name="search" className="gui-status-branch-search-ico" />
							<input
								className="gui-status-branch-input"
								value={branchQuery}
								onChange={e => setBranchQuery(e.target.value)}
								placeholder={t("search branches")}
								spellCheck={false}
							/>
						</div>
						<div className="gui-status-branch-section">{t("branches")}</div>
						{git?.branch && (
							<div className="gui-status-branch-current">
								<Icon name="git-branch" className="gui-status-row-icon" />
								<span className="gui-status-branch-current-main">
									<span className="gui-status-branch-name">{git.branch}</span>
									{!gitStale && changedFiles.length > 0 && (
										<span className="gui-status-branch-sub">
											{t("uncommitted changes", { count: changedFiles.length })}
										</span>
									)}
								</span>
								<Icon name="check" className="gui-status-branch-check" />
							</div>
						)}
						{(() => {
							const q = branchQuery.trim().toLowerCase();
							const filtered = q ? branches.filter(b => b.toLowerCase().includes(q)) : branches;
							if (filtered.length === 0) {
								return <div className="gui-status-branch-empty">{t("no branches found")}</div>;
							}
							return filtered.map(b => (
								<button
									key={b}
									type="button"
									className="gui-status-branch-item"
									disabled={switching}
									onClick={() => void switchBranch(b)}
								>
									<Icon name="git-branch" className="gui-status-row-icon" />
									<span className="min-w-0 flex-1 truncate text-left">{b}</span>
								</button>
							));
						})()}
						<div className="gui-status-branch-sep" />
						{creating ? (
							<input
								autoFocus
								className="gui-status-branch-input gui-status-branch-new"
								value={newBranchName}
								onChange={e => setNewBranchName(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter") void switchBranch(newBranchName, true);
									if (e.key === "Escape") setCreating(false);
								}}
								placeholder={t("new branch name")}
								spellCheck={false}
								disabled={switching}
							/>
						) : (
							<button type="button" className="gui-status-branch-item" onClick={() => setCreating(true)}>
								<Icon name="add" className="gui-status-row-icon" />
								<span className="min-w-0 flex-1 truncate text-left">{t("create and checkout branch")}</span>
							</button>
						)}
					</div>,
				)}
			</HeightMorph>
		) : null;

	// Shared diff readout for the compact forms. A file can be dirty with
	// 0/0 numstat (mode/perm flips) — count files then. The stale window
	// after a checkout still shows the last numbers (one poll of lag beats
	// a blank readout — ZCode never blanks either). The chain below always
	// renders something: stats → file count → branch.
	const hasDiff = Boolean(git && (changedFiles.length > 0 || git.added > 0 || git.deleted > 0));
	const diffNums = git ? (
		<span className="gui-status-nums">
			{git.added > 0 && <span className="gui-status-num-add">+{git.added}</span>}
			{git.deleted > 0 && <span className="gui-status-num-del">−{git.deleted}</span>}
			{git.added === 0 && git.deleted === 0 && <span className="gui-status-num-add">{changedFiles.length}</span>}
		</span>
	) : null;

	// ── Collapsed capsule (the manual fold target) ──────────────────────────
	// ZCode 胶囊 parity (its 收起为胶囊 state): a ROUND pill carrying one
	// signal — 更改 + colored diff stats — with no chrome. Deliberately shaped
	// (999px radius) and worded (更改, not a section title) so it never reads
	// like the folded header card.
	const pill = collapsed ? (
		<HeightMorph morphKey="pill" className="gui-status-card gui-status-card--pill">
			<button
				type="button"
				className="gui-status-pill"
				onClick={toggleCollapsed}
				aria-label={t("expand status cards")}
				title={t("expand status cards")}
			>
				{git ? (
					hasDiff ? (
						<>
							<Icon name="file-check" className="gui-status-pill-ico" />
							<span className="gui-status-pill-label">{t("git changes")}</span>
							{diffNums}
						</>
					) : (
						<>
							<Icon name="git-branch" className="gui-status-pill-ico" />
							<span className="gui-status-pill-label">{git.branch ?? "—"}</span>
							{!gitStale && (git.ahead > 0 || git.behind > 0) && (
								<span className="gui-status-tracks">
									{git.ahead > 0 && <span className="gui-status-track-up">↑{git.ahead}</span>}
									{git.behind > 0 && <span className="gui-status-track-down">↓{git.behind}</span>}
								</span>
							)}
						</>
					)
				) : hasAgentsSection ? (
					<>
						<Icon name="ai-agent" className="gui-status-pill-ico" />
						<span className="gui-status-pill-label">{t("agents")}</span>
						<span className="gui-status-nums">{live.length}</span>
					</>
				) : (
					todo && (
						<>
							<Icon name="list-check-2" className="gui-status-pill-ico" />
							<span className="gui-status-pill-label">{t("todo progress")}</span>
							<span className="gui-status-nums">{`${todo.done}/${todo.total}`}</span>
						</>
					)
				)}
			</button>
		</HeightMorph>
	) : null;

	// ── Folded header card (auto, narrow transcript column) ─────────────────
	// ZCode folded-panel parity: the expanded state's compact presentation —
	// section label + stats inline + expand control. Clicking forces the full
	// panel for the session (until the column widens or the user collapses).
	const miniCard =
		!collapsed && narrow && !forceFull ? (
			<HeightMorph morphKey="mini" className="gui-status-card gui-status-card--mini">
				<div className="gui-status-mini">
					<button
						type="button"
						className="gui-status-mini-main"
						onClick={() => setForceFull(true)}
						aria-label={t("expand status cards")}
						title={t("expand status cards")}
					>
						{git ? (
							<>
								<span className="gui-status-mini-label">{t("git tools")}</span>
								{hasDiff ? (
									diffNums
								) : (
									<span className="gui-status-mini-sub">
										{git.branch ?? "—"}
										{!gitStale && (git.ahead > 0 || git.behind > 0) && (
											<span className="gui-status-tracks">
												{git.ahead > 0 && <span className="gui-status-track-up">↑{git.ahead}</span>}
												{git.behind > 0 && <span className="gui-status-track-down">↓{git.behind}</span>}
											</span>
										)}
									</span>
								)}
							</>
						) : hasAgentsSection ? (
							<>
								<span className="gui-status-mini-label">{t("agents")}</span>
								<span className="gui-status-nums">{live.length}</span>
							</>
						) : (
							todo && (
								<>
									<span className="gui-status-mini-label">{t("todo progress")}</span>
									<span className="gui-status-nums">{`${todo.done}/${todo.total}`}</span>
								</>
							)
						)}
					</button>
					<button
						type="button"
						className="gui-status-tool"
						onClick={() => setForceFull(true)}
						aria-label={t("expand status cards")}
						title={t("expand status cards")}
					>
						<Icon name="fullscreen" className="h-3.5 w-3.5" />
					</button>
				</div>
			</HeightMorph>
		) : null;

	const expandedForm = !narrow || forceFull ? panel : miniCard;
	return (
		<div className="gui-status-cards" ref={rootRef}>
			{collapsed ? pill : expandedForm}
		</div>
	);
}
