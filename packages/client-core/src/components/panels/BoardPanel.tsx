import type { BoardData, BoardWidget as WireBoardWidget } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { WidgetErrorBoundary } from "../../widgets/error-boundary";
import { type ExtensionWidgetArtifact, loadExtensionWidgets } from "../../widgets/extension-widgets";
import { registerExternalWidgets, useWidgetRegistryVersion, widgetDef } from "../../widgets/registry";

/**
 * Guest board panel: read-only view of the host's widget boards
 * (board.list). Widgets render through the shared registry with a noop
 * update — no drag/resize, no editing, exactly the desktop canvas minus
 * the chrome. Re-fetches on every mount so external changes show up.
 */

interface BoardPanelProps {
	client: SessionClient;
}

export function BoardPanel({ client }: BoardPanelProps): ReactNode {
	useWidgetRegistryVersion();
	const [boards, setBoards] = useState<BoardData[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			// Plugin cards (`registerWidget`) are not in the static registry;
			// load their compiled modules before drawing the boards. A daemon
			// that cannot answer extensions.list still shows the built-ins.
			try {
				const ext = await client.rpc<{ widgets?: ExtensionWidgetArtifact[] }>("extensions.list");
				if (ext?.widgets?.length) registerExternalWidgets(await loadExtensionWidgets(ext.widgets));
			} catch {
				// no extensions surface / no permission — built-ins only
			}
			const res = await client.rpc<{ boards: BoardData[] }>("board.list");
			setBoards(res.boards);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	const noop = useCallback(() => {}, []);

	if (error !== null) {
		return (
			<div className="sh-panel-state">
				<p className="sh-panel-error">{t("guest.loadFailedWithError", { error })}</p>
				<button type="button" className="sh-btn" onClick={() => void load()}>
					{t("settings.retry")}
				</button>
			</div>
		);
	}
	if (boards === null) {
		return <div className="sh-panel-state">{t("settings.loading2")}</div>;
	}
	if (boards.length === 0) {
		return <div className="sh-panel-state">{t("guest.noBoardsYet")}</div>;
	}

	return (
		<div className="sh-board">
			{boards.map(board => (
				<section key={board.id} className="sh-board-section">
					<h2 className="sh-board-title">{board.title}</h2>
					{board.widgets.length === 0 ? (
						<p className="sh-panel-muted">{t("guest.noWidgetsYet")}</p>
					) : (
						<div className="sh-board-grid">
							{[...board.widgets]
								.sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x)
								.map(w => (
									<BoardWidgetCard key={w.id} widget={w} update={noop} />
								))}
						</div>
					)}
				</section>
			))}
		</div>
	);
}

export function BoardWidgetCard({
	widget,
	update,
}: {
	widget: WireBoardWidget;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const def = widgetDef(widget.type);
	if (!def) {
		// A plugin card whose renderer failed to load still occupies its slot;
		// a blank hole reads as a board bug, a labelled shell does not.
		return (
			<div
				className="sh-board-widget sh-board-widget--missing"
				data-tone="default"
				style={{ minHeight: `${Math.max(150, Math.min(320, widget.pos.h))}px` }}
			>
				<div className="sh-board-widget-head">
					<span className="sh-board-widget-title">{widget.title}</span>
				</div>
				<div className="sh-board-widget-body sh-panel-muted">
					{t("settings.widgetUnknown")} · {widget.type}
				</div>
			</div>
		);
	}
	return (
		<div
			className="sh-board-widget"
			data-tone={def.tone ?? "default"}
			style={{ minHeight: `${Math.max(150, Math.min(320, widget.pos.h))}px` }}
		>
			<div className="sh-board-widget-head">
				<span className="sh-board-widget-title">{widget.title}</span>
			</div>
			<div className="sh-board-widget-body">
				<WidgetErrorBoundary>
					<def.Component data={widget.data} update={update} />
				</WidgetErrorBoundary>
			</div>
		</div>
	);
}
