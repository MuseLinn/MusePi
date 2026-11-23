import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompactionThresholdRowEditor } from "../src/components/composer/compaction-threshold-editor";

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

/** Drive the React prop directly: this harness ignores native input events. */
function fire(element: Element, prop: string, event: unknown): void {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	const props = key
		? (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]
		: undefined;
	const handler = props?.[prop];
	if (!handler) throw new Error(`no React ${prop} handler`);
	act(() => handler(event));
}

describe("CompactionThresholdRowEditor", () => {
	it("renders each override as a row and removes by key", async () => {
		const commits: Record<string, unknown>[] = [];
		const host = await mount(
			<CompactionThresholdRowEditor
				value={{ "acme/wide": "80%", "openai/*": 90000 }}
				onCommit={next => commits.push(next)}
			/>,
		);
		const rows = host.querySelectorAll(".gui-threshold-editor-row");
		expect(rows).toHaveLength(2);
		expect(host.textContent).toContain("acme/wide");
		expect(host.textContent).toContain("80%");

		const remove = rows[0]!.querySelector("button")!;
		fire(remove, "onClick", {});
		expect(commits.at(-1)).toEqual({ "openai/*": 90000 });
	});

	it("saves a percentage as text, a suffixed count as tokens and a fixed trigger as text", async () => {
		const commits: Record<string, unknown>[] = [];
		const host = await mount(
			<CompactionThresholdRowEditor
				value={{}}
				onCommit={next => {
					commits.push(next);
				}}
			/>,
		);
		const [keyInput, valueInput] = host.querySelectorAll<HTMLInputElement>("input");

		fire(keyInput!, "onChange", { target: { value: "acme/wide" } });
		fire(valueInput!, "onChange", { target: { value: "85%" } });
		fire(host.querySelector("button.gui-threshold-editor-save")!, "onClick", {});
		expect(commits.at(-1)).toEqual({ "acme/wide": "85%" });

		// A second save adds to the map the page now holds (the value prop).
		const second = await mount(
			<CompactionThresholdRowEditor
				value={{ "acme/wide": "85%" }}
				onCommit={next => {
					commits.push(next);
				}}
			/>,
		);
		const [key2, value2] = second.querySelectorAll<HTMLInputElement>("input");
		fire(key2!, "onChange", { target: { value: "openai/*" } });
		fire(value2!, "onChange", { target: { value: "f90k" } });
		fire(second.querySelector("button.gui-threshold-editor-save")!, "onClick", {});
		expect(commits.at(-1)).toEqual({ "acme/wide": "85%", "openai/*": "f90000" });
	});

	it("refuses an invalid selector or trigger and says why", async () => {
		const commits: Record<string, unknown>[] = [];
		const host = await mount(<CompactionThresholdRowEditor value={{}} onCommit={next => commits.push(next)} />);
		const [keyInput, valueInput] = host.querySelectorAll<HTMLInputElement>("input");

		fire(keyInput!, "onChange", { target: { value: "nonsense" } });
		fire(valueInput!, "onChange", { target: { value: "80%" } });
		fire(host.querySelector("button.gui-threshold-editor-save")!, "onClick", {});
		expect(commits).toEqual([]);
		expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();

		fire(keyInput!, "onChange", { target: { value: "acme/wide" } });
		fire(valueInput!, "onChange", { target: { value: "abc" } });
		fire(host.querySelector("button.gui-threshold-editor-save")!, "onClick", {});
		expect(commits).toEqual([]);
		expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
	});

	it("shows the empty hint while no override exists", async () => {
		const host = await mount(<CompactionThresholdRowEditor value={{}} onCommit={() => {}} />);
		expect(host.querySelector(".gui-threshold-editor-empty") === null).toBe(false);
		expect(host.querySelectorAll(".gui-threshold-editor-row")).toHaveLength(0);
	});
});
