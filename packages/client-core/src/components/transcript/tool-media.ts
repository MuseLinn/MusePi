/**
 * Tool-result media and artifact classification — the ONE vocabulary shared by
 * the tool card (what to lift out of its collapsible body) and the completed-
 * round fold (which rows a closed turn keeps visible).
 *
 * Media is a turn's OUTPUT, not its process. The card draws pictures in the
 * message flow instead of inside its body, and the fold keeps the carrying row
 * mounted, so a closed turn still shows the picture the turn produced. Both
 * decisions have to read the result the same way: a second interpretation of
 * "does this result carry pictures" is exactly how the card can show a picture
 * the closed turn hides.
 *
 * Image generators keep the bytes in `details.images` (out of model context),
 * so content blocks alone miss the commonest produced picture.
 */
import type { ToolResultImage, ToolResultLike } from "../../tool-render/types.js";
import { computerShotsOf, detailsRecord, isRecord, resultImagesOf } from "../../tool-render/util.js";

/** Tools whose card IS the deliverable: the card never auto-collapses and the
 *  round fold never hides the row. `notify_user` joins the visualizations
 *  because its card is turn content, not process (see isProgressUpdateRow). */
const ARTIFACT_TOOLS: ReadonlySet<string> = new Set(["widget", "board", "schedule_task", "notify_user"]);

export function isArtifactTool(name: string): boolean {
	return ARTIFACT_TOOLS.has(name);
}

/** Pictures a result carries: content image blocks plus `details.images`
 *  (`{data, mimeType}[]`, the image-generation tools' out-of-context channel). */
export function resultPicturesOf(result: ToolResultLike | undefined): ToolResultImage[] {
	const pictures = resultImagesOf(result);
	const details = detailsRecord(result);
	const generated = details !== null && Array.isArray(details.images) ? details.images : [];
	for (const entry of generated) {
		if (!isRecord(entry)) continue;
		if (typeof entry.data !== "string" || typeof entry.mimeType !== "string") continue;
		pictures.push({ type: "image", data: entry.data, mimeType: entry.mimeType });
	}
	return pictures;
}

/** Screenshots the card lifts out of its body. Only the `computer` tool keeps
 *  them in `details.screenshots`; other tools would surface unrelated fields. */
export function toolShotsOf(name: string, result: ToolResultLike | undefined): string[] {
	return name === "computer" ? computerShotsOf(result) : [];
}
