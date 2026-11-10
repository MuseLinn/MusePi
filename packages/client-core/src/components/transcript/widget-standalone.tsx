/**
 * Widget card — the visualization rendered in the transcript flow (and
 * mirrored into the GUI right-panel widget tab).
 *
 * A widget call IS the artifact. With the standalone display on
 * (`musepi-gui-widget-standalone`, default ON) the tool card renders this
 * card **in place of** its row, so the payload is drawn exactly once; with
 * it off the call keeps its inline card and this file only supplies the
 * shared `WidgetCard` chrome.
 *
 * `WidgetCard` + `WidgetFullscreen` are host-agnostic (used by the collab
 * transcript and the GUI sidebar tab alike).
 */

import type { ToolResultMessage } from "@musepi/pi-wire";
import { Check as CheckIconData, Code2 as Code2IconData, Copy as CopyIconData, Eye as EyeIconData } from "lucide";
import { Download, ImageDown, Images, Maximize2, MoreHorizontal, X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { downloadBlob } from "../../lib/download";
import { InlineWidget } from "../../tool-render/tools/widget";
import type { ToolRenderHost } from "../../tool-render/types";
import { useWidgetRegistryVersion, widgetDef } from "../../widgets/registry";
import { type WidgetSource, widgetSource } from "../../widgets/source";
import {
	computeMorph,
	MORPH_EASING_IN,
	MORPH_EASING_OUT,
	MORPH_MS,
	type MorphRect,
	motionDisabled,
} from "../image-morph";

/** localStorage key for the standalone widget display. */
export const WIDGET_STANDALONE_KEY = "musepi-gui-widget-standalone";

/** True when the standalone widget display is enabled (default ON). */
export function widgetStandaloneEnabled(): boolean {
	try {
		return (localStorage.getItem(WIDGET_STANDALONE_KEY) ?? "1") !== "0";
	} catch {
		return true;
	}
}

export interface WidgetPayload {
	type: string;
	data: Record<string, unknown>;
	title?: string;
}

/** A successful widget tool result as the card payload, or null when there is
 *  nothing renderable (error, no details, stale type). */
export function widgetPayloadFromResult(result: ToolResultMessage | undefined): WidgetPayload | null {
	if (!result || result.isError === true) return null;
	const details = result.details;
	if (typeof details !== "object" || details === null) return null;
	const rec = details as Record<string, unknown>;
	const type = typeof rec.type === "string" ? rec.type : "";
	if (!type || typeof rec.data !== "object" || rec.data === null) return null;
	return {
		type,
		data: rec.data as Record<string, unknown>,
		...(typeof rec.title === "string" && rec.title.length > 0 ? { title: rec.title } : {}),
	};
}

/**
 * Latest successful widget payload across session entries — the GUI right
 * panel's persistent widget tab mirrors the most recent visualization.
 */
export function latestWidgetFromEntries(entries: readonly unknown[]): WidgetPayload | null {
	let found: WidgetPayload | null = null;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const rec = entry as { type?: unknown; message?: unknown };
		if (rec.type !== "message") continue;
		const msg = rec.message as { role?: unknown; toolName?: unknown; details?: unknown; isError?: unknown } | null;
		if (!msg || typeof msg !== "object" || msg.role !== "toolResult" || msg.toolName !== "widget") continue;
		if (msg.isError === true) continue;
		const details = msg.details;
		if (typeof details !== "object" || details === null) continue;
		const d = details as Record<string, unknown>;
		const type = typeof d.type === "string" ? d.type : "";
		if (!type || typeof d.data !== "object" || d.data === null) continue;
		found = {
			type,
			data: d.data as Record<string, unknown>,
			...(typeof d.title === "string" && d.title.length > 0 ? { title: d.title } : {}),
		};
	}
	return found;
}

