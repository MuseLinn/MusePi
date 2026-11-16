/**
 * UI-block card — a board card whose content is an OpenUI Lang block.
 *
 * The board used to hold only registered card types: a stock tape, a clock, a
 * calculator. Kimi's canvas holds generated documents instead (`blueprint/
 * widgets/<id>/workspace/index.html`), and our own `html` card already mirrors
 * that. This card closes the other half: the declarative blocks a reply draws
 * can also live on a board, so a generated answer can be kept without being
 * re-authored as HTML.
 *
 * It renders through `renderUiBlockFence`, the same function the transcript
 * uses, so a block looks identical on both surfaces. Controls inside a board
 * block answer through the same store; a board is not a transcript, so an
 * answer there sends its message into the session like any other.
 */

import type { ReactNode } from "react";
import { t } from "../i18n/index.js";
import { renderUiBlockFence } from "../ui-blocks/render.js";
import "../ui-blocks/ui-blocks.css";

export const blockDefaults = (): Record<string, unknown> => ({
	source: 'root = Stack([Card("一块看板", [Text("把回复里的 ui 块放到这里。")])])',
});

/** Board cards are read at a glance; a block bigger than this is a page. */
export const MAX_BLOCK_SOURCE = 12_000;

export function BlockCard({ data }: { data: Record<string, unknown> }): ReactNode {
	const source = typeof data.source === "string" ? data.source : "";
	if (!source.trim()) {
		return <div className="board-block-empty">{t("widget block empty")}</div>;
	}
	return (
		<div
			className="board-block"
			// `renderUiBlockFence` escapes every value it takes from the block; the
			// markup it returns is the same trusted markup the transcript injects.
			dangerouslySetInnerHTML={{ __html: renderUiBlockFence(source) }}
		/>
	);
}
