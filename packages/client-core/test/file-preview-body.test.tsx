import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FilePreviewBody } from "../src/components/panels/FilePreviewBody";
import { t } from "../src/i18n/index";
import type { FilePreviewResult } from "../src/lib/file-preview";

describe("FilePreviewBody (one renderer per preview kind)", () => {
	it("paints an image preview instead of dumping its bytes", () => {
		const preview: FilePreviewResult = {
			kind: "image",
			name: "shot.png",
			mime: "image/png",
			size: 1024,
			url: "blob:preview-1",
		};
		const html = renderToStaticMarkup(<FilePreviewBody preview={preview} />);
		expect(html).toContain('<img class="sh-files-preview-image"');
		expect(html).toContain('src="blob:preview-1"');
		expect(html).toContain('alt="shot.png"');
	});

	it("plays audio and video in the browser's own element", () => {
		const audio = renderToStaticMarkup(
			<FilePreviewBody preview={{ kind: "audio", name: "a.mp3", mime: "audio/mpeg", size: 10, url: "blob:a" }} />,
		);
		expect(audio).toContain("<audio");
		expect(audio).toContain("controls");
		const video = renderToStaticMarkup(
			<FilePreviewBody preview={{ kind: "video", name: "v.mp4", mime: "video/mp4", size: 10, url: "blob:v" }} />,
		);
		expect(video).toContain("<video");
		expect(video).toContain("controls");
	});

	it("offers a download for a binary it cannot render", () => {
		const html = renderToStaticMarkup(
			<FilePreviewBody
				preview={{ kind: "binary", name: "spec.pdf", mime: "application/pdf", size: 2048, url: "blob:pdf" }}
			/>,
		);
		expect(html).toContain("application/pdf");
		expect(html).toContain('href="blob:pdf"');
		expect(html).toContain('download="spec.pdf"');
	});

	it("shows text and names truncation", () => {
		const html = renderToStaticMarkup(
			<FilePreviewBody
				preview={{
					kind: "text",
					name: "notes.md",
					mime: "text/markdown",
					size: 300000,
					text: "# hi",
					truncated: true,
				}}
			/>,
		);
		expect(html).toContain("<pre");
		expect(html).toContain("# hi");
		expect(html).toContain(t("guest.previewTruncated"));
	});

	it("translates a vanished file into copy instead of a raw ENOENT", () => {
		const html = renderToStaticMarkup(
			<FilePreviewBody preview={{ kind: "error", message: "ENOENT: no such file mock/README.md" }} />,
		);
		expect(html).toContain(t("guest.fileUnavailable"));
		expect(html).not.toContain("ENOENT");
	});

	it("surfaces a read failure instead of an empty frame", () => {
		const html = renderToStaticMarkup(
			<FilePreviewBody preview={{ kind: "error", message: "path escapes workspace" }} />,
		);
		expect(html).toContain("sh-panel-error");
		expect(html).toContain("path escapes workspace");
	});
});
