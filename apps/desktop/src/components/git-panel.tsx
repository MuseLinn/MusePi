/**
 * GitPane — right-panel git surface: workspace changes (DiffPane) and
 * commit history (GitLogPane with lane graph). The PR/issue center lives in
 * the main view (PrBoardPage), not here. Extracted from ContextPanel.tsx;
 * the panel renders <GitPanel rpc cwd /> only.
 */
import { CodeHighlightProvider, DiffBlock, type TranslationKey, t } from "@musepi/client-core";
import { useDeepScrollShadow } from "@musepi/client-core/src/lib/scroll-shadow";
import {
	ArrowDown as ArrowDownIconData,
	ArrowUp as ArrowUpIconData,
	Check as CheckIconData,
	ChevronDown as ChevronDownIconData,
	ChevronRight as ChevronRightIconData,
	CloudDownload as CloudDownloadIconData,
	LoaderCircle as LoaderCircleIconData,
	X as XIconData,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { solveGraphLanes } from "../lib/git-graph-lanes";
import { type ChangesView, onGitPrefsChanged, readChangesView, writeChangesView } from "../lib/git-prefs";
import { consumeRequestedGitRoot, GIT_ROOT_EVENT } from "../lib/git-root";
import { invalidateGitStatus, onGitStatusChanged } from "../lib/git-status-cache";
import { useChatHighlight } from "../lib/highlight";
import { pathBaseName } from "../lib/project-label";
import type { RpcClient } from "../lib/rpc";
import { useGitWatch } from "../lib/use-git-watch";
import { directoriesEqual } from "../lib/workspace-projects";
import { Icon } from "../vendor/oc-icons";
import { FadeScroll } from "./FadeScroll";
import { MenuPopup } from "./MenuPopup";
import { type MonacoDiffContent, MonacoDiffEditor } from "./MonacoDiffEditor";
import { Reveal } from "./Reveal";

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
								<MorphIcon
									icon={loadingMore ? LoaderCircleIconData : ArrowDownIconData}
									size={14}
									spring="snappy"
									reducedMotion="user"
									className="h-3.5 w-3.5"
								/>
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

/** Change-kind buckets from the daemon git.context RPC, in display order. */
type GitChangeKind = "code" | "test" | "docs" | "config" | "style" | "other";

const CHANGE_KIND_ORDER: readonly GitChangeKind[] = ["code", "test", "docs", "config", "style", "other"];

const CHANGE_KIND_LABEL: Record<GitChangeKind, TranslationKey> = {
	code: "settings.changeKindCode",
	test: "settings.changeKindTest",
	docs: "settings.changeKindDocs",
	config: "settings.changeKindConfig",
	style: "settings.changeKindStyle",
	other: "settings.changeKindOther",
};

/** One changed file from git.context: porcelain status, line counts and kind. */
interface GitContextFile {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
	kind: GitChangeKind;
}

/** Wire shape of the daemon git.context RPC (git/context.ts). */
interface GitContextAvailable {
	available: true;
	root: string;
	worktree: { linked: boolean; gitDir: string; commonDir: string; mainRoot: string };
	head: { branch: string | null; detached: boolean; commit: string | null; shortCommit: string | null };
	base: { ref: string; source: "param" | "default" | "local" | "remote"; forkPoint: string | null } | null;
	upstream: { ahead: number; behind: number } | null;
	files: GitContextFile[];
	truncated: boolean;
	timedOut: boolean;
	limits: { maxFiles: number; timeoutMs: number };
}

interface GitContextUnavailable {
	available: false;
	cwd: string;
	reason: "not-a-repository" | "timeout" | "git-error" | "invalid-base";
	detail?: string;
}

type GitContextResult = GitContextAvailable | GitContextUnavailable;

/** Porcelain `XY` pair: X is the index side, Y the worktree side. */
function statusSides(status: string): { staged: boolean; unstaged: boolean } {
	if (status === "??") return { staged: false, unstaged: true };
	return { staged: (status[0] ?? " ") !== " ", unstaged: (status[1] ?? " ") !== " " };
}

/** Badge text for a porcelain pair: `"M "` → `M`, `"MM"` → `MM`, `"??"` → `?`. */
function statusBadge(status: string): string {
	if (status === "??") return "?";
	const pair = status.replaceAll(" ", "");
	return pair.length > 0 ? pair : "M";
}

/** `refs/heads/main` → `main`, so the header shows the name git users type. */
function shortRefName(ref: string): string {
	return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

function sumLineStats(files: readonly GitContextFile[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const file of files) {
		additions += file.additions ?? 0;
		deletions += file.deletions ?? 0;
	}
	return { additions, deletions };
}

/** Workspace-changes view (right-pane review surface): one git.context
 *  snapshot supplies the branch/worktree/base header and the changed files,
 *  grouped by kind with per-group line totals; per-file unified diffs still
 *  come from git.diff. Rows carry stage/unstage actions, and the header
 *  offers flat/tree view and a commit dialog (subject + bundled gitmoji
 *  picker + the settings-configured default identity). */
function DiffPane({ rpc, cwd, sessionId }: { rpc: RpcClient; cwd: string; sessionId?: string | null }): ReactNode {
	interface WorkspaceRootRow {
		path: string;
		primary: boolean;
		exists: boolean;
	}
	const [roots, setRoots] = useState<WorkspaceRootRow[]>([{ path: cwd, primary: true, exists: true }]);
	const [activeRoot, setActiveRoot] = useState(() => consumeRequestedGitRoot() ?? cwd);
	const [rootMenu, setRootMenu] = useState(false);
	const rootMenuAnchor = useRef<HTMLButtonElement | null>(null);
	useGitWatch(
		rpc,
		roots.map(root => root.path),
	);
	const [context, setContext] = useState<GitContextResult | null>(null);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [collapsedKinds, setCollapsedKinds] = useState<Set<GitChangeKind>>(new Set());
	const [fileDiff, setFileDiff] = useState<{
		staged: string;
		unstaged: string;
		stagedContent?: MonacoDiffContent;
		unstagedContent?: MonacoDiffContent;
	} | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const diffRequestRef = useRef(0);
	const contextRequestRef = useRef(0);
	const highlight = useChatHighlight();
	// GitSettings parity: flat/tree view — one shared pref module, and every
	// surface follows the change event.
	const [view, setView] = useState<ChangesView>(readChangesView);
	useEffect(
		() =>
			onGitPrefsChanged(() => {
				setView(readChangesView());
			}),
		[],
	);

	// Session roots: primary + additional working directories. A snapshot
	// session has no live directory list, so it falls back to the primary.
	useEffect(() => {
		let cancelled = false;
		const fallback: WorkspaceRootRow[] = [{ path: cwd, primary: true, exists: true }];
		const apply = (rows: WorkspaceRootRow[]): void => {
			if (cancelled) return;
			const next = rows.length > 0 ? rows : fallback;
			setRoots(next);
			setActiveRoot(current => (next.some(row => row.path === current) ? current : (next[0]?.path ?? cwd)));
		};
		if (!sessionId) {
			apply(fallback);
			return () => {
				cancelled = true;
			};
		}
		void rpc
			.request<{ directories?: WorkspaceRootRow[] }>("session.directories.list", { sessionId })
			.then(res => apply(res?.directories ?? fallback))
			.catch(() => apply(fallback));
		return () => {
			cancelled = true;
		};
	}, [rpc, sessionId, cwd]);

	// Switching sessions always starts from that session's primary root. The
	// initial mount is skipped so a one-shot root request from the session info
	// card is not clobbered before the directory list arrives.
	const previousCwd = useRef(cwd);
	useEffect(() => {
		if (previousCwd.current === cwd) return;
		previousCwd.current = cwd;
		setActiveRoot(cwd);
	}, [cwd]);

	// A click in the session info card's project-directory list lands here.
	useEffect(() => {
		const onRoot = (event: Event): void => {
			const detail = (event as CustomEvent<unknown>).detail;
			if (typeof detail === "string" && detail.length > 0) {
				consumeRequestedGitRoot();
				setActiveRoot(detail);
			}
		};
		window.addEventListener(GIT_ROOT_EVENT, onRoot);
		return () => window.removeEventListener(GIT_ROOT_EVENT, onRoot);
	}, []);
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
	useEffect(() => {
		setContext(null);
		setOpenPath(null);
		setFileDiff(null);
		setTreeOpen(new Set());
		setCollapsedKinds(new Set());
	}, [activeRoot]);
	const load = useCallback((): void => {
		if (!rpc) return;
		const request = ++contextRequestRef.current;
		void rpc
			.request<GitContextResult>("git.context", { cwd: activeRoot })
			.then(res => {
				if (contextRequestRef.current !== request) return;
				setContext(res ?? { available: false, cwd: activeRoot, reason: "git-error" });
			})
			.catch((err: unknown) => {
				if (contextRequestRef.current !== request) return;
				setContext({
					available: false,
					cwd: activeRoot,
					reason: "git-error",
					detail: err instanceof Error ? err.message : String(err),
				});
			});
	}, [rpc, activeRoot]);
	useEffect(load, [load]);
	// Daemon git-dir push (HEAD/index/refs) or a local mutation: reload the
	// active root without waiting for a timer.
	useEffect(
		() =>
			onGitStatusChanged(root => {
				if (!root || directoriesEqual(root, activeRoot)) load();
			}),
		[activeRoot, load],
	);
	const openFile = (path: string): void => {
		const request = ++diffRequestRef.current;
		if (openPath === path) {
			setOpenPath(null);
			setFileDiff(null);
			setDiffLoading(false);
			return;
		}
		setOpenPath(path);
		setFileDiff(null);
		setDiffLoading(true);
		void rpc
			.request<typeof fileDiff>("git.diff", { path, maxLines: 400, cwd: activeRoot, content: true })
			.then(res => {
				if (diffRequestRef.current !== request) return;
				setFileDiff(res ?? { staged: "", unstaged: "" });
				setDiffLoading(false);
			})
			.catch(() => {
				if (diffRequestRef.current === request) setDiffLoading(false);
			});
	};
	const stagePaths = async (paths: string[], stage: boolean): Promise<void> => {
		if (!rpc) return;
		await rpc.request(stage ? "git.stage" : "git.unstage", { paths, cwd: activeRoot }).catch(() => {});
		invalidateGitStatus(activeRoot);
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
				cwd: activeRoot,
			});
			if (res?.error) {
				setCommitError(res.error);
				return;
			}
			setCommitOpen(false);
			setCommitMsg("");
			invalidateGitStatus(activeRoot);
		} catch (err) {
			setCommitError(err instanceof Error ? err.message : String(err));
		} finally {
			setCommitting(false);
		}
	};

	const FileRow = ({ file, depth = 0 }: { file: GitContextFile; depth?: number }): ReactNode => {
		const open = openPath === file.path;
		const sides = statusSides(file.status);
		const badge = statusBadge(file.status);
		const cls =
			file.status === "??" ? "gui-changes-badge--untracked" : sides.staged ? "gui-changes-badge--staged" : "";
		return (
			<div key={file.path} className="gui-changes-row-wrap">
				<button
					type="button"
					className={`gui-changes-row${open ? " gui-changes-row--open" : ""}`}
					style={depth > 0 ? { paddingLeft: 8 + depth * 14 } : undefined}
					onClick={() => openFile(file.path)}
				>
					<span
						className={`gui-changes-badge ${cls}`}
						style={badge.length > 1 ? { width: "auto", minWidth: 16, paddingInline: 3 } : undefined}
					>
						{badge}
					</span>
					<span className="min-w-0 flex-1 truncate text-left">{file.path}</span>
					{file.additions !== null && file.deletions !== null && (file.additions > 0 || file.deletions > 0) && (
						<span className="gui-changes-stats">
							<span className="gui-diff-add">+{file.additions}</span>
							<span className="gui-diff-del">−{file.deletions}</span>
						</span>
					)}
					{sides.staged && (
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
					)}
					{sides.unstaged && (
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
					)}
					<MorphIcon
						icon={open ? ChevronDownIconData : ChevronRightIconData}
						size={12}
						spring="snappy"
						reducedMotion="user"
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
								{fileDiff?.stagedContent ? (
									<MonacoDiffEditor
										path={file.path}
										scope="staged"
										original={fileDiff.stagedContent.original}
										modified={fileDiff.stagedContent.modified}
										fallback={<DiffBlock diff={fileDiff.staged} />}
									/>
								) : fileDiff?.staged ? (
									<DiffBlock diff={fileDiff.staged} />
								) : null}
								{fileDiff?.unstagedContent ? (
									<MonacoDiffEditor
										path={file.path}
										scope="unstaged"
										original={fileDiff.unstagedContent.original}
										modified={fileDiff.unstagedContent.modified}
										fallback={
											fileDiff.unstaged ? (
												<DiffBlock diff={fileDiff.unstaged} />
											) : (
												<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">
													{t("settings.diffUnavailable")}
												</div>
											)
										}
									/>
								) : fileDiff?.unstaged ? (
									<DiffBlock diff={fileDiff.unstaged} />
								) : null}
								{!fileDiff?.staged &&
									!fileDiff?.unstaged &&
									!fileDiff?.stagedContent &&
									!fileDiff?.unstagedContent && (
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
	/** Changes tree: build the real directory hierarchy (not just the first
	 *  path segment), collapse per full directory path, and keep file rows
	 *  indented under their parent. Flat mode bypasses the tree entirely.
	 *  Directory keys carry the kind so two groups sharing a folder name
	 *  collapse independently. */
	const groupRows = (files: GitContextFile[], kind: GitChangeKind): ReactNode[] => {
		if (view === "flat") return files.map(file => FileRow({ file }));
		interface TreeDir {
			dirs: Map<string, TreeDir>;
			files: GitContextFile[];
		}
		const root: TreeDir = { dirs: new Map(), files: [] };
		for (const file of files) {
			const segments = file.path.split("/").filter(Boolean);
			let node = root;
			for (const name of segments.slice(0, -1)) {
				let child = node.dirs.get(name);
				if (!child) {
					child = { dirs: new Map(), files: [] };
					node.dirs.set(name, child);
				}
				node = child;
			}
			node.files.push(file);
		}
		const countFiles = (node: TreeDir): number =>
			node.files.length + [...node.dirs.values()].reduce((sum, child) => sum + countFiles(child), 0);
		const renderNode = (node: TreeDir, prefix: string, depth: number): ReactNode[] => {
			const rows: ReactNode[] = [];
			for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
				const dirPath = prefix.length > 0 ? `${prefix}/${name}` : name;
				const treeKey = `${kind}:${dirPath}`;
				const open = treeOpen.has(treeKey);
				rows.push(
					<button
						key={`dir:${treeKey}`}
						type="button"
						className="gui-changes-row gui-changes-row--dir"
						style={depth > 0 ? { paddingLeft: 8 + depth * 14 } : undefined}
						onClick={() => {
							const next = new Set(treeOpen);
							if (open) next.delete(treeKey);
							else next.add(treeKey);
							setTreeOpen(next);
						}}
					>
						<Icon name="folder" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
						<span className="min-w-0 flex-1 truncate text-left font-medium">{name}/</span>
						<span className="text-[11px] text-[var(--color-text-faint)]">{countFiles(child)}</span>
						<MorphIcon
							icon={open ? ChevronDownIconData : ChevronRightIconData}
							size={12}
							spring="snappy"
							reducedMotion="user"
							className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
						/>
					</button>,
				);
				if (open) rows.push(...renderNode(child, dirPath, depth + 1));
			}
			for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
				rows.push(FileRow({ file, depth }));
			}
			return rows;
		};
		return renderNode(root, "", 0);
	};

	const available = context?.available === true ? context : null;
	const total = available?.files.length ?? 0;
	const stagedCount = available ? available.files.filter(file => statusSides(file.status).staged).length : 0;
	const kindGroups = new Map<GitChangeKind, GitContextFile[]>();
	for (const file of [...(available?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
		const bucket = kindGroups.get(file.kind);
		if (bucket) bucket.push(file);
		else kindGroups.set(file.kind, [file]);
	}
	const ahead = available?.upstream?.ahead ?? 0;
	const behind = available?.upstream?.behind ?? 0;
	const headLabel = available ? (available.head.branch ?? available.head.shortCommit ?? "") : "";
	const rootBar = (
		<div className="gui-changes-rootbar">
			<button
				type="button"
				ref={rootMenuAnchor}
				className="gui-changes-root"
				aria-haspopup="menu"
				aria-expanded={rootMenu}
				title={activeRoot}
				onClick={() => setRootMenu(open => !open)}
			>
				<Icon name="folder" className="h-3.5 w-3.5 flex-none" />
				<span className="min-w-0 max-w-[140px] truncate">{pathBaseName(activeRoot)}</span>
				<MorphIcon
					icon={ChevronDownIconData}
					size={12}
					spring="snappy"
					reducedMotion="user"
					className="h-3 w-3 flex-none text-[var(--color-text-faint)]"
				/>
			</button>
			{available && <span className="gui-changes-count">{t("general.changesFileCount", { count: total })}</span>}
			<div className="ml-auto flex items-center gap-0.5">
				<button
					type="button"
					className={`gui-pane-tool${view === "flat" ? " gui-pane-tool--active" : ""}`}
					title={t("general.flatList")}
					aria-label={t("general.flatList")}
					onClick={() => {
						setView("flat");
						writeChangesView("flat");
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
						writeChangesView("tree");
					}}
				>
					<Icon name="node-tree" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-tool"
					title={t("settings.refresh")}
					aria-label={t("settings.refresh")}
					onClick={() => load()}
				>
					<Icon name="refresh" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className={`gui-btn !h-6 !px-2 !py-0 !text-[11.5px]${stagedCount === 0 ? " opacity-50" : ""}`}
					disabled={stagedCount === 0}
					onClick={() => {
						setCommitOpen(true);
						setCommitError(null);
					}}
				>
					<Icon name="git-commit" className="h-3 w-3" />
					{t("general.commit")}
				</button>
			</div>
			<MenuPopup
				open={rootMenu}
				className="gui-changes-rootmenu"
				anchor={rootMenuAnchor.current}
				onOpenChange={setRootMenu}
			>
				{roots.map(root => (
					<button
						key={root.path}
						type="button"
						className="gui-view-opt"
						onClick={() => {
							setRootMenu(false);
							setActiveRoot(root.path);
						}}
					>
						<Icon name={root.primary ? "folder" : "folder-add"} className="h-3.5 w-3.5" />
						<span className="min-w-0 flex-1 truncate text-left">{pathBaseName(root.path)}</span>
						{root.primary && (
							<span className="text-[10px] text-[var(--color-text-faint)]">
								{t("settings.primaryDirectory")}
							</span>
						)}
						{root.path === activeRoot && (
							<Icon name="check" className="h-3.5 w-3.5 flex-none text-[var(--color-accent)]" />
						)}
					</button>
				))}
			</MenuPopup>
		</div>
	);

	if (context === null) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				{rootBar}
				<div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
			</div>
		);
	}
	if (!context.available) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				{rootBar}
				<div className="mx-1 mt-1 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-2">
					<Icon name="error-warning" className="mt-px h-3.5 w-3.5 flex-none text-[var(--color-danger)]" />
					<div className="min-w-0 flex-1">
						<div className="text-[12px] text-[var(--color-text)]">
							{context.reason === "not-a-repository"
								? t("general.notGitDirectory")
								: context.reason === "timeout"
									? t("settings.gitContextTimedOut")
									: context.reason === "invalid-base"
										? t("settings.gitInvalidBase")
										: t("settings.gitContextError")}
						</div>
						{context.detail && (
							<div
								className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-faint)]"
								title={context.detail}
							>
								{context.detail}
							</div>
						)}
					</div>
					<button type="button" className="gui-pane-action !w-auto flex-none px-2" onClick={() => load()}>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						<span>{t("settings.retry")}</span>
					</button>
				</div>
			</div>
		);
	}
	const base = context.base;
	const worktree = context.worktree;
	const detached = context.head.detached;
	const forkPoint = base?.forkPoint ? base.forkPoint.slice(0, 7) : null;
	return (
		<div className="flex h-full min-h-0 flex-col">
			{rootBar}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pb-1 text-[11px] text-[var(--color-text-faint)]">
				{headLabel.length > 0 && (
					<span
						className="flex min-w-0 items-center gap-1"
						title={detached ? t("settings.detachedHead") : headLabel}
					>
						<Icon name="git-branch" className="h-3.5 w-3.5 flex-none text-[var(--color-accent)]" />
						<span
							className={`min-w-0 truncate font-medium text-[var(--color-text)]${detached ? " font-mono" : ""}`}
						>
							{headLabel}
						</span>
					</span>
				)}
				{(ahead > 0 || behind > 0) && (
					<span className="flex-none font-mono">
						{ahead > 0 ? `↑${ahead} ` : ""}
						{behind > 0 ? `↓${behind}` : ""}
					</span>
				)}
				{base && (
					<span className="flex min-w-0 items-center gap-1" title={t("settings.baseBranch")}>
						<Icon name="git-fork" className="h-3.5 w-3.5 flex-none" />
						<span className="truncate">{shortRefName(base.ref)}</span>
						{forkPoint && <span className="flex-none font-mono">@{forkPoint}</span>}
					</span>
				)}
				{worktree.linked && (
					<span
						className="flex-none rounded bg-[var(--color-surface-sunken)] px-1 py-px"
						title={worktree.mainRoot}
					>
						{t("settings.linkedWorktree")}
					</span>
				)}
				{context.truncated && (
					<span
						className="flex-none rounded bg-amber-500/15 px-1 py-px text-amber-700 dark:text-amber-400"
						title={t("settings.gitContextTruncatedHint", { count: context.limits.maxFiles })}
					>
						{t("settings.gitContextTruncated")}
					</span>
				)}
				{context.timedOut && (
					<span
						className="flex-none rounded bg-amber-500/15 px-1 py-px text-amber-700 dark:text-amber-400"
						title={t("settings.gitContextTimedOutHint")}
					>
						{t("settings.gitContextTimedOut")}
					</span>
				)}
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
							{t("general.stagedCount", { count: String(stagedCount) })}
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
			<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
				{total === 0 ? (
					<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("tools.noChanges")}</div>
				) : (
					CHANGE_KIND_ORDER.map(kind => {
						const files = kindGroups.get(kind);
						if (!files || files.length === 0) return null;
						const open = !collapsedKinds.has(kind);
						const stats = sumLineStats(files);
						return (
							<div key={kind}>
								<button
									type="button"
									className="gui-changes-row gui-changes-row--dir"
									aria-expanded={open}
									onClick={() =>
										setCollapsedKinds(current => {
											const next = new Set(current);
											if (next.has(kind)) next.delete(kind);
											else next.add(kind);
											return next;
										})
									}
								>
									<span className="gui-group-label min-w-0 flex-1 truncate text-left">
										{t(CHANGE_KIND_LABEL[kind])}
									</span>
									<span className="flex-none text-[11px] text-[var(--color-text-faint)]">{files.length}</span>
									{(stats.additions > 0 || stats.deletions > 0) && (
										<span className="gui-changes-stats">
											{stats.additions > 0 && <span className="gui-diff-add">+{stats.additions}</span>}
											{stats.deletions > 0 && <span className="gui-diff-del">−{stats.deletions}</span>}
										</span>
									)}
									<MorphIcon
										icon={open ? ChevronDownIconData : ChevronRightIconData}
										size={12}
										spring="snappy"
										reducedMotion="user"
										className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
									/>
								</button>
								<Reveal open={open}>{groupRows(files, kind)}</Reveal>
							</div>
						);
					})
				)}
			</FadeScroll>
		</div>
	);
}

