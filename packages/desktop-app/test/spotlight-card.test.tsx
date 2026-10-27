import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpotlightCard } from "../../client-core/src/components/shell/SpotlightCard";

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

it("moves the glow without rerendering the card children", async () => {
	let childRenders = 0;
	function Child(): React.ReactNode {
		childRenders++;
		return <textarea />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () =>
		root.render(
			<SpotlightCard>
				<Child />
			</SpotlightCard>,
		),
	);
	const card = host.querySelector<HTMLElement>(".gui-spotlight");
	const glow = host.querySelector<HTMLElement>(".gui-spotlight-glow");
	expect(card).not.toBeNull();
	expect(glow).not.toBeNull();
	expect(childRenders).toBe(1);
	card!.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 100 }) as DOMRect;

	await act(async () => {
		card!.dispatchEvent(new PointerEvent("pointermove", { clientX: 110, clientY: 60, bubbles: true }));
		card!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
	});

	expect(glow!.style.background).toContain("100px 40px");
	expect(glow!.style.opacity).toBe("1");
	expect(childRenders).toBe(1);
});
