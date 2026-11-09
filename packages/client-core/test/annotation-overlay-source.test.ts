/**
 * The overlay is delivered into a sandboxed frame as source text and wrapped
 * there as `window.__musepiAnnotationResult = (<source>);`. A terminator on the
 * source turned that into `(new Promise(...););` — a parse error the frame
 * reported as "overlay did not start". The builder must return an expression.
 */
import { describe, expect, it } from "bun:test";
import { buildAnnotationOverlayScript } from "../src/annotation/overlay";

const theme = {
	primary: "rgb(1, 2, 3)",
	primarySoft: "rgba(1, 2, 3, 0.2)",
	primaryContrast: "rgb(255, 255, 255)",
	border: "rgba(255, 255, 255, 0.2)",
	glassSurface: "rgba(0, 0, 0, 0.5)",
	glassFilter: "blur(20px)",
	mutedText: "rgb(150, 150, 150)",
	colorScheme: "dark" as const,
};

const labels = {
	select: "选择",
	marquee: "框选",
	draw: "绘制",
	commentPlaceholder: "评论",
	submit: "提交",
};

describe("annotation overlay source", () => {
	it("is a bare expression the host can wrap", () => {
		const script = buildAnnotationOverlayScript(theme as never, labels as never);
		expect(script.trimStart().startsWith("new Promise")).toBe(true);
		expect(script.trimEnd().endsWith(";")).toBe(false);
	});
});