/** Fullscreen overlay for a widget (Esc / ✕ closes). */
export function WidgetFullscreen({
	payload,
	host,
	rasterizeCard,
	originRect,
	onClose,
}: {
	payload: WidgetPayload;
	host?: ToolRenderHost;
	/** The host's card capture, threaded so the fullscreen view keeps the same
	 *  annotation entry the inline card has. */
	rasterizeCard?: (element: HTMLElement) => Promise<Blob | null>;
	/** The card's rect at request time: the overlay flies out of it and back
	 *  into it (一镜到底), falling back to a plain mount when it is gone. */
	originRect?(): MorphRect | null;
	onClose(): void;
}): ReactNode {
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const closingRef = useRef(false);
	// True while the panel is scaling between the card and the viewport. The
	// content is blurred for that window: the flight then animates one composited
	// transform instead of repainting text and iframes at every intermediate
	// scale, which is what made the morph read as a stutter.
	const [flying, setFlying] = useState(false);

	// Open flight: the panel is already laid out at its final size, so fly it
	// FROM the card's rect (FLIP). Layout effect, so the un-morphed panel never
	// paints.
	useLayoutEffect(() => {
		const body = bodyRef.current;
		const origin = originRect?.() ?? null;
		if (!body || !origin || motionDisabled()) return;
		const m = computeMorph(origin, body.getBoundingClientRect());
		if (!m) return;
		setFlying(true);
		const anim = body.animate(
			[
				{
					transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`,
					transformOrigin: "top left",
				},
				{ transform: "none", transformOrigin: "top left" },
			],
			{ duration: MORPH_MS, easing: MORPH_EASING_IN },
		);
		anim.onfinish = () => {
			// A close started mid-flight owns the blur until the panel is gone.
			if (!closingRef.current) setFlying(false);
		};
	}, [originRect]);

	const requestClose = useCallback(() => {
		if (closingRef.current) return;
		const body = bodyRef.current;
		const origin = originRect?.() ?? null;
		if (!body || !origin || motionDisabled()) {
			onClose();
			return;
		}
		const m = computeMorph(origin, body.getBoundingClientRect());
		if (!m) {
			onClose();
			return;
		}
		closingRef.current = true;
		setFlying(true);
		const anim = body.animate(
			[
				{ transform: "none", transformOrigin: "top left" },
				{
					transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`,
					transformOrigin: "top left",
				},
			],
			{ duration: MORPH_MS, easing: MORPH_EASING_OUT, fill: "forwards" },
		);
		anim.onfinish = () => onClose();
	}, [onClose, originRect]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") requestClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [requestClose]);
	return createPortal(
		<div className="tr-widget-fs" role="dialog" aria-modal="true" data-flying={flying ? "true" : "false"}>
			<button type="button" className="tr-widget-fs-x" aria-label={t("settings.close")} onClick={requestClose}>
				<X size={16} />
			</button>
			<div className="tr-widget-fs-head">
				<span className="tr-widget-fs-title">{payload.title ?? t("settings.widget")}</span>
			</div>
			<div className="tr-widget-fs-body" ref={bodyRef}>
				<InlineWidget
					type={payload.type}
					data={payload.data}
					title={payload.title ?? ""}
					sendPrompt={host?.sendPrompt}
					rasterizeCard={rasterizeCard}
				/>
			</div>
		</div>,
		document.body,
	);
}

/**
 * Card menu ("⋯"): 下载到本地 / 下载为图片 / 复制为图片 / 复制代码 / 查看代码.
 *
 * Portaled and positioned from the button's viewport rect — the card clips its
 * own overflow, so an in-card popover is cut off on short widgets — flipping
 * above when there is no room below. Scroll/resize re-anchor it (the
 * transcript moves under the card). Actions the host cannot perform are simply
 * absent: "下载为图片"/"复制为图片" need a rasterizer (see ToolRenderHost
 * .saveImage / .copyImage).
 */
function WidgetCardMenu({
	source,
	saveImage,
	copyImage,
	showCode,
	onToggleCode,
}: {
	source: WidgetSource;
	/** Absent when the host has no rasterizer — the item then hides. */
	saveImage?: () => void;
	copyImage?: () => void;
	showCode: boolean;
	onToggleCode(): void;
}): ReactNode {
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
	const [copied, setCopied] = useState(false);

	// One anchoring function for the first open and every re-anchor. Identical
	// positions keep the previous object: a fresh one each call would re-render
	// forever through the effect below.
	const anchor = useCallback((): void => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const right = Math.max(8, window.innerWidth - r.right);
		const height = menuRef.current?.offsetHeight ?? 184;
		const next =
			window.innerHeight - r.bottom >= height + 12
				? { top: r.bottom + 6, right }
				: { bottom: window.innerHeight - r.top + 6, right };
		setAt(prev =>
			prev && prev.top === next.top && prev.bottom === next.bottom && prev.right === next.right ? prev : next,
		);
	}, []);

	useEffect(() => {
		if (!at) return;
		anchor();
		const close = (): void => setAt(null);
		const onDown = (event: PointerEvent): void => {
			const inside = event
				.composedPath()
				.some(n => n instanceof HTMLElement && (n === btnRef.current || n === menuRef.current));
			if (!inside) close();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("keydown", onKey);
		document.addEventListener("scroll", anchor, true);
		window.addEventListener("resize", anchor);
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("scroll", anchor, true);
			window.removeEventListener("resize", anchor);
		};
	}, [at, anchor]);

	const copySource = (): void => {
		void navigator.clipboard.writeText(source.text).then(() => {
			setCopied(true);
			// Hold the menu open long enough to show the flip, then dismiss.
			window.setTimeout(() => setAt(null), 1200);
		});
	};

	return (
		<span className="tv-widget-menu-wrap">
			<button
				ref={btnRef}
				type="button"
				className="tv-widget-fs-btn"
				title={t("settings.widgetActions")}
				aria-label={t("settings.widgetActions")}
				aria-expanded={at !== null}
				onClick={() => {
					if (at) {
						setAt(null);
						return;
					}
					const r = btnRef.current?.getBoundingClientRect();
					if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
				}}
			>
				<MoreHorizontal size={12} />
			</button>
			{at &&
				createPortal(
					<div
						ref={menuRef}
						className="tv-widget-menu"
						role="menu"
						style={{ top: at.top, bottom: at.bottom, right: at.right }}
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								downloadBlob(
									source.filename,
									source.text,
									source.lang === "html" ? "text/html" : "application/json",
								);
								setAt(null);
							}}
						>
							<Download size={13} />
							{t("settings.download")}
						</button>
						{saveImage && (
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									saveImage();
									setAt(null);
								}}
							>
								<ImageDown size={13} />
								{t("settings.widgetDownloadImage")}
							</button>
						)}
						{copyImage && (
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									copyImage();
									setAt(null);
								}}
							>
								<Images size={13} />
								{t("settings.copyImage2")}
							</button>
						)}
						<button type="button" role="menuitem" onClick={copySource}>
							<MorphIcon icon={copied ? CheckIconData : CopyIconData} size={13} spring="snappy" />
							{copied ? t("settings.copied") : t("settings.copy")}
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onToggleCode();
								setAt(null);
							}}
						>
							<MorphIcon icon={showCode ? EyeIconData : Code2IconData} size={13} spring="snappy" />
							{showCode ? t("settings.widgetViewUi") : t("settings.widgetViewCode")}
						</button>
					</div>,
					document.body,
				)}
		</span>
	);
}
/** One standalone widget card: shell + card menu + fullscreen affordance. */
export function WidgetCard({
	payload,
	host,
	className,
}: {
	payload: WidgetPayload;
	host?: ToolRenderHost;
	className?: string;
}): ReactNode {
	const [fullscreen, setFullscreen] = useState(false);
	const [showCode, setShowCode] = useState(false);
	/** One-click source copy. The card menu already offers it, but "copy the
	 *  code" is the most frequent action after looking at a widget, and it was
	 *  two clicks deep behind "⋯". */
	const [copied, setCopied] = useState(false);
	const cardRef = useRef<HTMLDivElement | null>(null);
	useWidgetRegistryVersion();
	const def = widgetDef(payload.type);
	if (!def) return null;
	const title = payload.title ?? def.label ?? t((def.nameKey ?? "widget unknown") as never);
	const source = widgetSource(payload);
	// "下载为图片"/"复制为图片" ride host capabilities, so those items are
	// absent in hosts that have no rasterizer (plain browser, HTML export)
	// rather than dead.
	const saveImage = host?.saveImage
		? () => {
				const element = cardRef.current;
				if (element) void host.saveImage?.(element, source.imageFilename);
			}
		: undefined;
	const copyImage = host?.copyImage
		? () => {
				const element = cardRef.current;
				if (element) void host.copyImage?.(element);
			}
		: undefined;
	const copySource = (): void => {
		void navigator.clipboard.writeText(source.text).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		});
	};
	const copyLabel = copied ? t("settings.copied") : t("settings.copyCode");
	return (
		<div ref={cardRef} className={className ?? ""}>
			<InlineWidget
				type={payload.type}
				data={payload.data}
				title={title}
				sendPrompt={host?.sendPrompt}
				rasterizeCard={host?.rasterizeCard}
				codeView={showCode ? source : null}
				actions={
					<>
						<button
							type="button"
							className="tv-widget-fs-btn"
							title={copyLabel}
							aria-label={copyLabel}
							onClick={copySource}
						>
							<MorphIcon icon={copied ? CheckIconData : CopyIconData} size={12} spring="snappy" />
						</button>
						<WidgetCardMenu
							source={source}
							saveImage={saveImage}
							copyImage={copyImage}
							showCode={showCode}
							onToggleCode={() => setShowCode(v => !v)}
						/>
						<button
							type="button"
							className="tv-widget-fs-btn"
							title={t("settings.widgetFullscreen")}
							aria-label={t("settings.widgetFullscreen")}
							onClick={() => setFullscreen(true)}
						>
							<Maximize2 size={12} />
						</button>
					</>
				}
			/>
			{fullscreen && (
				<WidgetFullscreen
					payload={payload}
					host={host}
					rasterizeCard={host?.rasterizeCard}
					originRect={() => cardRef.current?.getBoundingClientRect() ?? null}
					onClose={() => setFullscreen(false)}
				/>
			)}
		</div>
	);
}
