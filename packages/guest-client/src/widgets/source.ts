/**
 * Widget card source — the single representation behind the card's
 * "查看代码 / 复制代码 / 下载到本地" actions.
 *
 * A card is rendered from `{ type, data, title? }`, so that payload IS its
 * source: a custom-HTML face supplies the HTML it runs, and every typed
 * widget supplies the JSON the `widget` tool was called with (paste it back
 * into a prompt to regenerate or edit the card). Keeping the choice in one
 * pure function means the viewer, the clipboard and the downloaded file can
 * never drift apart.
 */

/** A widget payload as it reaches the card (mirrors WidgetPayload). */
export interface WidgetSourceInput {
	type: string;
	data: Record<string, unknown>;
	title?: string;
}

export interface WidgetSource {
	/** Code language for the viewer's label and syntax slot. */
	lang: "html" | "json";
	/** Suggested file name for the "下载到本地" text export. */
	filename: string;
	/** Suggested file name for the "下载为图片" raster export. */
	imageFilename: string;
	text: string;
}

/** File-name-safe fragment (widget types are registry ids, but a face type
 *  may come from an extension). */
function slug(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned === "" ? "widget" : cleaned.slice(0, 40);
}

/** The generated face's own markup. */
function htmlSource(data: Record<string, unknown>): string | null {
	const html = data.html;
	return typeof html === "string" && html.trim() !== "" ? html : null;
}

export function widgetSource(payload: WidgetSourceInput): WidgetSource {
	if (payload.type === "html") {
		const html = htmlSource(payload.data);
		if (html !== null) {
			return {
				lang: "html",
				filename: `${slug(payload.type)}.html`,
				imageFilename: `${slug(payload.type)}.png`,
				text: html,
			};
		}
	}
	const payloadJson: Record<string, unknown> = { type: payload.type };
	if (payload.title !== undefined) payloadJson.title = payload.title;
	payloadJson.data = payload.data;
	return {
		lang: "json",
		filename: `${slug(payload.type)}.json`,
		imageFilename: `${slug(payload.type)}.png`,
		text: JSON.stringify(payloadJson, null, 2),
	};
}
