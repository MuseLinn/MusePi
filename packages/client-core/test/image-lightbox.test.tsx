import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImageLightbox } from "../src/components/image-lightbox";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];

function mount(node: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("ImageLightbox", () => {
	test("only the top lightbox handles Escape", () => {
		const closed: string[] = [];
		const items = [{ src: "data:image/png;base64,", alt: "preview" }];
		mount(
			<>
				<ImageLightbox items={items} index={0} onClose={() => closed.push("bottom")} onIndexChange={() => {}} />
				<ImageLightbox items={items} index={0} onClose={() => closed.push("top")} onIndexChange={() => {}} />
			</>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(closed).toEqual(["top"]);
	});
});
