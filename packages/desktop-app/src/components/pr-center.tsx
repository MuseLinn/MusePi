/**
 * PrCenter — the PR/issue center shared by the main-view board page. Two
 * subtabs: the PR tab (current-branch PR card, or the create form when the
 * branch has none, over the repo's open PR list) and the issues tab
 * (state-filtered issue list with label/author filters). Row clicks expand
 * an inline detail preview — body, comments, individual checks, and the
 * actions the list doesn't have: merge (method picker + confirm),
 * close/reopen, label/reviewer adds. All gh calls go through the daemon
 * with the machine's own credentials (gh CLI); a missing or unauthenticated
 * gh surfaces a readable error instead of a blank pane.
 */
import { Markdown, Segmented, type SegmentedOption, type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard, openExternalUrl } from "../lib/electron";
import { branchToTitle, prVisualState, rollupCheckState } from "../lib/pr-status";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { FadeScroll } from "./FadeScroll";
import { MenuPopup } from "./MenuPopup";

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

/** gh comment/review author + body + time (both fold to this for display). */
interface GhComment {
	author: { login: string };
	body: string;
	createdAt?: string;
}

/** Full PR detail from `github.prView` — everything the list row doesn't carry. */
interface GhPrDetail extends GhPr {
	body: string;
	labels: { name: string; color: string }[];
	reviewers: { login: string }[];
	assignees: { login: string }[];
	comments: GhComment[];
	createdAt?: string;
	closedAt?: string | null;
}

/** gh's statusCheckRollup is heterogeneous: CheckRun ({name, conclusion,
 *  status}) and StatusContext ({context, state}). Fold an entry to one of
 *  the three dot states, picking whichever field the entry actually has. */
function checkItemState(item: Record<string, unknown>): "success" | "failure" | "pending" {
	const conclusion = typeof item.conclusion === "string" ? item.conclusion : null;
	if (conclusion !== null) {
		if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "success";
		if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion))
			return "failure";
		return "pending";
	}
	const state = typeof item.state === "string" ? item.state : "";
	if (["SUCCESS", "EXPECTED"].includes(state)) return "success";
	if (["FAILURE", "ERROR", "CANCELLED"].includes(state)) return "failure";
	return "pending";
}

function checkItemName(item: Record<string, unknown>): string {
	return typeof item.name === "string" ? item.name : typeof item.context === "string" ? item.context : "";
}

/** Per-check list inside the detail pane (the list row only has the rollup dot). */
function CheckItemList({ rollup }: { rollup: unknown }): ReactNode {
	if (!Array.isArray(rollup) || rollup.length === 0) return null;
	return (
		<div className="gui-pr-detail-section">
			{rollup.slice(0, 20).map((item, i) => {
				const rec = item as Record<string, unknown>;
				const state = checkItemState(rec);
				return (
					<span key={`${checkItemName(rec)}-${i}`} className="gui-pr-check-item">
						<span className={`gui-pr-check-dot gui-pr-check-dot--${state}`} aria-hidden="true" />
						{checkItemName(rec)}
					</span>
				);
			})}
		</div>
	);
}

/** Comment list shared by the PR and issue detail panes. */
function CommentList({ comments }: { comments: GhComment[] }): ReactNode {
	return (
		<div className="gui-pr-detail-section">
			<span className="gui-pr-detail-label">{t("pr comments {count}", { count: comments.length })}</span>
			{comments.length === 0 && <p className="gui-pr-comments-empty">{t("pr no comments")}</p>}
			{comments.slice(0, 20).map((c, i) => (
				<article key={`${c.author?.login ?? "comment"}-${i}`} className="gui-pr-comment">
					<span className="gui-pr-comment-meta">
						<strong>{c.author?.login}</strong>
						{c.createdAt && <span>{new Date(c.createdAt).toLocaleString()}</span>}
					</span>
					<div className="gui-pr-comment-body">
						<Markdown text={c.body} />
					</div>
				</article>
			))}
		</div>
	);
}

