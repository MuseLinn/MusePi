import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowserControlOverlay as Overlay } from "../src/components/browser-control-overlay";

let BrowserControlOverlay: typeof Overlay;
let t: typeof import("@musepi/client-core").t;
let previousActEnvironment: boolean;
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(async () => {
	previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
	actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
	({ BrowserControlOverlay } = await import("../src/components/browser-control-overlay"));
	({ t } = await import("@musepi/client-core"));
});

afterAll(async () => {
	actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	await GlobalRegistrator.register();
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const running = {
	id: "a",
	action: "click",
	summary: "点击元素",
	domain: "example.com",
	status: "dispatched",
	tabId: "tab-a",
	at: 1_000,
};

describe("BrowserControlOverlay", () => {
	it("shows elapsed agent control, plays an exit transition, and invokes takeover once", async () => {
		let takeovers = 0;
		act(() => root.render(<BrowserControlOverlay activity={running} now={13_000} onTakeover={() => takeovers++} />));
		const frame = document.querySelector<HTMLElement>("[data-browser-control='running']");
		expect(frame).not.toBeNull();
		expect(frame?.style.position).toBe("fixed");
		expect(frame?.style.zIndex).toBe("1000");
		expect(document.querySelector("[data-elapsed='12']")).not.toBeNull();
		const button = document.querySelector("button");
		expect(button).not.toBeNull();
		act(() => button!.click());
		expect(takeovers).toBe(1);

		act(() =>
			root.render(
				<BrowserControlOverlay activity={{ ...running, status: "completed" }} onTakeover={() => takeovers++} />,
			),
		);
		expect(document.querySelector("[data-browser-control='closing']")).not.toBeNull();
		await act(async () => Bun.sleep(220));
		expect(host.querySelector("[data-browser-control]")).toBeNull();
	});

	it("keeps the elapsed counter continuous from the start of the hold", () => {
		act(() =>
			root.render(<BrowserControlOverlay activity={running} since={1_000} now={9_000} onTakeover={() => {}} />),
		);
		expect(document.querySelector("[data-elapsed='8']")).not.toBeNull();
	});

	it("stays visible for a settled activity while the agent still holds the tab", async () => {
		act(() =>
			root.render(
				<BrowserControlOverlay
					activity={{ ...running, status: "completed" }}
					visible
					now={5_000}
					onTakeover={() => {}}
				/>,
			),
		);
		expect(document.querySelector("[data-browser-control='running']")).not.toBeNull();
		expect(document.body.textContent).toContain(t("tools.agentHolding"));
		await act(async () => Bun.sleep(220));
		expect(document.querySelector("[data-browser-control='running']")).not.toBeNull();
	});

	it("reveals the background agent tab instead of drawing a frame over the current page", () => {
		let revealed = 0;
		act(() =>
			root.render(
				<BrowserControlOverlay
					activity={running}
					inView={false}
					onReveal={() => revealed++}
					onTakeover={() => {}}
				/>,
			),
		);
		expect(document.querySelector("[data-browser-control='out-of-view']")).not.toBeNull();
		const reveal = [...document.querySelectorAll("button")].find(
			button => button.textContent === t("tools.browserShowAgentTab"),
		);
		act(() => reveal!.click());
		expect(revealed).toBe(1);
	});

	it("blocks duplicate takeover requests until the active request settles", async () => {
		let takeovers = 0;
		const pending = Promise.withResolvers<void>();
		act(() =>
			root.render(
				<BrowserControlOverlay
					activity={running}
					onTakeover={() => {
						takeovers++;
						return pending.promise;
					}}
				/>,
			),
		);
		const button = document.querySelector<HTMLButtonElement>("button");
		act(() => button!.click());
		act(() => button!.click());
		expect(takeovers).toBe(1);
		expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
		pending.resolve();
		await act(async () => Bun.sleep(0));
		expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
	});

	it("stays hidden without an active operation", () => {
		act(() => root.render(<BrowserControlOverlay activity={null} onTakeover={() => {}} />));
		expect(host.querySelector("[data-browser-control]")).toBeNull();
	});

	it("names the agent operating a tab so a subagent's run is attributable", async () => {
		const { createTab, closeTab } = await import("../src/lib/managed-browser-host");
		void createTab("https://example.test", {
			tabId: "agent-tab",
			agent: true,
			agentId: "Helper",
			agentName: "Helper",
		}).catch(() => {});

		act(() =>
			root.render(
				<BrowserControlOverlay activity={{ ...running, tabId: "agent-tab" }} now={2_000} onTakeover={() => {}} />,
			),
		);
		const badge = document.querySelector("[data-browser-agent]");
		expect(badge?.getAttribute("data-browser-agent")).toBe("Helper");
		expect(badge?.textContent).toBe(t("tools.browserAgentOperator", { agent: "Helper" }));

		closeTab("agent-tab", { notifyMain: false });
	});

	it("prefers an operator published with the activity over the tab lookup", () => {
		act(() =>
			root.render(
				<BrowserControlOverlay
					activity={{ ...running, tabId: "unknown-tab", agentId: "Writer", agentName: "Writer" }}
					onTakeover={() => {}}
				/>,
			),
		);
		expect(document.querySelector("[data-browser-agent]")?.getAttribute("data-browser-agent")).toBe("Writer");
	});
});

describe("BrowserControlOverlay context", () => {
	it("shows the page domain next to the operation summary", () => {
		act(() => root.render(<BrowserControlOverlay activity={running} now={2_000} onTakeover={() => {}} />));
		const summary = document.querySelector(".gui-browser-control-summary");
		expect(summary?.textContent).toContain("example.com");
		expect(summary?.textContent).toContain("点击元素");
		expect(summary?.getAttribute("title")).toBe("点击元素");
	});
});

describe("BrowserControlOverlay pointer blocking", () => {
	it("puts a hit layer over the page while the agent drives the visible tab", () => {
		act(() => root.render(<BrowserControlOverlay activity={running} now={2_000} onTakeover={() => {}} />));
		expect(document.querySelector("[data-browser-control-blocker]")).not.toBeNull();
	});

	it("does not block the user's own page on a background tab", () => {
		act(() =>
			root.render(
				<BrowserControlOverlay activity={running} inView={false} onTakeover={() => {}} onReveal={() => {}} />,
			),
		);
		expect(document.querySelector("[data-browser-control-blocker]")).toBeNull();
	});

	it("refuses a click on the page and answers on the capsule instead", async () => {
		act(() => root.render(<BrowserControlOverlay activity={running} now={2_000} onTakeover={() => {}} />));
		const blocker = document.querySelector<HTMLElement>("[data-browser-control-blocker]")!;
		const frame = document.querySelector<HTMLElement>("[data-browser-control]")!;

		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		act(() => {
			blocker.dispatchEvent(click);
		});

		// Cancelled on the blocker: the guest never sees a default action, and
		// the capsule answers in place instead of the click doing nothing.
		expect(click.defaultPrevented).toBe(true);
		expect(frame.getAttribute("data-blocked")).toBe("true");
		expect(document.querySelector(".gui-browser-control-summary")?.textContent).toBe(t("tools.browserBlockedHint"));

		await act(async () => Bun.sleep(1_500));
		expect(frame.getAttribute("data-blocked")).toBeNull();
		expect(document.querySelector(".gui-browser-control-summary")?.textContent).toContain("example.com");
	});

	it("keeps the refusal up through a burst of clicks", async () => {
		act(() => root.render(<BrowserControlOverlay activity={running} now={2_000} onTakeover={() => {}} />));
		const blocker = document.querySelector<HTMLElement>("[data-browser-control-blocker]")!;
		const frame = document.querySelector<HTMLElement>("[data-browser-control]")!;

		act(() => {
			blocker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});
		await act(async () => Bun.sleep(900));
		act(() => {
			blocker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});
		// 900ms into the second refusal: the first timer would already have
		// expired here, so this only passes when a click re-arms the window.
		await act(async () => Bun.sleep(900));
		expect(frame.getAttribute("data-blocked")).toBe("true");
		await act(async () => Bun.sleep(700));
		expect(frame.getAttribute("data-blocked")).toBeNull();
	});

	it("never blocks while the user owns the tab", () => {
		act(() =>
			root.render(<BrowserControlOverlay activity={null} userOwned onTakeover={() => {}} onHandBack={() => {}} />),
		);
		expect(document.querySelector("[data-browser-control-blocker]")).toBeNull();
	});
});
