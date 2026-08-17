/**
 * generate_image renderer tests: the running state shows the aicss
 * image-generation shimmering canvas placeholder (prompt inside, aspect
 * ratio from args), and the settled state shows the framed preview with
 * the prompt caption under it — never the placeholder once images landed.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolRenderProps } from "../src/tool-render/types";
import { generateImageRenderer } from "../src/tool-render/tools/generate-image";

const renderBody = generateImageRenderer.Body as (props: ToolRenderProps) => ReactNode;

const BASE_ARGS = {
	subject: "a calm mountain lake at dawn",
	action: "generate",
	style: "photorealistic",
	aspect_ratio: "3:4",
};

function imageResult(): ToolRenderProps["result"] {
	return {
		content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		details: { provider: "agnes", model: "image-2.1-flash", imagePaths: ["/tmp/gen.png"] },
	};
}

describe("generate_image renderer", () => {
	it("shows the shimmering canvas placeholder while running (no images yet)", () => {
		const html = renderToStaticMarkup(
			renderBody({ args: BASE_ARGS, result: undefined, running: true } as never),
		);
		expect(html).toContain("tr-img-placeholder");
		expect(html).toContain("tr-img-shimmer");
		expect(html).toContain("Generating image");
		expect(html).toContain("a calm mountain lake at dawn");
		// portrait aspect from args
		expect(html).toContain('aspect-ratio:3/4');
		// the args table is suppressed while generating
		expect(html).not.toContain("tv-kv");
	});

	it("does not show the placeholder once the result has images", () => {
		const html = renderToStaticMarkup(
			renderBody({ args: BASE_ARGS, result: imageResult(), running: false } as never),
		);
		expect(html).not.toContain("tr-img-placeholder");
		expect(html).toContain("tr-tool-image");
		expect(html).toContain("tr-tool-image-caption");
		expect(html).toContain("a calm mountain lake at dawn");
	});
});
