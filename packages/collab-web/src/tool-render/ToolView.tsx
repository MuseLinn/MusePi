/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@musepi/pi-wire";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { useCollapseHeight, collapseStyle } from "../lib/use-collapse.js";
import { resolveToolRenderer } from "./registry";
import type { ToolKind, ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	/** aicss-style treatment hint (transcript ToolCard sets it). */
	kind?: ToolKind;
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
	const collapseDoneRef = useRef(false);
	const wasRunningRef = useRef(false);
	useEffect(() => {
		if (props.collapseWhenDone !== true) return;
		if (props.running === true) {
			collapseDoneRef.current = false;
			if (!wasRunningRef.current) setOpen(true);
			wasRunningRef.current = true;
			return;
		}
		wasRunningRef.current = false;
		if (props.result !== undefined && collapseDoneRef.current === false) {
			collapseDoneRef.current = true;
			setOpen(false);
		}
	}, [props.collapseWhenDone, props.running, props.result]);	const xdev = executeXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const result = xdev
		? { content: props.result!.content, details: xdev.inner, isError: props.result!.isError }
		: props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
		kind: props.kind,
	};

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";
	// Progressive per-line reveal (aicss streaming-text): each line fades in
	// with a stagger, plus a steady caret while the tool keeps streaming.
	const partialLines = useMemo(() => partial.split("\n"), [partial]);

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}${props.kind ? ` tr-card--${props.kind}` : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
				title={intent || undefined}
			>
				{status === "run" ? (
					<span className="tv-spin" aria-label={t("running")} />
				) : (
					<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
				)}
				<span className="tv-name">{xdev ? `xd://${name}` : name}</span>
				<span className="tv-sum">
					<renderer.Summary {...renderProps} />
				</span>
				<span className="tv-chev" aria-hidden="true" />
			</button>
			<div ref={bodyRef} className={`tv-body${open ? "" : " tv-body--closed"}`} style={collapseStyle(open)}>
				{intent && <div className="tv-intent">{intent}</div>}
				{renderer.Body ? <renderer.Body {...renderProps} /> : null}
			</div>
			{partial && (
				<div className="tr-stream" aria-live="polite">
					{partialLines.map((line, i) => (
						<div
							// Streamed lines have no stable id — the append-only index is their identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: streamed lines have no stable id
							key={i}
							className="tr-stream-line"
							style={{ "--tr-i": String(Math.min(i, 10)) } as CSSProperties}
						>
							{line.length > 0 ? line : "\u00A0"}
						</div>
					))}
					<span className="tr-stream-caret" aria-hidden="true" />
				</div>
			)}
		</div>
	);
}
