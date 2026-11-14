import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { useTabMotion as useTabMotionType } from "../src/lib/use-tab-motion";

let useTabMotion: typeof useTabMotionType;

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	({ useTabMotion } = await import("../src/lib/use-tab-motion"));
});

afterAll(async () => {
	await GlobalRegistrator.unregister();
	await GlobalRegistrator.register();
});

interface Tab {
	id: string;
	title: string;
}

function Probe({ tabs }: { tabs: readonly Tab[] }) {
	const motion = useTabMotion(tabs);
	return (
		<ul>
			{motion.tabs.map(tab => (
				<li
					key={tab.id}
					data-id={tab.id}
					data-entering={motion.enteringIds.has(tab.id) ? "true" : "false"}
					data-closing={motion.closingIds.has(tab.id) ? "true" : "false"}
				>
					{tab.title}
				</li>
			))}
		</ul>
	);
}

let host: HTMLDivElement;
let root: Root;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
	originalMatchMedia = window.matchMedia;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	document.documentElement.classList.remove("gui-motion-off");
	Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

function render(tabs: readonly Tab[]): void {
	act(() => root.render(<Probe tabs={tabs} />));
}

function ids(): string[] {
	return [...host.querySelectorAll("li")].map(el => el.getAttribute("data-id") ?? "");
}

function flags(id: string): { entering: string | null; closing: string | null } {
	const el = host.querySelector(`[data-id="${id}"]`);
	return { entering: el?.getAttribute("data-entering") ?? null, closing: el?.getAttribute("data-closing") ?? null };
}

describe("useTabMotion", () => {
	test("does not animate restored tabs or title updates", async () => {
		render([{ id: "a", title: "A" }]);
		expect(flags("a")).toEqual({ entering: "false", closing: "false" });
		render([{ id: "a", title: "Renamed" }]);
		expect(flags("a")).toEqual({ entering: "false", closing: "false" });
		expect(host.textContent).toBe("Renamed");
	});

	test("marks only a newly opened tab as entering for 130ms", async () => {
		render([{ id: "a", title: "A" }]);
		render([
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		]);
		expect(flags("b").entering).toBe("true");
		expect(flags("a").entering).toBe("false");
		await act(async () => Bun.sleep(160));
		expect(flags("b").entering).toBe("false");
	});

	test("keeps a closed tab only for its 140ms exit", async () => {
		render([
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		]);
		render([{ id: "b", title: "B" }]);
		expect(flags("a").closing).toBe("true");
		await act(async () => Bun.sleep(180));
		expect(ids()).toEqual(["b"]);
	});

	test("reopening during exit cancels removal", async () => {
		render([{ id: "a", title: "A" }]);
		render([]);
		expect(flags("a").closing).toBe("true");
		render([{ id: "a", title: "A" }]);
		await act(async () => Bun.sleep(180));
		expect(ids()).toEqual(["a"]);
		expect(flags("a").closing).toBe("false");
	});

	test("unmount cleans up a pending exit without removing a remounted tab", async () => {
		render([{ id: "a", title: "A" }]);
		render([]);
		act(() => root.unmount());
		root = createRoot(host);
		render([{ id: "a", title: "A" }]);
		await act(async () => Bun.sleep(180));
		expect(ids()).toEqual(["a"]);
	});

	test("gui-motion-off removes a closed tab without a static exit frame", () => {
		document.documentElement.classList.add("gui-motion-off");
		render([{ id: "a", title: "A" }]);
		render([]);
		expect(ids()).toEqual([]);
	});

	test("prefers-reduced-motion removes a closed tab without a static exit frame", () => {
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
		});
		render([{ id: "a", title: "A" }]);
		render([]);
		expect(ids()).toEqual([]);
	});

	test("turning motion off during an exit removes the pending frame immediately", async () => {
		render([{ id: "a", title: "A" }]);
		render([]);
		expect(flags("a").closing).toBe("true");
		document.documentElement.classList.add("gui-motion-off");
		await act(async () => Bun.sleep(0));
		expect(ids()).toEqual([]);
	});
});
