/**
 * GitPane — right-panel git surface: workspace changes (DiffPane), commit
 * history (GitLogPane with lane graph), and a PR/issue center (PrCenter with
 * PR and issues subtabs). Extracted from ContextPanel.tsx; the panel renders
 * <GitPanel rpc cwd /> only.
 */
import {
	CodeHighlightProvider,
	DiffBlock,
	Segmented,
	type SegmentedOption,
	type TranslationKey,
	t,
} from "@musepi/client-core";
import { useDeepScrollShadow } from "@musepi/client-core/src/lib/scroll-shadow";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard, openExternalUrl } from "../lib/electron";
import { solveGraphLanes } from "../lib/git-graph-lanes";
import { onGitPrefsChanged, readShowIgnored, writeShowIgnored } from "../lib/git-prefs";
import { useChatHighlight } from "../lib/highlight";
import { branchToTitle, prVisualState, rollupCheckState } from "../lib/pr-status";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { FadeScroll } from "./FadeScroll";
import { StateIcon } from "./StateIcon";

/** Structured commit row from the daemon git.log RPC (parsed from
 *  `git log --all --topo-order` with \x1f fields). */
interface GitLogCommit {
	hash: string;
	shortHash: string;
	author: string;
	timestamp: number;
	refs: { kind: "head" | "local" | "remote" | "tag"; name: string }[];
	parents: string[];
	subject: string;
}

/** Branch colors per graph lane (gitk-style palette). */
const GRAPH_COLORS = ["#e5484d", "#46a758", "#3e63dd", "#f76b15", "#8e4ec6", "#0091ff", "#f2b8c6", "#94a3b8"];

const GRAPH_ROW_H = 22;
const GRAPH_COL_W = 14;
const GIT_LOG_PAGE = 100;

const pad2 = (n: number): string => String(n).padStart(2, "0");