function CommentComposer({ busy, onSubmit }: { busy: boolean; onSubmit(body: string): Promise<boolean> }): ReactNode {
	const [draft, setDraft] = useState("");
	const submit = async (): Promise<void> => {
		const body = draft.trim();
		if (!body || busy) return;
		if (await onSubmit(body)) setDraft("");
	};
	return (
		<form
			className="gui-pr-comment-composer"
			onSubmit={event => {
				event.preventDefault();
				void submit();
			}}
		>
			<label>
				<span className="gui-pr-detail-label">{t("pr add comment")}</span>
				<textarea
					value={draft}
					onChange={event => setDraft(event.target.value)}
					placeholder={t("pr comment placeholder")}
					rows={4}
					disabled={busy}
				/>
			</label>
			<button type="submit" className="gui-btn gui-pr-comment-submit" disabled={busy || !draft.trim()}>
				{busy ? (
					<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
				) : (
					<Icon name="chat-1" className="h-3.5 w-3.5" />
				)}
				<span>{t("pr comment submit")}</span>
			</button>
		</form>
	);
}

/** Comma-separated input → trimmed non-empty tokens (label/reviewer adds). */
function splitCsv(raw: string): string[] {
	return raw
		.split(",")
		.map(s => s.trim())
		.filter(s => s !== "");
}

/** PR detail preview: fetched per selected list row; hosts the actions the
 *  list doesn't have — merge (method picker + two-step confirm), close/reopen,
 *  label/reviewer adds. `onChanged` refreshes the parent list after a mutation. */
