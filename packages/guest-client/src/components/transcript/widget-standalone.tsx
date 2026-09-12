/**
 * Widget standalone display — the visualization rendered as its own card
 * in the transcript flow (and mirrored into the GUI right-panel widget
 * tab), instead of being buried inside the collapsed tool-call card.
 *
 * - `musepi-gui-widget-standalone` (localStorage, default ON) gates the
 *   standalone card; when ON the tool-call card defaults to collapsed.
 * - `WidgetStandaloneCards` renders the deduped successful widget payloads
 *   of one assistant message, file-preview-card style (user request:
 *   "类似文件预览卡片那种单独的").
 * - `WidgetCard` + `WidgetFullscreen` are host-agnostic (used by the
 *   collab transcript and the GUI sidebar tab alike).
 */

import type { AssistantContent, ToolResultMessage } from "@musepi/pi-wire";
import { Check, Code2, Copy, Download, Eye, ImageDown, Maximize2, MoreHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { downloadBlob } from "../../lib/download";
import { InlineWidget } from "../../tool-render/tools/widget";
import type { ToolRenderHost } from "../../tool-render/types";
import { widgetDef } from "../../widgets/registry";
import { type WidgetSource, widgetSource } from "../../widgets/source";

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

/** Successful widget tool-result payloads of one assistant message,
 *  deduped by content (a re-render of the same widget collapses to one
 *  card), last occurrence wins. */
export function collectWidgetPayloads(
	content: readonly AssistantContent[],
	results: ReadonlyMap<string, ToolResultMessage>,
): WidgetPayload[] {
	const seen = new Map<string, WidgetPayload>();
	for (const block of content) {
		if (block.type !== "toolCall" || block.name !== "widget") continue;
		const result = results.get(block.id);
		if (!result || result.isError === true) continue;
		const details = result.details;
		if (typeof details !== "object" || details === null) continue;
		const rec = details as Record<string, unknown>;
		const type = typeof rec.type === "string" ? rec.type : "";
		if (!type || typeof rec.data !== "object" || rec.data === null) continue;
		const payload: WidgetPayload = {
			type,
			data: rec.data as Record<string, unknown>,
			...(typeof rec.title === "string" && rec.title.length > 0 ? { title: rec.title } : {}),
		};
		seen.set(JSON.stringify(payload), payload);
	}
	return [...seen.values()];
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
	onClose,
}: {
	payload: WidgetPayload;
	host?: ToolRenderHost;
	onClose(): void;
}): ReactNode {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<div className="tr-widget-fs" role="dialog" aria-modal="true">
			<button type="button" className="tr-widget-fs-x" aria-label={t("close")} onClick={onClose}>
				<X size={16} />
			</button>
			<div className="tr-widget-fs-head">
				<span className="tr-widget-fs-title">{payload.title ?? t("widget")}</span>
			</div>
			<div className="tr-widget-fs-body">
				<InlineWidget
					type={payload.type}
					data={payload.data}
					title={payload.title ?? ""}
					sendPrompt={host?.sendPrompt}
				/>
			</div>
		</div>,
		document.body,
	);
}

/**
 * Card menu ("⋯"): 下载到本地 / 下载为图片 / 复制代码 / 查看代码.
 *
 * Portaled and positioned from the button's viewport rect — the card clips its
 * own overflow, so an in-card popover is cut off on short widgets — flipping
 * above when there is no room below. Scroll/resize re-anchor it (the
 * transcript moves under the card). Actions the host cannot perform are simply
 * absent: "下载为图片" needs a rasterizer (see ToolRenderHost.saveImage).
 */
function WidgetCardMenu({
	source,
	saveImage,
	showCode,
	onToggleCode,
}: {
	source: WidgetSource;
	/** Absent when the host has no rasterizer — the item then hides. */
	saveImage?: () => void;
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
		const onDown = (event: MouseEvent): void => {
			const inside = event
				.composedPath()
				.some(n => n instanceof HTMLElement && (n === btnRef.current || n === menuRef.current));
			if (!inside) close();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey);
		document.addEventListener("scroll", anchor, true);
		window.addEventListener("resize", anchor);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
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
				title={t("widget actions")}
				aria-label={t("widget actions")}
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
							{t("download")}
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
								{t("widget download image")}
							</button>
						)}
						<button type="button" role="menuitem" onClick={copySource}>
							{copied ? <Check size={13} /> : <Copy size={13} />}
							{copied ? t("copied") : t("copy")}
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onToggleCode();
								setAt(null);
							}}
						>
							{showCode ? <Eye size={13} /> : <Code2 size={13} />}
							{showCode ? t("widget view ui") : t("widget view code")}
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
	const cardRef = useRef<HTMLDivElement | null>(null);
	const def = widgetDef(payload.type);
	if (!def) return null;
	const title = payload.title ?? t(def.nameKey as never);
	const source = widgetSource(payload);
	// "下载为图片" rides a host capability, so the item is absent in hosts that
	// have no rasterizer (plain browser, HTML export) rather than dead.
	const saveImage = host?.saveImage
		? () => {
				const element = cardRef.current;
				if (element) void host.saveImage?.(element, source.imageFilename);
			}
		: undefined;
	return (
		<div ref={cardRef} className={className ?? ""}>
			<InlineWidget
				type={payload.type}
				data={payload.data}
				title={title}
				sendPrompt={host?.sendPrompt}
				codeView={showCode ? source : null}
				actions={
					<>
						<WidgetCardMenu
							source={source}
							saveImage={saveImage}
							showCode={showCode}
							onToggleCode={() => setShowCode(v => !v)}
						/>
						<button
							type="button"
							className="tv-widget-fs-btn"
							title={t("widget fullscreen")}
							aria-label={t("widget fullscreen")}
							onClick={() => setFullscreen(true)}
						>
							<Maximize2 size={12} />
						</button>
					</>
				}
			/>
			{fullscreen && <WidgetFullscreen payload={payload} host={host} onClose={() => setFullscreen(false)} />}
		</div>
	);
}

/** Standalone cards for one settled assistant message (file-preview-card
 *  style, "行间自适应交互式展示"). Returns null when disabled or empty. */
export function WidgetStandaloneCards({
	content,
	results,
	host,
}: {
	content: readonly AssistantContent[];
	results: ReadonlyMap<string, ToolResultMessage>;
	host?: ToolRenderHost;
}): ReactNode {
	if (!widgetStandaloneEnabled()) return null;
	const payloads = collectWidgetPayloads(content, results);
	if (payloads.length === 0) return null;
	return (
		<div className="tr-widget-standalone" aria-label={t("widget preview")}>
			{payloads.map(payload => (
				<WidgetCard key={JSON.stringify(payload)} payload={payload} host={host} />
			))}
		</div>
	);
}