function formatCommitDate(ts: number): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const md = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
	return d.getFullYear() === now.getFullYear()
		? `${md} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
		: `${d.getFullYear()}/${md}`;
}

/** Ref badge (ZCode git-graph style): HEAD with a home marker, local
 *  branches with a branch glyph, remotes with a cloud, tags in amber. */
function GitRefBadge({ kind, name }: { kind: "head" | "local" | "remote" | "tag"; name: string }): ReactNode {
	const cls =
		kind === "head"
			? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
			: kind === "tag"
				? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
				: kind === "remote"
					? "bg-[var(--color-surface-sunken)] text-[var(--color-text-muted)]"
					: "bg-[var(--color-surface-sunken)] text-[var(--color-text)]";
	const icon = kind === "head" ? "home" : kind === "local" ? "git-branch" : kind === "remote" ? "cloud" : null;
	return (
		<span className={`flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9.5px] leading-none ${cls}`}>
			{icon && <Icon name={icon} className="h-2.5 w-2.5" />}
			{name}
		</span>
	);
}

/** Commit-graph view: lane-solved SVG rail (dots + bezier connectors) with
 *  a ZCode-style table beside it — subject with ref badges, date, author,
 *  click-to-copy short hash. */
function GitCommitGraph({
	commits,
	copied,
	onCopyHash,
}: {
	commits: GitLogCommit[];
	copied: string | null;
	onCopyHash: (hash: string) => void;
}): ReactNode {
	const layout = useMemo(() => solveGraphLanes(commits.map(c => ({ hash: c.hash, parents: c.parents }))), [commits]);
	const railW = layout.lanes * GRAPH_COL_W + 8;
	const H = layout.rows.length * GRAPH_ROW_H;
	const segs: ReactNode[] = [];
	layout.rows.forEach((row, r) => {
		const y0 = r * GRAPH_ROW_H;
		const y1 = y0 + GRAPH_ROW_H;
		for (const s of row.segments) {
			const color = GRAPH_COLORS[s.from % GRAPH_COLORS.length]!;
			const x1 = s.from * GRAPH_COL_W + 7;
			const x2 = s.to * GRAPH_COL_W + 7;
			const key = `${r}:${s.from}-${s.to}-${s.kind}`;
			if (s.from === s.to) {
				segs.push(<line key={key} x1={x1} y1={y0} x2={x2} y2={y1} stroke={color} strokeWidth={1.6} />);
			} else {
				const midY = (y0 + y1) / 2;
				segs.push(
					<path
						key={key}
						d={`M ${x1} ${y0} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y1}`}
						fill="none"
						stroke={color}
						strokeWidth={1.5}
					/>,
				);
			}
		}
	});
	layout.rows.forEach((row, r) => {
		segs.push(
			<circle
				key={`n${r}`}
				cx={row.lane * GRAPH_COL_W + 7}
				cy={r * GRAPH_ROW_H + GRAPH_ROW_H / 2}
				r={3.2}
				fill={GRAPH_COLORS[row.lane % GRAPH_COLORS.length]}
			/>,
		);
	});
	return (
		<div className="relative">
			<svg width={railW} height={H} className="absolute left-0 top-0" aria-hidden>
				{segs}
			</svg>
			<div style={{ marginLeft: railW }}>
				<div className="flex h-5 items-center gap-2 border-b border-[var(--border)] pr-1 text-[10px] text-[var(--color-text-faint)]">
					<span className="min-w-0 flex-1">{t("settings.subjectColumn")}</span>
					<span className="w-[86px] shrink-0">{t("settings.dateColumn")}</span>
					<span className="w-[72px] shrink-0">{t("settings.authorColumn")}</span>
					<span className="w-[52px] shrink-0">{t("settings.commitColumn")}</span>
				</div>
				{commits.map((c, i) => (
					<div key={`${c.hash}-${i}`} className="flex h-[22px] items-center gap-2 whitespace-nowrap pr-1">
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							{c.refs.length > 0 && (
								<span className="flex max-w-[55%] shrink items-center gap-1 overflow-hidden">
									{c.refs.map(ref => (
										<GitRefBadge key={ref.kind + ref.name} kind={ref.kind} name={ref.name} />
									))}
								</span>
							)}
							<span className="truncate text-[12px] text-[var(--color-text)]">{c.subject}</span>
						</div>
						<span className="w-[86px] shrink-0 text-[11px] text-[var(--color-text-faint)]">
							{formatCommitDate(c.timestamp)}
						</span>
						<span className="w-[72px] shrink-0 truncate text-[11px] text-[var(--color-text-faint)]">
							{c.author}
						</span>
						<button
							type="button"
							className="w-[52px] shrink-0 text-left font-mono text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
							title={copied === c.hash ? t("settings.copied") : c.hash}
							onClick={() => onCopyHash(c.hash)}
						>
							{copied === c.hash ? t("settings.copied") : c.shortHash}
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

/** Recent-commit view (right-pane git tool): structured git log via the
 *  daemon git.log RPC (lane-solved graph + ZCode-style columns), branch
 *  sync state via git.status, paged with a load-more button. */
function GitLogPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [commits, setCommits] = useState<GitLogCommit[] | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [branch, setBranch] = useState<string | null>(null);
	const [ahead, setAhead] = useState(0);
	const [behind, setBehind] = useState(0);
	const [copied, setCopied] = useState<string | null>(null);
	const skipRef = useRef(0);
	const load = useCallback(
		(mode: "reset" | "more"): void => {
			if (!rpc) return;
			if (mode === "more") setLoadingMore(true);
			else {
				setCommits(null);
				skipRef.current = 0;
			}
			const skip = skipRef.current;
			void rpc
				.request<{ commits?: GitLogCommit[]; hasMore?: boolean; error?: string }>("git.log", {
					cwd,
					limit: GIT_LOG_PAGE,
					skip: mode === "more" ? skip : 0,
				})
				.then(res => {
					if (res?.error) {
						setError(res.error);
						return;
					}
					const page = res?.commits ?? [];
					setError(null);
					setHasMore(res?.hasMore === true);
					skipRef.current = skip + page.length;
					if (mode === "more") setCommits(prev => [...(prev ?? []), ...page]);
					else setCommits(page);
				})
				.catch(err => setError(err instanceof Error ? err.message : String(err)))
				.finally(() => setLoadingMore(false));
		},
		[rpc, cwd],
	);
	useEffect(() => {
		load("reset");
		void rpc
			?.request<{ branch?: string | null; ahead?: number; behind?: number }>("git.status", { cwd })
			.then(res => {
				setBranch(res?.branch ?? null);
				setAhead(res?.ahead ?? 0);
				setBehind(res?.behind ?? 0);
			})
			.catch(() => {});
	}, [load, rpc, cwd]);
	const copyHash = useCallback((hash: string): void => {
		void navigator.clipboard?.writeText(hash).catch(() => {});
		setCopied(hash);
		window.setTimeout(() => setCopied(cur => (cur === hash ? null : cur)), 1200);
	}, []);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("settings.commitHistory")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => load("reset")}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("settings.refresh")}</span>
				</button>
			</div>
			{branch && (
				<div className="mb-1 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-1.5 text-[12px]">
					<Icon name="git-branch" className="h-3.5 w-3.5 text-[var(--color-accent)]" />
					<span className="min-w-0 flex-1 truncate font-medium">{branch}</span>
					{(ahead > 0 || behind > 0) && (
						<span className="flex-shrink-0 text-[11px] text-[var(--color-text-faint)]">
							{ahead > 0 ? `↑${ahead} ` : ""}
							{behind > 0 ? `↓${behind}` : ""}
						</span>
					)}
				</div>
			)}
			<FadeScroll className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2">
				{error ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{error}</div>
				) : commits === null ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
				) : commits.length === 0 ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("tools.noChanges")}</div>
				) : (
					<>
						<GitCommitGraph commits={commits} copied={copied} onCopyHash={copyHash} />
						{hasMore && (
							<button
								type="button"
								className="gui-pane-action mt-1 !w-full justify-center"
								disabled={loadingMore}
								onClick={() => load("more")}
							>
								<StateIcon on={loadingMore} pair={["loader-4", "arrow-down"]} className="h-3.5 w-3.5" />
								<span>{loadingMore ? t("settings.loading2") : t("settings.loadMore")}</span>
							</button>
						)}
					</>
				)}
			</FadeScroll>
		</div>
	);
}

/** Common gitmojis (subset of carloscuesta/gitmoji, bundled so the picker
 *  works offline — openchamber fetches the full list over the network). */
const GITMOJIS: { emoji: string; code: string; desc: string }[] = [
	{ emoji: "✨", code: ":sparkles:", desc: "引入新功能" },
	{ emoji: "🐛", code: ":bug:", desc: "修复 bug" },
	{ emoji: "📝", code: ":memo:", desc: "文档" },
	{ emoji: "♻️", code: ":recycle:", desc: "重构" },
	{ emoji: "✅", code: ":white_check_mark:", desc: "测试" },
	{ emoji: "🔧", code: ":wrench:", desc: "配置" },
	{ emoji: "⚡", code: ":zap:", desc: "性能" },
	{ emoji: "🎨", code: ":art:", desc: "样式/格式" },
	{ emoji: "🚀", code: ":rocket:", desc: "部署/发布" },
	{ emoji: "🔥", code: ":fire:", desc: "删除代码" },
	{ emoji: "🩹", code: ":adhesive_bandage:", desc: "简单修复" },
	{ emoji: "⬆️", code: ":arrow_up:", desc: "依赖升级" },
	{ emoji: "📦", code: ":package:", desc: "打包" },
	{ emoji: "🏗️", code: ":building_construction:", desc: "结构调整" },
	{ emoji: "💄", code: ":lipstick:", desc: "UI 样式" },
	{ emoji: "🌐", code: ":globe_with_meridians:", desc: "国际化" },
	{ emoji: "🔒", code: ":lock:", desc: "安全" },
	{ emoji: "💥", code: ":boom:", desc: "破坏性变更" },
	{ emoji: "👷", code: ":construction_worker:", desc: "CI" },
];

/** Commit identity wire shape (settings Git tab 身份, localStorage). */
interface GitCommitIdentity {
	id: string;
	name: string;
	email: string;
}

/** Workspace-changes view (right-pane diff tool): a staged/unstaged/
 *  untracked file tree (openchamber ChangesPanel parity) with per-file
 *  unified diffs, fed by the daemon git.status + git.diff RPCs. Rows
 *  carry stage/unstage actions, and the header offers flat/tree view,
 *  gitignored display and a commit dialog (subject + bundled gitmoji
 *  picker + the settings-configured default identity). */
function DiffPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [status, setStatus] = useState<{
		root: string;
		branch: string | null;
		staged: { path: string; status: string }[];
		unstaged: { path: string; status: string }[];
		untracked: { path: string; status: string }[];
		ignored?: { path: string; status: string }[];
		error?: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [fileDiff, setFileDiff] = useState<{ staged: string; unstaged: string } | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const highlight = useChatHighlight();
	// openchamber GitSettings parity: flat/tree view, show-gitignored and
	// gitmoji picker — localStorage keys shared with the settings Git tab.
	const [view, setView] = useState<"flat" | "tree">(() =>
		localStorage.getItem("musepi-gui-git-view") === "tree" ? "tree" : "flat",
	);
	const [showIgnored, setShowIgnored] = useState<boolean>(() => readShowIgnored());
	// The Files pane and the Git tab write the same pref — follow it here too.
	useEffect(() => onGitPrefsChanged(() => setShowIgnored(readShowIgnored())), []);
	const [gitmojiOn, setGitmojiOn] = useState<boolean>(() => localStorage.getItem("musepi-gui-gitmoji") !== "0");
	// Git settings (Git tab) toggles this pref and dispatches
	// omp-gitmoji-changed (same-window storage events don't fire) — keep
	// the gitmoji badges in the context panel in sync.
	useEffect(() => {
		const sync = (): void => setGitmojiOn(localStorage.getItem("musepi-gui-gitmoji") !== "0");
		window.addEventListener("omp-gitmoji-changed", sync);
		return () => window.removeEventListener("omp-gitmoji-changed", sync);
	}, []);
	const [commitOpen, setCommitOpen] = useState(false);
	const [commitMsg, setCommitMsg] = useState("");
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | null>(null);
	const [treeOpen, setTreeOpen] = useState<Set<string>>(new Set());
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<typeof status>("git.status", { ignored: showIgnored, cwd })
			.then(res => {
				setStatus(res ?? null);
				setLoading(false);
			})
			.catch(err => {
				setStatus({
					root: "",
					branch: null,
					staged: [],
					unstaged: [],
					untracked: [],
					error: err instanceof Error ? err.message : String(err),
				});
				setLoading(false);
			});
	}, [rpc, showIgnored, cwd]);
	useEffect(load, [load]);
	const openFile = (path: string): void => {
		if (openPath === path) {
			setOpenPath(null);
			setFileDiff(null);
			return;
		}
		setOpenPath(path);
		setFileDiff(null);
		setDiffLoading(true);
		void rpc
			.request<{ staged: string; unstaged: string }>("git.diff", { path, maxLines: 400, cwd })
			.then(res => {
				setFileDiff(res ?? { staged: "", unstaged: "" });
				setDiffLoading(false);
			})
			.catch(() => setDiffLoading(false));
	};
	const stagePaths = async (paths: string[], stage: boolean): Promise<void> => {
		if (!rpc) return;
		await rpc.request(stage ? "git.stage" : "git.unstage", { paths, cwd }).catch(() => {});
		await load();
	};
	const runCommit = async (): Promise<void> => {
		if (!rpc || !commitMsg.trim()) return;
		setCommitting(true);
		setCommitError(null);
		try {
			const raw = localStorage.getItem("musepi-gui-git-identities");
			let identity: GitCommitIdentity | undefined;
			if (raw) {
				const all = JSON.parse(raw) as GitCommitIdentity[];
				const def = localStorage.getItem("musepi-gui-git-default-identity");
				identity = all.find(i => i.id === def) ?? all[0];
			}
			const res = await rpc.request<{ ok?: boolean; error?: string }>("git.commit", {
				message: commitMsg.trim(),
				identity: identity ? { name: identity.name, email: identity.email } : undefined,
				cwd,
			});
			if (res?.error) {
				setCommitError(res.error);
				return;
			}
			setCommitOpen(false);
			setCommitMsg("");
			await load();
		} catch (err) {
			setCommitError(err instanceof Error ? err.message : String(err));
		} finally {
			setCommitting(false);
		}
	};

	const statusBadge = (code: string): string => {
		const m: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", "??": "?", "!!": "!" };
		return m[code] ?? code;
	};
	const FileRow = ({
		file,
		group,
	}: {
		file: { path: string; status: string };
		group: "staged" | "unstaged" | "untracked" | "ignored";
	}): ReactNode => {
		const open = openPath === file.path;
		const cls =
			group === "staged"
				? "gui-changes-badge--staged"
				: group === "untracked"
					? "gui-changes-badge--untracked"
					: group === "ignored"
						? "gui-changes-badge--ignored"
						: "";
		return (
			<div key={file.path} className="gui-changes-row-wrap">
				<button
					type="button"
					className={`gui-changes-row${open ? " gui-changes-row--open" : ""}`}
					onClick={() => openFile(file.path)}
				>
					<span className={`gui-changes-badge ${cls}`}>{statusBadge(file.status)}</span>
					<span className="min-w-0 flex-1 truncate text-left">{file.path}</span>
					{group !== "ignored" &&
						(group === "staged" ? (
							<span
								className="gui-changes-act"
								title={t("general.unstage")}
								aria-label={t("general.unstage")}
								onClick={e => {
									e.stopPropagation();
									void stagePaths([file.path], false);
								}}
							>
								<Icon name="arrow-left-s" className="h-3.5 w-3.5" />
							</span>
						) : (
							<span
								className="gui-changes-act"
								title={t("general.stage")}
								aria-label={t("general.stage")}
								onClick={e => {
									e.stopPropagation();
									void stagePaths([file.path], true);
								}}
							>
								<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
							</span>
						))}
					<StateIcon
						on={open}
						pair={["arrow-down", "arrow-right"]}
						className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
					/>
				</button>
				{open && (
					<div className="gui-changes-file-diff overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2 font-mono text-[11px] leading-relaxed">
						{diffLoading ? (
							<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">
								{t("settings.loading2")}
							</div>
						) : (
							<CodeHighlightProvider highlight={highlight}>
								{fileDiff?.staged ? <DiffBlock diff={fileDiff.staged} /> : null}
								{fileDiff?.unstaged ? <DiffBlock diff={fileDiff.unstaged} /> : null}
								{!fileDiff?.staged && !fileDiff?.unstaged && (
									<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">
										{t("tools.noChanges")}
									</div>
								)}
							</CodeHighlightProvider>
						)}
					</div>
				)}
			</div>
		);
	};
	/** openchamber changesTree parity: group rows by their first path
	 *  segment; a collapsed directory hides its children. */
	const groupRows = (
		files: { path: string; status: string }[],
		group: "staged" | "unstaged" | "untracked" | "ignored",
	): ReactNode[] => {
		if (view === "flat") return files.map(f => FileRow({ file: f, group }));
		const dirs = new Map<string, { path: string; status: string }[]>();
		const roots: { path: string; status: string }[] = [];
		for (const f of files) {
			const seg = f.path.split("/");
			if (seg.length > 1) {
				const list = dirs.get(seg[0]) ?? [];
				list.push(f);
				dirs.set(seg[0], list);
			} else {
				roots.push(f);
			}
		}
		return [
			...roots.map(f => FileRow({ file: f, group })),
			...[...dirs.entries()].map(([dir, entries]) => {
				const open = treeOpen.has(dir);
				return (
					<div key={dir}>
						<button
							type="button"
							className="gui-changes-row gui-changes-row--dir"
							onClick={() => {
								const next = new Set(treeOpen);
								if (open) next.delete(dir);
								else next.add(dir);
								setTreeOpen(next);
							}}
						>
							<Icon name="folder" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
							<span className="min-w-0 flex-1 truncate text-left font-medium">{dir}/</span>
							<span className="text-[11px] text-[var(--color-text-faint)]">{entries.length}</span>
							<StateIcon
								on={open}
								pair={["arrow-down", "arrow-right"]}
								className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
							/>
						</button>
						{open && entries.map(f => FileRow({ file: f, group }))}
					</div>
				);
			}),
		];
	};

	if (loading) {
		return <div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>;
	}
	if (status?.error || !status?.root) {
		return (
			<div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">
				{status?.error ?? t("tools.notGitRepository")}
			</div>
		);
	}
	const total = status.staged.length + status.unstaged.length + status.untracked.length;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("settings.workspaceChanges")}</span>
				<div className="ml-auto flex items-center gap-0.5">
					{/* openchamber GitSettings parity: flat/tree changes view */}
					<button
						type="button"
						className={`gui-pane-tool${view === "flat" ? " gui-pane-tool--active" : ""}`}
						title={t("general.flatList")}
						aria-label={t("general.flatList")}
						onClick={() => {
							setView("flat");
							localStorage.setItem("musepi-gui-git-view", "flat");
						}}
					>
						<Icon name="align-justify" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-pane-tool${view === "tree" ? " gui-pane-tool--active" : ""}`}
						title={t("general.treeView")}
						aria-label={t("general.treeView")}
						onClick={() => {
							setView("tree");
							localStorage.setItem("musepi-gui-git-view", "tree");
						}}
					>
						<Icon name="node-tree" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-pane-tool${showIgnored ? " gui-pane-tool--active" : ""}`}
						title={t("general.showGitignored")}
						aria-label={t("general.showGitignored")}
						onClick={() => {
							const next = !showIgnored;
							setShowIgnored(next);
							writeShowIgnored(next);
						}}
					>
						<StateIcon on={showIgnored} pair={["eye", "eye-off"]} className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className="gui-pane-tool"
						title={t("settings.refresh")}
						aria-label={t("settings.refresh")}
						onClick={load}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-btn !h-6 !px-2 !py-0 !text-[11.5px]${status.staged.length === 0 ? " opacity-50" : ""}`}
						disabled={status.staged.length === 0}
						onClick={() => {
							setCommitOpen(true);
							setCommitError(null);
						}}
					>
						<Icon name="git-commit" className="h-3 w-3" />
						{t("general.commit")}
					</button>
				</div>
			</div>
			{commitOpen && (
				<div className="gui-commit-box mb-1 rounded-lg border border-[var(--border)] bg-[var(--color-surface-raised)] p-2">
					<textarea
						className="gui-input min-h-[64px] w-full resize-y text-[12.5px]"
						value={commitMsg}
						placeholder={t("general.commitMessage")}
						onChange={e => setCommitMsg(e.target.value)}
						autoFocus
						onKeyDown={e => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void runCommit();
							else if (e.key === "Escape") setCommitOpen(false);
						}}
					/>
					{gitmojiOn && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{GITMOJIS.map(g => (
								<button
									key={g.code}
									type="button"
									className="gui-gitmoji-chip"
									title={`${g.emoji} ${g.desc}`}
									aria-label={g.desc}
									onClick={() => setCommitMsg(prev => `${prev}${prev ? " " : ""}${g.code} `)}
								>
									<span>{g.emoji}</span>
								</button>
							))}
						</div>
					)}
					{commitError && <div className="mt-1.5 text-[12px] text-[var(--color-danger)]">{commitError}</div>}
					<div className="mt-2 flex items-center justify-end gap-2">
						<span className="mr-auto text-[11.5px] text-[var(--color-text-faint)]">
							{t("general.stagedCount", { count: String(status.staged.length) })}
						</span>
						<button type="button" className="gui-btn" onClick={() => setCommitOpen(false)}>
							{t("settings.cancel")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={committing || !commitMsg.trim()}
							onClick={() => void runCommit()}
						>
							{committing ? t("general.committing") : t("general.commit")}
						</button>
					</div>
				</div>
			)}
			{total === 0 && !showIgnored ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("tools.noChanges")}</div>
			) : (
				<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{status.staged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-1">
								{t("general.staged")} · {status.staged.length}
							</div>
							{groupRows(status.staged, "staged")}
						</>
					)}
					{status.unstaged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("general.unstaged")} · {status.unstaged.length}
							</div>
							{groupRows(status.unstaged, "unstaged")}
						</>
					)}
					{status.untracked.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("general.untracked")} · {status.untracked.length}
							</div>
							{groupRows(status.untracked, "untracked")}
						</>
					)}
					{showIgnored && (status.ignored?.length ?? 0) > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("general.ignored")} · {status.ignored?.length}
							</div>
							{groupRows(status.ignored ?? [], "ignored")}
						</>
					)}
					{total === 0 && (status.ignored?.length ?? 0) === 0 && (
						<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("tools.noChanges")}</div>
					)}
				</FadeScroll>
			)}
		</div>
	);
}

