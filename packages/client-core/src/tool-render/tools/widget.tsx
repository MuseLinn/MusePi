import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { WidgetErrorBoundary } from "../../widgets/error-boundary";
import { widgetDef } from "../../widgets/registry";
import type { WidgetSource } from "../../widgets/source";
import { ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, str } from "../util";

/** Shallow content equality for widget data records. Identity alone can't
 *  gate the incoming-data adopt below: while a tool is still running the
 *  renderer rebuilds `data` as a fresh `{}` every render, so reference
 *  comparison would reset local state every frame. Comparing keys and
 *  primitive values (strings compare by value) distinguishes the running
 *  empty placeholder from the real payload. */
export function widgetDataEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const k of ka) {
		if (!(k in b) || a[k] !== b[k]) return false;
	}
	return true;
}

/** Inline widget shell: the shared registry component rendered with a
 *  LOCAL data state so the card is interactive (sliders, calculator,
 *  todo) without persisting anything back to the agent or the board.
 *  When the host wires `sendPrompt` (chat only), interactive widgets can
 *  hand results back to the conversation (kimi sendPrompt parity).
 *  `actions` renders at the head's right edge (fullscreen + the card menu on
 *  the standalone display), and `codeView` swaps the BODY for the widget's
 *  source while the head stays put ("查看代码"). */
export function InlineWidget({
	type,
	data,
	title,
	sendPrompt,
	rasterizeCard,
	actions,
	codeView = null,
}: {
	type: string;
	data: Record<string, unknown>;
	title: string;
	sendPrompt?: (text: string) => void;
	/** 统一标注(桌面渲染器提供卡片 rasterize 时才有):把卡片元素拍成图,
	 *  html 卡片的标注截图由它合成。 */
	rasterizeCard?: (element: HTMLElement) => Promise<Blob | null>;
	actions?: ReactNode;
	/** Source view: when set, the body renders this text instead of the
	 *  registry component (null = normal UI view). */
	codeView?: WidgetSource | null;
}): ReactNode {
	const [local, setLocal] = useState<Record<string, unknown>>(data);
	// The card mounts while the tool is still running — the result (and
	// its data) has not arrived yet, so `data` is the empty placeholder.
	// Adopt the real payload when it lands; user edits via `update` only
	// touch `local`, so the adopted snapshot is never clobbered by the
	// parent's unchanged data on later renders.
	const lastDataRef = useRef(data);
	if (!widgetDataEq(lastDataRef.current, data)) {
		lastDataRef.current = data;
		setLocal(data);
	}
	// 卡片根元素:标注截图 rasterize 的对象(frame 里的 face 由 rasterizer
	// 重建同源影子后拍进图里)。
	const rootRef = useRef<HTMLDivElement | null>(null);
	const def = widgetDef(type);
	if (!def) return <span className="tv-row-val">{t("settings.widgetUnknown")}</span>;
	return (
		<div className="tv-widget" ref={rootRef}>
			<div className="tv-widget-head">
				<span className="tv-widget-title">{title}</span>
				<span className="tv-widget-tag">{type}</span>
				{actions && <span className="tv-widget-actions">{actions}</span>}
			</div>
			<div className="tv-widget-body">
				{codeView ? (
					<pre className="tv-widget-code" data-lang={codeView.lang} aria-label={t("settings.widgetSource")}>
						{codeView.text}
					</pre>
				) : (
					<WidgetErrorBoundary>
						<def.Component
							data={local}
							update={patch => setLocal(prev => ({ ...prev, ...patch }))}
							sendPrompt={sendPrompt}
							annotateCapture={
								rasterizeCard && rootRef.current
									? () => rasterizeCard(rootRef.current as HTMLElement)
									: undefined
							}
						/>
					</WidgetErrorBoundary>
				)}
			</div>
		</div>
	);
}

/**
 * `widget` tool renderer — renders an inline interactive widget in the
 * transcript (kimi inline-widget parity). The tool result's `details`
 * carry `{ type, data, title? }` (the widget tool's WidgetToolDetails);
 * the shared widget registry (the same one the board uses) renders it
 * inside a shell card. Validation against the registry happens
 * daemon-side; here we fall back to a note when the type is unknown
 * (stale session replay).
 */
export const widgetRenderer: ToolRenderer = {
	Summary: ({ args, result }: ToolRenderProps): string => {
		// The payload rides `result.details` on the wire ({type, data,
		// title?} — the widget tool's WidgetToolDetails); `args.type` covers
		// the running state where the result has not landed yet.
		const details = detailsRecord(result);
		const type = str(details?.type) ?? str((isRecord(args) ? args : null)?.type) ?? "";
		return `${t("settings.widget")}${type ? ` · ${type}` : ""}`;
	},
	Body: ({ args, result, host }: ToolRenderProps): ReactNode => {
		const details = detailsRecord(result);
		const type = str(details?.type) ?? str((isRecord(args) ? args : null)?.type) ?? "";
		const def = widgetDef(type);
		if (!def) {
			return <span className="tv-row-val">{t("settings.widgetUnknown")}</span>;
		}
		// Failed calls (validation errors, aborted runs) carry no widget to
		// render — surface the error text instead of a blank card.
		if (result?.isError === true) {
			return <ResultText result={result} maxLines={8} />;
		}
		const data = isRecord(details?.data) ? (details.data as Record<string, unknown>) : {};
		const title = str(details?.title) ?? t(def.nameKey as never);
		return (
			<InlineWidget
				type={type}
				data={data}
				title={title}
				sendPrompt={host?.sendPrompt}
				rasterizeCard={host?.rasterizeCard}
			/>
		);
	},
};
