import type { ReactNode } from "react";

/**
 * `daimon-canvas` preview blocks (kimi parity): the agent ends a board-build
 * reply with a fenced block so the user can jump straight from chat to the
 * dashboard it just created:
 *
 * ```daimon-canvas
 * canvasId: <board id>
 * title: <board title>
 * ```
 *
 * The block is extracted out of the message text (never rendered as code)
 * and replaced by an "open board" card. Clicking dispatches a window-level
 * event; the desktop shell (GUI) listens and swaps to the board view.
 */

const CANVAS_FENCE_RE = /```daimon-canvas[^\S\r\n]*\r?\n([\s\S]{0,2048}?)```/g;
const CANVAS_ID_RE = /\bcanvasId[ \t]*:[ \t]*([A-Za-z0-9_-]+)/;
const CANVAS_TITLE_RE = /\btitle[ \t]*:[ \t]*([^\r\n]+)/;

export interface CanvasJumpBlock {
	canvasId: string;
	title?: string;
}

/** Extract ```daimon-canvas fences; returns remaining content + blocks. */
export function extractCanvasJumpBlocks(content: string): { content: string; blocks: CanvasJumpBlock[] } {
	if (!content.includes("```daimon-canvas")) return { content, blocks: [] };
	const blocks: CanvasJumpBlock[] = [];
	const seen = new Set<string>();
	const out = content.replace(CANVAS_FENCE_RE, (full, inner: string) => {
		const canvasId = CANVAS_ID_RE.exec(inner)?.[1]?.trim();
		if (!canvasId || seen.has(canvasId)) return full;
		seen.add(canvasId);
		const title = CANVAS_TITLE_RE.exec(inner)?.[1]?.trim();
		blocks.push({ canvasId, title });
		return "";
	});
	return { content: out, blocks };
}

/** Open-board card dispatched to the desktop shell. */
export function openBoardFromChat(canvasId: string, title?: string): void {
	window.dispatchEvent(
		new CustomEvent("omp-open-board", {
			detail: { id: canvasId, title: title ?? "" },
		}),
	);
}

export function CanvasJumpCard({ block }: { block: CanvasJumpBlock }): ReactNode {
	return (
		<button type="button" className="tr-canvas-jump" onClick={() => openBoardFromChat(block.canvasId, block.title)}>
			<span className="tr-canvas-jump-icon" aria-hidden="true">
				▦
			</span>
			<span className="tr-canvas-jump-text">
				<span className="tr-canvas-jump-title">{block.title || block.canvasId}</span>
				<span className="tr-canvas-jump-sub">打开看板</span>
			</span>
			<span className="tr-canvas-jump-arrow" aria-hidden="true">
				→
			</span>
		</button>
	);
}
