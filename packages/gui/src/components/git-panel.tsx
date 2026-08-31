/**
 * GitPane — right-panel git surface: workspace changes (DiffPane), commit
 * history (GitLogPane with lane graph), pull requests (PrPane). Extracted
 * from ContextPanel.tsx; the panel renders <GitPanel rpc cwd /> only.
 */
import { CodeHighlightProvider, DiffBlock, type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { solveGraphLanes } from "../lib/git-graph-lanes";
import { useChatHighlight } from "../lib/highlight";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { FadeScroll } from "./FadeScroll";

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
					<span className="min-w-0 flex-1">{t("subject column")}</span>
					<span className="w-[86px] shrink-0">{t("date column")}</span>
					<span className="w-[72px] shrink-0">{t("author column")}</span>
					<span className="w-[52px] shrink-0">{t("commit column")}</span>
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
							title={copied === c.hash ? t("copied") : c.hash}
							onClick={() => onCopyHash(c.hash)}
						>
							{copied === c.hash ? t("copied") : c.shortHash}
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
				<span className="gui-group-label px-2">{t("commit history")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => load("reset")}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("refresh")}</span>
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
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("loading…")}</div>
				) : commits.length === 0 ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
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
								<Icon name={loadingMore ? "loader-4" : "arrow-down"} className="h-3.5 w-3.5" />
								<span>{loadingMore ? t("loading…") : t("load more")}</span>
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
	const [showIgnored, setShowIgnored] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-git-show-ignored") === "1",
	);
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
								title={t("unstage")}
								aria-label={t("unstage")}
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
								title={t("stage")}
								aria-label={t("stage")}
								onClick={e => {
									e.stopPropagation();
									void stagePaths([file.path], true);
								}}
							>
								<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
							</span>
						))}
					<Icon
						name={open ? "arrow-down" : "arrow-right"}
						className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
					/>
				</button>
				{open && (
					<div className="gui-changes-file-diff overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2 font-mono text-[11px] leading-relaxed">
						{diffLoading ? (
							<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">{t("loading…")}</div>
						) : (
							<CodeHighlightProvider highlight={highlight}>
								{fileDiff?.staged ? <DiffBlock diff={fileDiff.staged} /> : null}
								{fileDiff?.unstaged ? <DiffBlock diff={fileDiff.unstaged} /> : null}
								{!fileDiff?.staged && !fileDiff?.unstaged && (
									<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">{t("no changes")}</div>
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
							<Icon
								name={open ? "arrow-down" : "arrow-right"}
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
		return <div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">{t("loading…")}</div>;
	}
	if (status?.error || !status?.root) {
		return (
			<div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">
				{status?.error ?? t("not a git repository")}
			</div>
		);
	}
	const total = status.staged.length + status.unstaged.length + status.untracked.length;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("workspace changes")}</span>
				<div className="ml-auto flex items-center gap-0.5">
					{/* openchamber GitSettings parity: flat/tree changes view */}
					<button
						type="button"
						className={`gui-pane-tool${view === "flat" ? " gui-pane-tool--active" : ""}`}
						title={t("flat list")}
						aria-label={t("flat list")}
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
						title={t("tree view")}
						aria-label={t("tree view")}
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
						title={t("show gitignored")}
						aria-label={t("show gitignored")}
						onClick={() => {
							const next = !showIgnored;
							setShowIgnored(next);
							localStorage.setItem("musepi-gui-git-show-ignored", next ? "1" : "0");
						}}
					>
						<Icon name="eye-off" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className="gui-pane-tool"
						title={t("refresh")}
						aria-label={t("refresh")}
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
						{t("commit")}
					</button>
				</div>
			</div>
			{commitOpen && (
				<div className="gui-commit-box mb-1 rounded-lg border border-[var(--border)] bg-[var(--color-surface-raised)] p-2">
					<textarea
						className="gui-input min-h-[64px] w-full resize-y text-[12.5px]"
						value={commitMsg}
						placeholder={t("commit message")}
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
							{t("staged count", { count: String(status.staged.length) })}
						</span>
						<button type="button" className="gui-btn" onClick={() => setCommitOpen(false)}>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={committing || !commitMsg.trim()}
							onClick={() => void runCommit()}
						>
							{committing ? t("committing…") : t("commit")}
						</button>
					</div>
				</div>
			)}
			{total === 0 && !showIgnored ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
			) : (
				<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{status.staged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-1">
								{t("staged")} · {status.staged.length}
							</div>
							{groupRows(status.staged, "staged")}
						</>
					)}
					{status.unstaged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("unstaged")} · {status.unstaged.length}
							</div>
							{groupRows(status.unstaged, "unstaged")}
						</>
					)}
					{status.untracked.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("untracked")} · {status.untracked.length}
							</div>
							{groupRows(status.untracked, "untracked")}
						</>
					)}
					{showIgnored && (status.ignored?.length ?? 0) > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("ignored")} · {status.ignored?.length}
							</div>
							{groupRows(status.ignored ?? [], "ignored")}
						</>
					)}
					{total === 0 && (status.ignored?.length ?? 0) === 0 && (
						<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
					)}
				</FadeScroll>
			)}
		</div>
	);
}

/** Pull-request view (right-pane PR tool): `gh pr list` via the daemon,
 *  with a clear message when the CLI is missing. */
function PrPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [prs, setPrs] = useState<
		| {
				number: number;
				title: string;
				author: { login: string };
				isDraft: boolean;
				state: string;
				headRefName: string;
				baseRefName: string;
				url: string;
		  }[]
		| null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<{ prs?: typeof prs; error?: string }>("github.prs", { cwd })
			.then(res => {
				setPrs(res?.prs ?? []);
				setError(res?.error ?? null);
				setLoading(false);
			})
			.catch(err => {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
	}, [rpc]);
	useEffect(load, [load]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("pull requests")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={load}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("refresh")}</span>
				</button>
			</div>
			{error ? (
				<div className="px-2 py-5 text-[12.5px] leading-relaxed text-[var(--color-text-faint)]">{error}</div>
			) : loading ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("loading…")}</div>
			) : prs && prs.length > 0 ? (
				<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{prs.map(pr => (
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
							<span
								className={`gui-changes-badge gui-pr-badge--${pr.isDraft ? "draft" : pr.state === "OPEN" ? "open" : "merged"}`}
							>
								{pr.isDraft ? "D" : pr.state === "OPEN" ? "O" : "M"}
							</span>
							<span className="min-w-0 flex-1 truncate text-left">
								<span className="text-[var(--color-text-faint)]">#{pr.number}</span> {pr.title}
							</span>
							<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
								{pr.headRefName} → {pr.baseRefName}
							</span>
						</button>
					))}
				</FadeScroll>
			) : (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no open pull requests")}</div>
			)}
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
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="gui-pane-subtabs" role="tablist" aria-label={t("git")}>
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
					<PrPane rpc={rpc} cwd={cwd} />
				) : (
					<DiffPane rpc={rpc} cwd={cwd} />
				)}
			</div>
		</div>
	);
}
