// Picture-in-picture desktop preview: rises with a computer run, keeps one
// frame at a time, collapses to a static thumbnail when the run ends, and
// yields to approvals.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActiveTool, GuestSnapshot, SessionClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const pipModule = await import("../src/components/shell/ComputerViewerPip");
const { ComputerViewerPip } = pipModule;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

function frame(data: string) {
	return { data, mimeType: "image/png", width: 480, height: 300, target: "desktop", at: 1 };
}

function computerTool(toolCallId: string, data: string, action?: { kind: string; title?: string }): ActiveTool {
	return {
		toolCallId,
		toolName: "computer",
		args: {},
		startedAt: 1,
		partialResult: {
			content: [],
			details: {
				screenshots: [],
				viewer: frame(data),
				...(action ? { inputEvents: [action] } : {}),
			},
		},
	};
}

function fakeClient(initial: Partial<GuestSnapshot> = {}) {
	let snapshot = {
		activeTools: new Map<string, ActiveTool>(),
		focusedSessionId: null,
		approvalRequest: null,
		...initial,
	} as unknown as GuestSnapshot;
	const listeners = new Set<() => void>();
	const client = {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	} as unknown as SessionClient;
	return {
		client,
		set(patch: Partial<GuestSnapshot>) {
			snapshot = { ...snapshot, ...patch };
			for (const listener of listeners) listener();
		},
	};
}

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

function mount(client: SessionClient): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<ComputerViewerPip client={client} />));
	return host;
}

function click(host: HTMLElement, selector: string): void {
	const target = host.querySelector<HTMLElement>(selector);
	expect(target).not.toBeNull();
	act(() => {
		target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("ComputerViewerPip", () => {
	test("rises on the first frame, replaces it, and keeps one image", () => {
		const fake = fakeClient();
		const host = mount(fake.client);
		expect(host.querySelector(".cvp")).toBeNull();

		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "AAAA", { kind: "click", title: "Notes" })]]) });
		});
		const pip = host.querySelector(".cvp");
		expect(pip?.getAttribute("data-running")).toBe("true");
		expect(pip?.getAttribute("data-expanded")).toBe("true");
		expect(host.querySelector(".cvp-frame")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		expect(host.querySelector(".cvp-caption")?.textContent).toContain("Notes");

		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "BBBB")]]) });
		});
		const images = host.querySelectorAll("img");
		expect(images).toHaveLength(1);
		expect(images[0]!.getAttribute("src")).toBe("data:image/png;base64,BBBB");

		// A burst of frames replaces the single image instead of stacking.
		for (const data of ["CCCC", "DDDD", "EEEE", "FFFF"]) {
			act(() => {
				fake.set({ activeTools: new Map([["t1", computerTool("t1", data)]]) });
			});
		}
		expect(host.querySelectorAll("img")).toHaveLength(1);
		expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,FFFF");
	});

	test("renders from explicit props, the shape the desktop window passes", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		const { ComputerViewerPipView } = pipModule;
		act(() =>
			root.render(
				<ComputerViewerPipView
					activeTools={new Map([["d1", computerTool("d1", "DDDD", { kind: "type", title: "Notes" })]])}
					sessionKey="desktop-session"
					blocked={false}
				/>,
			),
		);
		expect(host.querySelector(".cvp")?.getAttribute("data-running")).toBe("true");
		expect(host.querySelector(".cvp-frame")?.getAttribute("src")).toBe("data:image/png;base64,DDDD");
		expect(host.querySelector(".cvp-caption")?.textContent).toContain("Notes");
	});

	test("collapses by hand while running and stays collapsed", () => {
		const fake = fakeClient();
		const host = mount(fake.client);
		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "AAAA")]]) });
		});
		click(host, ".cvp-icon");
		expect(host.querySelector(".cvp")?.getAttribute("data-expanded")).toBe("false");
		expect(host.querySelector(".cvp-thumb")).not.toBeNull();
	});

	test("run end turns the live card into a static thumbnail that can be reopened", () => {
		const fake = fakeClient();
		const host = mount(fake.client);
		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "AAAA", { kind: "type" })]]) });
		});
		act(() => {
			fake.set({ activeTools: new Map() });
		});
		const pip = host.querySelector(".cvp");
		expect(pip?.getAttribute("data-running")).toBe("false");
		expect(pip?.getAttribute("data-expanded")).toBe("false");
		expect(host.querySelector(".cvp-thumb-frame")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");

		click(host, ".cvp-thumb-main");
		expect(host.querySelector(".cvp")?.getAttribute("data-expanded")).toBe("true");
		expect(host.querySelector(".cvp-frame")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
	});

	test("dismiss hides the card until the next run", () => {
		const fake = fakeClient();
		const host = mount(fake.client);
		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "AAAA")]]) });
		});
		const icons = host.querySelectorAll(".cvp-icon");
		act(() => {
			icons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(host.querySelector(".cvp")).toBeNull();

		act(() => {
			fake.set({ activeTools: new Map([["t2", computerTool("t2", "CCCC")]]) });
		});
		expect(host.querySelector(".cvp")?.getAttribute("data-expanded")).toBe("true");
	});

	test("yields to a pending approval and clears on a session switch", () => {
		const fake = fakeClient({
			approvalRequest: { requestId: "a1", tool: "bash", args: {}, prompt: null },
		});
		const host = mount(fake.client);
		act(() => {
			fake.set({ activeTools: new Map([["t1", computerTool("t1", "AAAA")]]) });
		});
		expect(host.querySelector(".cvp")).toBeNull();

		act(() => {
			fake.set({ approvalRequest: null, activeTools: new Map() });
		});
		expect(host.querySelector(".cvp-thumb")).not.toBeNull();

		act(() => {
			fake.set({ focusedSessionId: "other-session" });
		});
		expect(host.querySelector(".cvp")).toBeNull();
	});
});
