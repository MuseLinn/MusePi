import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackWidthEpoch,
	type RenderScheduler,
	type RenderTimer,
	TUI,
} from "@musepi/pi-tui";
import { Text } from "@musepi/pi-tui/components/text";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2088
//
// Closing a tmux horizontal split widens the surviving pane. SIGWINCH fires
// on the host process before tmux finishes repainting the pane buffer at
// the new size, and drag-resize/pane-close animations also fire several
// SIGWINCHes in flight. Forcing an immediate render on every event raced
// those mid-reflow paints — tmux's catch-up paint then partially overwrote
// the TUI output, which the user saw as a viewport flash or blank screen
// before the next throttled frame arrived.
//
// Fix: coalesce SIGWINCHes inside a multiplexer settle window so a single
// forced render fires once the pane is quiet. `#resizeEventPending` is set
// on every event so the eventual render still classifies as a resize.

// Pad the production debounce by 30 ms so the test consistently observes the
// settled render without re-encoding the constant.
const DEBOUNCE_SETTLE_WAIT_MS = 80;

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class RevisionMutableLinesComponent implements Component {
	#lines: string[];
	#revision = 0;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
		this.#revision++;
	}

	getNativeScrollbackWidthEpochRevision(): number {
		return this.#revision;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class WrappingLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rows: string[] = [];
		for (const line of this.#lines) {
			for (let offset = 0; offset < line.length; offset += width) rows.push(line.slice(offset, offset + width));
		}
		return rows;
	}
}

class RecoveringWrappingLinesComponent extends WrappingLinesComponent implements NativeScrollbackWidthEpoch {
	#resolveAttempts = 0;
	#lastRows = 0;

	override render(width: number): string[] {
		const rows = super.render(width);
		this.#lastRows = rows.length;
		return rows;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		return {};
	}

	resolveNativeScrollbackWidthEpoch(): number | undefined {
		this.#resolveAttempts++;
		return this.#resolveAttempts === 1 ? undefined : this.#lastRows;
	}

	getNativeScrollbackWidthEpochRows(): number {
		return this.#lastRows;
	}

	isNativeScrollbackWidthEpochAppendOnly(): boolean {
		return true;
	}
}

class UnresolvedWrappingLinesComponent extends WrappingLinesComponent implements NativeScrollbackWidthEpoch {
	captureNativeScrollbackWidthEpoch(): unknown {
		return {};
	}

	resolveNativeScrollbackWidthEpoch(): undefined {
		return undefined;
	}

	getNativeScrollbackWidthEpochRows(): undefined {
		return undefined;
	}
}

class WidthLabelComponent implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [width < 30 ? "narrow layout" : "wide layout"];
	}
}

