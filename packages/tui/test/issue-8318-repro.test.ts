import { describe, expect, it, vi } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TUI } from "@musepi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Kitty OSC 66 text-sizing marker and the erase sequences the renderer emits.
// A scale-`s` heading renders `s` cells tall and `visibleWidth` cells wide, so
// the blank rows beneath it hold the multicell glyph's lower half: those
// columns must survive every repaint or the glyph vanishes and leaves
// reserved-but-invisible space (issue #8318). The `s=2` "Heading" glyph is
// 2 * 7 = 14 cells wide; the `s=3` "Big" glyph is 3 * 3 = 9.
const OSC66 = "\x1b]66;";
const ST = "\x1b\\";
const ERASE_LINE = "\x1b[2K";

class RawLines implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	setLines(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.#lines;
	}
}

class SeamRawLines extends RawLines implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number {
		return Number.POSITIVE_INFINITY;
	}
}

// Flush the real render scheduler. Its throttle and post-paint settle windows
// are driven by the platform clock, so these integration tests wait real time
// (the suite-wide convention in deccara/image-budget tests) rather than mock a
// scheduler that would not exercise the resize-settle full paint under test.
async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// A non-multiplexer resize paints the viewport immediately and defers the
// authoritative full paint until the drag settles (120 ms window).
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

/**
 * Split the paint write that carries the sized heading into terminal rows and
 * return the heading row plus the `spacerCount` rows written directly beneath
 * it. Rows are `\r\n`-separated in the emitted buffer; the OSC 66 ST (`ESC \\`)
 * never contains a newline, so the split keeps each span intact.
 */
function headingAndSpacers(writes: string[], spacerCount: number): { heading: string; spacers: string[] } {
	const paint = writes.find(write => write.includes(OSC66));
	expect(paint).toBeDefined();
	const rows = paint!.split("\r\n");
	const idx = rows.findIndex(row => row.includes(OSC66));
	expect(idx).toBeGreaterThanOrEqual(0);
	return { heading: rows[idx]!, spacers: rows.slice(idx + 1, idx + 1 + spacerCount) };
}

/**
 * A reserved spacer row must preserve the glyph's own columns `[0, glyphWidth)`
 * while clearing any stale cells to their right (a row can reflow from wider
 * text into the spacer). So: no whole-line erase, no erase-to-end before the
 * glyph, and exactly one cursor-forward to `glyphWidth` followed by erase-to-end.
 */
function expectClearsRightOfGlyph(spacer: string, glyphWidth: number): void {
	expect(spacer).not.toContain(ERASE_LINE);
	expect(spacer).not.toMatch(/^(?:\x1b\[0m)?\x1b\[K/);
	const match = spacer.match(/\x1b\[(\d+)C\x1b\[K/);
	expect(match).not.toBeNull();
	expect(Number(match![1])).toBe(glyphWidth);
}

describe("issue #8318: scaled OSC 66 headings survive repaint and resize", () => {
	it("re-emits the heading and preserves its reserved row on a full repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// Destructive full replay — the same gesture a redraw/session replace
			// uses, routed through the per-row erase path (#lineRewriteSequence).
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
			expect(writes.find(write => write.includes(OSC66))).toContain("Body");
		} finally {
			tui.stop();
		}
	});

	it("preserves the reserved row across a resize repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			term.resize(70, 6);
			await settleResize(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
		} finally {
			tui.stop();
		}
	});

	it("protects every reserved row of a scale-3 heading (the /debug probe case)", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=3;Big${ST}`, "", "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 2);
			expect(heading).toContain("Big");
			for (const spacer of spacers) expectClearsRightOfGlyph(spacer, 9);
		} finally {
			tui.stop();
		}
	});

	it("protects all six reserved rows at the maximum legal scale", async () => {
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=7;Max${ST}`, "", "", "", "", "", "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { spacers } = headingAndSpacers(writes, 6);
			for (const spacer of spacers) expectClearsRightOfGlyph(spacer, 21);
		} finally {
			tui.stop();
		}
	});

	it("clears stale cells when a wide row reflows into the reserved spacer", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		// Row 1 starts as text far wider than the eventual 14-cell glyph.
		const content = new RawLines(["intro", `wide prior text ${"x".repeat(40)}`, "tail"]);
		tui.addChild(content);
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// Reflow: row 0 becomes the sized heading, row 1 becomes its reserved
			// spacer. The glyph write covers only columns [0, 14); the stale wide
			// text to the right must still be erased.
			content.setLines([`${OSC66}s=2;Heading${ST}`, "", "tail"]);
			tui.requestRender();
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
		} finally {
			tui.stop();
		}
	});

	it("uses full-frame context when the spacer is the first row below the commit seam", async () => {
		const term = new VirtualTerminal(80, 4);
		const tui = new TUI(term);
		const content = new SeamRawLines(["old heading row", `wide prior text ${"x".repeat(40)}`, "tail-0", "tail-1"]);
		tui.addChild(content);
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// Appending one row commits frame[0] through the chunk loop. The
			// reserved frame[1] row becomes window[0], so window-local context
			// cannot see the heading immediately above the commit seam.
			content.setLines([`${OSC66}s=2;Heading${ST}`, "", "tail-0", "tail-1", "tail-2"]);
			tui.requestRender();
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
		} finally {
			tui.stop();
		}
	});

	it("preserves the top spacer during an in-place viewport rewrite", async () => {
		const term = new VirtualTerminal(80, 4);
		const tui = new TUI(term);
		// The heading is immediately above the visible window while its reserved
		// lower row is window[0]. An in-place rewrite must classify that row from
		// the full frame rather than the context-free window slice.
		tui.addChild(new RawLines(["f0", "f1", `${OSC66}s=2;Heading${ST}`, "", "b0", "b1", "b2"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true);
			await settle(term);

			const paint = writes.join("");
			expect(paint).toContain("\x1b[14C\x1b[K");
		} finally {
			tui.stop();
		}
	});

	it("preserves the top spacer when the heading scrolls above the resize viewport", async () => {
		const term = new VirtualTerminal(80, 4);
		const tui = new TUI(term);
		// windowTop = frameLength - height = 7 - 4 = 3. The heading sits at row 2
		// (just above the fold) and its reserved spacer at row 3 = window[0], so
		// the resize fast path composes it as the first visible row.
		tui.addChild(new RawLines(["f0", "f1", `${OSC66}s=2;Heading${ST}`, "", "b0", "b1", "b2"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// A width drag paints the viewport synchronously via #emitResizeViewport
			// before the settle full paint. Capture that throwaway frame directly.
			term.resize(70, 4);
			const viewportPaint = writes.find(
				write => write.includes("\x1b[H") && !write.includes("\x1b[2J") && !write.includes("\x1b[3J"),
			);
			expect(viewportPaint).toBeDefined();
			// Row 0 (the spacer) is emitted right after the final cursor-home.
			const seg0 = viewportPaint!.split("\r\n")[0]!;
			const row0 = seg0.slice(seg0.lastIndexOf("\x1b[H") + 3);
			expectClearsRightOfGlyph(row0, 14);
		} finally {
			tui.stop();
		}
	});
});