/** gh PR shape shared by the list and the current-branch card (the daemon
 *  passes gh's --json fields through; the check rollup stays opaque until
 *  rollupCheckState folds it). */
interface GhPr {
	number: number;
	title: string;
	author: { login: string };
	isDraft: boolean;
	state: string;
	headRefName: string;
	baseRefName: string;
	url: string;
	statusCheckRollup?: unknown;
	mergeable?: boolean;
	mergeStateStatus?: string;
	reviewDecision?: string;
}

/** Check-state line (dot + label) shared by the card and the list rows. */
function PrChecks({ rollup }: { rollup: unknown }): ReactNode {
	const state = rollupCheckState(rollup);
	const labelKey =
		state === null
			? "pr no checks"
			: state === "success"
				? "pr checks passing"
				: state === "failure"
					? "pr checks failing"
					: "pr checks pending";
	return (
		<span
			className={`gui-pr-check${state ? ` gui-pr-check--${state}` : " gui-pr-check--none"}`}
			role="img"
			aria-label={t(labelKey as TranslationKey)}
			title={t(labelKey as TranslationKey)}
		>
			{state && <span className="gui-pr-check-dot" aria-hidden="true" />}
			{t(labelKey as TranslationKey)}
		</span>
	);
}

/** Merge/review side of the card: conflicts first, then mergeability, then
 *  the review verdict — one line, skipping whatever gh didn't report. */
