import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { openBoardFromChat } from "../../components/transcript/canvas-jump.js";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, str } from "../util";

/**
 * `board` tool renderer — desktop dashboard read/write (kimi canvas
 * parity). Unknown actions fall back to a compact JSON row; `save`
 * renders the board summary with an "open board" jump button so the user
 * can hop from the chat straight into the dashboard the agent just built
 * (the same event the `daimon-canvas` reply block dispatches).
 */

function boardIdOf(args: unknown, result: unknown): string | undefined {
	const a = isRecord(args) ? args : null;
	const r = isRecord(result) ? result : null;
	const rBoard = isRecord(r?.board) ? r.board : null;
	const aBoard = isRecord(a?.board) ? a.board : null;
	return (
		str(rBoard?.id) ??
		str(rBoard?.boardId) ??
		str(aBoard?.id) ??
		str(aBoard?.boardId) ??
		str(r?.id) ??
		str(a?.id) ??
		undefined
	);
}

function boardTitleOf(args: unknown, result: unknown): string {
	const a = isRecord(args) ? args : null;
	const r = isRecord(result) ? result : null;
	const rBoard = isRecord(r?.board) ? r.board : null;
	const aBoard = isRecord(a?.board) ? a.board : null;
	return (
		str(rBoard?.title) ??
		str(aBoard?.title) ??
		str(r?.title) ??
		str(a?.title) ??
		""
	);
}

function widgetCountOf(args: unknown, result: unknown): number {
	const a = isRecord(args) ? args : null;
	const r = isRecord(result) ? result : null;
	const rBoard = isRecord(r?.board) ? r.board : null;
	const aBoard = isRecord(a?.board) ? a.board : null;
	const list = rBoard?.widgets ?? aBoard?.widgets;
	return Array.isArray(list) ? list.length : 0;
}

export const boardRenderer: ToolRenderer = {
	Summary: ({ args, result }: ToolRenderProps): string => {
		const action = str((isRecord(args) ? args : null)?.action) ?? "board";
		const title = boardTitleOf(args, result);
		return `${t("board")}${action !== "board" ? ` · ${action}` : ""}${title ? ` · ${title}` : ""}`;
	},
	Body: ({ args, result }: ToolRenderProps): ReactNode => {
		const a = isRecord(args) ? args : null;
		const action = str(a?.action) ?? "";
		if (action !== "save") {
			// list / get / schema — compact raw row.
			return <span className="tv-row-val">{JSON.stringify(result ?? args).slice(0, 300)}</span>;
		}
		const id = boardIdOf(args, result);
		const title = boardTitleOf(args, result);
		const count = widgetCountOf(args, result);
		return (
			<div className="tv-board">
				<div className="tv-board-head">
					<span className="tv-board-title">{title || t("board")}</span>
					<span className="tv-board-tag">{t("board saved")}</span>
				</div>
				<div className="tv-board-meta">
					{count > 0 ? `${count} ${t("widgets count")}` : ""}
				</div>
				{id ? (
					<button type="button" className="tv-board-open" onClick={() => openBoardFromChat(id, title)}>
						<span>▦</span>
						{t("board open")}
						<span className="tv-board-open-arrow">→</span>
					</button>
				) : null}
			</div>
		);
	},
};
