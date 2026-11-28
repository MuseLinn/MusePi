import type { ToolResultMessage } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { memo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { messageText } from "../../lib/format";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import { ToolView } from "../../tool-render/ToolView";
import type { ToolRenderHost, ToolResultImage } from "../../tool-render/types";
import { detailsRecord } from "../../tool-render/util";
import { ImageCardStack } from "./image-card-stack";
import { Markdown } from "./Markdown";
import { isArtifactTool, resultPicturesOf, toolShotsOf } from "./tool-media";
import { toolKind } from "./toolcard-shared";
import { WidgetCard, widgetPayloadFromResult, widgetStandaloneEnabled } from "./widget-standalone";

/** Hoist a tool result's pictures out of the foldable card: the card keeps the
 *  text/log content (its ZCode summary), while the media renders inline in the
 *  message flow. Both channels are hoisted — content image blocks and
 *  `details.images` (image generators, see tool-media) — and stripped from the
 *  card result so the body never re-renders them. Artifact cards keep their
 *  media inside. */
export function hoistToolMedia(
	result: ToolResultMessage | undefined,
	keepMediaInside: boolean,
): { images: ToolResultImage[]; cardResult: ToolResultMessage | undefined } {
	if (!result || keepMediaInside) return { images: [], cardResult: result };
	const images = resultPicturesOf(result);
	if (images.length === 0) return { images: [], cardResult: result };
	const details = detailsRecord(result);
	return {
		images,
		cardResult: {
			...result,
			content: result.content.filter(block => block.type !== "image"),
			...(details !== null && Array.isArray(details.images) ? { details: { ...details, images: [] } } : {}),
		},
	};
}

/** `request_secret` settles into one permanent transcript line. While the card is
 *  above the composer there is nothing to draw here (the card IS the surface);
 *  after the answer, the name, outcome and any narrowing stay readable. */
function SecretLine({
	args,
	result,
	running,
	host,
}: {
	args: unknown;
	result?: ToolResultMessage;
	running?: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	if (running && !result) return null;
	const details = detailsRecord(result) ?? {};
	const argsRecord = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const read = (key: string): string =>
		typeof details[key] === "string"
			? (details[key] as string)
			: typeof argsRecord[key] === "string"
				? (argsRecord[key] as string)
				: "";
	const status = typeof details.status === "string" ? details.status : undefined;
	const narrowed = Array.isArray(details.scope) && details.scope.length > 0;
	// A login is a saved sign-in, not a value: same row, different words, and its
	// line says what it will be used for rather than which env var it reaches.
	const isLogin = details.fillWith === "browser" || typeof details.site === "string";
	const title = isLogin ? t("tools.loginLineLabel") : t("tools.secretLineLabel");
	const name = read("name");
	const site = read("site");
	const state =
		status === "saved"
			? t(isLogin ? "tools.loginLineSaved" : "tools.secretLineSaved")
			: status === "available"
				? t(isLogin ? "tools.loginLineAvailable" : "tools.secretLineAvailable")
				: status === "cancelled"
					? t("tools.secretLineCancelled")
					: t("tools.secretLineInterrupted");
	// Where the entry now lives, so the line is a way in rather than a dead end.
	const canOpen = typeof host?.openSettings === "function" && (status === "saved" || status === "available");
	return (
		<section className="tr-secret-line" data-status={status ?? "interrupted"} aria-label={`${title} ${name}`}>
			{/* The hover card names the store and offers the way in, which is what a
			 *  line about a saved credential is for: "where did it go?" */}
			<div className="tr-secret-hover" role="tooltip">
				<div className="tr-secret-hover-head">
					<span className="tr-secret-hover-title">{t("tools.secretHoverTitle")}</span>
					<span className="tr-secret-hover-sub">{t("tools.secretHoverWhere")}</span>
				</div>
				{canOpen ? (
					<button type="button" className="tr-secret-hover-action" onClick={() => host?.openSettings?.("secrets")}>
						<span>{t("tools.secretHoverOpen")}</span>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path
								d="M5 12h14M13 6l6 6-6 6"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				) : null}
			</div>
			<span className="tr-secret-label">{title}</span>
			<button
				type="button"
				className="tr-secret-name"
				disabled={!canOpen}
				onClick={canOpen ? () => host?.openSettings?.("secrets") : undefined}
			>
				{name || t("tools.secretLineAnonymous")}
			</button>
			{site ? <span className="tr-secret-scope">{site}</span> : null}
			{narrowed ? <span className="tr-secret-scope">{t("tools.secretScopeWorkspace")}</span> : null}
			{read("purpose") ? <span className="tr-secret-purpose">{read("purpose")}</span> : null}
			<span className="tr-secret-state">{state}</span>
		</section>
	);
}

/** Posting time in the viewer's locale, right-aligned on the title row. */
function progressTime(timestamp: number | undefined): { label: string; iso: string } | null {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
	const date = new Date(timestamp);
	return {
		label: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
		iso: date.toISOString(),
	};
}

/** `notify_user` is a progress update, not a tool log: a foldable row with the
 * title, a live/completed state dot and the posting time pinned to the right.
 * A running update starts open (the reader is waiting for it); a completed one
 * starts folded so the transcript stays scannable, and either state can be
 * toggled. */
function ProgressUpdate({
	args,
	running,
	timestamp,
}: {
	args: unknown;
	running?: boolean;
	timestamp?: number;
}): ReactNode {
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : null;
	const title = record !== null && typeof record.title === "string" ? record.title : "";
	const message = record !== null && typeof record.message === "string" ? record.message : "";
	const time = progressTime(timestamp);
	const [open, setOpen] = useState(running === true);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	const hasBody = message.length > 0;
	return (
		<section className="tr-progress-update" data-running={running === true} data-open={open}>
			<span className="tr-progress-dot" aria-hidden />
			<div className="tr-progress-main">
				<button
					type="button"
					className="tr-progress-head"
					aria-expanded={hasBody ? open : undefined}
					onClick={hasBody ? () => setOpen(v => !v) : undefined}
					disabled={!hasBody}
				>
					<span className="tr-progress-chev" aria-hidden />
					<span className="tr-progress-title">{title || t("tools.toolNotifyUser")}</span>
					{time !== null && (
						<time className="tr-progress-time" dateTime={time.iso}>
							{time.label}
						</time>
					)}
				</button>
				{hasBody && (
					<div
						ref={bodyRef}
						className={`tr-progress-body-wrap${open ? "" : " tr-progress-body-wrap--closed"}`}
						style={collapseStyle(open)}
					>
						<div className="tr-progress-body">
							<Markdown text={message} repair="off" />
						</div>
					</div>
				)}
			</div>
		</section>
	);
}

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	/** No result and the agent is idle: the call was cut off mid-flight. */
	interrupted?: boolean;
	partialResult?: unknown;
	/** Message timestamp (epoch ms); the progress row's right-aligned time. */
	timestamp?: number;
	/** Wall-clock start of a live call (epoch ms); drives the elapsed readout. */
	startedAt?: number;
	host?: ToolRenderHost;
	/** display.taskCardStyle parity: "classic" uses the plain tool-call card
	 *  instead of the swarm member-grid card. */
	taskCardStyle?: "swarm" | "classic";
	/** Open the transcript-level full-size image preview (lightbox) at this
	 *  tool's inline media; images are hoisted out of the folded card. */
	onPreviewImage?(images: { src: string; alt: string }[], index: number, element?: HTMLElement | null): void;
	/** Optional: the turn's picture only. A closed turn's reply renders text,
	 *  but keeps its media row (the card body stays out) — see
	 *  round-collapse's media exemption. */
	mediaOnly?: boolean;
}

/** Widget cards render expanded by default (GUI setting
 *  musepi-gui-widget-expanded, written by the appearance chat PrefToggle as
 *  "1"/"0": unset or "1" → expanded, "0" → collapsed; default on — the card
 *  IS the visualization). Artifact cards (`tool-media.isArtifactTool`) never
 *  auto-collapse when the turn completes: process tools fold away, the
 *  artifact stays. */
function widgetDefaultOpen(): boolean {
	try {
		return localStorage.getItem("musepi-gui-widget-expanded") !== "0";
	} catch {
		return true;
	}
}

/** Wire-type adapter over the shared per-tool renderer stack. Media-carrying
 *  results (read image, generate_image, inspect_image, browser screenshots)
 *  are HOISTED out of the card: the tool card keeps its ZCode fold behavior
 *  as a text/log summary, while the result images render inline right below
 *  it in the message flow (craft-agents message-image parity) so the user
 *  never has to expand a folded card to see the picture. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const {
		toolCallId,
		name,
		intent,
		args,
		result,
		running,
		interrupted,
		partialResult,
		timestamp,
		startedAt,
		host,
		taskCardStyle,
		mediaOnly,
		onPreviewImage,
	} = props;
	// A progress update is prose, not a tool card; no fold, no "using" chrome.
	if (name === "notify_user" && !mediaOnly) {
		return <ProgressUpdate args={args} running={running} timestamp={timestamp} />;
	}
	// A secret request keeps one settled line; the typing surface is the card
	// above the composer, not a transcript row.
	if ((name === "request_secret" || name === "request_login") && !mediaOnly) {
		return <SecretLine args={args} result={result} running={running} host={host} />;
	}
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	const structuredPartial =
		(name === "browser" || name === "widget") &&
		running &&
		!result &&
		typeof partialResult === "object" &&
		partialResult !== null &&
		"content" in partialResult &&
		Array.isArray(partialResult.content)
			? (partialResult as ToolResultMessage)
			: undefined;
	const effectiveResult = result ?? structuredPartial;
	// A widget call IS its artifact: with the standalone display on, the card
	// replaces the tool row instead of appearing under a folded one. One
	// payload, one surface — a closed row above a second copy read as a
	// duplication bug.
	if (name === "widget" && widgetStandaloneEnabled()) {
		const payload = widgetPayloadFromResult(effectiveResult);
		if (payload) return <WidgetCard payload={payload} host={host} className="tr-widget-inplace" />;
	}
	// Artifact cards are the deliverable, not process noise, so they never
	// start collapsed. The expanded preference only applies to a widget shown
	// inline (standalone display off).
	const artifactDefaultOpen = name === "widget" ? widgetDefaultOpen() : true;
	// Artifact cards own their visualization (widget/board) — leave their
	// media inside. For every other tool, strip pictures out of the card
	// content so the fold never re-hides them, and render them inline.
	const isArtifact = isArtifactTool(name);
	const { images, cardResult } = hoistToolMedia(effectiveResult, isArtifact);
	// Computer screenshots live in `details.screenshots` (not content
	// blocks), so the picture hoist misses them — pull them out here too, and
	// blank them from the card result (with a screenshotCount fallback for the
	// summary badge) so the folded body never duplicates.
	const shotSrcs = isArtifact ? [] : toolShotsOf(name, effectiveResult);
	let mediaResult = cardResult;
	if (shotSrcs.length > 0 && mediaResult) {
		const details = detailsRecord(mediaResult);
		mediaResult = { ...mediaResult, details: { ...details, screenshots: [], screenshotCount: shotSrcs.length } };
	}
	const mediaItems = [
		...images.map((img, i) => ({
			// Persisted images over the blob threshold keep a `blob:sha256:` ref;
			// ImageCardStack resolves it through the host (lib/blob-image).
			src: img.data.startsWith("blob:") ? img.data : `data:${img.mimeType};base64,${img.data}`,
			mimeType: img.mimeType,
			alt: t("tools.toolResultWithCount", { count: String(i + 1) }),
		})),
		...shotSrcs.map((src, i) => ({ src, alt: t("tools.computerScreenshotWithCount", { count: String(i + 1) }) })),
	];
	// A closed turn's reply keeps its picture without the card (AssistantBody
	// passes this when the text-only reply is a media row).
	if (mediaOnly) {
		return mediaItems.length > 0 ? (
			<ImageCardStack items={mediaItems} host={host} onOpen={(idx, list, el) => onPreviewImage?.(list, idx, el)} />
		) : null;
	}
	return (
		<>
			<ToolView
				toolCallId={toolCallId}
				name={name}
				args={args}
				result={mediaResult}
				running={running}
				interrupted={interrupted}
				intent={intent}
				kind={toolKind(name, intent)}
				partial={partial || undefined}
				startedAt={startedAt}
				host={host}
				taskCardStyle={taskCardStyle}
				/* ZCode parity: live tools open while they run, fold when done;
				 * artifacts (widget/board cards) stay open per the user setting;
				 * a cut-off call opens so its interruption note is readable. */
				defaultOpen={isArtifact ? artifactDefaultOpen : running === true || interrupted === true}
				collapseWhenDone={!isArtifact}
			/>
			{mediaItems.length > 0 && (
				<ImageCardStack
					items={mediaItems}
					host={host}
					onOpen={(idx, list, el) => onPreviewImage?.(list, idx, el)}
				/>
			)}
		</>
	);
});