function PrMergeLine({ pr }: { pr: GhPr }): ReactNode {
	const reviewKey =
		pr.reviewDecision === "APPROVED"
			? "pr review approved"
			: pr.reviewDecision === "CHANGES_REQUESTED"
				? "pr review changes"
				: pr.reviewDecision === "REVIEW_REQUIRED"
					? "pr review required"
					: null;
	if (pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "CONFLICTING") {
		return <span className="gui-pr-merge gui-pr-merge--conflict">{t("pr has conflicts")}</span>;
	}
	return (
		<>
			{pr.mergeable === true && <span className="gui-pr-merge gui-pr-merge--ok">{t("pr mergeable")}</span>}
			{reviewKey && <span className="gui-pr-review">{t(reviewKey as TranslationKey)}</span>}
		</>
	);
}

/** Create-as-draft preference (last choice wins, ready by default). */
const CREATE_AS_DRAFT_KEY = "musepi-gui-pr-draft";
function readCreateAsDraft(): boolean {
	try {
		return localStorage.getItem(CREATE_AS_DRAFT_KEY) === "1";
	} catch {
		return false;
	}
}

/** Prefer main → master → first branch for the create form's base. */
function pickDefaultBase(branches: string[]): string {
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";
	return branches[0] ?? "";
}

/** Create form for a branch that has no PR yet: title (derived from the
 *  branch name, editable), body, base branch, remembered draft switch.
 *  Push first, then create — a PR for an unpushed branch fails anyway. */
