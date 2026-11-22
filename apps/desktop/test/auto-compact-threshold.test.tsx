import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextRing } from "../src/components/ContextRing";
import {
	AutoCompactThresholdControl,
	type CompactionThresholdView,
} from "../src/components/composer/auto-compact-threshold";
import { ContextUsageCard } from "../src/components/composer/context-dialog";

const mounted = new Set<Root>();

async function mount(element: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(element));
	return container;
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

/** Invoke the React prop directly: this harness ignores native input events
 *  on controlled fields (same pattern as settings-controls.test.tsx). */
function fire(element: Element, prop: string, event: unknown): void {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	const props = key
		? (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]
		: undefined;
	const handler = props?.[prop];
	if (!handler) throw new Error(`no React ${prop} handler`);
	act(() => handler(event));
}

const base: CompactionThresholdView = {
	thresholdTokens: 80_000,
	thresholdPercent: 40,
	thresholdMode: "percent",
	thresholdScope: "global",
	thresholdValuePercent: 40,
	thresholdModelKey: null,
};

describe("AutoCompactThresholdControl", () => {
	it("commits a percentage once, on release", async () => {
		const changes: number[] = [];
		const host = await mount(
			<AutoCompactThresholdControl
				view={base}
				onChange={p => changes.push(p)}
				onReset={() => {}}
				onSwitchToPercent={() => {}}
			/>,
		);
		const slider = host.querySelector<HTMLInputElement>("input[type=range]");
		expect(slider?.value).toBe("40");
		expect(changes).toEqual([]);

		act(() => {
			// The handler reads event.target.value; drive the DOM value too.
			if (slider) slider.value = "65";
		});
		fire(slider!, "onChange", { target: slider, currentTarget: slider });
		expect(changes).toEqual([]);
		fire(slider!, "onPointerUp", {});
		expect(changes).toEqual([65]);
	});

	it("does not turn the auto resting point into an explicit setting without a drag", async () => {
		const changes: number[] = [];
		const host = await mount(
			<AutoCompactThresholdControl
				view={{ ...base, thresholdMode: "auto", thresholdValuePercent: null, thresholdPercent: 85 }}
				onChange={p => changes.push(p)}
				onReset={() => {}}
				onSwitchToPercent={() => {}}
			/>,
		);
		const slider = host.querySelector<HTMLInputElement>("input[type=range]");
		expect(slider?.value).toBe("85");
		fire(slider!, "onPointerUp", {});
		expect(changes).toEqual([]);

		act(() => {
			if (slider) slider.value = "70";
		});
		fire(slider!, "onChange", { target: slider, currentTarget: slider });
		fire(slider!, "onKeyUp", {});
		expect(changes).toEqual([70]);
	});

	it("labels a fixed token cap and offers the equivalent percentage", async () => {
		const switched: number[] = [];
		const host = await mount(
			<AutoCompactThresholdControl
				view={{
					...base,
					thresholdTokens: 190_000,
					thresholdPercent: 95,
					thresholdMode: "fixed",
					thresholdValuePercent: null,
				}}
				onChange={() => {}}
				onReset={() => {}}
				onSwitchToPercent={p => switched.push(p)}
			/>,
		);
		expect(host.querySelector("input[type=range]")).toBeNull();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		fire(button!, "onClick", {});
		expect(switched).toEqual([95]);
	});

	it("resets a per-model percentage to the global policy", async () => {
		let resets = 0;
		const host = await mount(
			<AutoCompactThresholdControl
				view={{
					...base,
					thresholdPercent: 55,
					thresholdValuePercent: 55,
					thresholdScope: "model",
					thresholdModelKey: "acme/wide",
				}}
				onChange={() => {}}
				onReset={() => {
					resets += 1;
				}}
				onSwitchToPercent={() => {}}
			/>,
		);
		const button = host.querySelector("button");
		fire(button!, "onClick", {});
		expect(resets).toBe(1);
	});

	it("surfaces a write failure instead of snapping back silently", async () => {
		const host = await mount(
			<AutoCompactThresholdControl
				view={base}
				error="settings write refused"
				onChange={() => {}}
				onReset={() => {}}
				onSwitchToPercent={() => {}}
			/>,
		);
		const alert = host.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("settings write refused");
	});

	it("opens inside the context ring popover with the effective share", async () => {
		const host = await mount(
			<ContextRing
				percent={40}
				tokens={80_000}
				contextWindow={200_000}
				threshold={{ ...base, thresholdMode: "auto", thresholdValuePercent: null, thresholdPercent: 85 }}
				onThresholdChange={() => {}}
				onThresholdReset={() => {}}
				onThresholdSwitchToPercent={() => {}}
			/>,
		);
		fire(host.querySelector("button")!, "onClick", {});
		const pop = document.querySelector<HTMLElement>(".gui-context-pop")!;
		const slider = pop.querySelector<HTMLInputElement>("input[type=range]");
		expect(slider).not.toBeNull();
		expect(slider?.value).toBe("85");
		// Hierarchy contract: the control closes the card, after every usage
		// reading, rather than splitting the readout rows.
		const threshold = pop.querySelector<HTMLElement>(".gui-context-threshold")!;
		expect(threshold.parentElement?.lastElementChild).toBe(threshold);
	});

	it("keeps the /context card a report first and the trigger last", async () => {
		await mount(
			<ContextUsageCard
				loading={false}
				onClose={() => {}}
				onThresholdChange={() => {}}
				onThresholdReset={() => {}}
				onThresholdSwitchToPercent={() => {}}
				data={{
					...base,
					tokens: 80_000,
					contextWindow: 200_000,
					percent: 40,
					breakdown: {
						contextWindow: 200_000,
						usedTokens: 80_000,
						systemPromptTokens: 10_000,
						systemToolsTokens: 5_000,
						systemContextTokens: 0,
						skillsTokens: 0,
						messagesTokens: 65_000,
					},
				}}
			/>,
		);
		const panel = document.querySelector<HTMLElement>(".gui-quota-panel")!;
		const threshold = panel.querySelector<HTMLElement>(".gui-context-threshold")!;
		expect(threshold.parentElement?.lastElementChild).toBe(threshold);
	});
});
