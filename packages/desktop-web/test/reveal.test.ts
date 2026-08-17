import { describe, expect, it } from "bun:test";
import {
	BlockUnitCounter,
	BURST_WINDOW,
	burstStyleFor,
	CATCHUP_FRAMES,
	countGraphemes,
	FLIP_WINDOW,
	flipStyleFor,
	GLITCH_CHARS,
	GLITCH_WINDOW,
	glitchGlyph,
	glitchScrambled,
	glitchStyleFor,
	graphemeSpans,
	INK_WINDOW,
	inkStyleFor,
	MIN_STEP,
	nextRevealPosition,
	nextStep,
	RAINBOW_HUE_STEP,
	sliceGraphemes,
	TAIL_RENDERERS,
	TYPING_FADE_WINDOW,
	typingFadeOpacity,
} from "../src/components/transcript/reveal";

/** Pure Intl.Segmenter grapheme count, independent of BlockUnitCounter's memoization. */
function refCount(text: string): number {
	return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

/** Pure Intl.Segmenter grapheme slice, independent of BlockUnitCounter's memoization. */
function refSlice(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	let count = 0;
	for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

describe("grapheme counting", () => {
	it("treats a ZWJ emoji family as a single grapheme", () => {
		const family = "👨‍👩‍👧‍👦";
		expect(countGraphemes(`${family}B`)).toBe(2);
	});

	it("counts CJK characters one per grapheme", () => {
		expect(countGraphemes("逐字输出")).toBe(4);
	});

	it("matches the reference segmenter on mixed text", () => {
		const text = "Hello 世界 👨‍👩‍👧‍👦 test 中文, a😀b";
		expect(countGraphemes(text)).toBe(refCount(text));
	});
});

describe("sliceGraphemes", () => {
	it("never splits a grapheme cluster", () => {
		const family = "👨‍👩‍👧‍👦";
		expect(sliceGraphemes(`${family}B`, 1)).toBe(family);
		expect(sliceGraphemes(`${family}B`, 2)).toBe(`${family}B`);
	});

	it("slices CJK per character", () => {
		expect(sliceGraphemes("逐字输出", 2)).toBe("逐字");
	});

	it("returns full text when units exceed length", () => {
		const text = "ab";
		expect(sliceGraphemes(text, 99)).toBe(text);
	});

	it("matches the reference slice for every prefix length", () => {
		const text = "a😀b中👨‍👩‍👧‍👦d";
		for (let units = 0; units <= refCount(text) + 2; units++) {
			expect(sliceGraphemes(text, units)).toBe(refSlice(text, units));
		}
	});
});

describe("nextStep catch-up", () => {
	it("eats a large backlog in ~8 frames", () => {
		const largeBacklog = CATCHUP_FRAMES * 101;
		const step = nextStep(largeBacklog);
		expect(step).toBe(101);
		expect(step * CATCHUP_FRAMES).toBeGreaterThanOrEqual(largeBacklog);
	});

	it("floors at MIN_STEP for a trickle", () => {
		expect(nextStep(1)).toBe(MIN_STEP);
		expect(nextStep(MIN_STEP * CATCHUP_FRAMES)).toBe(MIN_STEP);
	});

	it("never goes negative", () => {
		expect(nextStep(-5)).toBe(MIN_STEP);
	});
});

describe("nextRevealPosition (proportional drain)", () => {
	it("advances a large backlog by the catch-up step, never pops it", () => {
		// Fast stream, big backlog: the reveal STEPS (drain over ~8 frames)
		// instead of jumping to the delivered text — no chunk popping.
		const total = 101 * CATCHUP_FRAMES;
		const stepped = nextRevealPosition(0, total);
		expect(stepped).toBe(101);
		expect(stepped).toBeLessThan(total);
	});

	it("advances a small backlog one grapheme at a time", () => {
		// A trickle never skips ahead of its own pace.
		expect(nextRevealPosition(0, 4)).toBe(1);
	});

	it("never overshoots the delivered text", () => {
		for (let total = 0; total < 200; total += 7) {
			for (let revealed = 0; revealed <= total; revealed += 1) {
				expect(nextRevealPosition(revealed, total)).toBeLessThanOrEqual(total);
			}
		}
	});

	it("drains a large backlog mostly in the first frames (geometric decay)", () => {
		// Proportional drain: each frame eats 1/8 of the CURRENT backlog
		// (Cherry Studio / proma parity). After 8 frames a 1000-char burst
		// is down to ~34% — the reveal visibly races ahead, then eases as
		// the backlog shrinks. Never pops the whole chunk at once.
		const total = 1000;
		let revealed = 0;
		for (let i = 0; i < CATCHUP_FRAMES; i++) {
			revealed = nextRevealPosition(revealed, total);
		}
		expect(revealed).toBeGreaterThanOrEqual(600);
		expect(revealed).toBeLessThan(total);
	});

	it("converges to the delivered text", () => {
		const total = 1000;
		let revealed = 0;
		let frames = 0;
		while (revealed < total && frames < 500) {
			revealed = nextRevealPosition(revealed, total);
			frames += 1;
		}
		expect(revealed).toBe(total);
		expect(frames).toBeLessThan(100);
	});
});

describe("graphemeSpans (dazzle)", () => {
	it("walks the golden-angle hue sequence", () => {
		const spans = graphemeSpans("abc");
		expect(spans.map(s => s.word).join("")).toBe("abc");
		expect(spans[0]!.hue).toBe(0);
		expect(spans[1]!.hue).toBeCloseTo(RAINBOW_HUE_STEP);
		expect(spans[2]!.hue).toBeCloseTo((RAINBOW_HUE_STEP * 2) % 360);
	});

	it("keeps a ZWJ emoji family as one colored word", () => {
		const family = "👨‍👩‍👧‍👦";
		const spans = graphemeSpans(`${family}B`);
		expect(spans).toHaveLength(2);
		expect(spans[0]!.word).toBe(family);
	});

	it("hues every CJK character independently", () => {
		const spans = graphemeSpans("逐字输出");
		expect(spans).toHaveLength(4);
		expect(new Set(spans.map(s => s.hue)).size).toBe(4);
	});
});

describe("BlockUnitCounter", () => {
	it("counts incrementally when text appends", () => {
		const c = new BlockUnitCounter();
		expect(c.count(0, "ab")).toBe(2);
		expect(c.count(0, "abc")).toBe(3);
		expect(c.count(0, "abcd")).toBe(4);
	});

	it("re-segments when an append extends the final cluster (ZWJ)", () => {
		const c = new BlockUnitCounter();
		expect(c.count(0, "ab👨")).toBe(3);
		// "👨" + "\u200D👩" merges into a single cluster: 3, not 4.
		expect(c.count(0, "ab👨\u200D👩x")).toBe(4);
	});

	it("slices incrementally reusing the previous prefix", () => {
		const c = new BlockUnitCounter();
		const text = "逐字输出测试";
		expect(c.slice(0, text, 2)).toBe("逐字");
		expect(c.slice(0, text, 3)).toBe("逐字输");
		expect(c.slice(0, text, 6)).toBe(text);
	});

	it("slices match the reference for growing units", () => {
		const c = new BlockUnitCounter();
		const text = "a😀b中👨‍👩‍👧‍👦d";
		for (let units = 0; units <= refCount(text); units++) {
			expect(c.slice(0, text, units)).toBe(refSlice(text, units));
		}
	});

	it("reset clears memoized state", () => {
		const c = new BlockUnitCounter();
		c.count(0, "abc");
		c.slice(0, "abc", 2);
		c.reset();
		expect(c.count(0, "abc")).toBe(3);
		expect(c.slice(0, "abc", 2)).toBe("ab");
	});

	it("full reveal of a cumulative target ends at the exact text", () => {
		const c = new BlockUnitCounter();
		const targets = ["", "H", "He", "Hel", "Hello", "Hello ", "Hello world"];
		let revealed = 0;
		for (const t of targets) {
			const total = c.count(0, t);
			// catch up over frames like the controller does
			while (revealed < total) {
				revealed = Math.min(total, revealed + nextStep(total - revealed));
			}
			expect(c.slice(0, t, revealed)).toBe(t);
		}
		expect(c.slice(0, "Hello world", revealed)).toBe("Hello world");
	});
});

describe("typingFadeOpacity", () => {
	it("oldest window grapheme is opaque, newest is faintest", () => {
		expect(typingFadeOpacity(0)).toBe(1);
		expect(typingFadeOpacity(TYPING_FADE_WINDOW - 1)).toBe(0.25);
	});

	it("is monotonically decreasing across the window", () => {
		const values = Array.from({ length: TYPING_FADE_WINDOW }, (_, i) => typingFadeOpacity(i));
		for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1]);
	});

	it("guards a 1-grapheme window against divide-by-zero", () => {
		expect(typingFadeOpacity(0, 1)).toBe(1);
	});

	it("window size shifts the curve", () => {
		expect(typingFadeOpacity(0, 20)).toBe(1);
		expect(typingFadeOpacity(19, 20)).toBe(0.25);
		expect(typingFadeOpacity(10, 20)).toBeGreaterThan(0.25);
	});
});

