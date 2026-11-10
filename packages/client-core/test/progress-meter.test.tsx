import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressMeter, ProgressSegments } from "../src/components/progress/ProgressMeter";
import {
	capRunningFraction,
	clampFraction,
	clampProgress,
	fractionPercent,
	UNFINISHED_PROGRESS_CAP,
} from "../src/components/progress/progress";

describe("progress math", () => {
	it("floors an unfinished percentage so it never reads full", () => {
		expect(clampProgress(99.6)).toBe(99);
		expect(clampProgress(99.999)).toBe(99);
		expect(clampProgress(100)).toBe(100);
	});

	it("clamps into range and treats non-finite input as empty", () => {
		expect(clampProgress(-5)).toBe(0);
		expect(clampProgress(150)).toBe(100);
		expect(clampProgress(Number.NaN)).toBe(0);
		expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampFraction(Number.NaN)).toBe(0);
		expect(clampFraction(1.4)).toBe(1);
	});

	it("caps a running fraction below full and lets settled work finish", () => {
		expect(capRunningFraction(0.99, false)).toBe(UNFINISHED_PROGRESS_CAP);
		expect(capRunningFraction(0.5, false)).toBe(0.5);
		expect(capRunningFraction(0.99, true)).toBe(0.99);
	});

	it("converts a fraction through the same floor", () => {
		expect(fractionPercent(0.996)).toBe(99);
		expect(fractionPercent(1)).toBe(100);
		expect(fractionPercent(Number.NaN)).toBe(0);
	});
});

describe("ProgressMeter", () => {
	it("announces the same floored value the fill shows", () => {
		const html = renderToStaticMarkup(<ProgressMeter value={99.6} label="Researcher" valueText="99%" />);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="99"');
		expect(html).toContain('aria-valuemax="100"');
		expect(html).toContain('aria-valuemin="0"');
		expect(html).toContain('aria-label="Researcher"');
		expect(html).toContain("--progress-value:0.99");
	});

	it("marks full only at 100", () => {
		expect(renderToStaticMarkup(<ProgressMeter value={100} />)).toContain('data-done="true"');
		expect(renderToStaticMarkup(<ProgressMeter value={99} />)).not.toContain("data-done");
	});

	it("drops aria-valuenow while indeterminate", () => {
		const html = renderToStaticMarkup(<ProgressMeter value={40} indeterminate label="Working" />);
		expect(html).toContain('data-indeterminate="true"');
		expect(html).not.toContain("aria-valuenow");
	});
});

describe("ProgressSegments", () => {
	it("keeps one segment per non-empty phase", () => {
		const html = renderToStaticMarkup(
			<ProgressSegments
				segments={[
					{ value: 2, tone: "ok" },
					{ value: 1, tone: "err" },
					{ value: 0, tone: "warn" },
				]}
			/>,
		);
		expect(html.match(/musepi-progress-seg"/g)).toHaveLength(2);
		expect(html).toContain('data-tone="ok"');
		expect(html).toContain('data-tone="err"');
		expect(html).toContain('aria-hidden="true"');
	});

	it("renders nothing when every phase is empty", () => {
		expect(renderToStaticMarkup(<ProgressSegments segments={[{ value: 0 }]} />)).toBe("");
	});
});
