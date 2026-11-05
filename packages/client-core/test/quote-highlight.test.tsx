import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { QuoteHighlightLayer, requestQuoteReveal } = await import("../src/components/transcript/quote-highlight");

/** happy-dom has no CSS Custom Highlight API; a registry stub makes the paint
 *  and reveal contracts observable. */
class HighlightStub {
	readonly ranges: Range[];
	priority = 0;
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}
const registry = new Map<string, HighlightStub>();
Object.defineProperty(globalThis, "Highlight", { configurable: true, value: HighlightStub });
// happy-dom's `CSS` global is a getter that hands out a fresh object per
// access, so the registry is installed on a stable replacement instead.
const cssStub = Object.create(CSS) as typeof CSS & { highlights: Map<string, HighlightStub> };
Object.defineProperty(cssStub, "highlights", { value: registry });
Object.defineProperty(globalThis, "CSS", { configurable: true, value: cssStub });

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	registry.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const ANCHOR = { text: "quoted fragment", prefix: "Source: ", suffix: " ends here.", start: 8 };

function mountTranscript(fragment = "quoted fragment"): HTMLElement {
	document.body.innerHTML = `
		<div class="gui-transcript">
			<div class="tr-root">
				<div data-entry-id="src-1">
					<div class="tr-row"><div class="tr-body"><div class="tr-md"><p>Source: ${fragment} ends here.</p></div></div></div>
				</div>
			</div>
		</div>`;
	const root = document.querySelector<HTMLElement>(".tr-root");
	if (!root) throw new Error("fixture transcript did not mount");
	return root;
}

async function mountLayer(root: HTMLElement): Promise<void> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const reactRoot = createRoot(host);
	mounted.add(reactRoot);
	await act(async () =>
		reactRoot.render(
			<QuoteHighlightLayer rootRef={{ current: root }} marks={[{ entryId: "src-1", anchor: ANCHOR }]} />,
		),
	);
}

describe("quote highlight layer", () => {
	it("paints every anchored quote on its source message text", async () => {
		const root = mountTranscript();
		await mountLayer(root);
		const painted = registry.get("musepi-quote");
		expect(painted?.ranges.map(range => range.toString())).toEqual(["quoted fragment"]);
	});

	it("reveals an anchored fragment and flashes it when a quote card is clicked", async () => {
		const root = mountTranscript();
		await mountLayer(root);
		await act(async () => requestQuoteReveal({ entryId: "src-1", anchor: ANCHOR }));
		const focused = registry.get("musepi-quote-focus");
		expect(focused?.ranges.map(range => range.toString())).toEqual(["quoted fragment"]);
		expect(focused?.priority).toBe(1);
	});

	it("leaves no mark when the anchored text is gone, without throwing", async () => {
		const root = mountTranscript("rewritten text");
		await mountLayer(root);
		expect(registry.get("musepi-quote")?.ranges ?? []).toEqual([]);
		await act(async () => requestQuoteReveal({ entryId: "src-1", anchor: ANCHOR }));
		expect(registry.get("musepi-quote-focus")?.ranges ?? []).toEqual([]);
	});
});
