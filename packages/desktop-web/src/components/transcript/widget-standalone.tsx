/**
 * Widget standalone display — the visualization rendered as its own card
 * in the transcript flow (and mirrored into the GUI right-panel widget
 * tab), instead of being buried inside the collapsed tool-call card.
 *
 * - `omp-gui-widget-standalone` (localStorage, default ON) gates the
 *   standalone card; when ON the tool-call card defaults to collapsed.
 * - `WidgetStandaloneCards` renders the deduped successful widget payloads
 *   of one assistant message, file-preview-card style (user request:
 *   "类似文件预览卡片那种单独的").
 * - `WidgetCard` + `WidgetFullscreen` are host-agnostic (used by the
 *   collab transcript and the GUI sidebar tab alike).
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { t } from "../../i18n/index.js";
import { widgetDef } from "../../widgets/registry";
import type { AssistantContent, ToolResultMessage } from "@musepi/pi-wire";
import { InlineWidget } from "../../tool-render/tools/widget";
import type { ToolRenderHost } from "../../tool-render/types";

/** localStorage key for the standalone widget display. */
export const WIDGET_STANDALONE_KEY = "omp-gui-widget-standalone";

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
				<InlineWidget type={payload.type} data={payload.data} title={payload.title ?? ""} sendPrompt={host?.sendPrompt} />
			</div>
		</div>,
		document.body,
	);
}

/** One standalone widget card: shell + fullscreen affordance. */
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
	const def = widgetDef(payload.type);
	if (!def) return null;
	const title = payload.title ?? t(def.nameKey as never);
	return (
		<div className={className ?? ""}>
			<InlineWidget
				type={payload.type}
				data={payload.data}
				title={title}
				sendPrompt={host?.sendPrompt}
				actions={
					<button
						type="button"
						className="tv-widget-fs-btn"
						title={t("widget fullscreen")}
						aria-label={t("widget fullscreen")}
						onClick={() => setFullscreen(true)}
					>
						<Maximize2 size={12} />
					</button>
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
