import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { type HistoryDirection, navigateHistory, useInputHistory } from "../src/components/composer/use-input-history";
import type { RpcClient } from "../src/lib/rpc";

// Composer sent-history recall: ArrowUp must walk NEWEST → older (first press
// gets the latest submission), ArrowDown back toward the present and finally
// the draft that was in the box when browsing started. Storage is per project
// dir, and a re-submitted prompt takes the newest slot instead of repeating.

type Harness = {
	history(): string[];
	historyIndex(): number | null;
	type(value: string): void;
	browse(direction: HistoryDirection): string | null;
	push(prompt: string): void;
};

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function Probe({ cwd, api }: { cwd?: string; api: { current: Harness | null } }): null {
	const { history, historyIndex, browseHistory, pushHistory } = useInputHistory(cwd);
	const [text, setText] = useState("");
	api.current = {
		history: () => history,
		historyIndex: () => historyIndex,
		type: value => setText(value),
		browse: direction => {
			const next = browseHistory(direction, text);
			if (next !== null) setText(next);
			return next;
		},
		push: prompt => pushHistory(prompt),
	};
	return null;
}

function mount(cwd: string | undefined, api: { current: Harness | null }): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<Probe cwd={cwd} api={api} />));
	return root;
}

/** One committed browse step (React only re-renders when the update commits). */
function step(api: { current: Harness | null }, direction: HistoryDirection): string | null {
	let result: string | null = null;
	act(() => {
		result = api.current!.browse(direction);
	});
	return result;
}

function push(api: { current: Harness | null }, ...prompts: string[]): void {
	act(() => {
		for (const prompt of prompts) api.current!.push(prompt);
	});
}

function type(api: { current: Harness | null }, value: string): void {
	act(() => api.current!.type(value));
}

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list") || method.startsWith("providers")) return [];
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

function mountComposer(cwd: string, onSend: (text: string) => void): HTMLTextAreaElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	act(() =>
		root.render(
			<Composer
				working={false}
				onSend={onSend}
				onStop={() => {}}
				rpc={rpc}
				sessionId="session-1"
				cwd={cwd}
				quotes={[]}
				onQuotesChange={() => {}}
			/>,
		),
	);
	return host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
}

