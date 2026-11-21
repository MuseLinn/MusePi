import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import { AgentInfoPane } from "../src/lib/surfaces/agent-info-pane";

/**
 * Agent info tab body: the two writes it owns and the readouts it shows.
 *
 * - the model list is the shared selector rendered in place, addressed by
 *   `provider/id`; a pick writes `session.setModel` and re-reads
 *   `session.thinkingInfo` (the daemon's re-clamped level is the authority);
 * - a refused write is reported, never swallowed;
 * - the thinking slider only writes on release, clamps to the model's ceiling,
 *   and rolls its optimistic readout back when the daemon refuses.
 */

const thinkingInfo = {
	ceiling: "high",
	efforts: ["minimal", "low", "medium", "high", "max"],
	level: "medium",
	auto: false,
	resolved: null,
	model: { id: "m1", name: "Model One", provider: "prov" },
};

interface Call {
	method: string;
	params: Record<string, unknown> | undefined;
}

function makeRpc(options: { failModel?: boolean; failThinking?: boolean; failReads?: boolean } = {}) {
	const calls: Call[] = [];
	const failReads = { current: options.failReads === true };
	const rpc = {
		request: async (method: string, params?: Record<string, unknown>) => {
			calls.push({ method, params });
			if (method === "session.thinkingInfo") {
				if (failReads.current) throw new Error("daemon unreachable");
				return { ...thinkingInfo };
			}
			if (method === "session.contextUsage") {
				if (failReads.current) throw new Error("daemon unreachable");
				return { model: "prov/m1", tokens: 1000, contextWindow: 10_000, percent: 10, usage: { cost: 0.25 } };
			}
			if (method === "models.list") {
				return [
					{ id: "m1", name: "Model One", provider: "prov" },
					{ id: "m2", name: "Model Two", provider: "prov2" },
				];
			}
			if (method === "session.setModel") {
				if (options.failModel) throw new Error("provider rejected");
				return { ok: true };
			}
			if (method === "session.setThinkingLevel") {
				if (options.failThinking) throw new Error("thinking rejected");
				return { ok: true };
			}
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	return { rpc, calls, failReads };
}

function snap(overrides: Partial<GuiSessionState> = {}): GuiSessionState {
	return {
		sessionId: "session-1",
		entries: [],
		state: { isStreaming: false, queuedMessageCount: 0, cwd: "C:/workspace", participants: [] },
		streaming: false,
		activeTools: new Map(),
		working: false,
		cursor: 0,
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		unviewedCompleted: [],
		approvals: [],
		recap: null,
		roundDurations: new Map(),
		...overrides,
	} as GuiSessionState;
}

async function mount(rpc: RpcClient, state: GuiSessionState = snap()) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<AgentInfoPane rpc={rpc} sessionId="session-1" cwd="C:/workspace" title="Refactor the panel" snap={state} />,
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** React tracks the DOM value; set it through the prototype so the input
 *  event is not swallowed as "unchanged". */
function setRangeValue(input: HTMLInputElement, value: number): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, String(value));
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function range(host: HTMLElement): HTMLInputElement {
	const input = host.querySelector<HTMLInputElement>("input[type=range]");
	expect(input).not.toBeNull();
	return input!;
}

const level = (calls: Call[]): unknown =>
	calls.filter(call => call.method === "session.setThinkingLevel").at(-1)?.params?.thinkingLevel;

beforeEach(() => {
	setLocale("zh-CN");
	localStorage.setItem("musepi-gui-avatars", "0");
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	setLocale("en-US");
});

describe("agent info pane", () => {
	it("shows the model as a provider/id reference and the session metadata", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		expect(host.querySelector(".gui-agent-info-model-ref")?.textContent).toBe("prov/m1");
		expect(host.textContent).toContain("Refactor the panel");
		expect(host.textContent).toContain("10%");
		await unmount();
	});

	it("renders the searchable model list in place and switches with the picked provider", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		expect(host.querySelector(".gui-model-menu--inline")).not.toBeNull();
		expect(host.querySelector(".gui-model-menu-input")).not.toBeNull();
		const rows = host.querySelectorAll(".gui-model-opt");
		expect(rows.length).toBe(2);
		const thinkingReads = calls.filter(call => call.method === "session.thinkingInfo").length;

		await act(async () => (rows[1] as HTMLElement).click());

		const setModel = calls.find(call => call.method === "session.setModel");
		expect(setModel?.params).toEqual({ sessionId: "session-1", model: { id: "m2", provider: "prov2" } });
		// Re-read after the switch: the daemon re-clamps the level for the new model.
		expect(calls.filter(call => call.method === "session.thinkingInfo").length).toBeGreaterThan(thinkingReads);
		await unmount();
	});

	it("reports a refused model switch instead of dropping it", async () => {
		const { rpc } = makeRpc({ failModel: true });
		const toasts: string[] = [];
		const onToast = (event: Event): void => toasts.push(String((event as CustomEvent).detail));
		window.addEventListener("musepi-gui-toast", onToast);
		const { host, unmount } = await mount(rpc);
		const activeBefore = host.querySelector(".gui-model-opt--active")?.textContent ?? null;
		expect(activeBefore).toContain("Model One");
		const rows = host.querySelectorAll(".gui-model-opt");
		await act(async () => {
			(rows[1] as HTMLElement).click();
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(toasts.some(text => text.includes("切换模型失败"))).toBe(true);
		expect(host.querySelector(".gui-agent-info-error")?.textContent).toContain("切换模型失败");
		// The refused model is not left checked: the daemon kept the old one.
		expect(host.querySelector(".gui-model-opt--active")?.textContent).toBe(activeBefore);
		window.removeEventListener("musepi-gui-toast", onToast);
		await unmount();
	});

	it("shows a retry when the session reads fail instead of loading forever", async () => {
		const { rpc, failReads } = makeRpc({ failReads: true });
		const { host, unmount } = await mount(rpc);
		const banner = host.querySelector(".gui-agent-info-error");
		expect(banner?.textContent).toContain("无法读取会话信息");
		expect(banner?.querySelector("button")?.textContent).toContain("重试");
		expect(host.textContent).not.toContain("正在读取会话信息");

		// The retry reuses the same read path; a recovered daemon fills the pane.
		failReads.current = false;
		const retryButton = banner!.querySelector("button") as HTMLButtonElement;
		await act(async () => {
			retryButton.click();
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(host.querySelector(".gui-agent-info-error")).toBeNull();
		expect(host.querySelector(".gui-agent-info-model-ref")?.textContent).toBe("prov/m1");
		await unmount();
	});

	it("cancels a dragged ladder without writing the draft", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const input = range(host);
		const before = input.getAttribute("aria-valuetext");
		await act(async () => setRangeValue(input, 4));
		await act(async () => input.dispatchEvent(new Event("pointercancel", { bubbles: true })));
		expect(level(calls)).toBeUndefined();
		expect(range(host).getAttribute("aria-valuetext")).toBe(before);
		await unmount();
	});

	it("commits the thinking level only on release", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const input = range(host);
		// off + five efforts + auto
		expect(input.max).toBe("6");
		await act(async () => setRangeValue(input, 2));
		expect(level(calls)).toBeUndefined();
		await act(async () => input.dispatchEvent(new Event("pointerup", { bubbles: true })));
		expect(level(calls)).toBe("low");
		await unmount();
	});

	it("clamps a release above the model ceiling to the ceiling", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const input = range(host);
		await act(async () => setRangeValue(input, 5));
		await act(async () => input.dispatchEvent(new Event("pointerup", { bubbles: true })));
		expect(level(calls)).toBe("high");
		const ticks = [...host.querySelectorAll(".gui-ladder-tick")];
		expect(ticks[5]?.classList.contains("gui-ladder-tick--capped")).toBe(true);
		await unmount();
	});

	it("rolls the optimistic reading back when the thinking write is refused", async () => {
		const { rpc } = makeRpc({ failThinking: true });
		const toasts: string[] = [];
		const onToast = (event: Event): void => toasts.push(String((event as CustomEvent).detail));
		window.addEventListener("musepi-gui-toast", onToast);
		const { host, unmount } = await mount(rpc);
		const input = range(host);
		const before = input.getAttribute("aria-valuetext");
		await act(async () => setRangeValue(input, 4));
		await act(async () => input.dispatchEvent(new Event("pointerup", { bubbles: true })));
		expect(toasts.some(text => text.includes("修改思考强度失败"))).toBe(true);
		expect(range(host).getAttribute("aria-valuetext")).toBe(before);
		window.removeEventListener("musepi-gui-toast", onToast);
		await unmount();
	});

	it("marks a configured auto level with the resolved rung beside it", async () => {
		const base = makeRpc();
		// Auto mode: the slider sits on the auto rung, the resolved effort is secondary.
		const autoRpc = {
			...base.rpc,
			request: async (method: string, params?: Record<string, unknown>) => {
				if (method === "session.thinkingInfo") {
					return { ...thinkingInfo, auto: true, level: "high", resolved: "high" };
				}
				return base.rpc.request(method, params);
			},
		} as unknown as RpcClient;
		const { host, unmount } = await mount(autoRpc);
		const input = range(host);
		expect(input.value).toBe("6");
		expect(host.querySelector(".gui-ladder-resolved")).not.toBeNull();
		await unmount();
	});
});
