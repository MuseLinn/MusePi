import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { WidgetErrorBoundary } from "../../widgets/error-boundary";
import { WIDGET_REGISTRY, widgetDef } from "../../widgets/registry";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, str } from "../util";

/** Inline widget shell: the shared registry component rendered with a
 *  LOCAL data state so the card is interactive (sliders, calculator,
 *  todo) without persisting anything back to the agent or the board.
 *  When the host wires `sendPrompt` (chat only), interactive widgets can
 *  hand results back to the conversation (kimi sendPrompt parity). */
function InlineWidget({
	type,
	data,
	title,
	sendPrompt,
}: {
	type: string;
	data: Record<string, unknown>;
	title: string;
	sendPrompt?: (text: string) => void;
}): ReactNode {
	const [local, setLocal] = useState<Record<string, unknown>>(data);
	const def = widgetDef(type);
	if (!def) return <span className="tv-row-val">{t("widget unknown")}</span>;
	return (
		<div className="tv-widget">
			<div className="tv-widget-head">
				<span className="tv-widget-title">{title}</span>
				<span className="tv-widget-tag">{type}</span>
			</div>
			<div className="tv-widget-body">
				<WidgetErrorBoundary>
					<def.Component
						data={local}
						update={patch => setLocal(prev => ({ ...prev, ...patch }))}
						sendPrompt={sendPrompt}
					/>
				</WidgetErrorBoundary>
			</div>
		</div>
	);
}

/**
 * `widget` tool renderer — renders an inline interactive widget in the
 * transcript (kimi inline-widget parity). The tool result carries
 * `{ type, data, title? }`; the shared widget registry (the same one the
 * board uses) renders it inside a shell card. Validation against the
 * registry happens daemon-side; here we fall back to a note when the type
 * is unknown (stale session replay).
 */
export const widgetRenderer: ToolRenderer = {
	Summary: ({ args, result }: ToolRenderProps): string => {
		const r = isRecord(result) ? result : null;
		const type = str(r?.type) ?? str((isRecord(args) ? args : null)?.type) ?? "";
		return `${t("widget")}${type ? ` · ${type}` : ""}`;
	},
	Body: ({ args, result, host }: ToolRenderProps): ReactNode => {
		const r = isRecord(result) ? result : null;
		const type = str(r?.type) ?? str((isRecord(args) ? args : null)?.type) ?? "";
		const def = widgetDef(type);
		if (!def) {
			return <span className="tv-row-val">{t("widget unknown")}</span>;
		}
		const data = isRecord(r?.data) ? (r.data as Record<string, unknown>) : {};
		const title = str(r?.title) ?? t(def.nameKey as never);
		return <InlineWidget type={type} data={data} title={title} sendPrompt={host?.sendPrompt} />;
	},
};
