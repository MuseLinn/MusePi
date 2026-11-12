import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingBlock } from "../src/components/transcript/transcript-content";
import { t } from "../src/i18n/index.js";
import { fmtDuration } from "../src/lib/format.js";

describe("ThinkingBlock labels", () => {
	it("says thinking while streaming", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text="reasoning" streaming />);
		expect(html).toContain(t("transcript.thinkingInProgress"));
		expect(html).toContain("tr-round-fold-icon");
		expect(html).not.toContain(t("transcript.thinkingDone"));
	});

	it("shows the settled process with its duration", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text="reasoning" durationMs={12_000} />);
		expect(html).toContain(t("transcript.thinkingProcess"));
		expect(html).toContain(fmtDuration(12_000));
	});

	it("falls back to a done label when no duration exists", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text="reasoning" />);
		expect(html).toContain(t("transcript.thinkingDone"));
	});
});