function PrCreateForm({
	rpc,
	cwd,
	branch,
	ahead,
	branches,
	onCreated,
}: {
	rpc: RpcClient;
	cwd: string;
	branch: string | null;
	ahead: number;
	branches: string[];
	onCreated(url: string): void;
}): ReactNode {
	const [title, setTitle] = useState(() => (branch ? branchToTitle(branch) : ""));
	useEffect(() => {
		setTitle(branch ? branchToTitle(branch) : "");
	}, [branch]);
	const [body, setBody] = useState("");
	const [base, setBase] = useState(() => pickDefaultBase(branches));
	useEffect(() => {
		setBase(pickDefaultBase(branches));
	}, [branches]);
	const [draft, setDraft] = useState<boolean>(readCreateAsDraft);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const create = async (): Promise<void> => {
		if (!title.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const push = await rpc.request<{ ok?: boolean; error?: string }>("git.push", { cwd }).catch(() => null);
			if (push && push.ok === false) {
				setError(push.error ?? "git push failed");
				return;
			}
			const res = await rpc
				.request<{ url?: string; error?: string }>("github.prCreate", {
					cwd,
					title: title.trim(),
					body,
					base,
					draft,
				})
				.catch(() => null);
			if (res?.url) onCreated(res.url);
			else setError(res?.error ?? "gh pr create failed");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="gui-pr-create">
			<div className="gui-pr-create-hint">
				{t("no pr for branch")}
				{ahead > 0 && (
					<span className="gui-pr-ahead">
						{t("pr ahead count", {
							count: ahead,
						})}
					</span>
				)}
			</div>
			<input
				className="gui-input w-full"
				value={title}
				onChange={e => setTitle(e.target.value)}
				placeholder={t("pr title placeholder")}
				aria-label={t("pr title placeholder")}
			/>
			<div className="gui-pr-create-row">
				<select
					className="gui-input gui-pr-base"
					value={base}
					onChange={e => setBase(e.target.value)}
					aria-label={t("pr base branch")}
					title={t("pr base branch")}
				>
					{branches.map(b => (
						<option key={b} value={b}>
							{b}
						</option>
					))}
				</select>
				<label className="gui-pr-draft">
					<input
						type="checkbox"
						checked={draft}
						onChange={e => {
							setDraft(e.target.checked);
							try {
								localStorage.setItem(CREATE_AS_DRAFT_KEY, e.target.checked ? "1" : "0");
							} catch {
								// convenience only
							}
						}}
					/>
					{t("create as draft")}
				</label>
			</div>
			<textarea
				className="gui-input gui-pr-body w-full"
				value={body}
				onChange={e => setBody(e.target.value)}
				placeholder={t("pr description")}
				aria-label={t("pr description")}
				rows={4}
			/>
			{error && <div className="gui-pr-error">{error}</div>}
			<button
				type="button"
				className="gui-pane-action !w-auto px-3"
				disabled={busy || !title.trim()}
				onClick={() => void create()}
			>
				{busy ? (
					<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
				) : (
					<Icon name="git-pull-request" className="h-3.5 w-3.5" />
				)}
				<span>{t("push and create")}</span>
			</button>
		</div>
	);
}

/** Pull-request center (right-pane PR tool): the current branch's PR card
 *  (or the create form when there is none) over the repo's PR list. All gh
 *  calls go through the daemon with the machine's own credentials. */
function PrPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [data, setData] = useState<{
		pr: GhPr | null;
		prs: GhPr[];
		branch: string | null;
		ahead: number;
		branches: string[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void Promise.all([
			rpc.request<{ pr?: GhPr | null; error?: string }>("github.prStatus", { cwd }).catch(() => null),
			rpc.request<{ prs?: GhPr[]; error?: string }>("github.prs", { cwd }).catch(() => null),
			rpc
				.request<{ branch?: string | null; ahead?: number; error?: string }>("git.status", { cwd })
				.catch(() => null),
			rpc.request<{ branches?: string[]; error?: string }>("git.branches", { cwd }).catch(() => null),
		]).then(([statusRes, listRes, gitRes, branchesRes]) => {
			setError(statusRes?.error ?? listRes?.error ?? null);
			setData({
				pr: statusRes?.pr === undefined ? null : statusRes.pr,
				prs: listRes?.prs ?? [],
				branch: gitRes?.branch ?? null,
				ahead: gitRes?.ahead ?? 0,
				branches: branchesRes?.branches ?? [],
			});
			setLoading(false);
		});
	}, [rpc, cwd]);
	useEffect(load, [load]);
	const refresh = useCallback((): void => load(), [load]);
	const pr = data?.pr ?? null;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("settings.pullRequests")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={refresh}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("settings.refresh")}</span>
				</button>
			</div>
			{error ? (
				<div className="px-2 py-5 text-[12.5px] leading-relaxed text-[var(--color-text-faint)]">{error}</div>
			) : loading ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
			) : data ? (
				<FadeScroll className="min-h-0 flex-1 overflow-y-auto">
					{pr ? (
						<div className="gui-pr-card">
							<div className="flex min-w-0 items-center gap-2">
								<span className={`gui-changes-badge gui-pr-badge--${prVisualState(pr)}`}>
									{pr.isDraft ? "D" : pr.state === "MERGED" ? "M" : pr.state === "CLOSED" ? "X" : "O"}
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] font-medium">
									<span className="text-[var(--color-text-faint)]">#{pr.number}</span> {pr.title}
								</span>
							</div>
							<div className="gui-pr-meta">
								<PrChecks rollup={pr.statusCheckRollup} />
								<PrMergeLine pr={pr} />
							</div>
							<div className="gui-pr-actions">
								<button
									type="button"
									className="gui-pane-action !w-auto px-2"
									onClick={() => void openExternalUrl(pr.url)}
								>
									<Icon name="external-link" className="h-3.5 w-3.5" />
									<span>{t("open in browser")}</span>
								</button>
								<button
									type="button"
									className="gui-pane-action !w-auto px-2"
									onClick={() => void copyToClipboard(pr.url)}
								>
									<Icon name="clipboard" className="h-3.5 w-3.5" />
									<span>{t("copy link")}</span>
								</button>
							</div>
						</div>
					) : (
						<PrCreateForm
							rpc={rpc}
							cwd={cwd}
							branch={data.branch}
							ahead={data.ahead}
							branches={data.branches.filter(b => b !== data.branch)}
							onCreated={url => {
								refresh();
								void openExternalUrl(url);
							}}
						/>
					)}
					{data.prs.length > 0 && (
						<div className="m-1.5 rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
							{data.prs.map(pr => (
								<button
									key={pr.number}
									type="button"
									className="gui-changes-row"
									onClick={() => {
										// Open the PR in the SYSTEM browser (Electron
										// shell.openExternal; window.open fallback for
										// plain-browser dev).
										void openExternalUrl(pr.url);
									}}
								>
									<span className={`gui-changes-badge gui-pr-badge--${prVisualState(pr)}`}>
										{pr.isDraft ? "D" : pr.state === "MERGED" ? "M" : pr.state === "CLOSED" ? "X" : "O"}
									</span>
									<span className="min-w-0 flex-1 truncate text-left">
										<span className="text-[var(--color-text-faint)]">#{pr.number}</span> {pr.title}
									</span>
									{rollupCheckState(pr.statusCheckRollup) !== null && (
										<span
											className={`gui-pr-check-dot gui-pr-check-dot--${rollupCheckState(pr.statusCheckRollup)}`}
											role="img"
											aria-label={t(
												(rollupCheckState(pr.statusCheckRollup) === "success"
													? "pr checks passing"
													: rollupCheckState(pr.statusCheckRollup) === "failure"
														? "pr checks failing"
														: "pr checks pending") as TranslationKey,
											)}
											title={t(
												(rollupCheckState(pr.statusCheckRollup) === "success"
													? "pr checks passing"
													: rollupCheckState(pr.statusCheckRollup) === "failure"
														? "pr checks failing"
														: "pr checks pending") as TranslationKey,
											)}
										/>
									)}
									<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
										{pr.headRefName} → {pr.baseRefName}
									</span>
								</button>
							))}
						</div>
					)}
				</FadeScroll>
			) : null}
		</div>
	);
}