class CommittedMutableLinesComponent implements Component, NativeScrollbackCommittedRows {
	readonly receivedCommittedRows: number[] = [];
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(lines: string[]): void {
		this.#lines.push(...lines);
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.receivedCommittedRows.push(rows);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class WidthEpochAuditLinesComponent implements Component, NativeScrollbackLiveRegion {
	#lines: string[];
	#liveStart: number | undefined;
	#pinned: boolean;

	constructor(lines: string[], liveStart: number, pinned = false) {
		this.#lines = [...lines];
		this.#liveStart = liveStart;
		this.#pinned = pinned;
	}

	append(lines: string[]): void {
		this.#lines.push(...lines);
	}

	setLine(index: number, line: string): void {
		this.#lines[index] = line;
	}

	setLiveStart(row: number): void {
		this.#liveStart = row;
	}

	finalize(): void {
		this.#liveStart = undefined;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveStart;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#pinned;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class ResetWidthEpochAuditLinesComponent implements Component, NativeScrollbackLiveRegion, NativeScrollbackWidthEpoch {
	#lines: string[];
	#liveStart: number | undefined;
	#lastRows = 0;
	#appendOnly: boolean;
	#widthEpochBoundaries = new WeakMap<object, number>();

	constructor(lines: string[], liveStart: number, appendOnly: boolean) {
		this.#lines = [...lines];
		this.#liveStart = liveStart;
		this.#appendOnly = appendOnly;
	}

	append(lines: string[]): void {
		this.#lines.push(...lines);
	}

	setLine(index: number, line: string): void {
		this.#lines[index] = line;
	}

	finalize(): void {
		this.#liveStart = undefined;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveStart;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		const marker = {};
		this.#widthEpochBoundaries.set(marker, this.#lastRows);
		return marker;
	}

	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		return typeof boundary === "object" && boundary !== null ? this.#widthEpochBoundaries.get(boundary) : undefined;
	}

	getNativeScrollbackWidthEpochRows(): number {
		return this.#lastRows;
	}

	isNativeScrollbackWidthEpochAppendOnly(): boolean {
		return this.#appendOnly;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rows = this.#lines.map(line => line.slice(0, width));
		this.#lastRows = rows.length;
		return rows;
	}
}

class WrappingStreamComponent implements Component, NativeScrollbackLiveRegion, NativeScrollbackWidthEpoch {
	#records: string[] = [];
	#stream = "";
	#trailingTail: string[] = [];
	#liveStart = 0;
	#lastRenderedRecords: string[] = [];
	#lastRenderedStream = "";
	#lastWidth = 0;
	#lastRows: string[] = [];
	#widthEpochBoundaries = new WeakMap<object, { records: string[]; stream: string; trailingTail: string[] }>();

	append(record: string): void {
		this.#records.push(record);
	}

	appendToLive(suffix: string): void {
		this.#stream += suffix;
	}

	setTrailingTail(lines: string[]): void {
		this.#trailingTail = [...lines];
	}

	render(width: number): string[] {
		const rows: string[] = [];
		const chunkWidth = Math.max(1, width);
		for (const record of this.#records) {
			for (let offset = 0; offset < record.length; offset += chunkWidth) {
				rows.push(record.slice(offset, offset + chunkWidth));
			}
			rows.push("");
		}
		this.#liveStart = rows.length;
		for (let offset = 0; offset < this.#stream.length; offset += chunkWidth) {
			rows.push(this.#stream.slice(offset, offset + chunkWidth));
		}
		rows.push("");
		for (const line of this.#trailingTail) {
			for (let offset = 0; offset < line.length; offset += chunkWidth)
				rows.push(line.slice(offset, offset + chunkWidth));
		}
		this.#lastRenderedRecords = this.#records.slice();
		this.#lastRenderedStream = this.#stream;
		this.#lastWidth = chunkWidth;
		this.#lastRows = rows;
		return rows;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		const marker = {};
		this.#widthEpochBoundaries.set(marker, {
			records: this.#lastRenderedRecords.slice(),
			stream: this.#lastRenderedStream,
			trailingTail: this.#trailingTail.slice(),
		});
		return marker;
	}

	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null || this.#lastWidth <= 0) return undefined;
		const source = this.#widthEpochBoundaries.get(boundary);
		if (!source) return undefined;
		let rows = 0;
		for (const record of source.records) rows += Math.ceil(record.length / this.#lastWidth) + 1;
		rows += Math.ceil(source.stream.length / this.#lastWidth);
		for (const line of source.trailingTail) rows += Math.ceil(line.length / this.#lastWidth);
		return rows;
	}

	getNativeScrollbackWidthEpochRows(): number | undefined {
		return Math.max(0, this.#lastRows.length - 1);
	}

	isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		return (this.#widthEpochBoundaries.get(boundary)?.trailingTail.length ?? 0) === 0;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveStart;
	}
}

class PinnedMutableLinesComponent implements Component, NativeScrollbackLiveRegion, NativeScrollbackWidthEpoch {
	#lines: string[];
	#pinned = true;
	#finalBoundary = 0;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	setFinalBoundary(rows: number): void {
		this.#finalBoundary = rows;
	}

	finalize(): void {
		this.#pinned = false;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		return {};
	}

	resolveNativeScrollbackWidthEpoch(): undefined {
		return undefined;
	}

	getNativeScrollbackWidthEpochRows(): number {
		return this.#lines.length;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#pinned ? this.#finalBoundary : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#pinned;
	}
}

class ManualRenderScheduler implements RenderScheduler {
	#now = 0;
	#immediates: (() => void)[] = [];
	#timers: { at: number; callback: () => void; canceled: boolean }[] = [];

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { at: this.#now + Math.max(0, delayMs), callback, canceled: false };
		this.#timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}

	async flush(term: VirtualTerminal): Promise<void> {
		while (this.#immediates.length > 0) {
			const callbacks = this.#immediates.splice(0);
			for (const callback of callbacks) callback();
		}
		await term.flush();
	}

	async advanceBy(ms: number, term: VirtualTerminal): Promise<void> {
		await this.flush(term);
		this.#now += ms;
		while (true) {
			const due = this.#timers.filter(timer => !timer.canceled && timer.at <= this.#now);
			if (due.length === 0) break;
			for (const timer of due) {
				timer.canceled = true;
				timer.callback();
			}
			await this.flush(term);
		}
	}
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

// Pad the non-multiplexer resize viewport settle window (120 ms) so the test
// reliably observes the deferred authoritative full paint. These are
// integration tests against the real render scheduler (process.nextTick
// immediates interleaved with setTimeout debounces), so the settle window is
// driven with a real delay rather than fake timers.
const RESIZE_VIEWPORT_SETTLE_WAIT_MS = 160;

async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(RESIZE_VIEWPORT_SETTLE_WAIT_MS);
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

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

const MULTIPLEXER_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_PANEL_ID",
	"CMUX_TAB_ID",
	"CMUX_SOCKET_PATH",
	"HERDR_ENV",
];
const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = Object.fromEntries(
	MULTIPLEXER_ENV_KEYS.map(key => [key, undefined]),
);
const TMUX_ENV: Record<string, string | undefined> = { ...NO_MULTIPLEXER_ENV, TMUX: "1" };
const MULTIPLEXER_ENV_CASES: Array<[string, Record<string, string | undefined>]> = [
	["CMUX_WORKSPACE_ID", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", CMUX_WORKSPACE_ID: "workspace:cmux-2088" }],
	["CMUX_SURFACE_ID", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", CMUX_SURFACE_ID: "surface:cmux-2088" }],
];
const CMUX_SOCKET_ONLY_ENV: Record<string, string | undefined> = {
	...NO_MULTIPLEXER_ENV,
	TERM: "xterm-256color",
	CMUX_SOCKET_PATH: "/tmp/cmux.sock",
};
// Pin TERM to a non-multiplexer value: `isMultiplexerSession()` falls back to
// the TERM prefix, so leaving the host's TERM (which may be `tmux-*`/`screen-*`
// under CI-in-tmux) would misclassify this "direct terminal" case.
NO_MULTIPLEXER_ENV.TERM = "xterm-256color";
// Resize classification also keys off TERM_PROGRAM (Warp takes the in-place
// path) and PI_TUI_RESIZE_IN_PLACE, so neutralize them to keep this
// direct-terminal case deterministic.
NO_MULTIPLEXER_ENV.TERM_PROGRAM = undefined;
NO_MULTIPLEXER_ENV.PI_TUI_RESIZE_IN_PLACE = undefined;

describe("issue #2088: tmux pane-resize race produces viewport flash", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("propagates rendered-height changes from mutable text descendants", () => {
		const child = new Text("one", 0, 0);
		const container = new Container();
		container.addChild(child);
		container.render(40);
		const initialRevision = container.getNativeScrollbackWidthEpochRevision();

		child.setText("one\ntwo");
		container.render(40);

		expect(container.getNativeScrollbackWidthEpochRevision()).toBeGreaterThan(initialRevision);
	});

	it("coalesces a burst of multiplexer resize events into a single settled render", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// Simulate a tmux pane-close animation: several SIGWINCHes arrive
				// while tmux is still mid-reflow, each carrying an intermediate
				// width. Only the final width should be painted, and only once.
				term.resize(60, 10);
				term.resize(75, 10);
				term.resize(80, 10);

				// Inside the debounce window: no new paint must have landed yet,
				// otherwise the TUI would be writing into a pane tmux has not
				// finished reflowing.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window the single coalesced render fires at the
				// final geometry — exactly one paint covering 80×10.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("repaints a cursorless width-dependent component after resize", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 3, 1000);
			const tui = new TUI(term);
			tui.addChild(new WidthLabelComponent());

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(["wide layout", "", ""]);

				term.resize(17, 3);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(visible(term)).toEqual(["narrow layout", "", ""]);
			} finally {
				tui.stop();
			}
		});
	});

	it("paints the viewport immediately on resize outside a multiplexer, then replays on settle", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const baselinePaints = tui.resizeViewportPaints;
				const expectedViewport = Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`);
				term.resize(80, 10);
				await settle(term);

				// In flight: a cheap viewport-only paint lands at once (no native
				// scrollback replay), and the authoritative full paint is deferred.
				expect(tui.resizeViewportPaints).toBeGreaterThan(baselinePaints);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(visible(term)).toEqual(expectedViewport);

				// Once the drag goes quiet the full replay fires exactly once.
				await settleResize(term);
				expect(tui.fullRedraws).toBeGreaterThan(baselineRedraws);
				expect(visible(term)).toEqual(expectedViewport);
			} finally {
				tui.stop();
			}
		});
	});

	it("cancels a pending multiplexer resize timer on stop()", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			tui.start();
			await settle(term);

			const writes = captureWrites(term);
			term.resize(80, 10);
			tui.stop();

			// stop() must cancel the pending debounce; no render bytes appear
			// after the settle window has elapsed, even though the resize was
			// armed only moments ago.
			await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
			const lateRepaintBytes = writes.filter(chunk => chunk.includes("\x1b[H")).length;
			expect(lateRepaintBytes).toBe(0);
		});
	});

	it("supersedes a throttled render queued just before a multiplexer SIGWINCH", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			const lines = Array.from({ length: 20 }, (_v, i) => `line-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A streamed token lands in the same 30fps frame as the SIGWINCH:
				// `requestRender(false)` arms `#renderTimer`, then `term.resize`
				// fires the SIGWINCH that arms the multiplexer debounce. If the
				// queued throttled render were left active it would fire inside
				// the 50 ms settle window and paint mid-reflow.
				lines[19] = "line-19 streamed";
				component.setLines(lines);
				tui.requestRender();
				term.resize(80, 10);

				// During the debounce window: no paint must land. The queued
				// throttled timer was canceled and any follow-on
				// `requestRender(false)` is held off until the multiplexer
				// settles.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window: exactly one forced render lands, at
				// the new geometry, with the streamed token visible.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term).at(-1)).toBe("line-19 streamed");
			} finally {
				tui.stop();
			}
		});
	});

	it("retains an ordinary render requested inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 1000);
			const lines = Array.from({ length: 12 }, (_value, index) => `line-${index}`);
			const component = new MutableLinesComponent(lines);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				term.resize(80, 6);
				await Bun.sleep(10);
				lines[11] = "line-11 updated during resize";
				component.setLines(lines);
				tui.requestRender();

				await Bun.sleep(20);
				expect(writes).toHaveLength(0);

				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(visible(term).at(-1)).toBe("line-11 updated during resize");
			} finally {
				tui.stop();
			}
		});
	});

	it("retains rows appended inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 12 }, (_value, index) => `initial-${index}`);
			const appended = Array.from({ length: 8 }, (_value, index) => `settle-${index}`);
			const component = new MutableLinesComponent(initial);
			const term = new VirtualTerminal(40, 6, 1000);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(17, 6);
				component.setLines([...initial, ...appended]);
				tui.requestRender();

				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of [...initial, ...appended]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
				expect(visible(term)).toEqual(appended.slice(-6));
			} finally {
				tui.stop();
			}
		});
	});

	it("does not let ordinary renders postpone the multiplexer settle deadline", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 1000);
			const lines = Array.from({ length: 12 }, (_value, index) => `line-${index}`);
			const component = new MutableLinesComponent(lines);
			const scheduler = new ManualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(component);

			try {
				tui.start();
				await scheduler.advanceBy(0, term);
				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				term.resize(80, 6);
				for (let tick = 1; tick <= 4; tick++) {
					await scheduler.advanceBy(10, term);
					lines[11] = `line-11 stream-${tick}`;
					component.setLines(lines);
					tui.requestRender();
				}
				expect(writes).toHaveLength(0);

				// Ordinary spinner/stream frames only mark the settled paint as
				// content-bearing. They must not move the original 50 ms deadline.
				await scheduler.advanceBy(10, term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term).at(-1)).toBe("line-11 stream-4");
			} finally {
				tui.stop();
			}
		});
	});

	it("defers a forced repaint that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A SIGWINCH starts the debounce. Then a `requestRender(true)`
				// (e.g. from finishSixelProbe or an image-budget eviction)
				// arrives mid-window. Without deferral it would paint
				// immediately into a still-reflowing pane.
				term.resize(80, 10);
				await Bun.sleep(10);
				tui.requestRender(true);

				// Inside the window: still no paint. The forced render was
				// folded into the in-flight debounce.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the window: exactly one settled paint at the final
				// geometry.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("defers resetDisplay() that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				term.resize(80, 10);
				await Bun.sleep(10);
				tui.resetDisplay();

				// resetDisplay normally repaints synchronously; here it must
				// route through the multiplexer debounce so no paint lands
				// while tmux is still reflowing.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("freezes committed coordinates across repeated multiplexer width epochs", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(
					`record-${index.toString().padStart(2, "0")} ${String.fromCharCode(65 + index).repeat(46)}`,
				);
			}
			component.appendToLive(`stream-seed ${"S".repeat(80)}`);
			tui.addChild(component);

			const assertFrame = (width: number, recordCount: number, checkRetainedRecords = true): void => {
				const rendered = component.render(width);
				const expected = rendered.slice(Math.max(0, rendered.length - term.rows)).map(line => line.trimEnd());
				while (expected.length < term.rows) expected.push("");
				const current = visible(term);
				if (checkRetainedRecords) {
					expect(current).toEqual(expected);
				} else {
					expect(current.some(line => line.length > 0)).toBeTrue();
					expect(current.every(line => line.length <= width)).toBeTrue();
					expect(current.at(-1)).toBe("");
				}
				if (checkRetainedRecords) {
					const buffer = term.getScrollBuffer().map(line => line.trimEnd());
					for (let index = 0; index < recordCount; index++) {
						const marker = `record-${index.toString().padStart(2, "0")}`;
						expect(
							buffer.filter(line => line.includes(marker)),
							marker,
						).toHaveLength(1);
					}
				}
			};

			try {
				tui.start();
				await settle(term);
				assertFrame(40, 8);

				const baselineViewportPaints = tui.resizeViewportPaints;
				let baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);
				const widths = [17, 40, 17];
				for (let epoch = 0; epoch < widths.length; epoch++) {
					const width = widths[epoch]!;
					term.resize(width, 6);
					if (epoch === 0) {
						await Bun.sleep(10);
						tui.requestRender(true);
						await Bun.sleep(20);
						expect(writes).toHaveLength(0);
						expect(tui.fullRedraws).toBe(baselineRedraws);
					}
					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);

					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(tui.resizeViewportPaints).toBe(baselineViewportPaints);
					assertFrame(width, 8, false);
					baselineRedraws = tui.fullRedraws;

					component.appendToLive(` stream-${epoch} ${String.fromCharCode(73 + epoch).repeat(23)}`);
					tui.requestRender(true);
					await settle(term);
					assertFrame(width, 8);
					baselineRedraws = tui.fullRedraws;
				}

				const output = writes.join("");
				expect(output).not.toContain("\x1b[3J");
				expect(output).not.toContain("\x1b[?1049h");
				expect(output).not.toContain("\x1b[?1049l");
				expect(output).not.toContain("\x1b[2J");
				expect(output).not.toContain("\x1b[22J");
				assertFrame(17, 8);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains streamed rows across a net-unchanged width resize epoch", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(`round-trip-${index.toString().padStart(2, "0")} ${"W".repeat(46)}`);
			}
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				component.append(`round-trip-final ${"F".repeat(46)}`);
				tui.requestRender();
				term.resize(40, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `round-trip-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(buffer.filter(line => line.includes("round-trip-final"))).toHaveLength(1);
			} finally {
				tui.stop();
			}
		});
	});

	it("maps a queued append through the settled width using its logical boundary", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(`initial-${index.toString().padStart(2, "0")} ${"I".repeat(46)}`);
			}
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				component.append(`queued-00 ${"Q".repeat(46)}`);
				component.append(`queued-01 ${"R".repeat(46)}`);
				tui.requestRender();
				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const marker of [
					...Array.from({ length: 8 }, (_value, index) => `initial-${index.toString().padStart(2, "0")}`),
					"queued-00",
					"queued-01",
				]) {
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("does not duplicate a finalized tail below live growth during width settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(`history-${index.toString().padStart(2, "0")} ${"H".repeat(46)}`);
			}
			component.appendToLive("live-seed");
			component.setTrailingTail(["finalized-notice"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				component.appendToLive(` ${"G".repeat(120)}`);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer.filter(line => line === "finalized-notice")).toHaveLength(1);
				for (let index = 0; index < 8; index++) {
					const marker = `history-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).at(-1)).toBe("finalized-notice");
			} finally {
				tui.stop();
			}
		});
	});

	it("freezes logical resize appends while a normal-buffer overlay is visible", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(`overlay-base-${index.toString().padStart(2, "0")} ${"B".repeat(46)}`);
			}
			component.appendToLive("live-seed");
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const overlay = tui.showOverlay(new MutableLinesComponent(["overlay-marker"]), {
					anchor: "top-left",
					row: 0,
					col: 0,
				});
				await settle(term);

				const writes = captureWrites(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				component.appendToLive(` ${"Q".repeat(120)}`);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(writes.join("")).not.toContain("\r\n");
				const coveredBaseY = term.getBufferPosition().baseY;

				writes.length = 0;
				overlay.hide();
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBeGreaterThan(coveredBaseY);
				expect(writes.join("")).toContain("\r\n");
			} finally {
				tui.stop();
			}
		});
	});

	it("retains transcript growth hidden by a fullscreen overlay across resize", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`falt-${index.toString().padStart(2, "0")} ${"A".repeat(46)}`);
			}
			tui.addChild(transcript);

			try {
				tui.start();
				await settle(term);
				const overlay = tui.showOverlay(new MutableLinesComponent(["fullscreen-overlay"]), {
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				});
				tui.requestRender(true);
				await settle(term);

				term.resize(17, 6);
				transcript.append(`falt-final ${"F".repeat(46)}`);
				tui.requestRender();
				await settle(term);
				overlay.hide();
				tui.requestRender(true);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `falt-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(buffer.filter(line => line.includes("falt-final"))).toHaveLength(1);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains transcript rows displaced by a trailing root that grows during resize settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`tail-${index.toString().padStart(2, "0")} ${"I".repeat(46)}`);
			}
			const pendingMessages = new Container();
			pendingMessages.addChild(new MutableLinesComponent(["editor"]));
			tui.addChild(transcript);
			tui.addChild(pendingMessages);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				pendingMessages.clear();
				pendingMessages.addChild(new MutableLinesComponent(["pending-00", "pending-01", "pending-02", "editor"]));
				tui.requestComponentRender(pendingMessages);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `tail-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).slice(-4)).toEqual(["pending-00", "pending-01", "pending-02", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains rows when a revisionless trailing root grows during resize settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`revisionless-${index.toString().padStart(2, "0")} ${"R".repeat(46)}`);
			}
			const editor = new MutableLinesComponent(["editor"]);
			tui.addChild(transcript);
			tui.addChild(editor);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				editor.setLines(["draft-00", "draft-01", "draft-02", "editor"]);
				tui.requestComponentRender(editor);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `revisionless-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.some(line => line.includes(marker)),
						marker,
					).toBe(true);
				}
				expect(visible(term).slice(-4)).toEqual(["draft-00", "draft-01", "draft-02", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not append a populated trailing root replaced during resize settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`replaced-tail-${index.toString().padStart(2, "0")} ${"T".repeat(46)}`);
			}
			const editor = new RevisionMutableLinesComponent(["editor-before"]);
			tui.addChild(transcript);
			tui.addChild(editor);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				editor.setLines(["editor-after"]);
				tui.requestComponentRender(editor);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `replaced-tail-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).at(-1)).toBe("editor-after");
			} finally {
				tui.stop();
			}
		});
	});

	it("preserves populated tails after an empty root gains rows", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`empty-tail-${index.toString().padStart(2, "0")} ${"E".repeat(46)}`);
			}
			const emptyStatus = new RevisionMutableLinesComponent([]);
			const editor = new MutableLinesComponent(["editor"]);
			tui.addChild(transcript);
			tui.addChild(emptyStatus);
			tui.addChild(editor);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				emptyStatus.setLines(["status"]);
				tui.requestComponentRender(emptyStatus);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `empty-tail-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).slice(-2)).toEqual(["status", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains rows when a leading root grows before the width-epoch source", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const leading = new MutableLinesComponent(["header"]);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`leading-${index.toString().padStart(2, "0")} ${"L".repeat(46)}`);
			}
			tui.addChild(leading);
			tui.addChild(transcript);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				leading.setLines(["header", "queued-header-00", "queued-header-01", "queued-header-02"]);
				tui.requestComponentRender(leading);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `leading-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.some(line => line.includes(marker)),
						marker,
					).toBe(true);
				}
				const settledBaseY = term.getBufferPosition().baseY;
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(settledBaseY);
			} finally {
				tui.stop();
			}
		});
	});

	it("captures trailing-root growth queued immediately before SIGWINCH", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`pre-resize-${index.toString().padStart(2, "0")} ${"I".repeat(46)}`);
			}
			const pendingMessages = new Container();
			pendingMessages.addChild(new MutableLinesComponent(["editor"]));
			tui.addChild(transcript);
			tui.addChild(pendingMessages);

			try {
				tui.start();
				await settle(term);
				pendingMessages.clear();
				pendingMessages.addChild(new MutableLinesComponent(["queued-00", "queued-01", "queued-02", "editor"]));
				tui.requestComponentRender(pendingMessages);
				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `pre-resize-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).slice(-4)).toEqual(["queued-00", "queued-01", "queued-02", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains rows when a stable trailing child changes rendered height during settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`content-${index.toString().padStart(2, "0")} ${"C".repeat(46)}`);
			}
			const editor = new RevisionMutableLinesComponent(["editor"]);
			const editorRoot = new Container();
			editorRoot.addChild(editor);
			editorRoot.addChild(new MutableLinesComponent(["nested-footer"]));
			tui.addChild(transcript);
			tui.addChild(editorRoot);
			tui.addChild(new MutableLinesComponent(["root-footer"]));

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				editor.setLines(["draft-00", "draft-01", "draft-02", "editor"]);
				tui.requestComponentRender(editor);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `content-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(buffer.filter(line => line === "")).toHaveLength(9);
				expect(visible(term)).toEqual([
					"draft-00",
					"draft-01",
					"draft-02",
					"editor",
					"nested-footer",
					"root-footer",
				]);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains rows when a nested trailing child grows during settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`nested-${index.toString().padStart(2, "0")} ${"N".repeat(46)}`);
			}
			const editor = new MutableLinesComponent(["editor"]);
			const root = new Container();
			root.addChild(transcript);
			root.addChild(editor);
			tui.addChild(root);

			try {
				tui.start();
				await settle(term);
				const beforeResizeBaseY = term.getBufferPosition().baseY;
				term.resize(17, 6);
				await Bun.sleep(10);
				editor.setLines(["draft-00", "draft-01", "draft-02", "editor"]);
				tui.requestComponentRender(editor);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(term.getBufferPosition().baseY).toBeGreaterThan(beforeResizeBaseY);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `nested-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(buffer.filter(line => line === "")).toHaveLength(9);
				expect(visible(term).slice(-4)).toEqual(["draft-00", "draft-01", "draft-02", "editor"]);

				const settledBaseY = term.getBufferPosition().baseY;
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(settledBaseY);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not append a populated nested tail replaced during resize settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`nrep-${index.toString().padStart(2, "0")} ${"X".repeat(46)}`);
			}
			const editor = new RevisionMutableLinesComponent(["editor-before"]);
			const root = new Container();
			root.addChild(transcript);
			root.addChild(editor);
			tui.addChild(root);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				editor.setLines(["editor-after"]);
				tui.requestComponentRender(editor);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `nrep-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).at(-1)).toBe("editor-after");
			} finally {
				tui.stop();
			}
		});
	});

	it("preserves populated nested tails after an empty child gains rows", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`nempty-${index.toString().padStart(2, "0")} ${"E".repeat(46)}`);
			}
			const emptyStatus = new RevisionMutableLinesComponent([]);
			const editor = new MutableLinesComponent(["editor"]);
			const root = new Container();
			root.addChild(transcript);
			root.addChild(emptyStatus);
			root.addChild(editor);
			tui.addChild(root);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				emptyStatus.setLines(["status"]);
				tui.requestComponentRender(emptyStatus);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `nempty-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).slice(-2)).toEqual(["status", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("captures nested trailing growth queued immediately before resize", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`queued-nested-${index.toString().padStart(2, "0")} ${"Q".repeat(46)}`);
			}
			const editor = new RevisionMutableLinesComponent(["editor"]);
			const root = new Container();
			root.addChild(transcript);
			root.addChild(editor);
			tui.addChild(root);

			try {
				tui.start();
				await settle(term);
				editor.setLines(["queued-00", "queued-01", "queued-02", "editor"]);
				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `queued-nested-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term).slice(-4)).toEqual(["queued-00", "queued-01", "queued-02", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not treat paint-only reflow in a trailing root as appended output", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const transcript = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				transcript.append(`paint-${index.toString().padStart(2, "0")} ${"P".repeat(46)}`);
			}
			const wrappingHud = new WrappingLinesComponent([`hud ${"H".repeat(40)}`]);
			const trailingRoot = new Container();
			trailingRoot.addChild(wrappingHud);
			tui.addChild(transcript);
			tui.addChild(trailingRoot);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(10);
				tui.requestComponentRender(wrappingHud);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let index = 0; index < 8; index++) {
					const marker = `paint-${index.toString().padStart(2, "0")}`;
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("does not commit a logical suffix while the settled frame still fits the viewport", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 8, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			component.append("short-initial-00");
			component.append("short-initial-01");
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const historyBeforeResize = term.getScrollBuffer();
				const scrollbackRowsBeforeResize = term.getBufferPosition().baseY;
				component.append("short-queued-00");
				tui.requestRender();
				term.resize(17, 8);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(term.getBufferPosition().baseY).toBe(scrollbackRowsBeforeResize);
				const history = term.getScrollBuffer();
				for (const marker of ["short-initial-00", "short-initial-01"]) {
					const occurrencesBeforeResize = historyBeforeResize.filter(line => line.includes(marker)).length;
					expect(
						history.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(occurrencesBeforeResize);
				}
				expect(history.filter(line => line.includes("short-queued-00"))).toHaveLength(1);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains forced output appended after SIGWINCH without cross-width row arithmetic", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const component = new WrappingStreamComponent();
			for (let index = 0; index < 8; index++) {
				component.append(`forced-initial-${index.toString().padStart(2, "0")} ${"I".repeat(46)}`);
			}
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				component.append(`forced-final-00 ${"F".repeat(46)}`);
				component.append(`forced-final-01 ${"G".repeat(46)}`);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const marker of [
					...Array.from({ length: 8 }, (_value, index) => `forced-initial-${index.toString().padStart(2, "0")}`),
					"forced-final-00",
					"forced-final-01",
				]) {
					expect(
						buffer.filter(line => line.includes(marker)),
						marker,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps the native commit count separate and retains bulk post-epoch output", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 20 }, (_value, index) => `initial-${index.toString().padStart(2, "0")}`);
			const appended = Array.from(
				{ length: 20 },
				(_value, index) => `post-epoch-${index.toString().padStart(2, "0")}`,
			);
			const continued = ["post-epoch-20", "post-epoch-21"];
			const term = new VirtualTerminal(40, 6, 10_000);
			const component = new CommittedMutableLinesComponent(initial);
			const editor = new MutableLinesComponent(["editor"]);
			const tui = new TUI(term);
			tui.addChild(component);
			tui.addChild(editor);

			try {
				tui.start();
				await settle(term);
				const committedBeforeResize = component.receivedCommittedRows.at(-1);
				expect(committedBeforeResize).toBe(15);

				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(component.receivedCommittedRows.at(-1)).toBe(committedBeforeResize);

				const writes = captureWrites(term);
				component.append(appended);
				tui.requestRender(true);
				await settle(term);

				expect(writes.join("")).toContain("post-epoch-00");
				expect(component.receivedCommittedRows.at(-1)).toBe(35);
				expect(visible(term)).toEqual([...appended.slice(-5), "editor"]);

				component.append(continued);
				tui.requestRender(true);
				await settle(term);
				expect(component.receivedCommittedRows.at(-1)).toBe(37);
				expect(visible(term)).toEqual([...appended.slice(-3), ...continued, "editor"]);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of [...initial, ...appended, ...continued, "editor"]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("separates height-shrink movement from post-epoch append movement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 100 }, (_value, index) => `mixed-${index.toString().padStart(3, "0")}`);
			const appended = Array.from(
				{ length: 5 },
				(_value, index) => `mixed-${(100 + index).toString().padStart(3, "0")}`,
			);
			const term = new VirtualTerminal(40, 10, 10_000);
			const component = new CommittedMutableLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 10);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				term.resize(17, 5);
				component.append(appended);
				tui.requestRender();
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(visible(term)).toEqual(appended);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of [...initial, ...appended]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("does not attribute sparse-frame append movement to a height shrink", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = ["sparse-0", "sparse-1", "sparse-2"];
			const appended = ["sparse-3", "sparse-4", "sparse-5", "sparse-6", "sparse-7"];
			const term = new VirtualTerminal(40, 10, 10_000);
			const component = new CommittedMutableLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 10);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				term.resize(17, 5);
				component.append(appended);
				tui.requestRender();
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(visible(term)).toEqual(appended);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer.slice(0, -5)).toEqual(initial);
				for (const line of [...initial, ...appended]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("backfills post-epoch rows appended behind an overlay", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 12 }, (_value, index) => `initial-${index.toString().padStart(2, "0")}`);
			const appended = Array.from({ length: 12 }, (_value, index) => `hidden-${index.toString().padStart(2, "0")}`);
			const term = new VirtualTerminal(40, 6, 10_000);
			const component = new MutableLinesComponent(initial);
			const editor = new MutableLinesComponent(["editor"]);
			const tui = new TUI(term);
			tui.addChild(component);
			tui.addChild(editor);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const overlay = tui.showOverlay(new MutableLinesComponent(["overlay"]), {
					anchor: "top-left",
					row: 1,
					col: 1,
				});
				await settle(term);
				component.setLines([...initial, ...appended]);
				tui.requestRender(true);
				await settle(term);
				overlay.hide();
				tui.requestRender(true);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of [...initial, ...appended, "editor"]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
				expect(visible(term)).toEqual([...appended.slice(-5), "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("retains resolved overlay growth across repeated width epochs", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 12 }, (_value, index) => `resolved-${index.toString().padStart(2, "0")}`);
			const appended = Array.from(
				{ length: 8 },
				(_value, index) => `resolved-${(12 + index).toString().padStart(2, "0")}`,
			);
			const component = new ResetWidthEpochAuditLinesComponent(initial, initial.length, true);
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const overlay = tui.showOverlay(new MutableLinesComponent(["overlay"]), {
					anchor: "top-left",
					row: 1,
					col: 1,
				});
				await settle(term);
				term.resize(17, 6);
				component.append(appended);
				tui.requestRender();
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				term.resize(23, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				overlay.hide();
				tui.requestRender(true);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of [...initial, ...appended]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("rebases hidden-growth accounting when an overlay spans a widening width epoch", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from(
				{ length: 8 },
				(_value, index) => `initial-${index.toString().padStart(2, "0")} ${"I".repeat(20)}`,
			);
			const appended = Array.from(
				{ length: 8 },
				(_value, index) => `hidden-${index.toString().padStart(2, "0")} ${"H".repeat(20)}`,
			);
			const term = new VirtualTerminal(17, 6, 10_000);
			const component = new WrappingLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const overlay = tui.showOverlay(new MutableLinesComponent(["overlay"]), {
					anchor: "top-left",
					row: 1,
					col: 1,
				});
				await settle(term);

				term.resize(40, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				component.setLines([...initial, ...appended]);
				tui.requestRender(true);
				await settle(term);
				overlay.hide();
				tui.requestRender(true);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of appended) {
					const marker = line.slice(0, line.indexOf(" "));
					expect(
						buffer.filter(bufferLine => bufferLine.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term)).toEqual(appended.slice(-6));
			} finally {
				tui.stop();
			}
		});
	});

	it("replays unresolved output queued while a widening epoch reduces reflow rows", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from(
				{ length: 12 },
				(_value, index) => `unresolved-initial-${index.toString().padStart(2, "0")} ${"I".repeat(20)}`,
			);
			const appended = Array.from(
				{ length: 8 },
				(_value, index) => `unresolved-new-${index.toString().padStart(2, "0")}`,
			);
			const settledInitial = ["changed-prefix-00", "changed-prefix-01", ...initial.slice(2)];
			const term = new VirtualTerminal(17, 6, 10_000);
			const component = new UnresolvedWrappingLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(40, 4);
				component.setLines([...settledInitial, ...appended]);
				tui.requestRender();
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of settledInitial.slice(0, 2)) {
					expect(
						buffer.some(bufferLine => bufferLine.includes(line)),
						line,
					).toBe(true);
				}
				for (const line of appended) {
					const marker = line;
					expect(
						buffer.some(bufferLine => bufferLine.includes(marker)),
						marker,
					).toBe(true);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("backfills unresolved growth queued behind an overlay during width settlement", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from(
				{ length: 8 },
				(_value, index) => `initial-${index.toString().padStart(2, "0")} ${"I".repeat(20)}`,
			);
			const appended = Array.from(
				{ length: 8 },
				(_value, index) => `hidden-${index.toString().padStart(2, "0")} ${"H".repeat(20)}`,
			);
			const term = new VirtualTerminal(17, 6, 10_000);
			const component = new RecoveringWrappingLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const overlay = tui.showOverlay(new MutableLinesComponent(["overlay"]), {
					anchor: "top-left",
					row: 1,
					col: 1,
				});
				await settle(term);

				const writes = captureWrites(term);
				term.resize(40, 6);
				component.setLines([...initial, ...appended]);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(writes.join("")).not.toContain("\r\n");
				const coveredBaseY = term.getBufferPosition().baseY;
				writes.length = 0;

				// A later pure width reset under the same overlay must retain the
				// conservative replay debt established by the growth frame.
				term.resize(50, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(coveredBaseY);
				expect(writes.join("")).not.toContain("\r\n");

				writes.length = 0;
				overlay.hide();
				term.resize(60, 6);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(term.getBufferPosition().baseY).toBeGreaterThan(coveredBaseY);
				expect(writes.join("")).toContain("\r\n");
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of appended) {
					const marker = line.slice(0, line.indexOf(" "));
					expect(
						buffer.filter(bufferLine => bufferLine.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(visible(term)).toEqual(appended.slice(-6));
			} finally {
				tui.stop();
			}
		});
	});

	it("defers pinned live-region growth until width-epoch finalization", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = ["pinned-00", "pinned-01"];
			const final = Array.from({ length: 10 }, (_value, index) => `pinned-${index.toString().padStart(2, "0")}`);
			const term = new VirtualTerminal(40, 4, 1000);
			const component = new PinnedMutableLinesComponent(initial);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 4);
				component.setLines(final);
				tui.requestRender();
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				expect(term.getBufferPosition().baseY).toBe(0);
				expect(visible(term)).toEqual(final.slice(-4));
				term.resize(23, 4);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(0);
				expect(visible(term)).toEqual(final.slice(-4));

				const extended = [...final, "pinned-10", "pinned-11"];
				component.setLines(extended);
				component.setFinalBoundary(6);
				tui.requestRender(true);
				await settle(term);
				component.setFinalBoundary(8);
				tui.requestRender(true);
				await settle(term);

				component.finalize();
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(8);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of extended) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
				const finalizedBaseY = term.getBufferPosition().baseY;
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(finalizedBaseY);
			} finally {
				tui.stop();
			}
		});
	});

	it("recommits a post-width-epoch mutable snapshot once when it finalizes", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from({ length: 12 }, (_value, index) => `row-${index.toString().padStart(2, "0")}`);
			const component = new WidthEpochAuditLinesComponent(initial, 8);
			const term = new VirtualTerminal(40, 4, 1000);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 4);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				component.append(["row-12", "row-13", "row-14", "row-15"]);
				tui.requestRender(true);
				await settle(term);
				const committedAtNewWidth = term.getBufferPosition().baseY;

				component.setLine(9, "preview-changed");
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(committedAtNewWidth);

				component.setLine(9, "final-row-09");
				component.finalize();
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(committedAtNewWidth + 3);
				let buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer.filter(line => line === "final-row-09")).toHaveLength(1);

				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(committedAtNewWidth + 3);
				buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer.filter(line => line === "final-row-09")).toHaveLength(1);

				// A height grow exposes tracked rows. If they scroll off again, their
				// fresh snapshots replace (rather than duplicate) the logical ledger.
				term.resize(17, 8);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				component.setLiveStart(8);
				component.setLine(9, "reexposed-preview");
				component.append(["row-16", "row-17", "row-18", "row-19"]);
				tui.requestRender(true);
				await settle(term);
				const recommittedAfterHeightGrow = term.getBufferPosition().baseY;

				component.finalize();
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(recommittedAfterHeightGrow);
			} finally {
				tui.stop();
			}
		});
	});

	it.each([
		{ appendOnly: false, appendedRows: 3, changedRow: 9, expectedRecommit: 2 },
		{ appendOnly: true, appendedRows: 8, changedRow: 13, expectedRecommit: 3 },
	])(
		"recommits a mutable snapshot archived by a $appendOnly width-reset frame",
		async ({ appendOnly, appendedRows, changedRow, expectedRecommit }) => {
			await withEnvPatch(TMUX_ENV, async () => {
				const initial = Array.from({ length: 12 }, (_value, index) => `reset-${index.toString().padStart(2, "0")}`);
				const appended = Array.from(
					{ length: appendedRows },
					(_value, index) => `reset-${(12 + index).toString().padStart(2, "0")}`,
				);
				const component = new ResetWidthEpochAuditLinesComponent(initial, 8, appendOnly);
				const term = new VirtualTerminal(40, 4, 1000);
				const tui = new TUI(term);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					term.resize(17, 4);
					component.append(appended);
					tui.requestRender(true);
					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const committedByReset = term.getBufferPosition().baseY;

					component.setLine(changedRow, "reset-preview-changed");
					tui.requestRender(true);
					await settle(term);
					expect(term.getBufferPosition().baseY).toBe(committedByReset);

					component.setLine(changedRow, "reset-finalized");
					component.finalize();
					tui.requestRender(true);
					await settle(term);
					expect(term.getBufferPosition().baseY).toBe(committedByReset + expectedRecommit);
					let buffer = term.getScrollBuffer().map(line => line.trimEnd());
					expect(buffer.filter(line => line === "reset-finalized")).toHaveLength(1);

					tui.requestRender(true);
					await settle(term);
					expect(term.getBufferPosition().baseY).toBe(committedByReset + expectedRecommit);
					buffer = term.getScrollBuffer().map(line => line.trimEnd());
					expect(buffer.filter(line => line === "reset-finalized")).toHaveLength(1);
				} finally {
					tui.stop();
				}
			});
		},
	);

	it("does not audit reset rows below a pinned width-epoch recovery seam", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const initial = Array.from(
				{ length: 20 },
				(_value, index) => `pinned-reset-${index.toString().padStart(2, "0")}`,
			);
			const appended = Array.from(
				{ length: 4 },
				(_value, index) => `pinned-reset-${(20 + index).toString().padStart(2, "0")}`,
			);
			const component = new WidthEpochAuditLinesComponent(initial, 8, true);
			const term = new VirtualTerminal(40, 8, 1000);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 4);
				component.append(appended);
				component.setLiveStart(24);
				tui.requestRender(true);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				const committedByReset = term.getBufferPosition().baseY;

				component.setLiveStart(16);
				component.setLine(17, "pinned-reset-preview");
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(committedByReset);

				component.setLiveStart(24);
				tui.requestRender(true);
				await settle(term);
				expect(term.getBufferPosition().baseY).toBe(committedByReset);
			} finally {
				tui.stop();
			}
		});
	});

	it("parks a short no-cursor width epoch at the real content bottom", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 1000);
			const header = new MutableLinesComponent(["short-0", "short-1"]);
			const loader = new MutableLinesComponent(["loader-0"]);
			const tui = new TUI(term);
			tui.addChild(header);
			tui.addChild(loader);

			try {
				tui.start();
				await settle(term);
				term.resize(17, 6);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);

				loader.setLines(["loader-1"]);
				tui.requestDirectWrite(loader);
				await term.flush();
				expect(visible(term).slice(0, 3)).toEqual(["short-0", "short-1", "loader-1"]);

				term.resize(17, 2);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of ["short-0", "short-1", "loader-1"]) {
					expect(
						buffer.filter(bufferLine => bufferLine === line),
						line,
					).toHaveLength(1);
				}
				expect(visible(term)).toEqual(["short-1", "loader-1"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps multiplexer height-only resize accounting unchanged", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 6, 10_000);
			const tui = new TUI(term);
			const lines = Array.from(
				{ length: 12 },
				(_value, index) => `height-record-${index.toString().padStart(2, "0")}`,
			);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				for (const height of [4, 6]) {
					term.resize(40, height);
					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					expect(visible(term)).toEqual(lines.slice(-height));
				}

				lines.push("height-record-12");
				component.setLines(lines);
				tui.requestRender(true);
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of lines) {
					expect(
						buffer.filter(row => row === line),
						line,
					).toHaveLength(1);
				}
				const output = writes.join("");
				expect(output).not.toContain("\x1b[3J");
				expect(output).not.toContain("\x1b[?1049h");
				expect(output).not.toContain("\x1b[?1049l");
				expect(visible(term)).toEqual(lines.slice(-6));
			} finally {
				tui.stop();
			}
		});
	});
});