function PrDetail({
	rpc,
	cwd,
	number,
	onChanged,
}: {
	rpc: RpcClient;
	cwd: string;
	number: number;
	onChanged(): void;
}): ReactNode {
	const [detail, setDetail] = useState<GhPrDetail | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [labelInput, setLabelInput] = useState("");
	const [reviewerInput, setReviewerInput] = useState("");
	const requestSeq = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		return () => {
			mounted.current = false;
			requestSeq.current++;
		};
	}, []);
	const load = useCallback((): void => {
		if (!mounted.current) return;
		const seq = ++requestSeq.current;
		setDetail(undefined);
		setError(null);
		void rpc
			.request<{ pr?: GhPrDetail | null; error?: string }>("github.prView", { cwd, number })
			.then(res => {
				if (seq !== requestSeq.current) return;
				if (res?.error) setError(res.error);
				else setDetail(res?.pr ?? null);
			})
			.catch(() => {
				if (seq === requestSeq.current) setError(t("general.requestFailed"));
			});
	}, [rpc, cwd, number]);
	useEffect(load, [load]);
	const act = useCallback(
		async (call: () => Promise<{ ok?: boolean; error?: string } | null>): Promise<void> => {
			if (busy) return;
			setBusy(true);
			setActionError(null);
			try {
				const res = await call();
				if (res?.ok) {
					onChanged();
					load();
				} else {
					setActionError(res?.error ?? t("general.requestFailed"));
				}
			} finally {
				setBusy(false);
				setConfirming(false);
			}
		},
		[busy, onChanged, load],
	);
	const addLabels = (): void => {
		const labels = splitCsv(labelInput);
		if (labels.length === 0) return;
		setLabelInput("");
		void act(() =>
			rpc.request<{ ok?: boolean; error?: string }>("github.prEdit", { cwd, number, addLabels }).catch(() => null),
		);
	};
	const addReviewers = (): void => {
		const reviewers = splitCsv(reviewerInput);
		if (reviewers.length === 0) return;
		setReviewerInput("");
		void act(() =>
			rpc
				.request<{ ok?: boolean; error?: string }>("github.prEdit", { cwd, number, addReviewers })
				.catch(() => null),
		);
	};
	const removeLabel = (name: string): void => {
		void act(() =>
			rpc
				.request<{ ok?: boolean; error?: string }>("github.prEdit", { cwd, number, removeLabels: [name] })
				.catch(() => null),
		);
	};
	const removeReviewer = (login: string): void => {
		void act(() =>
			rpc
				.request<{ ok?: boolean; error?: string }>("github.prEdit", { cwd, number, removeReviewers: [login] })
				.catch(() => null),
		);
	};
	const postComment = async (body: string): Promise<boolean> => {
		if (busy) return false;
		setBusy(true);
		setActionError(null);
		try {
			const res = await rpc
				.request<{ ok?: boolean; error?: string }>("github.prComment", { cwd, number, body })
				.catch(() => null);
			if (!res?.ok) {
				setActionError(res?.error ?? t("general.requestFailed"));
				return false;
			}
			onChanged();
			if (mounted.current) load();
			return true;
		} finally {
			setBusy(false);
		}
	};
	if (error) return <div className="gui-pr-detail gui-pr-error">{error}</div>;
	if (detail === undefined)
		return (
			<div className="gui-pr-detail" aria-busy="true">
				{[0, 1, 2].map(i => (
					<div key={i} className="gui-skeleton-row" />
				))}
			</div>
		);
	if (detail === null) return null;
	const open = detail.state === "OPEN";
	const methodOptions: { value: "merge" | "squash" | "rebase"; label: string }[] = [
		{ value: "merge", label: t("pr merge method merge") },
		{ value: "squash", label: t("pr merge method squash") },
		{ value: "rebase", label: t("pr merge method rebase") },
	];
	return (
		<div className="gui-pr-detail">
			<div className="flex min-w-0 items-center gap-2">
				<span className={`gui-changes-badge gui-pr-badge--${prVisualState(detail)}`}>
					{detail.isDraft ? "D" : detail.state === "MERGED" ? "M" : detail.state === "CLOSED" ? "X" : "O"}
				</span>
				<span className="gui-pr-detail-title min-w-0 flex-1 text-[13px] font-medium">
					<span className="text-[var(--color-text-faint)]">#{detail.number}</span> {detail.title}
				</span>
			</div>
			<div className="gui-pr-meta">
				{detail.author?.login} · {detail.headRefName} → {detail.baseRefName}
				{detail.createdAt && <> · {new Date(detail.createdAt).toLocaleDateString()}</>}
			</div>
			<div className="gui-pr-meta">
				<PrChecks rollup={detail.statusCheckRollup} />
				<PrMergeLine pr={detail} />
			</div>
			<CheckItemList rollup={detail.statusCheckRollup} />
			{detail.labels.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{detail.labels.map(label => (
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
							{open && (
								<button
									type="button"
									className="gui-chip-x"
									title={`${t("general.remove")} ${label.name}`}
									aria-label={`${t("general.remove")} ${label.name}`}
									onClick={() => removeLabel(label.name)}
								>
									×
								</button>
							)}
						</span>
					))}
				</div>
			)}
			{(detail.reviewers.length > 0 || detail.assignees.length > 0) && (
				<div className="gui-pr-meta">
					{detail.reviewers.length > 0 && (
						<span className="flex flex-wrap items-center gap-1">
							{t("pr reviewers")}:
							{detail.reviewers.map(r => (
								<span key={r.login} className="gui-issue-label">
									{r.login}
									{open && (
										<button
											type="button"
											className="gui-chip-x"
											title={`${t("general.remove")} ${r.login}`}
											aria-label={`${t("general.remove")} ${r.login}`}
											onClick={() => removeReviewer(r.login)}
										>
											×
										</button>
									)}
								</span>
							))}
						</span>
					)}
					{detail.assignees.length > 0 && (
						<span>
							{t("pr assignees")}: {detail.assignees.map(a => a.login).join(", ")}
						</span>
					)}
				</div>
			)}
			<div className="gui-pr-detail-body">
				<Markdown text={detail.body?.trim() || t("pr no description")} />
			</div>
			<CommentList comments={detail.comments} />
			<CommentComposer busy={busy} onSubmit={postComment} />
			{open && !detail.isDraft && (
				<div className="gui-pr-merge-row">
					<select
						value={method}
						onChange={e => setMethod(e.target.value as "merge" | "squash" | "rebase")}
						aria-label={t("pr merge")}
						title={t("pr merge")}
					>
						{methodOptions.map(o => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						disabled={busy}
						onClick={() => {
							if (!confirming) {
								setConfirming(true);
								return;
							}
							void act(() =>
								rpc
									.request<{ ok?: boolean; error?: string }>("github.prMerge", {
										cwd,
										number,
										method,
									})
									.catch(() => null),
							);
						}}
					>
						{busy ? (
							<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Icon name="git-pull-request" className="h-3.5 w-3.5" />
						)}
						<span>{confirming ? t("pr merge confirm", { number: detail.number }) : t("pr merge")}</span>
					</button>
				</div>
			)}
			<div className="gui-pr-actions">
				{open ? (
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						disabled={busy}
						onClick={() =>
							void act(() =>
								rpc
									.request<{ ok?: boolean; error?: string }>("github.prState", {
										cwd,
										number,
										state: "closed",
									})
									.catch(() => null),
							)
						}
					>
						<span>{t("pr close")}</span>
					</button>
				) : (
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						disabled={busy}
						onClick={() =>
							void act(() =>
								rpc
									.request<{ ok?: boolean; error?: string }>("github.prState", {
										cwd,
										number,
										state: "open",
									})
									.catch(() => null),
							)
						}
					>
						<span>{t("pr reopen")}</span>
					</button>
				)}
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void openExternalUrl(detail.url)}
				>
					<Icon name="external-link" className="h-3.5 w-3.5" />
					<span>{t("open in browser")}</span>
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void copyToClipboard(detail.url)}
				>
					<Icon name="clipboard" className="h-3.5 w-3.5" />
					<span>{t("copy link")}</span>
				</button>
			</div>
			{open && (
				<div className="gui-pr-merge-row">
					<input
						className="gui-pr-add-input"
						value={labelInput}
						onChange={e => setLabelInput(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") addLabels();
						}}
						placeholder={t("pr add labels placeholder")}
						aria-label={t("pr add labels placeholder")}
					/>
					<input
						className="gui-pr-add-input"
						value={reviewerInput}
						onChange={e => setReviewerInput(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") addReviewers();
						}}
						placeholder={t("pr add reviewers placeholder")}
						aria-label={t("pr add reviewers placeholder")}
					/>
				</div>
			)}
			{actionError && <div className="gui-pr-error">{actionError}</div>}
		</div>
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

