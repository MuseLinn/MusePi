// The image card stack's unavailable face: a card whose bytes are gone keeps
// its slot and size, shows the unavailable label instead of the browser's
// broken-image glyph, and stops being a target the lightbox can open.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "../src/i18n";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { ImageCardStack } = await import("../src/components/transcript/image-card-stack");

setLocale("zh-CN");

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];
afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

type Open = { index: number; gallery: { src: string; alt: string }[] };

function mount(items: { src: string; alt: string }[], opened: Open[]): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() =>
		root.render(<ImageCardStack items={items} onOpen={(index, gallery) => opened.push({ index, gallery })} />),
	);
	return host;
}

/** Fail the <img> in a card the way a browser does when the src cannot load. */
function fail(card: HTMLElement): void {
	const img = card.querySelector("img");
	expect(img).not.toBeNull();
	act(() => {
		img!.dispatchEvent(new Event("error", { bubbles: false }));
	});
}

function cards(host: HTMLElement): HTMLElement[] {
	return Array.from(host.querySelectorAll<HTMLElement>(".tr-img-stack-card"));
}

describe("image card stack: unavailable images", () => {
	test("a loadable image stays an interactive card", () => {
		const host = mount([{ src: "data:image/png;base64,AAAA", alt: "工具结果 1" }], []);

		const card = cards(host)[0]!;
		expect(card.getAttribute("role")).toBe("button");
		expect(card.classList.contains("tr-img-stack-card--missing")).toBe(false);
		expect(host.querySelector(".tr-img-stack-missing")).toBeNull();
	});

	test("a failed image paints the unavailable face instead of a broken glyph", () => {
		const host = mount([{ src: "data:image/png;base64,AAAA", alt: "工具结果 1" }], []);

		fail(cards(host)[0]!);

		const card = cards(host)[0]!;
		expect(card.classList.contains("tr-img-stack-card--missing")).toBe(true);
		// The dead card is inert: nothing to grab, nothing to open.
		expect(card.hasAttribute("role")).toBe(false);
		expect(card.getAttribute("tabindex")).toBe("-1");
		expect(card.querySelector("img")).toBeNull();
		expect(host.querySelector(".tr-img-stack-missing")?.textContent).toBe("图片已不可用");
		// A gallery of nothing has no counter to report.
		expect(host.querySelector(".tr-img-stack-count")).toBeNull();
	});

	test("tapping a dead card never opens the lightbox on it", () => {
		const opened: Open[] = [];
		const host = mount([{ src: "data:image/png;base64,AAAA", alt: "工具结果 1" }], opened);
		fail(cards(host)[0]!);

		const card = cards(host)[0]!;
		act(() => {
			card.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
			card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(opened).toEqual([]);
	});

	test("the stack rests on a showable card and counts only those", () => {
		const opened: Open[] = [];
		const host = mount(
			[
				{ src: "data:image/png;base64,AAAA", alt: "工具结果 1" },
				{ src: "data:image/png;base64,BBBB", alt: "工具结果 2" },
			],
			opened,
		);
		// The top card (index 0) is the one that dies.
		fail(cards(host)[0]!);

		const [first, second] = cards(host);
		expect(first!.classList.contains("tr-img-stack-card--missing")).toBe(true);
		expect(second!.classList.contains("tr-img-stack-card--top")).toBe(true);
		expect(second!.getAttribute("role")).toBe("button");
		expect(host.querySelector(".tr-img-stack-count")?.textContent).toBe("1 / 1");

		act(() => {
			second!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		// The gallery the lightbox receives skips the dead image, so its index
		// addresses the picture the card actually showed.
		expect(opened).toHaveLength(1);
		expect(opened[0]!.index).toBe(0);
		expect(opened[0]!.gallery.map(item => item.src)).toEqual(["data:image/png;base64,BBBB"]);
	});
});
