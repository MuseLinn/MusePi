import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { WidgetErrorBoundary } from "../../widgets/error-boundary";
import { useWidgetRegistryVersion, widgetDef } from "../../widgets/registry";
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
	ask = false,
	rasterizeCard,
	actions,
	codeView = null,
}: {
	type: string;
	data: Record<string, unknown>;
	title: string;
	sendPrompt?: (text: string) => void;
	/** The face asks the user to choose: keep a status line until an answer
	 *  leaves the card. */
	ask?: boolean;
	/** 统一标注(桌面渲染器提供卡片 rasterize 时才有):把卡片元素拍成图,
	 *  html 卡片的标注截图由它合成。 */
	rasterizeCard?: (element: HTMLElement) => Promise<Blob | null>;
	actions?: ReactNode;
	/** Source view: when set, the body renders this text instead of the
	 *  registry component (null = normal UI view). */
	codeView?: WidgetSource | null;
}): ReactNode {
	const [local, setLocal] = useState<Record<string, unknown>>(data);
	const [answered, setAnswered] = useState(false);
	// A face hands an answer to the conversation through sendPrompt; wrapping it
	// here is the only signal the card has that the user chose something.
	const submit = sendPrompt
		? (text: string) => {
				setAnswered(true);
				sendPrompt(text);
			}
		: undefined;
	// Re-render when a plugin contributes this type after the session loaded.
	useWidgetRegistryVersion();
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
	// A custom-HTML face is a whole page, not a component on a card: it takes
	// the full card width with no body padding, the way the page expects to be
	// laid out. Component widgets keep the inset so their own chrome reads as a
	// card.
	const isPage = type === "html";
	return (
		<div className={`tv-widget${isPage ? " tv-widget--page" : ""}`} ref={rootRef}>
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
							sendPrompt={submit}
							annotateCapture={
								// Resolve the element at capture time, not render time: on the
								// first paint `rootRef` is still empty, and gating on it made
								// the entry appear only after some later re-render (or never,
								// on a static widget).
								rasterizeCard
									? () => {
											const element = rootRef.current;
											return element ? rasterizeCard(element) : Promise.resolve(null);
										}
									: undefined
							}
						/>
					</WidgetErrorBoundary>
				)}
			</div>
			{ask && (
				// A waiting page names its state under the page: the card is answered
				// elsewhere (the answer becomes a user message), so without this the
				// page just looks unresponsive.
				<div className={`tv-widget-ask${answered ? " tv-widget-ask--done" : ""}`}>
					{answered ? t("tools.widgetAnswered") : t("tools.widgetWaiting")}
				</div>
			)}
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
		// title?} — the widget tool's WidgetToolDetails); `args` covers the
		// running state where the result has not landed yet. The slot is the
		// card's parenthetical, so a titled widget names itself there instead
		// of repeating the tool label ("组件 · html"), which left the row
		// looking like a stray paren pair around a type tag.
		const details = detailsRecord(result);
		const rawArgs = isRecord(args) ? args : null;
		const title = str(details?.title) ?? str(rawArgs?.title);
		const type = str(details?.type) ?? str(rawArgs?.type) ?? "";
		return title || type;
	},
	Body: ({ args, result, host }: ToolRenderProps): ReactNode => {
		useWidgetRegistryVersion();
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
		const title = str(details?.title) ?? def.label ?? t((def.nameKey ?? "widget unknown") as never);
		return (
			<InlineWidget
				type={type}
				data={data}
				title={title}
				sendPrompt={host?.sendPrompt}
				ask={details?.awaitAnswer === true}
				rasterizeCard={host?.rasterizeCard}
			/>
		);
	},
};