/** Issue row from the daemon github.issues RPC (gh --json passthrough). */
interface GhIssue {
	number: number;
	title: string;
	state: string;
	author: { login: string };
	labels: { name: string; color: string }[];
	updatedAt: string;
	url: string;
	comments: unknown[];
}

const ISSUE_STATE_SEGMENTS: SegmentedOption<"open" | "closed" | "all">[] = [
	{ value: "open", label: t("state open") },
	{ value: "closed", label: t("state closed") },
	{ value: "all", label: t("state all") },
];

/** Issues subtab: state filter + the repo's issue list (gh CLI via the
 *  daemon, same credentials as the PR pane). */
function IssuesPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [state, setState] = useState<"open" | "closed" | "all">("open");
	const [issues, setIssues] = useState<GhIssue[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<{ issues?: GhIssue[]; error?: string }>("github.issues", { cwd, state })
			.then(res => {
				setIssues(res?.issues ?? []);
				setError(res?.error ?? null);
				setLoading(false);
			})
			.catch(err => {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
	}, [rpc, cwd, state]);
	useEffect(load, [load]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-2 px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("issues")}</span>
				<Segmented<"open" | "closed" | "all">
					ariaLabel={t("issues")}
					value={state}
					options={ISSUE_STATE_SEGMENTS}
					onChange={setState}
				/>
			</div>
			{error ? (
				<div className="px-2 py-5 text-[12.5px] leading-relaxed text-[var(--color-text-faint)]">{error}</div>
			) : loading ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
			) : issues && issues.length > 0 ? (
				<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{issues.map(issue => (
						<button
							key={issue.number}
							type="button"
							className="gui-changes-row"
							onClick={() => void openExternalUrl(issue.url)}
						>
							<span
								className={`gui-changes-badge ${issue.state === "open" ? "gui-pr-badge--open" : "gui-pr-badge--merged"}`}
							>
								{issue.state === "open" ? "O" : "C"}
							</span>
							<span className="min-w-0 flex-1 truncate text-left">
								<span className="text-[var(--color-text-faint)]">#{issue.number}</span> {issue.title}
							</span>
							{issue.labels.slice(0, 3).map(label => (
								<span
									key={label.name}
									className="gui-issue-label"
									style={{
										background: `#${label.color}22`,
										color: `#${label.color}`,
										borderColor: `#${label.color}44`,
									}}
								>
									{label.name}
								</span>
							))}
							{issue.comments.length > 0 && (
								<span className="flex flex-shrink-0 items-center gap-0.5 text-[10.5px] text-[var(--color-text-faint)]">
									<Icon name="chat-1" className="h-3 w-3" />
									{issue.comments.length}
								</span>
							)}
							<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
								{new Date(issue.updatedAt).toLocaleDateString()}
							</span>
						</button>
					))}
				</FadeScroll>
			) : (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no open issues")}</div>
			)}
		</div>
	);
}