describe("burstStyleFor (彩虹烟花)", () => {
	it("newest grapheme (windowSize-1) bursts: dim, rainbow red, glow", () => {
		const s = burstStyleFor(BURST_WINDOW - 1);
		expect(s).not.toBeNull();
		expect(Number(s!.opacity)).toBeLessThan(0.5);
		expect(s!.color).toMatch(/^hsl\(0 /); // bursts red
		expect(s!.textShadow).toContain("hsl(");
	});

	it("oldest grapheme (0, document order) is settled → null, plain text", () => {
		expect(burstStyleFor(0)).toBeNull();
		expect(burstStyleFor(0, 20)).toBeNull();
	});

	it("hue walks red (new) → violet (settling) as localIndex grows", () => {
		const hues = [1, Math.floor(BURST_WINDOW / 2), BURST_WINDOW - 1].map(i =>
			Number(burstStyleFor(i)!.color!.match(/hsl\((\d+)/)![1]),
		);
		expect(hues[2]).toBeLessThan(hues[1]);
		expect(hues[1]).toBeLessThan(hues[0]);
	});

	it("opacity rises as the burst settles (older = more opaque)", () => {
		const ops = [BURST_WINDOW - 1, BURST_WINDOW - 3, BURST_WINDOW - 5].map(i =>
			Number(burstStyleFor(i)!.opacity),
		);
		for (let i = 1; i < ops.length; i++) expect(ops[i]).toBeGreaterThan(ops[i - 1]);
	});

	it("guard: 1-wide window's only grapheme is the newest → bursts, no div-by-zero", () => {
		const s = burstStyleFor(0, 1);
		expect(s).not.toBeNull();
		expect(s!.textShadow).toContain("hsl(");
	});
});

describe("flipStyleFor (逐字 3D 翻牌)", () => {
	it("newest grapheme is flipped 90° and dim", () => {
		const s = flipStyleFor(FLIP_WINDOW - 1);
		expect(s).not.toBeNull();
		expect(s!.display).toBe("inline-block");
		expect(s!.transform).toContain("rotateX(90deg)");
		expect(Number(s!.opacity)).toBeLessThan(0.5);
	});

	it("oldest grapheme settled → null", () => {
		expect(flipStyleFor(0)).toBeNull();
	});

	it("rotation decreases toward 0 as the flip completes", () => {
		const deg = (i: number) => Number(flipStyleFor(i)!.transform.match(/rotateX\((\d+)deg\)/)![1]);
		expect(deg(FLIP_WINDOW - 1)).toBeGreaterThan(deg(Math.floor(FLIP_WINDOW / 2)));
		expect(deg(Math.floor(FLIP_WINDOW / 2))).toBeGreaterThan(0);
	});

	it("opacity rises as the flip completes", () => {
		const ops = [FLIP_WINDOW - 1, FLIP_WINDOW - 3, FLIP_WINDOW - 5].map(i => Number(flipStyleFor(i)!.opacity));
		for (let i = 1; i < ops.length; i++) expect(ops[i]).toBeGreaterThan(ops[i - 1]);
	});

	it("guard: 1-wide window's only grapheme is the newest → flips", () => {
		expect(flipStyleFor(0, 1)).not.toBeNull();
	});
});

describe("glitch (故障乱码)", () => {
	it("newest graphemes scramble, older ones show the real character", () => {
		expect(glitchScrambled(GLITCH_WINDOW - 1)).toBe(true);
		expect(glitchScrambled(GLITCH_WINDOW - 2)).toBe(true);
		expect(glitchScrambled(0)).toBe(false);
	});

	it("glyphs come from the full-width garble set", () => {
		for (let i = 0; i < 20; i++) expect(GLITCH_CHARS).toContain(glitchGlyph());
	});

	it("newest grapheme carries a strong RGB split, oldest is settled", () => {
		const s = glitchStyleFor(GLITCH_WINDOW - 1);
		expect(s).not.toBeNull();
		expect(s!.textShadow).toContain("rgba(255,64,64");
		expect(s!.textShadow).toContain("rgba(64,200,255");
		expect(glitchStyleFor(0)).toBeNull();
	});

	it("split decays as the grapheme settles", () => {
		const jitter = (i: number) => Number(glitchStyleFor(i)!.textShadow.match(/^-([\d.]+)px /)![1]);
		expect(jitter(GLITCH_WINDOW - 1)).toBeGreaterThan(jitter(1));
	});
});

describe("TAIL_RENDERERS", () => {
	it("covers the five tail-window presets", () => {
		expect(Object.keys(TAIL_RENDERERS).sort()).toEqual(["burst", "flip", "glitch", "ink", "typewriter"].sort());
	});

	it("typewriter keeps the real word, flip keeps it too, glitch may scramble", () => {
		const t = TAIL_RENDERERS.typewriter.render(0, "字");
		expect(t!.text).toBe("字");
		expect(t!.style.opacity).toBe("1");
		const f = TAIL_RENDERERS.flip.render(0, "字");
		expect(f).toBeNull(); // oldest flip grapheme is settled
		const g = TAIL_RENDERERS.glitch.render(0, "字");
		expect(g).toBeNull();
		const gNew = TAIL_RENDERERS.glitch.render(GLITCH_WINDOW - 1, "字");
		expect(gNew!.text).not.toBe("字");
	});

	it("settled slots return null so callers emit plain text", () => {
		expect(TAIL_RENDERERS.burst.render(0, "字")).toBeNull();
		expect(TAIL_RENDERERS.flip.render(0, "字")).toBeNull();
	});
});

describe("inkStyleFor (逐字水墨)", () => {
	it("newest grapheme bleeds: blur + oversize + dim", () => {
		const s = inkStyleFor(INK_WINDOW - 1);
		expect(s).not.toBeNull();
		expect(s!.display).toBe("inline-block");
		expect(s!.filter).toMatch(/blur\([1-9]/); // blur > 0
		expect(Number(s!.opacity)).toBeLessThan(0.6);
		expect(s!.transform).toMatch(/scale\(1\.[2-5]/); // oversized
	});

	it("oldest grapheme settled → null", () => {
		expect(inkStyleFor(0)).toBeNull();
	});

	it("blur decays and opacity rises as it settles", () => {
		const blurOf = (i: number) => Number(inkStyleFor(i)!.filter.match(/blur\(([\d.]+)px\)/)![1]);
		const opOf = (i: number) => Number(inkStyleFor(i)!.opacity);
		expect(blurOf(INK_WINDOW - 1)).toBeGreaterThan(blurOf(Math.floor(INK_WINDOW / 2)));
		expect(opOf(INK_WINDOW - 1)).toBeLessThan(opOf(1));
	});

	it("guard: 1-wide window's only grapheme is the newest → bleeds", () => {
		expect(inkStyleFor(0, 1)).not.toBeNull();
	});
});
