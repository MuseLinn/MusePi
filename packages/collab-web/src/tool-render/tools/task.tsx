/** `task` — spawn subagents: batch shape, streamed progress, per-agent results.
 *  Kimi SwarmTool parity (2026-08-11): the head carries a done/total chip,
 *  and the native card body lists one compact line per subagent (status
 *  badge + description + stats) with output previews — the "one subagent
 *  per line" progress style. The rich avatar member grid (kimiwork parity)
 *  is an ADDITIVE component (`SwarmCard`) the host renders as a floating
 *  hover card, not inline under the tool call. */
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { AgentLink, Badge, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderHost, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

const MISSING_YIELD_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** One spawned unit of work, normalized across the batch and flat/legacy arg shapes. */
interface TaskItemView {
	id: string | null;
	description: string | null;
	assignment: string | null;
	isolated: boolean;
}

function taskItems(args: Record<string, unknown>): TaskItemView[] {
	const raw = args.tasks;
	if (Array.isArray(raw)) {
		const items: TaskItemView[] = [];
		for (const entry of raw) {
			if (!isRecord(entry)) continue;
			items.push({
				id: str(entry.id),
				description: str(entry.description),
				assignment: str(entry.assignment),
				isolated: entry.isolated === true,
			});
		}
		return items;
	}
	const flat: TaskItemView = {
		id: str(args.id),
		description: str(args.description),
		assignment: str(args.assignment),
		isolated: args.isolated === true,
	};
	return flat.id || flat.description || flat.assignment ? [flat] : [];
}

/** "Anna.Bob" nesting → "Anna>Bob" breadcrumb (mirrors the TUI's formatTaskId). */
function taskIdLabel(id: string): string {
	return id.includes(".") ? id.split(".").join(">") : id;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Outcome of one agent, mirroring the TUI's aborted / merge-failed / done / failed split. */
function resultStatus(res: Record<string, unknown>): {
	label: "aborted" | "merge failed" | "done" | "failed";
	tone: "ok" | "err" | "warn";
} {
	if (res.aborted === true) return { label: "aborted", tone: "err" };
	if (num(res.exitCode) === 0) {
		return str(res.error) ? { label: "merge failed", tone: "warn" } : { label: "done", tone: "ok" };
	}
	return { label: "failed", tone: "err" };
}

/** Phase of a finished result row (drives the member dot + segment color). */
function resultPhase(res: Record<string, unknown>): "ok" | "warn" | "err" {
	return resultStatus(res).tone;
}

/** Phase of a live progress row. */
function progressPhase(p: Record<string, unknown>): "ok" | "run" | "err" {
	const status = str(p.status) ?? "running";
	if (status === "completed") return "ok";
	if (status === "failed" || status === "aborted") return "err";
	return "run";
}

/**
 * Swarm-wide phase counts (Kimi parity: done/total chip + segmented bar).
 * Finished results take precedence; while the swarm is still running the
 * live progress frames are counted instead (the two never mix — Body only
 * shows progress when no results have landed yet).
 */
interface SwarmCounts {
	done: number;
	mergeFailed: number;
	failed: number;
	aborted: number;
	running: number;
	total: number;
}

function swarmCounts(results: Record<string, unknown>[], progress: Record<string, unknown>[]): SwarmCounts {
	const c: SwarmCounts = { done: 0, mergeFailed: 0, failed: 0, aborted: 0, running: 0, total: 0 };
	if (results.length > 0) {
		for (const res of results) {
			const { label } = resultStatus(res);
			if (label === "done") c.done++;
			else if (label === "merge failed") c.mergeFailed++;
			else if (label === "aborted") c.aborted++;
			else c.failed++;
		}
	} else {
		for (const p of progress) {
			const status = str(p.status) ?? "running";
			if (status === "completed") c.done++;
			else if (status === "failed") c.failed++;
			else if (status === "aborted") c.aborted++;
			else c.running++;
		}
	}
	c.total = c.done + c.mergeFailed + c.failed + c.aborted + c.running;
	return c;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const agent = str(args.agent);
	const resume = str(args.resume);
	const tasks = taskItems(args);
	const first = tasks.length > 0 ? tasks[0] : null;
	const label = first ? (first.description ?? first.id) : null;
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const counts = swarmCounts(results, progress);
	// Live batches that haven't emitted a single frame yet (or settled runs
	// with no frames at all) fall back to the declared batch size so the chip
	// still reads "0 / N" instead of vanishing.
	let total = counts.total;
	if (total === 0 && tasks.length > 0) total = tasks.length;
	const anyFailure = counts.failed + counts.aborted + counts.mergeFailed > 0;
	return (
		<>
			{agent && <Badge tone="accent">{agent}</Badge>}
			{!agent && resume && <Badge>{t("resume {name}", { name: resume })}</Badge>}
			{label && <span className="tv-muted">{truncate(normalizeWs(label), 72)}</span>}
			{tasks.length > 1 && <Badge>{t("{count} tasks", { count: String(tasks.length) })}</Badge>}
			{total > 0 && (
				<Badge tone={anyFailure ? "err" : undefined}>
					{counts.done + counts.mergeFailed + counts.failed + counts.aborted} / {total}
				</Badge>
			)}
		</>
	);
}

/** Derive the card head label: the task intent, else the first task's
 *  description/id, else the plain tool name. */

/**
 * Additive swarm card (Kimi SwarmTool parity / kimiwork member grid). NOT a
 * replacement for the native task tool-call card — it renders BESIDE it
 * (swarm style extension): the member grid with per-agent avatars, progress
 * bars and accordion outputs. Registered as `SwarmCard` so ToolView renders
 * it alongside the generic tool chrome when display.taskCardStyle=swarm.
 */
function SwarmCard({ result, host }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const showProgress = results.length === 0 && progress.length > 0;
	const counts = swarmCounts(results, progress);

	// Per-member accordion: each agent's output folds behind its row.
	const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
	const toggleRow = (key: string): void => {
		setOpenRows(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// Finished agents first, by runtime ascending — same order as the TUI.
	const ordered = [...results].sort(
		(a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0),
	);

	// Run footer: outcome counts + total wall time (mirrors the TUI's bracket line).
	let footer: ReactNode = null;
	const totalDurationMs = details ? num(details.totalDurationMs) : null;
	if (results.length > 0) {
		footer = (
			<Row>
				{counts.done > 0 && <Badge tone="ok">{t("{count} succeeded", { count: String(counts.done) })}</Badge>}{" "}
				{counts.mergeFailed > 0 && (
					<Badge tone="warn">{t("{count} merge failed", { count: String(counts.mergeFailed) })}</Badge>
				)}{" "}
				{counts.failed > 0 && <Badge tone="err">{t("{count} failed", { count: String(counts.failed) })}</Badge>}{" "}
				{counts.aborted > 0 && <Badge tone="err">{t("{count} aborted", { count: String(counts.aborted) })}</Badge>}{" "}
				{totalDurationMs != null && <span className="tv-faint">{fmtDuration(totalDurationMs)}</span>}
			</Row>
		);
	}

	return (
		<div className="tv-swarm-card">
			<SwarmOverview counts={counts} />
			{ordered.length > 0 && (
				<div className="tv-list tv-swarm-members">
					{ordered.map((res, i) => {
						const key = str(res.id) ?? `#${i}`;
						return (
							<SwarmAgentResult
								key={key}
								res={res}
								host={host}
								open={openRows.has(key)}
								onToggle={() => toggleRow(key)}
							/>
						);
					})}
					{footer}
				</div>
			)}
			{showProgress && (
				<div className="tv-list tv-swarm-members">
					{progress.map((p, i) => (
						<SwarmAgentProgressRow key={str(p.id) ?? i} p={p} host={host} />
					))}
				</div>
			)}
			{ordered.length === 0 && !showProgress && <ResultText result={result} maxLines={12} />}
		</div>
	);
}

/** Phase overview: progress line + segmented bar + legend (Kimi parity). */
type SwarmPhase = "done" | "merge failed" | "running" | "failed" | "aborted";

function SwarmOverview({ counts }: { counts: SwarmCounts }): ReactNode {
	if (counts.total === 0) return null;
	const segments: { phase: SwarmPhase; count: number; cls: string }[] = [];
	const push = (phase: SwarmPhase, count: number, cls: string): void => {
		if (count > 0) segments.push({ phase, count, cls });
	};
	push("done", counts.done, "s-ok");
	push("merge failed", counts.mergeFailed, "s-warn");
	push("running", counts.running, "s-run");
	push("failed", counts.failed, "s-fail");
	push("aborted", counts.aborted, "s-abort");
	const doneTotal = counts.done + counts.mergeFailed + counts.failed + counts.aborted;
	return (
		<div className="tv-swarm-overview">
			<div className="tv-swarm-line">
				<span className="tv-swarm-big">
					{t("swarm progress", { done: String(doneTotal), total: String(counts.total) })}
				</span>
				{counts.running > 0 ? (
					<span className="tv-swarm-lbl">{t("swarm running", { count: String(counts.running) })}</span>
				) : (
					(counts.failed > 0 || counts.aborted > 0) && (
						<span className="tv-swarm-lbl">
							{t("swarm done summary", {
								completed: String(counts.done + counts.mergeFailed),
								failed: String(counts.failed + counts.aborted),
							})}
						</span>
					)
				)}
			</div>
			{segments.length > 1 && (
				<>
					<div className="tv-swarm-seg" aria-hidden="true">
						{segments.map(s => (
							<span key={s.phase} className={`tv-swarm-seg-part ${s.cls}`} style={{ flexGrow: s.count }} />
						))}
					</div>
					<div className="tv-swarm-legend">
						{segments.map(s => (
							<span key={s.phase} className="tv-swarm-legend-item">
								<span className={`tv-swarm-dot ${s.cls}`} aria-hidden="true" />
								{t(s.phase)} {s.count}
							</span>
						))}
					</div>
				</>
			)}
		</div>
	);
}

/** Final snapshot for one agent: phase dot + status row, with the output
 *  details folded behind a per-member accordion (Kimi parity). Rendered in
 *  the floating SwarmCard grid, not the native card body (which keeps the
 *  compact one-line-per-subagent rows). */
function SwarmAgentResult({
	res,
	host,
	open,
	onToggle,
}: {
	res: Record<string, unknown>;
	host?: ToolRenderHost;
	open: boolean;
	onToggle(): void;
}): ReactNode {
	const { label, tone } = resultStatus(res);
	const phase = resultPhase(res);
	const id = str(res.id) ?? t("agent");
	const description = str(res.description);
	const stats: string[] = [];
	const tokens = num(res.tokens);
	if (tokens) stats.push(t("{count} tok", { count: fmtCount(tokens) }));
	const requests = num(res.requests);
	if (requests) stats.push(t("{count} req", { count: String(requests) }));
	const durationMs = num(res.durationMs);
	if (durationMs != null) stats.push(fmtDuration(durationMs));
	const model = str(res.resolvedModel);
	if (model) stats.push(model);

	// The runtime prepends a one-line warning when a subagent never called
	// yield; lift it out of the output preview like the TUI does.
	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	const bodyBits = [warning, output.trim(), error, abortReason];
	const hasBody = bodyBits.some(b => Boolean(b));
	// patch/branch lines render even when everything else is empty (a clean
	// patch-only run must stay expandable to show where the work landed).
	const hasDetails = hasBody || Boolean(patchPath) || Boolean(branchName);
	const avatarText = taskIdLabel(id)
		.split(/[>_]/)
		.map(part => (part.length > 0 ? part[0] : ""))
		.join("")
		.slice(0, 2)
		.toUpperCase();
	return (
		<div className={`tv-swarm-member tv-swarm-member--${phase}`}>
			<div className="tv-swarm-member-head">
				<span className={`tv-swarm-avatar tv-swarm-avatar--${phase}`} aria-hidden="true">
					{avatarText}
				</span>
				<div className="tv-swarm-member-main">
					<div className="tv-swarm-member-title">
						<AgentLink id={id} host={host}>
							{taskIdLabel(id)}
						</AgentLink>
						<Badge tone={tone}>{t(label)}</Badge>{" "}
						{res.truncated === true && <Badge tone="warn">{t("truncated")}</Badge>}
					</div>
					{description && <div className="tv-swarm-member-desc">{truncate(normalizeWs(description), 120)}</div>}
					{stats.length > 0 && <div className="tv-swarm-member-stats">{stats.join(" · ")}</div>}
					<div className="tv-swarm-bar" aria-hidden="true">
						<span
							className={`tv-swarm-bar-fill tv-swarm-bar-fill--${phase}`}
							style={{ width: `${phase === "ok" ? 100 : phase === "warn" ? 66 : 34}%` }}
						/>
					</div>
				</div>
				{hasDetails && (
					<button
						type="button"
						className="tv-swarm-chev"
						aria-expanded={open}
						aria-label={t(open ? "collapse" : "expand")}
						onClick={onToggle}
					>
						<span className={`tv-swarm-chev-icon${open ? " tv-swarm-chev-icon--open" : ""}`} aria-hidden="true" />
					</button>
				)}
			</div>
			{open && (
				<div className="tv-swarm-member-body">
					{warning && <Note tone="warn">{warning}</Note>}
					{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
					{output.trim() !== "" && <Output text={output} error={tone === "err"} />}
					{error && !aborted && error !== abortReason && (
						<Note tone={tone === "warn" ? "warn" : "err"}>{error}</Note>
					)}
					{patchPath && <div className="tv-faint">{t("patch: {path}", { path: patchPath })}</div>}
					{!patchPath && branchName && <div className="tv-faint">{t("branch: {name}", { name: branchName })}</div>}
				</div>
			)}
		</div>
	);
}

/** Live (still-running) snapshot for one agent: phase dot + status row.
 *  Rendered in the floating SwarmCard grid. */
function SwarmAgentProgressRow({ p, host }: { p: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const status = str(p.status) ?? "running";
	const tone =
		status === "completed"
			? ("ok" as const)
			: status === "failed" || status === "aborted"
				? ("err" as const)
				: status === "running"
					? ("accent" as const)
					: undefined;
	const phase = progressPhase(p);
	const id = str(p.id) ?? t("agent");
	const description = str(p.description);
	const intent = str(p.lastIntent) ?? str(p.currentTool);
	const bits: string[] = [];
	const toolCount = num(p.toolCount);
	if (toolCount) bits.push(t("{count} tools", { count: String(toolCount) }));
	const tokens = num(p.tokens);
	if (tokens) bits.push(t("{count} tok", { count: fmtCount(tokens) }));
	const durationMs = num(p.durationMs);
	if (durationMs) bits.push(fmtDuration(durationMs));
	const avatarText = taskIdLabel(id)
		.split(/[>_]/)
		.map(part => (part.length > 0 ? part[0] : ""))
		.join("")
		.slice(0, 2)
		.toUpperCase();
	return (
		<div className={`tv-swarm-member tv-swarm-member--${phase}`}>
			<div className="tv-swarm-member-head">
				<span className={`tv-swarm-avatar tv-swarm-avatar--${phase}`} aria-hidden="true">
					{avatarText}
				</span>
				<div className="tv-swarm-member-main">
					<div className="tv-swarm-member-title">
						<AgentLink id={id} host={host}>
							{taskIdLabel(id)}
						</AgentLink>
						<Badge tone={tone}>{status}</Badge>
					</div>
					{description && <div className="tv-swarm-member-desc">{truncate(normalizeWs(description), 120)}</div>}
					{intent && (
						<div className="tv-swarm-member-desc tv-swarm-member-intent">{truncate(normalizeWs(intent), 96)}</div>
					)}
					{bits.length > 0 && <div className="tv-swarm-member-stats">{bits.join(" · ")}</div>}
					{status === "running" && (
						<div className="tv-swarm-bar" aria-hidden="true">
							<span className="tv-swarm-bar-fill tv-swarm-bar-fill--run tv-swarm-bar-fill--live" />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** Final snapshot for one agent: compact status row (one line per subagent)
 *  with a chevron folding that agent's output/notes behind it — TUI task
 *  component parity (per-agent output folds behind expand). The rich avatar
 *  grid lives in the floating SwarmCard instead. */
function AgentResult({
	res,
	host,
	open,
	onToggle,
}: {
	res: Record<string, unknown>;
	host?: ToolRenderHost;
	open: boolean;
	onToggle(): void;
}): ReactNode {
	const { label, tone } = resultStatus(res);
	const id = str(res.id) ?? t("agent");
	const description = str(res.description);
	const stats: string[] = [];
	const tokens = num(res.tokens);
	if (tokens) stats.push(t("{count} tok", { count: fmtCount(tokens) }));
	const requests = num(res.requests);
	if (requests) stats.push(t("{count} req", { count: String(requests) }));
	const durationMs = num(res.durationMs);
	if (durationMs != null) stats.push(fmtDuration(durationMs));
	const model = str(res.resolvedModel);
	if (model) stats.push(model);

	// The runtime prepends a one-line warning when a subagent never called
	// yield; lift it out of the output preview like the TUI does.
	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	const bodyBits = [warning, output.trim(), error, abortReason];
	const hasBody = bodyBits.some(b => Boolean(b));
	const hasDetails = hasBody || Boolean(patchPath) || Boolean(branchName);
	return (
		<>
			<Row
				k={
					<AgentLink id={id} host={host}>
						{taskIdLabel(id)}
					</AgentLink>
				}
			>
				<Badge tone={tone}>{t(label)}</Badge>{" "}
				{res.truncated === true && <Badge tone="warn">{t("truncated")}</Badge>}{" "}
				{description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
				{stats.length > 0 && <span className="tv-faint">{stats.join(" · ")}</span>}
				{hasDetails && (
					<button
						type="button"
						className="tv-swarm-chev"
						aria-expanded={open}
						aria-label={t(open ? "collapse" : "expand")}
						onClick={onToggle}
					>
						<span className={`tv-swarm-chev-icon${open ? " tv-swarm-chev-icon--open" : ""}`} aria-hidden="true" />
					</button>
				)}
			</Row>
			{open && (
				<>
					{warning && <Note tone="warn">{warning}</Note>}
					{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
					{output.trim() !== "" && <Output text={output} maxLines={8} error={tone === "err"} />}
					{error && !aborted && error !== abortReason && (
						<Note tone={tone === "warn" ? "warn" : "err"}>{error}</Note>
					)}
					{patchPath && <div className="tv-faint">{t("patch: {path}", { path: patchPath })}</div>}
					{!patchPath && branchName && <div className="tv-faint">{t("branch: {name}", { name: branchName })}</div>}
				</>
			)}
		</>
	);
}

/** Live (still-running) snapshot for one agent: compact status row (one
 *  line per subagent) — the native task card body. */
function AgentProgressRow({
	p,
	host,
	open,
	onToggle,
}: {
	p: Record<string, unknown>;
	host?: ToolRenderHost;
	open: boolean;
	onToggle(): void;
}): ReactNode {
	const status = str(p.status) ?? "running";
	const tone =
		status === "completed"
			? ("ok" as const)
			: status === "failed" || status === "aborted"
				? ("err" as const)
				: status === "running"
					? ("accent" as const)
					: undefined;
	const id = str(p.id) ?? t("agent");
	const description = str(p.description);
	const intent = str(p.lastIntent) ?? str(p.currentTool);
	const bits: string[] = [];
	const toolCount = num(p.toolCount);
	if (toolCount) bits.push(t("{count} tools", { count: String(toolCount) }));
	const tokens = num(p.tokens);
	if (tokens) bits.push(t("{count} tok", { count: fmtCount(tokens) }));
	const durationMs = num(p.durationMs);
	if (durationMs) bits.push(fmtDuration(durationMs));
	return (
		<Row
			k={
				<AgentLink id={id} host={host}>
					{taskIdLabel(id)}
				</AgentLink>
			}
		>
			<Badge tone={tone}>{status}</Badge> {description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
			{intent && <span className="tv-muted">{truncate(normalizeWs(intent), 64)}</span>}{" "}
			{bits.length > 0 && <span className="tv-faint">{bits.join(" · ")}</span>}
			{intent && (
				<button
					type="button"
					className="tv-swarm-chev"
					aria-expanded={open}
					aria-label={t(open ? "collapse" : "expand")}
					onClick={onToggle}
				>
					<span className={`tv-swarm-chev-icon${open ? " tv-swarm-chev-icon--open" : ""}`} aria-hidden="true" />
				</button>
			)}
			{open && intent && <span className="tv-muted tv-progress-detail">{truncate(normalizeWs(intent), 96)}</span>}
		</Row>
	);
}

function Body({ args, result, host }: ToolRenderProps): ReactNode {
	const resume = str(args.resume);
	const context = str(args.context);
	const tasks = taskItems(args);
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const showProgress = results.length === 0 && progress.length > 0;
	const counts = swarmCounts(results, progress);

	// Per-agent accordion: each subagent's output folds behind its row
	// (TUI task component parity).
	const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
	const toggleRow = (key: string): void => {
		setOpenRows(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// Run footer: outcome counts + total wall time (mirrors the TUI's bracket line).
	let footer: ReactNode = null;
	const totalDurationMs = details ? num(details.totalDurationMs) : null;
	if (results.length > 0) {
		footer = (
			<Row>
				{counts.done > 0 && <Badge tone="ok">{t("{count} succeeded", { count: String(counts.done) })}</Badge>}{" "}
				{counts.mergeFailed > 0 && (
					<Badge tone="warn">{t("{count} merge failed", { count: String(counts.mergeFailed) })}</Badge>
				)}{" "}
				{counts.failed > 0 && <Badge tone="err">{t("{count} failed", { count: String(counts.failed) })}</Badge>}{" "}
				{counts.aborted > 0 && <Badge tone="err">{t("{count} aborted", { count: String(counts.aborted) })}</Badge>}{" "}
				{totalDurationMs != null && <span className="tv-faint">{fmtDuration(totalDurationMs)}</span>}
			</Row>
		);
	}

	// Finished agents first, by runtime ascending — same order as the TUI.
	const ordered = [...results].sort(
		(a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0),
	);

	return (
		<>
			{resume && <Badge>{t("resume {name}", { name: resume })}</Badge>}
			{context && <Output text={context} maxLines={4} title={t("context")} />}
			{tasks.length > 0 && tasks.some(task => task.description || task.assignment || task.isolated || task.id) && (
				<div className="tv-list">
					{tasks.map((task, i) =>
						// A batch entry with nothing but an index renders zero
						// information (the overview chip already carries the
						// count) — skip it instead of leaving an empty row.
						task.description || task.assignment || task.isolated || task.id ? (
							<div key={task.id ?? i}>
								<Row
									k={
										task.id ? (
											<AgentLink id={task.id} host={host}>
												{taskIdLabel(task.id)}
											</AgentLink>
										) : (
											<Badge tone="accent">{`#${i + 1}`}</Badge>
										)
									}
								>
									{task.isolated && <Badge>{t("isolated")}</Badge>}{" "}
									{task.description && <span>{truncate(normalizeWs(task.description), 120)}</span>}
								</Row>
								{task.assignment && <Output text={task.assignment} maxLines={6} title={task.assignment} />}
							</div>
						) : null,
					)}
				</div>
			)}
			{ordered.length > 0 && (
				<div className="tv-list">
					{ordered.map((res, i) => {
						const key = str(res.id) ?? `#${i}`;
						return (
							<AgentResult
								key={key}
								res={res}
								host={host}
								open={openRows.has(key)}
								onToggle={() => toggleRow(key)}
							/>
						);
					})}
					{footer}
				</div>
			)}
			{showProgress && (
				<div className="tv-list">
					{progress.map((p, i) => {
						const key = str(p.id) ?? String(i);
						return (
							<AgentProgressRow
								key={key}
								p={p}
								host={host}
								open={openRows.has(key)}
								onToggle={() => toggleRow(key)}
							/>
						);
					})}
				</div>
			)}
			{ordered.length === 0 && !showProgress && <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const taskRenderer: ToolRenderer = { Summary, Body, SwarmCard };