/** PR surface tabs: pull requests / issues (choice persisted locally). */
type PrCenterTab = "prs" | "issues";
const PR_CENTER_TAB_KEY = "musepi-gui-prcenter-tab";
function PrCenter({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [tab, setTab] = useState<PrCenterTab>(() => {
		try {
			return localStorage.getItem(PR_CENTER_TAB_KEY) === "issues" ? "issues" : "prs";
		} catch {
			return "prs";
		}
	});
	const pick = (next: PrCenterTab): void => {
		setTab(next);
		try {
			localStorage.setItem(PR_CENTER_TAB_KEY, next);
		} catch {
			// convenience only
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="gui-pane-subtabs" role="tablist" aria-label={t("settings.pullRequests")}>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "prs"}
					className={`gui-pane-subtab${tab === "prs" ? " gui-pane-subtab--active" : ""}`}
					onClick={() => pick("prs")}
				>
					{t("pull requests")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "issues"}
					className={`gui-pane-subtab${tab === "issues" ? " gui-pane-subtab--active" : ""}`}
					onClick={() => pick("issues")}
				>
					{t("issues")}
				</button>
			</div>
			<div className="min-h-0 flex-1">
				{tab === "prs" ? <PrPane rpc={rpc} cwd={cwd} /> : <IssuesPane rpc={rpc} cwd={cwd} />}
			</div>
		</div>
	);
}

/**
 * Single rail "git" surface (Phase 3 merge of the former git/diff/pr
 * surfaces): a view-local sub-tab bar — workspace changes / commit
 * history / pull requests — over the merged panes. The rail stays the
 * single navigation axis; these tabs switch content *within* the surface.
 */
type GitPaneTab = "changes" | "commits" | "pr";
const GIT_PANE_TABS: Array<{ id: GitPaneTab; label: string }> = [
	{ id: "changes", label: "workspace changes" },
	{ id: "commits", label: "commit history" },
	{ id: "pr", label: "pull requests" },
];
export function GitPanel({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [tab, setTab] = useState<GitPaneTab>("changes");
	// 横向边缘羽化:文件行展开的内嵌 diff 块横向滚动时左右羽化(条件渲染
	// 的容器由深扫描的 MutationObserver 增量补挂)。
	const rootRef = useRef<HTMLDivElement | null>(null);
	useDeepScrollShadow(rootRef, ".gui-changes-file-diff");
	return (
		<div ref={rootRef} className="flex h-full min-h-0 flex-col">
			<div className="gui-pane-subtabs" role="tablist" aria-label={t("settings.git")}>
				{GIT_PANE_TABS.map(({ id, label }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						className={`gui-pane-subtab${tab === id ? " gui-pane-subtab--active" : ""}`}
						onClick={() => setTab(id)}
					>
						{t(label as TranslationKey)}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "commits" ? (
					<GitLogPane rpc={rpc} cwd={cwd} />
				) : tab === "pr" ? (
					<PrCenter rpc={rpc} cwd={cwd} />
				) : (
					<DiffPane rpc={rpc} cwd={cwd} />
				)}
			</div>
		</div>
	);
}
