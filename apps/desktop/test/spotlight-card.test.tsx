import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpotlightCard } from "../../../packages/client-core/src/components/shell/SpotlightCard";

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

it("lets a composer hide the resting glow while preserving hover feedback", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () =>
		root.render(
			<SpotlightCard restingOpacity={0}>
				<textarea />
			</SpotlightCard>,
		),
	);
	const card = host.querySelector<HTMLElement>(".gui-spotlight")!;
	const glow = host.querySelector<HTMLElement>(".gui-spotlight-glow")!;
	expect(glow.style.opacity).toBe("0");
	await act(async () => {
		card.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
	});
	expect(glow.style.opacity).toBe("1");
	await act(async () => {
		card.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
	});
	expect(glow.style.opacity).toBe("0");
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