/** Stash entry from the daemon git.stashList RPC (\x1f fields of
 *  `git stash list --format=%gd%x1f%gs%x1f%cr%x1f%H`). */
interface GitStashEntry {
	ref: string;
	message: string;
	age: string;
	hash: string;
}

/** Stash tab: save the working tree (staged + unstaged + untracked) with
 *  an optional message, list entries newest-first, pop or drop each.
 *  Pop/drop refresh the list; a failed pop surfaces stderr (git keeps the
 *  stash on conflict, which is the outcome we want to show). */
function StashPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [entries, setEntries] = useState<GitStashEntry[] | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ stashes?: GitStashEntry[] }>("git.stashList", { cwd })
			.then(res => setEntries(res?.stashes ?? []))
			.catch(() => setEntries([]));
	}, [rpc, cwd]);
	useEffect(load, [load]);
	const push = async (): Promise<void> => {
		if (!rpc || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await rpc
				.request<{ ok?: boolean; empty?: boolean; error?: string }>("git.stashPush", {
					cwd,
					message: message.trim() || undefined,
				})
				.catch(() => null);
			if (res?.ok) {
				setMessage("");
				load();
			} else {
				setError(res?.error ?? t("general.requestFailed"));
			}
		} finally {
			setBusy(false);
		}
	};
	const act = async (method: "git.stashPop" | "git.stashDrop", ref: string): Promise<void> => {
		if (!rpc || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await rpc.request<{ ok?: boolean; error?: string }>(method, { cwd, ref }).catch(() => null);
			if (res?.ok) load();
			else setError(res?.error ?? t("general.requestFailed"));
		} finally {
			setBusy(false);
			setConfirmDrop(null);
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("stashes")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={load}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("settings.refresh")}</span>
				</button>
			</div>
			<div className="mb-1 flex items-center gap-1.5 px-1">
				<input
					className="gui-input min-w-0 flex-1 !py-1 text-[12px]"
					value={message}
					onChange={e => setMessage(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") void push();
					}}
					placeholder={t("stash message placeholder")}
					aria-label={t("stash message placeholder")}
				/>
				<button
					type="button"
					className="gui-btn !h-6 !px-2 !py-0 !text-[11.5px]"
					disabled={busy}
					onClick={() => void push()}
				>
					{busy ? t("general.committing") : t("stash push")}
				</button>
			</div>
			{error && <div className="gui-pr-error px-2 pb-1">{error}</div>}
			<FadeScroll className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
				{entries === null ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
				) : entries.length === 0 ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("no stashes")}</div>
				) : (
					entries.map(entry => (
						<div key={entry.ref} className="gui-changes-row-wrap">
							<div className="gui-changes-row !cursor-default">
								<span className="gui-changes-badge">{entry.ref.replace(/^stash@{(\d+)}$/, "#$1")}</span>
								<span className="min-w-0 flex-1 truncate text-left">{entry.message}</span>
								<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{entry.age}</span>
								<span
									className="gui-changes-act"
									role="button"
									tabIndex={0}
									title={t("stash pop")}
									aria-label={t("stash pop")}
									onClick={e => {
										e.stopPropagation();
										void act("git.stashPop", entry.ref);
									}}
									onKeyDown={e => {
										if (e.key === "Enter") void act("git.stashPop", entry.ref);
									}}
								>
									<Icon name="arrow-down" className="h-3.5 w-3.5" />
								</span>
								<button
									type="button"
									className="gui-changes-act"
									title={confirmDrop === entry.ref ? t("stash drop confirm") : t("stash drop")}
									aria-label={t("stash drop")}
									onClick={e => {
										e.stopPropagation();
										if (confirmDrop !== entry.ref) {
											setConfirmDrop(entry.ref);
											return;
										}
										void act("git.stashDrop", entry.ref);
									}}
								>
									<MorphIcon
										icon={confirmDrop === entry.ref ? CheckIconData : XIconData}
										size={14}
										spring="snappy"
										reducedMotion="user"
										className="h-3.5 w-3.5"
									/>
								</button>
							</div>
						</div>
					))
				)}
			</FadeScroll>
		</div>
	);
}

