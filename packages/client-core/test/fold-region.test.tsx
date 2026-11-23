import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { FoldRegion } from "@musepi/client-ui-primitives/client";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(node: ReactNode): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

/** The open flag is applied one frame AFTER the content mounts (double rAF). */
async function settle(): Promise<void> {
	await act(async () => {
		await nextFrame();
		await nextFrame();
	});
}

describe("FoldRegion collapse track", () => {
	test("closed regions mount no content and stay inert", () => {
		const host = render(
			<FoldRegion open={false} id="fold-1">
				<span className="payload">hidden</span>
			</FoldRegion>,
		);
		const region = host.querySelector(".fold-region");
		expect(region).not.toBeNull();
		expect(region?.getAttribute("id")).toBe("fold-1");
		expect(region?.hasAttribute("inert")).toBe(true);
		expect(region?.getAttribute("aria-hidden")).toBe("true");
		expect(region?.className.includes("fold-region--open")).toBe(false);
		expect(host.querySelector(".payload")).toBeNull();
	});

	test("opening mounts first, then opens the track on the next frame", async () => {
		const host = render(
			<FoldRegion open={false}>
				<span className="payload">body</span>
			</FoldRegion>,
		);
		act(() =>
			root?.render(
				<FoldRegion open>
					<span className="payload">body</span>
				</FoldRegion>,
			),
		);
		// Mounted in the commit, still closed: the track animates from a real box.
		expect(host.querySelector(".payload")).not.toBeNull();
		expect(host.querySelector(".fold-region")?.className.includes("fold-region--open")).toBe(false);
		await settle();
		expect(host.querySelector(".fold-region")?.className.includes("fold-region--open")).toBe(true);
		expect(host.querySelector(".fold-region")?.hasAttribute("inert")).toBe(false);
	});

	test("closing removes the open class at once and unmounts after the track lands", async () => {
		const host = render(
			<FoldRegion open>
				<span className="payload">body</span>
			</FoldRegion>,
		);
		await settle();
		act(() =>
			root?.render(
				<FoldRegion open={false}>
					<span className="payload">body</span>
				</FoldRegion>,
			),
		);
		expect(host.querySelector(".fold-region")?.className.includes("fold-region--open")).toBe(false);
		// Content still mounted: the collapse must be visible, not a pop.
		expect(host.querySelector(".payload")).not.toBeNull();
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 260));
		});
		expect(host.querySelector(".payload")).toBeNull();
	});

	test("keepMounted leaves the subtree in place while closed", async () => {
		const host = render(
			<FoldRegion open keepMounted>
				<span className="payload">body</span>
			</FoldRegion>,
		);
		await settle();
		act(() =>
			root?.render(
				<FoldRegion open={false} keepMounted>
					<span className="payload">body</span>
				</FoldRegion>,
			),
		);
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 260));
		});
		expect(host.querySelector(".payload")).not.toBeNull();
		expect(host.querySelector(".fold-region")?.hasAttribute("inert")).toBe(true);
	});
});
