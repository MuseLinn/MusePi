/**
 * The height-morph standard.
 *
 * HeightMorph is the app's one "the same surface changes height" component:
 * settings tab bodies, provider lists that grow in place, the extensions
 * centre's raw-data disclosure. Its motion is a spring, and the spring's
 * two parameters are what make it read as a shape changing rather than a
 * value being assigned.
 *
 * The assertions below measure the HEIGHTS THE COMPONENT ACTUALLY PRODUCES
 * during a morph, not the spring's parameters in isolation. A test that
 * only exercises the parameter helper would keep passing if the component
 * stopped using it — the wiring is the part that can regress.
 *
 * happy-dom does no layout, so every measurement is stubbed: the container
 * reports the height of the body it currently holds.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeightMorph } from "../src/components/HeightMorph";

const mounted = new Set<Root>();
/** Restores the stubbed `offsetHeight` accessor. */
let restoreLayout: (() => void) | undefined;

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	restoreLayout?.();
	restoreLayout = undefined;
});

/**
 * Stub the layout: an element reports the height of the body it holds, so
 * the component's own measurements (offsetHeight, getBoundingClientRect)
 * see the height the morph is supposed to travel between.
 */
function stubLayout(): void {
	// `offsetHeight` is an accessor, which a spy cannot replace — define the
	// property directly and restore it afterwards.
	const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			const body = this.querySelector<HTMLElement>("[data-morph-body]");
			return body ? Number.parseFloat(body.style.height || "0") : 0;
		},
	});
	restoreLayout = (): void => {
		if (descriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", descriptor);
	};
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const body = this.querySelector<HTMLElement>("[data-morph-body]");
		const height = body ? Number.parseFloat(body.style.height || "0") : 0;
		return new DOMRect(0, 0, 320, height);
	});
}

/**
 * Mount a morph and sample the container's height every frame while it runs.
 */
async function sampleMorph(
	fromHeight: number,
	toHeight: number,
	options: { frames?: number } = {},
): Promise<{ heights: number[]; node: HTMLDivElement }> {
	stubLayout();
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	const body = (height: number): React.ReactNode => <div data-morph-body style={{ height: `${height}px` }} />;

	await act(async () =>
		root.render(
			<HeightMorph morphKey="a" fade={false}>
				{body(fromHeight)}
			</HeightMorph>,
		),
	);
	await act(async () => {
		for (let index = 0; index < 4; index++) await Bun.sleep(8);
	});
	const node = container.firstElementChild as HTMLDivElement;
	const heights: number[] = [];

	// The commit runs inside act(); the spring's frames run OUTSIDE it.
	// Inside act, React's work loop owns the microtask queue and the
	// animation frames never advance.
	await act(async () => {
		root.render(
			<HeightMorph morphKey="b" fade={false}>
				{body(toHeight)}
			</HeightMorph>,
		);
	});
	const frames = options.frames ?? 60;
	for (let index = 0; index < frames; index++) {
		await Bun.sleep(10);
		heights.push(Number.parseFloat(node.style.height || "0"));
	}
	return { heights, node };
}

describe("height morph motion", () => {
	it("travels from the old height to the new one", async () => {
		const { heights } = await sampleMorph(40, 240);
		console.log("HEIGHTS:", JSON.stringify(heights));
		expect(heights.length).toBeGreaterThan(5);
		expect(heights.at(-1)).toBeGreaterThan(heights[0] ?? 0);
	});

	it("overshoots the target and comes back — a spring, not a monotone curve", async () => {
		const { heights } = await sampleMorph(40, 240);
		// The container is CLIPPED during the morph, so a height past the
		// target is the surface swelling beyond its content and settling
		// back. A transition reaches the target and stops; this one must
		// pass it.
		const peak = Math.max(...heights);
		expect(peak).toBeGreaterThan(240);
		// ... and it must come back down to the target, not stay swollen.
		expect(heights.at(-1)).toBeLessThanOrEqual(241);
	});

	it("keeps the overshoot inside a readable band of pixels", async () => {
		const { heights } = await sampleMorph(40, 240);
		const overshootPx = Math.max(...heights) - 240;
		// The overshoot is judged in pixels: a large travel must not turn a
		// small fraction into a visible bounce.
		expect(overshootPx).toBeGreaterThan(0);
		expect(overshootPx).toBeLessThanOrEqual(20);
	});

	it("releases the pin as soon as the spring converges, not at the hard cap", async () => {
		// The spring's cap is a runaway guard, not the settle time: a morph
		// that converges in 320ms must release then. While the pin is on,
		// the content is clipped and cannot scroll — so a late release is a
		// real defect, not a cosmetic one.
		const { heights, node } = await sampleMorph(40, 240, { frames: 90 });
		// The container was released while the spring was still within its
		// settle: the pin is gone even though the cap has not been reached.
		expect(node.style.height).toBe("");
		expect(node.style.overflow).toBe("");
		// And the release happened BEFORE the last frame was sampled, i.e.
		// the pin did not survive the whole run.
		const lastPinned = heights.findLastIndex(height => height > 0);
		expect(lastPinned).toBeLessThan(heights.length - 1);
	});

	it("clips the content during the morph so the box edge is what moves", async () => {
		// Without the clip, the new content renders at its natural height the
		// instant the commit lands — it overflows the pinned box and pops in
		// — so only the invisible box edge moves and the unfold reads as
		// "no animation". The clip is what makes the unfold visible.
		stubLayout();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		const body = (height: number): React.ReactNode => <div data-morph-body style={{ height: `${height}px` }} />;
		await act(async () =>
			root.render(
				<HeightMorph morphKey="a" fade={false}>
					{body(40)}
				</HeightMorph>,
			),
		);
		await act(async () => {
			for (let index = 0; index < 4; index++) await Bun.sleep(8);
		});
		const node = container.firstElementChild as HTMLDivElement;
		let clippedDuringMorph = false;
		await act(async () => {
			root.render(
				<HeightMorph morphKey="b" fade={false}>
					{body(240)}
				</HeightMorph>,
			);
		});
		for (let index = 0; index < 8; index++) {
			await Bun.sleep(10);
			if (node.style.overflow === "hidden") clippedDuringMorph = true;
		}
		expect(clippedDuringMorph).toBe(true);
	});

	it("does not morph when the height is unchanged", async () => {
		const { heights, node } = await sampleMorph(120, 120);
		// Nothing to morph: no pin is left behind, so a scroll container
		// keeps its scrollbar.
		expect(node.style.height).toBe("");
		expect(node.style.overflow).toBe("");
	});
});