function setBox(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	setter.call(textarea, value);
	act(() => {
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	// ArrowUp only starts browsing with the caret at the very start of a
	// non-empty draft; the programmatic value set leaves it at the end.
	textarea.setSelectionRange(0, 0);
}

function pressKey(textarea: HTMLTextAreaElement, key: string): void {
	act(() => {
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
});

describe("navigateHistory", () => {
	const ring = ["first", "second", "latest"];

	it("starts at the newest submission and walks older", () => {
		expect(navigateHistory(ring, null, "older", "draft")).toEqual({ index: 0, text: "latest" });
		expect(navigateHistory(ring, 0, "older", "draft")).toEqual({ index: 1, text: "second" });
		expect(navigateHistory(ring, 1, "older", "draft")).toEqual({ index: 2, text: "first" });
		expect(navigateHistory(ring, 2, "older", "draft")).toBeNull();
	});

	it("walks back toward the present and then to the saved draft", () => {
		expect(navigateHistory(ring, 2, "newer", "my draft")).toEqual({ index: 1, text: "second" });
		expect(navigateHistory(ring, 1, "newer", "my draft")).toEqual({ index: 0, text: "latest" });
		expect(navigateHistory(ring, 0, "newer", "my draft")).toEqual({ index: null, text: "my draft" });
	});

	it("cannot browse without a ring or while not browsing", () => {
		expect(navigateHistory([], null, "older", "draft")).toBeNull();
		expect(navigateHistory(ring, null, "newer", "draft")).toBeNull();
	});
});

describe("useInputHistory", () => {
	it("recalls newest → older and restores the typed draft at the bottom", () => {
		const api: { current: Harness | null } = { current: null };
		mount("C:/ws-history", api);
		push(api, "first", "second", "latest");
		type(api, "half-written draft");

		expect(api.current!.history()).toEqual(["first", "second", "latest"]);
		expect(step(api, "older")).toBe("latest");
		expect(api.current!.historyIndex()).toBe(0);
		expect(step(api, "older")).toBe("second");
		expect(step(api, "older")).toBe("first");
		expect(step(api, "older")).toBeNull();

		expect(step(api, "newer")).toBe("second");
		expect(step(api, "newer")).toBe("latest");
		expect(step(api, "newer")).toBe("half-written draft");
		expect(api.current!.historyIndex()).toBeNull();
		expect(step(api, "newer")).toBeNull();
	});

	it("restores an empty box when browsing started empty, and re-snapshots next time", () => {
		const api: { current: Harness | null } = { current: null };
		mount("C:/ws-empty", api);
		push(api, "sent");

		expect(step(api, "older")).toBe("sent");
		expect(step(api, "newer")).toBe("");
		expect(api.current!.historyIndex()).toBeNull();

		type(api, "second draft");
		expect(step(api, "older")).toBe("sent");
		expect(step(api, "newer")).toBe("second draft");
	});

	it("moves a re-submitted prompt to the newest slot instead of duplicating it", () => {
		const api: { current: Harness | null } = { current: null };
		mount("C:/ws-resend", api);
		push(api, "first", "second");

		// Recall the older prompt, then send it again.
		expect(step(api, "older")).toBe("second");
		expect(step(api, "older")).toBe("first");
		push(api, "first");

		expect(api.current!.history()).toEqual(["second", "first"]);
		expect(step(api, "older")).toBe("first");
		expect(step(api, "older")).toBe("second");
		expect(step(api, "older")).toBeNull();
	});

	it("does not leak history across project dirs", () => {
		const api: { current: Harness | null } = { current: null };
		const root = mount("C:/ws-alpha", api);
		push(api, "alpha prompt");

		act(() => root.render(<Probe cwd="C:/ws-beta" api={api} />));
		expect(api.current!.history()).toEqual([]);
		expect(step(api, "older")).toBeNull();
		push(api, "beta prompt");
		expect(step(api, "older")).toBe("beta prompt");

		act(() => root.render(<Probe cwd="C:/ws-alpha" api={api} />));
		expect(api.current!.history()).toEqual(["alpha prompt"]);
		expect(step(api, "older")).toBe("alpha prompt");
	});
});

describe("Composer history keys", () => {
	it("walks a seeded ring newest → older → newest → draft", () => {
		localStorage.setItem("musepi-gui-input-history:C:/ws-keys", JSON.stringify(["first", "second", "latest"]));
		const textarea = mountComposer("C:/ws-keys", () => {});
		setBox(textarea, "draft text");

		pressKey(textarea, "ArrowUp");
		expect(textarea.value).toBe("latest");
		pressKey(textarea, "ArrowUp");
		expect(textarea.value).toBe("second");
		pressKey(textarea, "ArrowUp");
		expect(textarea.value).toBe("first");

		pressKey(textarea, "ArrowDown");
		expect(textarea.value).toBe("second");
		pressKey(textarea, "ArrowDown");
		expect(textarea.value).toBe("latest");
		pressKey(textarea, "ArrowDown");
		expect(textarea.value).toBe("draft text");
	});

	it("puts the just-sent prompt first for the next recall", () => {
		localStorage.setItem("musepi-gui-input-history:C:/ws-send", JSON.stringify(["first", "second"]));
		const sent: string[] = [];
		const textarea = mountComposer("C:/ws-send", text => sent.push(text));

		setBox(textarea, "composed prompt");
		pressKey(textarea, "Enter");
		expect(sent).toEqual(["composed prompt"]);
		expect(textarea.value).toBe("");

		pressKey(textarea, "ArrowUp");
		expect(textarea.value).toBe("composed prompt");
		pressKey(textarea, "ArrowUp");
		expect(textarea.value).toBe("second");
	});
});
