import { t } from "@musepi/guest-client";
import type { SessionEntry, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { Reveal } from "./Reveal";

/** Collapse preference (renderer-local): "1" → slim pill stack. */
const COLLAPSE_KEY = "musepi-gui-status-cards";

/** One working-tree row from `git.status` (`status` is the porcelain code:
 *  `M`/`A`/`D`/`R` staged, `??` untracked, …). */
interface GitFile {
	path: string;
	status: string;
}

/** Files listed before the "+N more" rollup. */
const CHANGED_FILES_CAP = 6;

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

/**
 * Floating status-card stack pinned to the transcript's top-right corner
 * (ZCode 悬浮卡 parity): live git state (+N/−M, branch switcher, commit
 * jump), running/ended subagents with elapsed timers, and the todo-board
 * progress. Collapses to a slim pill; hidden entirely when there is
 * nothing to show. Cards are launchers — clicking through opens the
 * matching right-panel surface rather than duplicating it.
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

	// Branch switcher inside the git card (session-scene parity with the
	// welcome composer's popup — checkout errors surface the shared toast).
	const [branchOpen, setBranchOpen] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [switching, setSwitching] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(branchOpen, setBranchOpen, { align: "right" });
	// Toggle: useFloatingMenu skips a mousedown that lands on the anchor (it
	// expects the caller's own click to close), so an open-only handler left
	// the menu impossible to dismiss from the button that opened it.
	const openBranches = useCallback((): void => {
		if (branchOpen) {
			setBranchOpen(false);
			return;
		}
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
		async (branch: string): Promise<void> => {
			if (!rpc || !cwd || switching) return;
			setSwitching(true);
			try {
				const res = (await rpc.request<{ ok?: boolean; error?: string }>("git.checkout", { cwd, branch })) as
					| { ok?: boolean; error?: string }
					| undefined;
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

	const gitCard = git ? (
		<div className="gui-status-card" key="git">
			<div className="gui-status-card-head">
				<span className="gui-status-card-title">Git</span>
			</div>
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
				{/* Stale window (a checkout just landed): the counts on screen
				    describe the branch we left, so this row waits instead. */}
				{gitStale ? (
					<Icon name="loader-4" className="gui-status-row-icon gui-status-spin" />
				) : (
					changedFiles.length > 0 && (
						<Icon name={changesOpen ? "arrow-down-s" : "arrow-right-s"} className="gui-status-caret" />
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
							<span className={`gui-status-file-badge${f.status === "??" ? " gui-status-file-badge--new" : ""}`}>
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
			<button type="button" className="gui-status-row" onClick={() => onOpenSurface("git")}>
				<Icon name="git-commit" className="gui-status-row-icon" />
				<span className="min-w-0 flex-1 truncate text-left">{t("commit or push")}</span>
				{!gitStale && changedFiles.length > 0 && <Icon name="arrow-right-s" className="gui-status-caret" />}
			</button>
			{renderMenu(
				<div className="gui-status-branch-menu">
					{branches.length === 0 ? (
						<div className="gui-status-branch-empty">{t("no changes")}</div>
					) : (
						branches.map(b => (
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
						))
					)}
				</div>,
			)}
		</div>
	) : null;

	const agentsCard =
		live.length > 0 || endedCount > 0 ? (
			<div className="gui-status-card" key="agents">
				<div className="gui-status-card-head">
					<span className="gui-status-card-title">{t("agents")}</span>
					{live.length > 0 && <span className="gui-status-count gui-status-count--live">{live.length}</span>}
				</div>
				{live.slice(0, 4).map(([id, p]) => (
					<button key={id} type="button" className="gui-status-row" onClick={() => onOpenSurface("trajectory")}>
						<Icon name="loader-4" className="gui-status-row-icon gui-status-spin" />
						<span className="min-w-0 flex-1 truncate text-left" title={p.task}>
							{p.agent}
							{p.task ? ` · ${p.task}` : ""}
						</span>
						<span className="gui-status-elapsed">{elapsed(id)}</span>
					</button>
				))}{" "}
				{endedCount > 0 && (
					<button type="button" className="gui-status-row" onClick={() => setEndedOpen(v => !v)}>
						<Icon name={endedOpen ? "arrow-down-s" : "arrow-right-s"} className="gui-status-row-icon" />
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
			</div>
		) : null;

	const todoCard =
		todo && (todo.current || working) && todo.done < todo.total ? (
			<div className="gui-status-card" key="todo">
				<div className="gui-status-card-head">
					<span className="gui-status-card-title">{t("todo progress")}</span>
					<span className="gui-status-count">
						{todo.done}/{todo.total}
					</span>
				</div>
				<button type="button" className="gui-status-row" onClick={() => onOpenSurface("trajectory")}>
					<Icon name="list-check-2" className="gui-status-row-icon" />
					<span className="min-w-0 flex-1 truncate text-left" title={todo.current ?? undefined}>
						{todo.current ?? t("todo progress")}
					</span>
				</button>
			</div>
		) : null;

	const cards = [gitCard, agentsCard, todoCard].filter(Boolean);
	if (cards.length === 0) return null;

	if (collapsed) {
		return (
			<div className="gui-status-cards gui-status-cards--pill">
				<button type="button" className="gui-status-pill" onClick={toggleCollapsed} title={t("commit or push")}>
					{/* Labelled segments: a lone glyph + number is unreadable at a
					    glance (openchamber work-status panel documents the same
					    rule for its rows). */}
					{git && (
						<span className="gui-status-pill-seg">
							<Icon name="git-branch" className="h-3.5 w-3.5" />
							{live.length === 0 && !todo && <span className="gui-status-pill-label">{git.branch ?? "—"}</span>}
						</span>
					)}
					{live.length > 0 && (
						<span className="gui-status-pill-seg">
							<Icon name="ai-agent" className="h-3.5 w-3.5" />
							<span className="gui-status-pill-label">{t("agents")}</span>
							{live.length}
						</span>
					)}
					{todo && todo.done < todo.total && (
						<span className="gui-status-pill-seg">
							<Icon name="list-check-2" className="h-3.5 w-3.5" />
							<span className="gui-status-pill-label">{t("todo progress")}</span>
							{todo.done}/{todo.total}
						</span>
					)}
					<Icon name="arrow-right-s" className="h-3 w-3 opacity-60" />
				</button>
			</div>
		);
	}
	return (
		<div className="gui-status-cards">
			<button type="button" className="gui-status-collapse" onClick={toggleCollapsed} aria-label="collapse">
				<Icon name="arrow-right-s" className="h-3 w-3" />
			</button>
			{cards}
		</div>
	);
}
