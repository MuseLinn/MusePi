import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { TailPresence } from "../src/components/transcript/TailPresence";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const phrase = { phase: "tool:searching", phrases: ["正在四处查找", "正在缩小范围"] };

type Props = Parameters<typeof TailPresence>[0];

function render(overrides: Partial<Props> = {}): string {
	return renderToStaticMarkup(
		<TailPresence visible phrase={phrase} seed="s1" since={Date.now() - 12_000} {...overrides} />,
	);
}

describe("TailPresence", () => {
	it("renders nothing when not visible", () => {
		expect(render({ visible: false })).toBe("");
	});

	it("renders the canonical phrase and the sheen copy", () => {
		const html = render();
		expect(html).toContain("正在四处查找");
		expect(html).toContain("presence-band");
	});

	it("keeps the phrase in one single-line slot", () => {
		const html = render();
		expect(html).toContain("presence-phrase");
		expect(html).not.toContain("presence-phrase-wrapped");
	});

	it("marks the animated copy aria-hidden and exposes exactly one live region", () => {
		const html = render();
		expect(html).toContain('aria-hidden="true"');
		expect(html.match(/role="status"/g)?.length).toBe(1);
	});

	it("renders the avatar only when one is supplied", () => {
		expect(render()).not.toContain("presence-avatar");
		expect(render({ avatar: <span>orb</span> })).toContain("presence-avatar");
	});

	it("is a toggle button only when a detail is supplied", () => {
		expect(render()).not.toContain("presence-toggle");
		const withDetail = render({ detail: <span>rows</span>, detailLabel: "这一轮正在做什么" });
		expect(withDetail).toContain("presence-toggle");
		expect(withDetail).toContain('aria-expanded="false"');
	});

	it("shows the quiet note only past the threshold", () => {
		expect(render({ quietMs: 10_000 })).not.toContain("presence-quiet");
		expect(render({ quietMs: 45_000 })).toContain("presence-quiet");
	});

	it("keeps a very long phrase in the same single-line slot", () => {
		const long = { phase: "tool:reading", phrases: [`正在读取 ${"a/".repeat(80)}file.ts`] };
		const html = render({ phrase: long });
		expect(html).toContain("presence-phrase");
		expect(html).not.toContain("presence-phrase-wrapped");
	});

	it("still renders avatar and timer when the phrase is long", () => {
		const long = { phase: "tool:reading", phrases: [`正在读取 ${"a/".repeat(80)}`] };
		const html = render({ phrase: long, avatar: <span>orb</span> });
		expect(html).toContain("presence-avatar");
		expect(html).toContain("presence-timer");
	});

	it("renders exactly one visible phrase copy regardless of the phase", () => {
		for (const phase of ["thinking", "tool:reading", "tool:running-commands", "reply"]) {
			const html = render({ phrase: { phase, phrases: ["一", "二", "三"] } });
			expect(html.match(/class="presence-phrase"/g)?.length).toBe(1);
		}
	});

	it("writes a sheen delay on every band so two rows can differ", () => {
		const a = render();
		const b = render();
		for (const html of [a, b]) {
			expect(html).toMatch(/--presence-sheen-delay:\s*-\d+ms/);
		}
	});
});

describe("tail presence stylesheet contract", () => {
	const css = readFileSync(resolve(import.meta.dirname, "../src/components/transcript/transcript.css"), "utf8");

	it("counter-translates the band and the bright copy", () => {
		// The one non-negotiable correctness condition: the window sweeps one
		// way and the bright copy inside it crosses back, so the glyphs hold
		// still on screen. Same direction = a marquee.
		// Match the exact at-rule names: `presence-band` is a prefix of
		// `presence-bright`, so a loose pattern reads the wrong block.
		const band = /@keyframes presence-band\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		const bright = /@keyframes presence-bright\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		expect(band).toContain("translateX(-70%)");
		expect(band).toContain("translateX(70%)");
		expect(bright).toContain("translateX(70%)");
		expect(bright).toContain("translateX(-70%)");
		expect(band).toContain("steps(12");
		expect(bright).toContain("steps(12");
		expect(band).toContain("35%");
		expect(bright).toContain("35%");
	});

	it("truncates the phrase to one line", () => {
		const rule = /\.presence-phrase\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
		expect(rule).toContain("nowrap");
		expect(rule).toContain("ellipsis");
		expect(rule).toContain("hidden");
	});

	it("puts the detail card on its own line instead of squeezing the phrase", () => {
		// The bug this pins: `.presence-detail` is a child of the horizontal
		// flex row, so `width: 100%` made it compete for the row's width and the
		// phrase collapsed to "正在…". It must wrap to its own line.
		const row = /\.presence\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		expect(row).toContain("flex-wrap: wrap");
		const detail = /\.presence-detail\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		expect(detail).toContain("flex: 0 0 100%");
	});

	it("drops the sheen when motion is off", () => {
		expect(css).toMatch(/prefers-reduced-motion[\s\S]*?\.presence-band\s*\{\s*display:\s*none/);
		expect(css).toMatch(/\.gui-motion-off\s+\.presence-band\s*\{\s*display:\s*none/);
	});
});
