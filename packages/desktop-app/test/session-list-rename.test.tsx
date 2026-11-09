import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionList, type SessionListNode } from "../src/components/SessionList";

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

function node(id: string, label: string): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children: [] };
}

async function mount(ui: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
}

describe("SessionList title affordances", () => {
	it("renders a session emoji and renames on double-click + Enter", async () => {
		const renames: Array<{ id: string; title: string }> = [];
		await mount(
			<SessionList
				nodes={[node("s1", "Original")]}
				selectedId={null}
				onSelect={() => {}}
				emojis={new Map([["s1", "🚀"]])}
				onRenameSession={(id, title) => renames.push({ id, title })}
			/>,
		);

		expect(document.querySelector(".gui-session-emoji")?.textContent).toBe("🚀");
		const title = document.querySelector<HTMLElement>(".gui-session-title");
		expect(title).not.toBeNull();
		await act(async () => {
			title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});
		await flush(2);

		const input = document.querySelector<HTMLInputElement>(".gui-session-title-input");
		expect(input).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Renamed");
			const propsKey = Object.keys(input!).find(key => key.startsWith("__reactProps$"));
			const props = input![propsKey as keyof HTMLInputElement] as unknown as {
				onChange(event: { target: HTMLInputElement }): void;
			};
			props.onChange({ target: input! });
			await Bun.sleep(0);
		});
		await act(async () => {
			input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		await flush(2);

		expect(renames).toEqual([{ id: "s1", title: "Renamed" }]);
	});
});