/** PR tab: the current branch's PR card (or the create form when there is
 *  none) over the repo's open PR list. All gh calls go through the daemon
 *  with the machine's own credentials. */
const PR_STATE_SEGMENTS: SegmentedOption<"open" | "closed" | "merged" | "all">[] = [
	{ value: "open", label: t("state open") },
	{ value: "closed", label: t("state closed") },
	{ value: "merged", label: t("state merged") },
	{ value: "all", label: t("state all") },
];

function useNarrowPrPane(): { narrow: boolean; paneRef: (element: HTMLDivElement | null) => void } {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		if (!element) return;
		const update = (width: number): void => {
			if (width > 0) setNarrow(width < 960);
		};
		const observer = new ResizeObserver(entries => {
			const entry = entries[0];
			if (entry) update(entry.contentRect.width);
		});
		observer.observe(element);
		update(element.clientWidth);
		return () => observer.disconnect();
	}, [element]);
	return { narrow, paneRef: setElement };
}

function PrWorkspace({
	narrow,
	itemLabel,
	filters,
	notice,
	list,
	detail,
}: {
	narrow: boolean;
	itemLabel: string;
	filters: ReactNode;
	notice?: ReactNode;
	list: ReactNode;
	detail: ReactNode;
}): ReactNode {
	const [listOpen, setListOpen] = useState(false);
	const listButtonRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => setListOpen(false), [narrow]);
	return (
		<>
			<div className="gui-pr-filter-row">
				{narrow && (
					<button
						ref={listButtonRef}
						type="button"
						className="gui-pr-list-toggle"
						aria-expanded={listOpen}
						aria-label={itemLabel}
						onClick={() => setListOpen(open => !open)}
					>
						<Icon name="list-check-2" className="h-3.5 w-3.5" />
						<span>{itemLabel}</span>
						<Icon name="arrow-down-s" className="h-3.5 w-3.5" />
					</button>
				)}
				<div className="gui-issue-filters">{filters}</div>
			</div>
			{notice}
			<div className={`gui-pr-workspace${narrow ? " gui-pr-workspace--narrow" : ""}`}>
				{!narrow && <FadeScroll className="gui-pr-list">{list}</FadeScroll>}
				<FadeScroll className="gui-pr-detail-pane">{detail}</FadeScroll>
				{narrow && (
					<MenuPopup
						open={listOpen}
						className="gui-pr-list-popup"
						anchor={listButtonRef.current}
						onOpenChange={setListOpen}
					>
						<FadeScroll
							className="gui-pr-list"
							onClick={event => {
								if ((event.target as HTMLElement).closest(".gui-pr-list-row")) setListOpen(false);
							}}
						>
							{list}
						</FadeScroll>
					</MenuPopup>
				)}
			</div>
		</>
	);
}