// Regression for multiplexer auto-detection: `isMultiplexerSession()` gates the
// renderer's resize behavior. It previously checked only TMUX/STY/ZELLIJ, while
// sibling checks also fall back to TERM prefixes and CMUX exposes its own session
// env markers. When a multiplexer was missed, the engine misclassified the pane
// as a direct terminal and emitted ED3 (CSI 3 J) on resize — which wipes pane
// history (verified against tmux 3.6a: a 20-line pane drops to its 6 on-screen
// rows after ED3), so scrollback only reappeared after a full rerender.
describe("multiplexer detection gates ED3 on resize", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ED3 clears native scrollback; the renderer must never emit it in a mux.
	const ED3 = "\x1b[3J";

	// tmux/screen panes whose authoritative env signal was stripped but whose
	// TERM still names the multiplexer — the case previously misclassified.
	const strippedMuxTerms: Array<[string, Record<string, string | undefined>]> = [
		["tmux-256color", { ...NO_MULTIPLEXER_ENV, TERM: "tmux-256color" }],
		["screen-256color", { ...NO_MULTIPLEXER_ENV, TERM: "screen-256color" }],
	];

	for (const [label, env] of strippedMuxTerms) {
		it(`debounces the resize and emits no ED3 when only TERM=${label} marks the multiplexer`, async () => {
			await withEnvPatch(env, async () => {
				const term = new VirtualTerminal(40, 10, 1000);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

				try {
					tui.start();
					await settle(term);

					const baselineRedraws = tui.fullRedraws;
					const writes = captureWrites(term);

					// SIGWINCH must route through the multiplexer debounce, not the
					// immediate forced render: detection via TERM alone is the proof.
					term.resize(80, 10);
					await Bun.sleep(10);
					expect(writes.length).toBe(0);
					expect(tui.fullRedraws).toBe(baselineRedraws);

					// The settled paint repaints at the new geometry without clearing
					// native scrollback, so the pane keeps its history.
					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const out = writes.join("");
					expect(out).not.toContain(ED3);
					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
				} finally {
					tui.stop();
				}
			});
		});
	}

	for (const [label, env] of MULTIPLEXER_ENV_CASES) {
		it(`debounces resize and emits no ED3 when ${label} marks a multiplexer with TERM=dumb`, async () => {
			await withEnvPatch(env, async () => {
				const term = new VirtualTerminal(40, 10, 1000);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

				try {
					tui.start();
					await settle(term);

					const baselineRedraws = tui.fullRedraws;
					const writes = captureWrites(term);

					term.resize(80, 10);
					await Bun.sleep(10);
					expect(writes.length).toBe(0);
					expect(tui.fullRedraws).toBe(baselineRedraws);

					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const out = writes.join("");
					expect(out).not.toContain(ED3);
					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
				} finally {
					tui.stop();
				}
			});
		});
	}

	it("repaints direct HerdR resizes in place without ED3", async () => {
		await withEnvPatch({ ...NO_MULTIPLEXER_ENV, TERM: "dumb", HERDR_ENV: "1" }, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_value, index) => `line-${index}`)));

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				for (const width of [80, 40, 80]) {
					term.resize(width, 10);
					await settleResize(term);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_value, index) => `line-${index + 10}`));
					const buffer = term.getScrollBuffer().map(line => line.trimEnd());
					for (let index = 0; index < 20; index++) {
						expect(
							buffer.filter(line => line === `line-${index}`),
							`line-${index}`,
						).toHaveLength(1);
					}
				}

				expect(writes.join("")).not.toContain(ED3);
			} finally {
				tui.stop();
			}
		});
	});

	it("preserves explicit scrollback clears in direct HerdR", async () => {
		await withEnvPatch({ ...NO_MULTIPLEXER_ENV, TERM: "dumb", HERDR_ENV: "1" }, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_value, index) => `line-${index}`)));

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);
				tui.resetDisplay();
				await settle(term);

				expect(writes.join("")).toContain(ED3);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps nested tmux inside HerdR on the ED3-unsafe path", async () => {
		await withEnvPatch({ ...TMUX_ENV, TERM: "tmux-256color", HERDR_ENV: "1" }, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_value, index) => `line-${index}`)));

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);
				term.resize(80, 10);
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(writes.join("")).not.toContain(ED3);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not treat CMUX_SOCKET_PATH alone as a multiplexer session marker", async () => {
		await withEnvPatch(CMUX_SOCKET_ONLY_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const writes = captureWrites(term);
				term.resize(80, 10);
				await settleResize(term);
				const out = writes.join("");
				expect(out).toContain(ED3);
			} finally {
				tui.stop();
			}
		});
	});
	it("still clears native scrollback (ED3) on a genuine direct-terminal resize", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				// Capture only the resize-driven paint; the initial paint never
				// clears scrollback, so any ED3 in `out` belongs to the resize.
				// Wait past the 120 ms viewport-settle window — that deferred
				// `requestRender(true, { clearScrollback: true })` is what emits ED3.
				const writes = captureWrites(term);
				term.resize(80, 10);
				await settleResize(term);
				const out = writes.join("");
				expect(out).toContain(ED3);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});
});
