import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container, type NativeScrollbackLiveRegion, type RenderScheduler, TUI } from "@musepi/pi-tui";
import { Image, ImageBudget } from "@musepi/pi-tui/components/image";
import { Text } from "@musepi/pi-tui/components/text";
import { getKittyGraphics, setKittyGraphics } from "@musepi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyPlacementLine,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@musepi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

// Direct-placement contract: a straddling image block must be re-anchored at
// its first visible row with the source rectangle clipped to the visible
// slice, and a placement id whose cells reached native scrollback must never
// be re-used (Kitty replace semantics strip the old placement everywhere,
// scrollback included — the permanently cropped images on WezTerm).

const originalProtocol = TERMINAL.imageProtocol;
const originalTerminalId = terminal.id;
const originalGraphics = { ...getKittyGraphics() };
let originalCellDims: CellDimensions;

beforeEach(() => {
	originalCellDims = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	terminal.imageProtocol = ImageProtocol.Kitty;
	terminal.id = "wezterm";
	setKittyGraphics({ unicodePlaceholders: false });
});

afterEach(() => {
	setCellDimensions(originalCellDims);
	terminal.imageProtocol = originalProtocol;
	terminal.id = originalTerminalId;
	setKittyGraphics(originalGraphics);
});

describe("kitty direct-placement wire format", () => {
	it("round-trips the exact line Image renders for a direct placement", () => {
		const budget = new ImageBudget(8, () => {});
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget, imageKey: "roundtrip" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = budget.acquireId("roundtrip");
		budget.beginPass();
		const lines = image.render(40);
		budget.endPass();
		expect(lines.length).toBe(6);
		const parsed = parseKittyDirectPlacementLine(lines[lines.length - 1]!);
		expect(parsed).toEqual({ imageId, placementId: imageId, columns: 4, rows: 6 });
	});

	it("rejects non-placement image lines", () => {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\")).toBeNull();
		// tmux-wrapped placements stay untouched.
		expect(parseKittyDirectPlacementLine(wrapTmuxPassthrough("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\"))).toBeNull();
		// Transmit-and-display and plain text never match.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\")).toBeNull();
		expect(parseKittyDirectPlacementLine("plain text")).toBeNull();
	});

	it("encodes the anchored, clipped, and last-row-only placement forms", () => {
		const base = { imageId: 7, columns: 4, rows: 6, imageHeightPx: 60 };
		// Whole block visible (last line at viewport row 9): full anchored form.
		expect(encodeKittyPlacementLine({ ...base, placementId: 1, screenRow: 9 })).toBe(
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8",
		);
		// Straddling (last line at row 3): two rows hidden above, four visible —
		// the source slice starts at 60*2/6 = 20px.
		expect(encodeKittyPlacementLine({ ...base, placementId: 2, screenRow: 3 })).toBe(
			"\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8",
		);
		// Only the last row visible: no cursor movement, bottom slice only.
		expect(encodeKittyPlacementLine({ ...base, placementId: 3, screenRow: 0 })).toBe(
			"\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\",
		);
	});
});

// Unit tests cover only the epoch transitions the TUI integration below cannot
// reach deterministically (ledger rewinds, position-less emits, purge
// lifecycle, reset reporting). The ordinary advance/stability arithmetic is
// proven end-to-end by the integration tests' exact placement-id assertions.
describe("ImageBudget placement epochs", () => {
	it("skips epoch bookkeeping for emits without a frame position", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		// Alt-screen/resize emit: unknown position, unknown commits.
		expect(budget.resolvePlacementEmit(5, -1, -1)?.placementId).toBe(1);
		// The unknown emit must not have overwritten the tracked attach top.
		expect(budget.resolvePlacementEmit(5, 10, 12)?.placementId).toBe(2);
	});

	it("returns null for unregistered ids and after a full purge", () => {
		const budget = new ImageBudget(8, () => {});
		expect(budget.resolvePlacementEmit(9, 0, 0)).toBeNull();
		budget.registerPlacementGeometry(9, 40, 60);
		budget.enqueueTransmit(9, "seq");
		expect(budget.resolvePlacementEmit(9, 0, -1)).not.toBeNull();
		budget.takeAllTransmittedIds();
		expect(budget.resolvePlacementEmit(9, 0, -1)).toBeNull();
	});

	it("detects archived cells across commit-ledger rewinds without churning afterwards", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		// Placement 1 attaches from row 100 while commits sit at 90.
		expect(budget.resolvePlacementEmit(5, 100, 90)?.placementId).toBe(1);
		// Later frames (no re-emission) commit past the attach top...
		budget.observeCommitWatermark(120);
		// ...then a divergence recommit rewinds the ledger to 50. The archived
		// cells are physically in scrollback, so the re-emit must not re-use
		// placement 1 (Kitty replace would strip the archive).
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		// The stale pre-rewind peak must NOT keep advancing the epoch: rewrites
		// with no commit progression replace placement 2 in place.
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		budget.observeCommitWatermark(55);
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		// The recommit re-crossing the new attach top advances exactly once.
		budget.observeCommitWatermark(61);
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(3);
	});

	it("reports every image with its highest epoch when resetting", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		budget.registerPlacementGeometry(7, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		expect(budget.resolvePlacementEmit(5, 12, 12)?.placementId).toBe(2);
		expect(budget.resolvePlacementEmit(7, 30, 12)?.placementId).toBe(1);
		// Every image is reported — an image absent from the replay never
		// re-places, so even its epoch-1 registry entry must be deleted.
		expect(budget.resetPlacementEpochs()).toEqual([
			{ imageId: 5, lastEpoch: 2 },
			{ imageId: 7, lastEpoch: 1 },
		]);
		// After the reset both images are back at epoch 1.
		expect(budget.resolvePlacementEmit(5, 10, -1)?.placementId).toBe(1);
	});
});

describe("TUI direct-placement clipping", () => {
	/**
	 * Deterministic render driver: every scheduled callback (immediate and
	 * delayed) queues here and `pump()` drains it to a fixed point, so each
	 * mutation renders exactly once per pump with no wall-clock coalescing.
	 */
	function makeManualScheduler(): { scheduler: RenderScheduler; pump: () => void } {
		let now = 0;
		const queue: Array<{ callback: () => void; canceled: boolean }> = [];
		const enqueue = (callback: () => void) => {
			const entry = { callback, canceled: false };
			queue.push(entry);
			return entry;
		};
		return {
			scheduler: {
				now: () => now,
				scheduleImmediate: (callback: () => void) => {
					enqueue(callback);
				},
				scheduleRender: (callback: () => void, _delayMs: number) => {
					const entry = enqueue(callback);
					return {
						cancel: () => {
							entry.canceled = true;
						},
					};
				},
			},
			pump: () => {
				for (let guard = 0; guard < 20 && queue.length > 0; guard++) {
					const batch = queue.splice(0, queue.length);
					now += 50;
					for (const entry of batch) {
						if (!entry.canceled) entry.callback();
					}
				}
			},
		};
	}

	class PinnedLiveBlock extends Container implements NativeScrollbackLiveRegion {
		finalized = false;
		getNativeScrollbackLiveRegionStart(): number | undefined {
			return this.finalized ? undefined : 0;
		}
		isNativeScrollbackLiveRegionPinned(): boolean {
			return !this.finalized;
		}
	}

	interface CapturedPlacement {
		cuu: number;
		imageId: number;
		placementId: number;
		rows: number;
		srcY: number | undefined;
	}

	function capturePlacements(output: string, imageId: number): CapturedPlacement[] {
		const re = /(?:\x1b7(?:\x1b\[(\d+)A)?)?\x1b_Ga=p,q=2,C=1,i=(\d+),p=(\d+),c=\d+,r=(\d+)(?:,y=(\d+),h=\d+)?\x1b\\/g;
		const captured: CapturedPlacement[] = [];
		for (const m of output.matchAll(re)) {
			if (Number(m[2]) !== imageId) continue;
			captured.push({
				cuu: m[1] !== undefined ? Number(m[1]) : 0,
				imageId: Number(m[2]),
				placementId: Number(m[3]),
				rows: Number(m[4]),
				srcY: m[5] !== undefined ? Number(m[5]) : undefined,
			});
		}
		return captured;
	}

	/** Placement ids deleted for `imageId` via `d=i` in `output`, in order. */
	function captureDeletes(output: string, imageId: number): number[] {
		const re = /\x1b_Ga=d,d=i,i=(\d+),p=(\d+),q=2\x1b\\/g;
		const deleted: number[] = [];
		for (const m of output.matchAll(re)) {
			if (Number(m[1]) === imageId) deleted.push(Number(m[2]));
		}
		return deleted;
	}

	/**
	 * 40×12 TUI with a captured write stream, a manual scheduler, one 4×6-cell
	 * direct-placement image (in a pinned live block when `pinned`), and a
	 * trailing stream Text whose growth walks the block out of the viewport.
	 */
	function makeHarness(key: string, opts: { pinned?: boolean } = {}) {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: key },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = tui.imageBudget.acquireId(key);
		const stream = new Text("", 0, 0);
		const block = new PinnedLiveBlock();
		tui.addChild(new Text("header", 0, 0));
		if (opts.pinned) {
			block.addChild(new Text("tool-head", 0, 0));
			block.addChild(image);
			tui.addChild(block);
		} else {
			tui.addChild(image);
		}
		tui.addChild(stream);
		const lines: string[] = [];
		return {
			tui,
			writes,
			pump,
			imageId,
			block,
			image,
			output: () => writes.join(""),
			streamLines(count: number) {
				for (let n = 0; n < count; n++) {
					lines.push(`streaming line ${lines.length + 1}`);
					stream.setText(lines.join("\n"));
					tui.requestRender();
					pump();
				}
			},
		};
	}

	it("clips straddling re-emits to the visible slice, then archives under a fresh id on finalize", () => {
		const h = makeHarness("clip", { pinned: true });
		try {
			h.tui.start();
			h.pump();

			// Frame layout: header(1) + tool-head(1) + image block rows 2..7.
			// Stream one line per frame until the frame is 10 rows taller than
			// the viewport — the block walks out of the top of the window and,
			// because the pinned live region blocks commits, every slid frame
			// takes the in-place full-window rewrite that re-emits the placement.
			h.streamLines(20);

			const placements = capturePlacements(h.output(), h.imageId);
			expect(placements.length).toBeGreaterThan(0);
			for (const p of placements) {
				// The anchor CUU never exceeds the rows the placement actually
				// spans — the pre-fix failure shape was cuu=5 with r=6 emitted at
				// a viewport row < 5, which the terminal clamps and re-anchors
				// shifted (the permanently cropped image).
				expect(p.cuu).toBe(p.rows - 1);
				if (p.rows < 6) {
					// Clipped: the source rectangle starts exactly at the hidden slice.
					expect(p.srcY).toBe(Math.floor((60 * (6 - p.rows)) / 6));
				} else {
					expect(p.srcY).toBeUndefined();
				}
			}
			// The walk-out must actually have produced clipped emissions.
			expect(placements.some(p => p.rows < 6)).toBe(true);
			// Pinned region ⇒ nothing committed past the block origin ⇒ the
			// placement id never advances.
			expect(new Set(placements.map(p => p.placementId))).toEqual(new Set([1]));

			// Finalize the block: the seam rewrite commits its rows through the
			// screen. That commit passes placement 1's attach top, so the archive
			// copy written into scrollback must carry a fresh placement id —
			// replacing placement 1 later would strip the committed cells.
			h.writes.length = 0;
			h.block.finalized = true;
			h.tui.invalidate();
			h.tui.requestRender();
			h.pump();

			const committed = capturePlacements(h.output(), h.imageId);
			expect(committed.length).toBeGreaterThan(0);
			const archive = committed[committed.length - 1]!;
			// Exactly one epoch advance: the finalize commit bumps 1 → 2, no churn.
			expect(archive.placementId).toBe(2);
			// The archive copy is the full image, not a clipped slice.
			expect(archive.rows).toBe(6);
			expect(archive.srcY).toBeUndefined();
		} finally {
			h.tui.stop();
		}
	});

	it("bumps the epoch when an in-window rewrite re-emits after mid-stream commits passed the origin", () => {
		const h = makeHarness("midstream");
		try {
			h.tui.start();
			h.pump();

			// Frame layout: header(1) + image rows 1..6. Unpinned streaming:
			// scroll-appends commit rows past the block origin while the
			// placement-1 cells scroll natively (no re-emission).
			h.streamLines(10);
			const beforeOverlay = capturePlacements(h.output(), h.imageId);
			expect(new Set(beforeOverlay.map(p => p.placementId))).toEqual(new Set([1]));

			// An overlay frame forces the in-place full-window rewrite — the
			// in-window diff path re-emits the straddling placement line with
			// committedTo = the already-advanced committed row count.
			h.writes.length = 0;
			const overlay = h.tui.showOverlay(new Text("OVERLAY", 0, 0), { anchor: "top-left", width: "100%" });
			h.pump();
			overlay.hide();
			h.pump();

			const after = capturePlacements(h.output(), h.imageId);
			expect(after.length).toBeGreaterThan(0);
			for (const p of after) {
				// Commits passed the origin before this emit: placement 1 is
				// scrollback archive and must not be replaced.
				expect(p.placementId).toBe(2);
				// The block straddles the window top, so the re-emit is clipped.
				expect(p.rows).toBeLessThan(6);
				expect(p.srcY).toBe(Math.floor((60 * (6 - p.rows)) / 6));
				expect(p.cuu).toBe(p.rows - 1);
			}
			// Show + hide are two rewrites with no commit progression between
			// them: both must replace placement 2 exactly — repeated overlay
			// toggles must not mint a fresh placement per frame (#8057 review).
			expect(new Set(after.map(p => p.placementId))).toEqual(new Set([2]));
		} finally {
			h.tui.stop();
		}
	});

	it("restarts epochs on a destructive clear, deleting exactly the ids each image ever placed", () => {
		const h = makeHarness("stale");
		// A second image that never advances past epoch 1: its delete set pins
		// that the reset sweep uses per-image history, not a global maximum.
		const calm = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: h.tui.imageBudget, imageKey: "calm" },
			{ widthPx: 40, heightPx: 60 },
		);
		const calmId = h.tui.imageBudget.acquireId("calm");
		h.tui.addChild(calm);
		try {
			h.tui.start();
			h.pump();
			// 4 lines: frame = header(1) + image(6) + stream(4) + calm(6) = 17
			// rows against a 12-row viewport, so the first image straddles the
			// window top (visible rows 5..6) while calm stays fully in-window.
			h.streamLines(4);
			// Drive the first image to epoch 2: an overlay frame re-emits its
			// straddling placement after commits passed the origin. Calm's rows
			// never commit, so its re-emits keep replacing placement 1.
			const overlay = h.tui.showOverlay(new Text("OVERLAY", 0, 0), { anchor: "top-left", width: "100%" });
			h.pump();
			overlay.hide();
			h.pump();

			// Destructive replay: ED3 wipes every placement cell, so the replay
			// must delete each image's stale registry entries (d=i keeps the
			// data) and re-place under epoch 1 instead of stranding one entry
			// per reset (Codex review on #8057).
			h.writes.length = 0;
			h.tui.resetDisplay();
			h.pump();

			const output = h.output();
			expect(output).toContain("\x1b[3J");
			// Exactly [1, 2]: a p=3 delete would betray epoch churn upstream —
			// and epoch 1 is included, so an image absent from the replay
			// leaves nothing behind.
			expect(captureDeletes(output, h.imageId)).toEqual([1, 2]);
			// The never-advanced image deletes exactly its epoch-1 entry.
			expect(captureDeletes(output, calmId)).toEqual([1]);
			for (const id of [h.imageId, calmId]) {
				const replay = capturePlacements(output, id);
				expect(replay.length).toBeGreaterThan(0);
				expect(replay[replay.length - 1]!.placementId).toBe(1);
			}
		} finally {
			h.tui.stop();
		}
	});
});