function PrPane({ rpc, cwd, query }: { rpc: RpcClient; cwd: string; query: string }): ReactNode {
	const [data, setData] = useState<{
		pr: GhPr | null;
		prs: GhPr[];
		branch: string | null;
		ahead: number;
		branches: string[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedPr, setSelectedPr] = useState<number | null>(null);
	const [prState, setPrState] = useState<"open" | "closed" | "merged" | "all">("open");
	const listRequestSeq = useRef(0);
	const { narrow, paneRef } = useNarrowPrPane();
	const load = useCallback((): void => {
		const seq = ++listRequestSeq.current;
		void Promise.all([
			rpc.request<{ pr?: GhPr | null; error?: string }>("github.prStatus", { cwd }).catch(() => null),
			rpc.request<{ prs?: GhPr[]; error?: string }>("github.prs", { cwd, state: prState }).catch(() => null),
			rpc
				.request<{ branch?: string | null; ahead?: number; error?: string }>("git.status", { cwd })
				.catch(() => null),
			rpc.request<{ branches?: string[]; error?: string }>("git.branches", { cwd }).catch(() => null),
		]).then(([statusRes, listRes, gitRes, branchesRes]) => {
			if (seq !== listRequestSeq.current) return;
			// A null slot means the RPC itself failed at the transport/daemon
			// layer — without this the pane silently renders "no PR → create
			// form" while gh is actually broken or unreachable.
			setError(
				statusRes === null || listRes === null
					? t("general.requestFailed")
					: (statusRes.error ?? listRes.error ?? null),
			);
			setData({
				pr: statusRes?.pr === undefined ? null : statusRes.pr,
				prs: listRes?.prs ?? [],
				branch: gitRes?.branch ?? null,
				ahead: gitRes?.ahead ?? 0,
				branches: branchesRes?.branches ?? [],
			});
		});
	}, [rpc, cwd, prState]);
	useEffect(load, [load]);
	const refresh = useCallback((): void => load(), [load]);
	const pr = data?.pr ?? null;
	// 搜索词过滤（编号/标题）；链接形态不改列表，交给「打开链接」行。
	const filteredPrs = (data?.prs ?? []).filter(p2 => matchesQuery(query, p2.number, p2.title));
	useEffect(() => {
		const visible = (data?.prs ?? []).filter(item => matchesQuery(query, item.number, item.title));
		setSelectedPr(current =>
			visible.some(item => item.number === current) ? current : (visible[0]?.number ?? null),
		);
	}, [data, query]);
	const linkQuery = isLinkQuery(query);
	return (
		<div ref={paneRef} className="gui-pr-pane">
			<PrWorkspace
				narrow={narrow}
				notice={error ? <div className="gui-pr-load-state gui-pr-error">{error}</div> : undefined}
				itemLabel={selectedPr === null ? t("pr select detail") : `#${selectedPr}`}
				filters={
					<>
						<Segmented<"open" | "closed" | "merged" | "all">
							ariaLabel={t("settings.pullRequests")}
							value={prState}
							options={PR_STATE_SEGMENTS}
							onChange={setPrState}
						/>
						<button type="button" className="gui-pane-action !w-auto px-2" onClick={refresh}>
							<Icon name="refresh" className="h-3.5 w-3.5" />
							<span>{t("settings.refresh")}</span>
						</button>
					</>
				}
				list={
					data ? (
						<>
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
							{linkQuery && (
								<div className="m-1.5">
									<button
										type="button"
										className="gui-changes-row"
										onClick={() => void openExternalUrl(query.trim())}
									>
										<Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
										<span className="min-w-0 flex-1 truncate text-left">{t("general.prOpenLink")}</span>
										<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
											{query.trim()}
										</span>
									</button>
								</div>
							)}
							{filteredPrs.length > 0 && (
								<div className="m-1.5 rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
									{filteredPrs.map(pr => (
										<button
											key={pr.number}
											type="button"
											className={`gui-changes-row gui-pr-list-row${selectedPr === pr.number ? " gui-changes-row--active" : ""}`}
											onClick={() => setSelectedPr(pr.number)}
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
											<span className="gui-pr-list-branches text-[10.5px] text-[var(--color-text-faint)]">
												{pr.headRefName} → {pr.baseRefName}
											</span>
										</button>
									))}
								</div>
							)}
						</>
					) : (
						<div className="min-h-0 flex-1 px-1 py-1" aria-busy="true">
							{[0, 1, 2, 3].map(i => (
								<div key={i} className="gui-skeleton-row" />
							))}
						</div>
					)
				}
				detail={
					data ? (
						selectedPr !== null ? (
							<PrDetail key={selectedPr} rpc={rpc} cwd={cwd} number={selectedPr} onChanged={refresh} />
						) : (
							<div className="gui-pr-detail-empty">{t("pr select detail")}</div>
						)
					) : (
						<div className="min-h-0 flex-1 px-1 py-1" aria-busy="true">
							{[0, 1, 2, 3].map(i => (
								<div key={i} className="gui-skeleton-row" />
							))}
						</div>
					)
				}
			/>
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

/** Full issue detail from `github.issueView`. */
interface GhIssueDetail extends GhIssue {
	body: string;
	assignees: { login: string }[];
	comments: GhComment[];
	createdAt?: string;
	closedAt?: string | null;
}

/** Issue detail preview: body, labels, assignees, comments, close/reopen. */
function IssueDetail({
	rpc,
	cwd,
	number,
	onChanged,
}: {
	rpc: RpcClient;
	cwd: string;
	number: number;
	onChanged(): void;
}): ReactNode {
	const [detail, setDetail] = useState<GhIssueDetail | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const requestSeq = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		return () => {
			mounted.current = false;
			requestSeq.current++;
		};
	}, []);
	const load = useCallback((): void => {
		if (!mounted.current) return;
		const seq = ++requestSeq.current;
		setDetail(undefined);
		setError(null);
		void rpc
			.request<{ issue?: GhIssueDetail | null; error?: string }>("github.issueView", { cwd, number })
			.then(res => {
				if (seq !== requestSeq.current) return;
				if (res?.error) setError(res.error);
				else setDetail(res?.issue ?? null);
			})
			.catch(() => {
				if (seq === requestSeq.current) setError(t("general.requestFailed"));
			});
	}, [rpc, cwd, number]);
	useEffect(load, [load]);
	const toggleState = async (): Promise<void> => {
		if (busy || !detail) return;
		setBusy(true);
		setActionError(null);
		try {
			const res = await rpc
				.request<{ ok?: boolean; error?: string }>("github.issueState", {
					cwd,
					number,
					state: isOpenState(detail.state) ? "closed" : "open",
				})
				.catch(() => null);
			if (res?.ok) {
				onChanged();
				load();
			} else {
				setActionError(res?.error ?? t("general.requestFailed"));
			}
		} finally {
			setBusy(false);
		}
	};
	const postComment = async (body: string): Promise<boolean> => {
		if (busy) return false;
		setBusy(true);
		setActionError(null);
		try {
			const res = await rpc
				.request<{ ok?: boolean; error?: string }>("github.issueComment", { cwd, number, body })
				.catch(() => null);
			if (!res?.ok) {
				setActionError(res?.error ?? t("general.requestFailed"));
				return false;
			}
			onChanged();
			if (mounted.current) load();
			return true;
		} finally {
			setBusy(false);
		}
	};
	if (error) return <div className="gui-pr-detail gui-pr-error">{error}</div>;
	if (detail === undefined)
		return (
			<div className="gui-pr-detail" aria-busy="true">
				{[0, 1, 2].map(i => (
					<div key={i} className="gui-skeleton-row" />
				))}
			</div>
		);
	if (detail === null) return null;
	const open = isOpenState(detail.state);
	return (
		<div className="gui-pr-detail">
			<div className="flex min-w-0 items-center gap-2">
				<span className={`gui-changes-badge ${open ? "gui-pr-badge--open" : "gui-pr-badge--merged"}`}>
					{open ? "O" : "C"}
				</span>
				<span className="gui-pr-detail-title min-w-0 flex-1 text-[13px] font-medium">
					<span className="text-[var(--color-text-faint)]">#{detail.number}</span> {detail.title}
				</span>
			</div>
			<div className="gui-pr-meta">
				{detail.author?.login}
				{detail.assignees.length > 0 && (
					<span>
						{t("pr assignees")}: {detail.assignees.map(a => a.login).join(", ")}
					</span>
				)}
			</div>
			{detail.labels.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{detail.labels.map(label => (
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
				</div>
			)}
			<div className="gui-pr-detail-body">
				<Markdown text={detail.body?.trim() || t("pr no description")} />
			</div>
			<CommentList comments={detail.comments} />
			<CommentComposer busy={busy} onSubmit={postComment} />
			<div className="gui-pr-actions">
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					disabled={busy}
					onClick={() => void toggleState()}
				>
					<span>{open ? t("pr close") : t("pr reopen")}</span>
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void openExternalUrl(detail.url)}
				>
					<Icon name="external-link" className="h-3.5 w-3.5" />
					<span>{t("open in browser")}</span>
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void copyToClipboard(detail.url)}
				>
					<Icon name="clipboard" className="h-3.5 w-3.5" />
					<span>{t("copy link")}</span>
				</button>
			</div>
			{actionError && <div className="gui-pr-error">{actionError}</div>}
		</div>
	);
}

/** Issues subtab: state filter + the repo's issue list (gh CLI via the
 *  daemon, same credentials as the PR tab). */
function IssuesPane({ rpc, cwd, query }: { rpc: RpcClient; cwd: string; query: string }): ReactNode {
	const [state, setState] = useState<"open" | "closed" | "all">("open");
	const [labelFilter, setLabelFilter] = useState("");
	const [authorFilter, setAuthorFilter] = useState("");
	const [issues, setIssues] = useState<GhIssue[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
	const listRequestSeq = useRef(0);
	const { narrow, paneRef } = useNarrowPrPane();
	const load = useCallback((): void => {
		const seq = ++listRequestSeq.current;
		void rpc
			.request<{ issues?: GhIssue[]; error?: string }>("github.issues", {
				cwd,
				state,
				label: labelFilter.trim() || undefined,
				author: authorFilter.trim() || undefined,
			})
			.then(res => {
				if (seq !== listRequestSeq.current) return;
				setIssues(res?.issues ?? []);
				setError(res?.error ?? null);
			})
			.catch(err => {
				if (seq === listRequestSeq.current) setError(err instanceof Error ? err.message : String(err));
			});
	}, [rpc, cwd, state, labelFilter, authorFilter]);
	useEffect(load, [load]);
	const filteredIssues = (issues ?? []).filter(i => matchesQuery(query, i.number, i.title));
	useEffect(() => {
		const visible = (issues ?? []).filter(i => matchesQuery(query, i.number, i.title));
		setSelectedIssue(current => (visible.some(i => i.number === current) ? current : (visible[0]?.number ?? null)));
	}, [issues, query]);
	const linkQuery = isLinkQuery(query);
	return (
		<div ref={paneRef} className="gui-pr-pane">
			<PrWorkspace
				narrow={narrow}
				notice={error ? <div className="gui-pr-load-state gui-pr-error">{error}</div> : undefined}
				itemLabel={selectedIssue === null ? t("pr select detail") : `#${selectedIssue}`}
				filters={
					<>
						<input
							value={labelFilter}
							onChange={e => setLabelFilter(e.target.value)}
							placeholder={t("filter by label")}
							aria-label={t("filter by label")}
						/>
						<input
							value={authorFilter}
							onChange={e => setAuthorFilter(e.target.value)}
							placeholder={t("filter by author")}
							aria-label={t("filter by author")}
						/>
						<Segmented<"open" | "closed" | "all">
							ariaLabel={t("issues")}
							value={state}
							options={ISSUE_STATE_SEGMENTS}
							onChange={setState}
						/>
					</>
				}
				list={
					issues ? (
						<>
							{linkQuery && (
								<button
									type="button"
									className="gui-changes-row"
									onClick={() => void openExternalUrl(query.trim())}
								>
									<Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
									<span className="min-w-0 flex-1 truncate text-left">{t("general.prOpenLink")}</span>
								</button>
							)}
							{filteredIssues.map(issue => (
								<button
									key={issue.number}
									type="button"
									className={`gui-changes-row gui-pr-list-row${selectedIssue === issue.number ? " gui-changes-row--active" : ""}`}
									onClick={() => setSelectedIssue(issue.number)}
								>
									<span
										className={`gui-changes-badge ${isOpenState(issue.state) ? "gui-pr-badge--open" : "gui-pr-badge--merged"}`}
									>
										{isOpenState(issue.state) ? "O" : "C"}
									</span>
									<span className="gui-pr-list-copy">
										<span className="gui-pr-list-title">
											<span className="text-[var(--color-text-faint)]">#{issue.number}</span> {issue.title}
										</span>
										<span className="gui-pr-list-meta">
											{issue.labels.slice(0, 2).map(label => (
												<span key={label.name} className="gui-issue-label">
													{label.name}
												</span>
											))}
											{issue.comments.length > 0 && (
												<span>
													<Icon name="chat-1" className="h-3 w-3" />
													{issue.comments.length}
												</span>
											)}
											<span>{new Date(issue.updatedAt).toLocaleDateString()}</span>
										</span>
									</span>
								</button>
							))}
							{filteredIssues.length === 0 && <div className="gui-pr-load-state">{t("no open issues")}</div>}
						</>
					) : (
						<div className="min-h-0 flex-1 px-1 py-1" aria-busy="true">
							{[0, 1, 2, 3].map(i => (
								<div key={i} className="gui-skeleton-row" />
							))}
						</div>
					)
				}
				detail={
					issues ? (
						selectedIssue !== null ? (
							<IssueDetail key={selectedIssue} rpc={rpc} cwd={cwd} number={selectedIssue} onChanged={load} />
						) : (
							<div className="gui-pr-detail-empty">{t("pr select detail")}</div>
						)
					) : (
						<div className="min-h-0 flex-1 px-1 py-1" aria-busy="true">
							{[0, 1, 2, 3].map(i => (
								<div key={i} className="gui-skeleton-row" />
							))}
						</div>
					)
				}
			/>
		</div>
	);
}

/** 搜索过滤：普通文本按标题子串过滤；`#123` 精确匹配编号；http(s) 链接不
 * 过滤列表，由面板渲染一行「打开链接」。 */
export function isOpenState(state: string): boolean {
	return state.toUpperCase() === "OPEN";
}

export function matchesQuery(query: string, number: number, title: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const num = /^#(\d+)$/.exec(query.trim());
	if (num) return number === Number(num[1]);
	return title.toLowerCase().includes(q);
}

export function isLinkQuery(query: string): boolean {
	return /^https?:\/\/\S+$/i.test(query.trim());
}

/** PR surface tabs: pull requests / issues (choice persisted locally). */
type PrCenterTab = "prs" | "issues";
const PR_CENTER_TAB_KEY = "musepi-gui-prcenter-tab";

/** PR/issue center body — hosted full-page by the main-view board page. */
export function PrCenter({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [tab, setTab] = useState<PrCenterTab>(() => {
		try {
			return localStorage.getItem(PR_CENTER_TAB_KEY) === "issues" ? "issues" : "prs";
		} catch {
			return "prs";
		}
	});
	// 搜索词在两个子页间共享：切换 tab 不换词，列表各自解释（编号/标题/链接）。
	const [query, setQuery] = useState("");
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
			<div className="gui-pr-toolbar">
				<div className="gui-pr-search-row">
					<label className="gui-ext-plugins-search gui-pr-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-50" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder={t("general.prSearchPlaceholder")}
							aria-label={t("general.prSearchPlaceholder")}
						/>
					</label>
				</div>
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
			</div>
			<div className="flex min-h-0 flex-1 flex-col">
				{tab === "prs" ? (
					<PrPane rpc={rpc} cwd={cwd} query={query} />
				) : (
					<IssuesPane rpc={rpc} cwd={cwd} query={query} />
				)}
			</div>
		</div>
	);
}
