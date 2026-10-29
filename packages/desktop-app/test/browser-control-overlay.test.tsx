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
});