/** Sync controls: fetch / pull(rebase) / push for the repo's current
 *  branch, with errors inline. Lives on the GitPanel sub-tab row so every
 *  git tab reaches it; ahead/behind is owned by the pane that displays it
 *  (the changes header reads git.context, the history pane its own status). */
function GitSyncControls({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = async (method: "git.fetch" | "git.pull" | "git.push"): Promise<void> => {
		if (!rpc || busyAction) return;
		setBusyAction(method);
		setError(null);
		try {
			const res = await rpc.request<{ ok?: boolean; error?: string }>(method, { cwd }).catch(() => null);
			if (res?.ok) invalidateGitStatus(cwd);
			else setError(res?.error ?? t("general.requestFailed"));
		} finally {
			setBusyAction(null);
		}
	};
	return (
		<div className="ml-auto flex items-center gap-0.5">
			<button
				type="button"
				className="gui-pane-tool"
				disabled={busyAction !== null}
				title={t("fetch")}
				aria-label={t("fetch")}
				onClick={() => void run("git.fetch")}
			>
				<MorphIcon
					icon={busyAction === "git.fetch" ? LoaderCircleIconData : CloudDownloadIconData}
					size={14}
					spring="snappy"
					reducedMotion="user"
					className="h-3.5 w-3.5"
				/>
			</button>
			<button
				type="button"
				className="gui-pane-tool"
				disabled={busyAction !== null}
				title={t("pull")}
				aria-label={t("pull")}
				onClick={() => void run("git.pull")}
			>
				<MorphIcon
					icon={busyAction === "git.pull" ? LoaderCircleIconData : ArrowDownIconData}
					size={14}
					spring="snappy"
					reducedMotion="user"
					className="h-3.5 w-3.5"
				/>
			</button>
			<button
				type="button"
				className="gui-pane-tool"
				disabled={busyAction !== null}
				title={t("push")}
				aria-label={t("push")}
				onClick={() => void run("git.push")}
			>
				<MorphIcon
					icon={busyAction === "git.push" ? LoaderCircleIconData : ArrowUpIconData}
					size={14}
					spring="snappy"
					reducedMotion="user"
					className="h-3.5 w-3.5"
				/>
			</button>
			{error && (
				<span className="ml-1 max-w-[140px] truncate text-[10.5px] text-[var(--color-danger)]" title={error}>
					{error}
				</span>
			)}
		</div>
	);
}

/**
 * Single rail "git" surface (Phase 3 merge of the former git/diff/pr
 * surfaces): a view-local sub-tab bar — workspace changes / commit
 * history / stashes — over the merged panes. The rail stays the
 * single navigation axis; these tabs switch content *within* the surface.
 */
type GitPaneTab = "changes" | "commits" | "stash";
const GIT_PANE_TABS: Array<{ id: GitPaneTab; label: string }> = [
	{ id: "changes", label: "workspace changes" },
	{ id: "commits", label: "commit history" },
	{ id: "stash", label: "stashes" },
];
export function GitPanel({
	rpc,
	cwd,
	sessionId,
}: {
	rpc: RpcClient;
	cwd: string;
	/** Live session id: the changes pane offers every working directory. */
	sessionId?: string | null;
}): ReactNode {
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
				<GitSyncControls rpc={rpc} cwd={cwd} />
			</div>
			<div className="min-h-0 flex-1">
				{tab === "commits" ? (
					<GitLogPane rpc={rpc} cwd={cwd} />
				) : tab === "stash" ? (
					<StashPane rpc={rpc} cwd={cwd} />
				) : (
					<DiffPane rpc={rpc} cwd={cwd} sessionId={sessionId} />
				)}
			</div>
		</div>
	);
}
