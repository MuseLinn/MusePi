import type { ToolResultMessage } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { memo } from "react";
import { t } from "../../i18n/index.js";
import { messageText } from "../../lib/format";
import { ToolView } from "../../tool-render/ToolView";
import type { ToolRenderHost, ToolResultImage } from "../../tool-render/types";
import { resultImagesOf } from "../../tool-render/util";
import { ImageCardStack } from "./image-card-stack";
import { toolKind } from "./toolcard-shared";
import { widgetStandaloneEnabled } from "./widget-standalone";

/** Hoist a tool result's image blocks out of the foldable card: the card
 *  keeps the text/log content (its ZCode summary), while the media renders
 *  inline in the message flow. Returns the extracted images (for the inline
 *  stack) plus a copy of the result with those image blocks removed so the
 *  card body never re-renders them. Artifact cards keep their media inside. */
export function hoistToolMedia(
	result: ToolResultMessage | undefined,
	keepMediaInside: boolean,
): { images: ToolResultImage[]; cardResult: ToolResultMessage | undefined } {
	if (!result || keepMediaInside) return { images: [], cardResult: result };
	const images = resultImagesOf(result);
	if (images.length === 0) return { images: [], cardResult: result };
	return {
		images,
		cardResult: { ...result, content: result.content.filter(block => block.type !== "image") },
	};
}

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
	/** display.taskCardStyle parity: "classic" uses the plain tool-call card
	 *  instead of the swarm member-grid card. */
	taskCardStyle?: "swarm" | "classic";
	/** Open the transcript-level full-size image preview (lightbox) at this
	 *  tool's inline media; images are hoisted out of the folded card. */
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
}

/** Widget cards render expanded by default (GUI setting
 *  musepi-gui-widget-expanded; default on — the card IS the visualization).
 *  Board cards render the board itself — same artifact semantics. Both are
 *  turn *artifacts*, so they never auto-collapse when the turn completes
 *  (process tools fold away, the artifact stays). */
function isArtifactCard(name: string): boolean {
	return name === "widget" || name === "board";
}

function widgetDefaultOpen(): boolean {
	try {
		return localStorage.getItem("musepi-gui-widget-expanded") !== "false";
	} catch {
		return true;
	}
}

/** Wire-type adapter over the shared per-tool renderer stack. Media-carrying
 *  results (read image, generate_image, inspect_image, browser screenshots)
 *  are HOISTED out of the card: the tool card keeps its ZCode fold behavior
 *  as a text/log summary, while the result images render inline right below
 *  it in the message flow (craft-agents message-image parity) so the user
 *  never has to expand a folded card to see the picture. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, partialResult, host, taskCardStyle, onPreviewImage } = props;
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	// With the standalone widget display on, the widget's visual lives on
	// its own card in the message flow — the tool-call card folds to its
	// summary line (the musepi-gui-widget-expanded pref only applies when the
	// standalone display is off). Board cards keep their own default.
	const artifactDefaultOpen = name === "widget" && widgetStandaloneEnabled() ? false : widgetDefaultOpen();
	// Artifact cards own their visualization (widget/board) — leave their
	// media inside. For every other tool, strip image blocks out of the
	// card content so the fold never re-hides them, and render them inline.
	const isArtifact = isArtifactCard(name);
	const { images, cardResult } = hoistToolMedia(result, isArtifact);
	const mediaItems = images.map((img, i) => ({
		src: `data:${img.mimeType};base64,${img.data}`,
		alt: t("tool result {count}", { count: String(i + 1) }),
	}));
	return (
		<>
			<ToolView
				name={name}
				args={args}
				result={cardResult}
				running={running}
				intent={intent}
				kind={toolKind(name, intent)}
				partial={partial || undefined}
				host={host}
				taskCardStyle={taskCardStyle}
				/* ZCode parity: live tools open while they run, fold when done;
				 * artifacts (widget/board cards) stay open per the user setting. */
				defaultOpen={isArtifact ? artifactDefaultOpen : running === true}
				collapseWhenDone={!isArtifact}
			/>
			{mediaItems.length > 0 && (
				<ImageCardStack items={mediaItems} onOpen={idx => onPreviewImage?.(mediaItems, idx)} />
			)}
		</>
	);
});
