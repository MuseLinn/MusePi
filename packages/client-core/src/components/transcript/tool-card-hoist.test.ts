import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@musepi/pi-wire";
import { hoistToolMedia } from "./ToolCard";

/**
 * hoistToolMedia contract: result pictures are pulled OUT of the tool card
 * (which keeps its fold behavior), so media renders inline in the message
 * flow instead of hiding behind a collapsed card — and the completed-round
 * fold treats the same pictures as output (round-collapse). The card result
 * must NOT re-render those images (no duplication), and artifact cards
 * (widget/board) keep their media inside.
 */

const imageBlock = { type: "image", data: "Zm9v", mimeType: "image/png" } as const;
const textBlock = { type: "text", text: "Read image file [image/png]" } as const;
const result = {
	content: [textBlock, imageBlock] as unknown as ToolResultMessage["content"],
} as ToolResultMessage;

describe("hoistToolMedia", () => {
	test("extracts image blocks and strips them from the card result", () => {
		const { images, cardResult } = hoistToolMedia(result, false);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ mimeType: "image/png", data: "Zm9v" });
		expect(cardResult).toBeDefined();
		expect(cardResult!.content).toHaveLength(1);
		expect(cardResult!.content.some(b => b.type === "image")).toBe(false);
		// Text block survives for the card summary.
		expect(cardResult!.content.some(b => b.type === "text")).toBe(true);
	});

	test("keeps media inside for artifact cards (widget/board)", () => {
		const { images, cardResult } = hoistToolMedia(result, true);
		expect(images).toHaveLength(0);
		expect(cardResult!.content.some(b => b.type === "image")).toBe(true);
	});

	test("undefined result is a no-op", () => {
		const { images, cardResult } = hoistToolMedia(undefined, false);
		expect(images).toEqual([]);
		expect(cardResult).toBeUndefined();
	});

	test("text-only result has no images and passes the card result through", () => {
		const textOnly = { content: [textBlock] } as unknown as ToolResultMessage;
		const { images, cardResult } = hoistToolMedia(textOnly, false);
		expect(images).toEqual([]);
		expect(cardResult).toBe(textOnly);
	});

	test("lifts generated pictures out of details.images and clears them from the card", () => {
		// The production image-generator shape: content is text only, bytes ride
		// in `details.images`. Without this channel the hoist misses the
		// commonest generated picture and the card body hides it.
		const generated = {
			content: [{ type: "text", text: "Generated 1 image(s):" }],
			details: { provider: "agnes", imagePaths: ["/tmp/gen.png"], images: [imageBlock] },
		} as unknown as ToolResultMessage;
		const { images, cardResult } = hoistToolMedia(generated, false);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ mimeType: "image/png", data: "Zm9v" });
		// Fields the card still reads survive; only the bytes are removed.
		const details = cardResult?.details as { provider?: string; imagePaths?: string[]; images?: unknown[] };
		expect(details.provider).toBe("agnes");
		expect(details.imagePaths).toEqual(["/tmp/gen.png"]);
		expect(details.images).toEqual([]);
	});
});
