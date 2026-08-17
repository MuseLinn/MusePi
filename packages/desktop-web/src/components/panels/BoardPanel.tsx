import type { BoardData, BoardWidget as WireBoardWidget } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { GuestClient } from "../../lib/client";
import { WidgetErrorBoundary } from "../../widgets/error-boundary";
import { widgetDef } from "../../widgets/registry";

/**
 * Guest board panel: read-only view of the host's widget boards
 * (board.list). Widgets render through the shared registry with a noop
 * update — no drag/resize, no editing, exactly the desktop canvas minus
 * the chrome. Re-fetches on every mount so external changes show up.
 */

interface BoardPanelProps {
	client: GuestClient;
}

export function BoardPanel({ client }: BoardPanelProps): ReactNode {
	const [boards, setBoards] = useState<BoardData[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
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
				<p className="sh-panel-error">{t("load failed: {error}", { error })}</p>
				<button type="button" className="sh-btn" onClick={() => void load()}>
					{t("retry")}
				</button>
			</div>
		);
	}
	if (boards === null) {
		return <div className="sh-panel-state">{t("loading…")}</div>;
	}
	if (boards.length === 0) {
		return <div className="sh-panel-state">{t("no boards yet")}</div>;
	}

	return (
		<div className="sh-board">
			{boards.map(board => (
				<section key={board.id} className="sh-board-section">
					<h2 className="sh-board-title">{board.title}</h2>
					{board.widgets.length === 0 ? (
						<p className="sh-panel-muted">{t("no widgets yet")}</p>
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

function BoardWidgetCard({
	widget,
	update,
}: {
	widget: WireBoardWidget;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const def = widgetDef(widget.type);
	if (!def) return null;
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
