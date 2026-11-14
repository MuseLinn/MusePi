import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { agentColor, agentFace, agentShape } from "@aora-bot/react";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AoraAvatar } from "../src/components/AoraAvatar";
import type { AgentSignals } from "../src/lib/agent-signals";

const roots = new Set<Root>();

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

async function mount(element: ReactElement): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(element));
	return container;
}

function identity(seed: string): [string, string, string] {
	const agent = { id: seed };
	return [agentShape(agent), agentColor(agent), agentFace(agent)];
}

describe("AoraAvatar", () => {
	it("derives the engine identity deterministically from the seed", () => {
		expect(identity("musepi")).toEqual(identity("musepi"));
		expect(identity("musepi-2")).not.toEqual(identity("musepi"));
	});

	it("renders the seeded identity on the character mark", async () => {
		const container = await mount(<AoraAvatar size={32} />);
		const mark = container.querySelector(".aora-mark");
		expect(mark?.getAttribute("data-shape")).toBe(agentShape({ id: "musepi" }));
		expect(mark?.getAttribute("data-color")).toBe(agentColor({ id: "musepi" }));
		expect(mark?.getAttribute("data-face")).toBe(agentFace({ id: "musepi" }));
	});

	it("projects signals onto the avatar surface", async () => {
		const cases: Array<[AgentSignals, string]> = [
			[{ approvals: 1 }, "waiting"],
			[{ phase: "tool", activity: "searching" }, "searching"],
			[{ personaMood: "sad" }, "idle"],
		];
		for (const [signals, expected] of cases) {
			const container = await mount(<AoraAvatar signals={signals} size={32} />);
			const wrapper = container.querySelector("[data-aora-state]");
			expect(wrapper?.getAttribute("data-aora-state")).toBe(expected);
		}
	});

	it("sizes the wrapper and forwards still to the engine", async () => {
		const container = await mount(<AoraAvatar size={48} still />);
		const wrapper = container.querySelector<HTMLElement>("[data-aora-state]");
		expect(wrapper?.style.width).toBe("48px");
		expect(wrapper?.style.height).toBe("48px");
		expect(container.querySelector(".aora-mark")).not.toBeNull();
	});
});
