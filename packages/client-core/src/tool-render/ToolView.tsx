/**
 * Tool card chrome + per-tool dispatch. Works in the guest-client app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@musepi/pi-wire";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { fmtDuration } from "../lib/format";
import { collapseStyle, useCollapseHeight } from "../lib/use-collapse.js";
import { resolveToolRenderer, toolCallTitle } from "./registry";
import type { ToolKind, ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, resultTextOf, stripAnsi } from "./util";
import "./tool-render.css";

/**
 * Grace period before a completed tool card auto-folds: the user just
 * watched it run — collapsing the instant it finishes yanks the result
 * away mid-glance. Delaying (and honouring a manual expand during the
 * wait) keeps the reveal readable without piling up open cards.
 */
const COLLAPSE_DELAY_MS = 1800;

export interface ToolViewProps {
	/** Wire tool-call id (settles a held `widget` turn when the page answers). */
	toolCallId?: string;
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Wall-clock start of this call (epoch ms). A running card ticks its
	 *  elapsed readout from it; absent hosts (exports, old transcripts) simply
	 *  show the state without a timer. */
	startedAt?: number;
	/** The call never recorded a result and the agent is idle: a persisted turn
	 *  was cut off mid-execution (daemon exit, crash). Distinct from `pending`,
	 *  which is a call the live turn has not dispatched yet. */
	interrupted?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	/** aicss-style treatment hint (transcript ToolCard sets it). */
	kind?: ToolKind;
	/** display.taskCardStyle parity: "classic" bypasses dedicated Card
	 *  chrome (e.g. the task swarm card) and uses the plain tool card. */
	taskCardStyle?: "swarm" | "classic";
	defaultOpen?: boolean;
	/** ZCode parity: collapse the card when the tool finishes running (the
	 *  process trace folds away once the turn completes). Manual expand
	 *  after the first auto-collapse is respected (one-shot guard). */
	collapseWhenDone?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

const XDEV_PATH_RE = /^xd:\/\/([A-Za-z0-9_-]+)$/;

/** Decode a device write's `content` (a JSON args object, possibly fully or
 *  partially streamed). Anything unparseable renders as an empty arg set; the
 *  card identity already comes from the `xd://` path. */
function decodeDeviceArgs(content: unknown): Record<string, unknown> {
	if (typeof content !== "string") return {};
	const text = content.trim();
	if (text.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Resolve a `write xd://<tool>` device dispatch BEFORE its result arrives.
 * `executeXdevDispatch` can only reroute once the daemon supplies
 * `details.xdev`; until then the row would read as a plain file write and the
 * plugin/extension card would only appear after completion. The path alone
 * names the device, so the running card already shows the real action.
 */
function pendingXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.result !== undefined || props.name !== "write") return null;
	if (!isRecord(props.args)) return null;
	const device = typeof props.args.path === "string" ? XDEV_PATH_RE.exec(props.args.path.trim()) : null;
	if (device === null) return null;
	return { tool: device[1]!, args: decodeDeviceArgs(props.args.content), inner: undefined };
}

interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

function executeXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.name !== "write" || props.result?.isError === true || !isRecord(props.result?.details)) return null;
	const xdev = props.result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	// Collapse/expand height animation: the body stays mounted at height 0
	// when closed so both directions animate (WAAPI-on-mount only covered
	// expand; unmount collapse snapped). See useCollapseHeight.
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	// One-shot fold on the running→done transition (ZCode "process trace
	// folds when the turn completes"). The reverse transition (pending →
	// running, e.g. the active-tool map arrives after the message row)
	// opens the card so a live trace is visible while it runs. Manual
	// expand after the first auto-collapse is respected (doneRef guard).
	// The fold itself is DELAYED (COLLAPSE_DELAY_MS) so a freshly
	// completed card is readable for a moment — collapsing instantly
	// yanks content away the second it finishes, which reads as churn.
	const collapseDoneRef = useRef(false);
	const wasRunningRef = useRef(false);
	const collapseTimerRef = useRef<Timer | null>(null);
	useEffect(() => {
		if (props.collapseWhenDone !== true) return;
		if (props.running === true) {
			collapseDoneRef.current = false;
			// Any pending delayed fold is cancelled — the tool is running
			// again, the card must stay open for the live trace.
			if (collapseTimerRef.current !== null) {
				clearTimeout(collapseTimerRef.current);
				collapseTimerRef.current = null;
			}
			if (!wasRunningRef.current) setOpen(true);
			wasRunningRef.current = true;
			return;
		}
		wasRunningRef.current = false;
		if (props.result !== undefined && collapseDoneRef.current === false) {
			collapseTimerRef.current = setTimeout(() => {
				collapseTimerRef.current = null;
				// Manual interaction since scheduling (collapsed-then-
				// re-expanded, or auto-folded-then-expanded) sets the guard
				// — never auto-fold a card the user has handled.
				if (collapseDoneRef.current) return;
				collapseDoneRef.current = true;
				setOpen(false);
			}, COLLAPSE_DELAY_MS);
		}
	}, [props.collapseWhenDone, props.running, props.result]);
	useEffect(
		() => () => {
			if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current);
		},
		[],
	);
	const xdev = executeXdevDispatch(props) ?? pendingXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const result = xdev
		? props.result === undefined
			? undefined
			: { content: props.result.content, details: xdev.inner, isError: props.result.isError }
		: props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		toolCallId: props.toolCallId ?? "",
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
		kind: props.kind,
		intent,
	};

	const isError = props.result?.isError === true;
	const status = props.running
		? "run"
		: isError
			? "err"
			: props.result
				? "ok"
				: props.interrupted
					? "interrupted"
					: "pending";
	// Known tools read as their action name ("运行命令"); the key argument stays
	// in the Summary slot beside it. Unknown tools keep the raw wire name.
	const title = toolCallTitle(name, renderer);
	const titled = title !== name;
	// The first non-empty result line stands in for the argument summary on a
	// failed call: a red card whose head still only names the target makes the
	// user expand it to learn WHY it failed.
	const errorLine = isError
		? (resultTextOf(props.result)
				.split("\n")
				.map(line => line.trim())
				.find(line => line.length > 0) ?? "")
		: "";
	const ToolIcon = renderer.Icon;
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";
	// Live elapsed readout: only a running call with a known start ticks. The
	// interval is dropped the moment the call settles, so a finished transcript
	// holds no timers.
	const [clock, setClock] = useState(() => Date.now());
	useEffect(() => {
		if (props.running !== true || props.startedAt === undefined) return;
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [props.running, props.startedAt]);
	const elapsedMs =
		props.running === true && props.startedAt !== undefined ? Math.max(0, clock - props.startedAt) : null;
	// Visible state readout beside the argument: running carries the live
	// elapsed time, a failure its own word, and a cut-off call its interruption.
	// Success needs no word — the green dot and the result body already say it.
	const meta =
		props.running === true
			? `${t("tools.running")}${elapsedMs === null ? "" : ` · ${fmtDuration(elapsedMs)}`}`
			: isError
				? t("tools.failed")
				: props.interrupted === true
					? t("tools.callInterruptedShort")
					: null;
	// Progressive per-line reveal (aicss streaming-text): each line fades in
	// with a stagger, plus a steady caret while the tool keeps streaming.
	const partialLines = useMemo(() => partial.split("\n"), [partial]);

	// The dedicated full-card chrome (`Card`) is legacy and bypasses the
	// generic head entirely.
	if (renderer.Card && props.taskCardStyle !== "classic") {
		return <renderer.Card {...renderProps} />;
	}

	const nativeCard = (
		<div className={`tv-card${isError ? " tv-card--error" : ""}${props.kind ? ` tr-card--${props.kind}` : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => {
					// Any manual click cancels the pending delayed fold. The
					// card is OPEN during the grace period, so the first
					// click there is a collapse (the timer would have done
					// the same — no point waiting it out); re-expanding
					// afterwards means the user drives the state, and the
					// one-shot guard keeps it from auto-folding again.
					if (collapseTimerRef.current !== null) {
						clearTimeout(collapseTimerRef.current);
						collapseTimerRef.current = null;
					}
					setOpen(v => {
						const next = !v;
						if (next) collapseDoneRef.current = true;
						return next;
					});
				}}
				title={intent || undefined}
			>
				{/* One anchor for every foldable process row: the chevron leads,
				 *  status/result dots follow. It used to trail the argument, so a
				 *  tool card folded at the opposite edge from 思考过程 / 活动. */}
				<span className="tv-chev" aria-hidden="true" />
				{status === "run" ? (
					<span className="tv-spin" aria-label={t("tools.running")} />
				) : (
					<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
				)}
				{ToolIcon ? (
					<span className="tv-tool-icon" aria-hidden="true">
						<ToolIcon />
					</span>
				) : null}
				<span className="tv-name">{title}</span>
				<span className="tv-arg">
					{titled ? (
						<span className="tv-arg-paren" aria-hidden="true">
							{t("tools.argOpen")}
						</span>
					) : null}
					<span className="tv-sum">
						<renderer.Summary {...renderProps} />
						{errorLine !== "" && (
							<>
								<span className="tv-faint" aria-hidden="true">
									{" · "}
								</span>
								<span className="tv-err-text">{errorLine}</span>
							</>
						)}
					</span>
					{titled ? (
						<span className="tv-arg-paren" aria-hidden="true">
							{t("tools.argClose")}
						</span>
					) : null}
				</span>
				{meta !== null && (
					<span
						className={`tv-meta${isError ? " tv-meta--err" : ""}${props.interrupted === true ? " tv-meta--warn" : ""}`}
					>
						{meta}
					</span>
				)}
			</button>
			<div ref={bodyRef} className={`tv-body${open ? "" : " tv-body--closed"}`} style={collapseStyle(open)}>
				{intent && <div className="tv-intent">{intent}</div>}
				{props.interrupted && <div className="tv-interrupted">{t("tools.callInterrupted")}</div>}
				{renderer.Body ? <renderer.Body {...renderProps} /> : null}
			</div>
			{partial && (
				<div className="tr-stream" aria-live="polite">
					{partialLines.map((line, i) => (
						<div
							// Streamed lines have no stable id — the append-only index is their identity.
							key={i}
							className="tr-stream-line"
							// Tight cascade: 16ms steps, capped at 5 lines (~80ms) so a
							// multi-line tool burst lands together instead of trailing
							// line-by-line (the old 36ms × 10 = 620ms tail).
							style={{ "--tr-i": String(Math.min(i, 5)) } as CSSProperties}
						>
							{line.length > 0 ? line : "\u00A0"}
						</div>
					))}
					<span className="tr-stream-caret" aria-hidden="true" />
				</div>
			)}
		</div>
	);
	// The additive swarm member grid is NOT rendered in the transcript: the
	// native tool-call card lists one collapsible line per subagent (TUI
	// parity), and the floating avatar grid is hosted by the GUI composer's
	// temporary status chip when taskCardStyle=swarm.
	return nativeCard;
}
