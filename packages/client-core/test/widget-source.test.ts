/**
 * Widget card source contract — what the card's "查看代码 / 复制代码 /
 * 下载到本地" actions put on screen, on the clipboard and on disk.
 *
 * The consumers are the code viewer, the clipboard and the downloaded file;
 * if the representation drifts, the copied text stops being a payload the
 * agent can take back, and the downloaded HTML stops opening standalone.
 */
import { describe, expect, test } from "bun:test";
import { widgetSource } from "../src/widgets/source";

describe("widgetSource", () => {
	test("a generated face exports its own markup as a standalone html file", () => {
		const html = "<div class='face'>hi</div><script>1</script>";
		const source = widgetSource({ type: "html", title: "仪表", data: { html, data: { rpm: 3200 } } });
		expect(source.lang).toBe("html");
		expect(source.text).toBe(html);
		expect(source.filename).toBe("html.html");
		expect(source.imageFilename).toBe("html.png");
	});

	test("a typed widget exports the payload the tool was called with", () => {
		const payload = { type: "metric", title: "温度", data: { label: "CPU", value: 61 } };
		const source = widgetSource(payload);
		expect(source.lang).toBe("json");
		// Round-trip is the contract: pasting this JSON back into a prompt must
		// describe the same card.
		expect(JSON.parse(source.text)).toEqual(payload);
		expect(source.filename).toBe("metric.json");
	});

	test("an untitled widget omits the title key instead of padding it", () => {
		expect(JSON.parse(widgetSource({ type: "todo", data: { items: [] } }).text)).toEqual({
			type: "todo",
			data: { items: [] },
		});
	});

	test("an html face without markup falls back to the JSON form", () => {
		for (const data of [{}, { html: "" }, { html: "   " }]) {
			const source = widgetSource({ type: "html", data });
			expect(source.lang).toBe("json");
			expect(source.filename).toBe("html.json");
			expect(JSON.parse(source.text)).toEqual({ type: "html", data });
		}
	});

	test("file names stay safe for extension-provided types", () => {
		const source = widgetSource({ type: "ext:Some Widget/2", data: {} });
		expect(source.filename).toBe("ext-some-widget-2.json");
		expect(source.imageFilename).toBe("ext-some-widget-2.png");
	});
});
