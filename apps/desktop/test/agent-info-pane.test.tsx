import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import { AgentInfoPane } from "../src/lib/surfaces/agent-info-pane";

/**
 * Agent info tab body: the model disclosure, the two writes it owns and the
 * readouts it shows.
 *
 * - the model area is one card: collapsed it reads the running `provider/id`
 *   and its thinking level; the searchable list lives inside the same
 *   disclosure and only opens on a click/keyboard activation;
 * - opening moves focus to the search field, Escape folds it and returns focus
 *   to the card, a pick folds it and keeps the selection;
 * - a pick writes `session.setModel` and re-reads `session.thinkingInfo` (the
 *   daemon's re-clamped level is the authority);
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

function makeRpc(
	options: {
		failModel?: boolean;
		failThinking?: boolean;
		failReads?: boolean;
		/** One `agentRole` payload from the session row, or a failed read. */
		role?: { id: string; name?: string } | "fail";
	} = {},
) {
	const calls: Call[] = [];
	const failReads = { current: options.failReads === true };
	// The daemon is the authority: a successful write is what the next
	// `thinkingInfo` read reports, so the slider's post-write re-seed is real.
	const thinking = { level: thinkingInfo.level as string | null, auto: false, resolved: null as string | null };
	const rpc = {
		request: async (method: string, params?: Record<string, unknown>) => {
			calls.push({ method, params });
			if (method === "session.list") {
				if (options.role === "fail") throw new Error("daemon unreachable");
				return [{ id: "session-1", agentRole: options.role ?? { id: "coder" } }];
			}
			if (method === "session.thinkingInfo") {
				if (failReads.current) throw new Error("daemon unreachable");
				return { ...thinkingInfo, ...thinking };
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
				const level = (params?.thinkingLevel as string | null) ?? null;
				thinking.level = level;
				thinking.auto = level === "auto";
				thinking.resolved = level === "auto" ? "high" : null;
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
		// Settle the pane's initial reads INSIDE mount. `thinkingInfo`,
		// `contextUsage` and the agent-role `session.list` each resolve into a
		// state update; one landing after mount would re-render the pane while a
		// test is mid-assertion. The macrotask turn is what lets a read that
		// settles a frame late (slow machine, batched run) be flushed here
		// instead of during the next `expect`.
		await new Promise(resolve => setTimeout(resolve, 0));
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function setTextValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: HTMLElement, name: string): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

function card(host: HTMLElement): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(".gui-agent-model-card");
	expect(button).not.toBeNull();
	return button!;
}

function disclosure(host: HTMLElement): HTMLElement {
	const collapse = host.querySelector<HTMLElement>(".gui-agent-info .gui-collapse");
	expect(collapse).not.toBeNull();
	return collapse!;
}

async function expand(host: HTMLElement): Promise<void> {
	await act(async () => card(host).click());
}

function slider(host: HTMLElement): HTMLElement {
	const track = host.querySelector<HTMLElement>('[role="slider"]');
	expect(track).not.toBeNull();
	return track!;
}

/** Happy-dom lays nothing out; give the track and its rail real widths so the
 *  pointer position maps onto rungs the way it does in the app. The rail is
 *  the CSS-inset travel span (`--gui-slider-inset`), which is exactly what the
 *  component measures — passing a different knob size here is how the tests
 *  prove the pointer math follows layout instead of a baked-in radius. */
function stubTrackWidth(track: HTMLElement, width = 200, knob = 18): void {
	const rect = (left: number, span: number): DOMRect =>
		({
			left,
			top: 0,
			right: left + span,
			bottom: 28,
			width: span,
			height: 28,
			x: left,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
	track.getBoundingClientRect = () => rect(0, width);
	const rail = track.querySelector<HTMLElement>(".gui-slider-rail");
	expect(rail).not.toBeNull();
	const inset = knob / 2;
	rail!.getBoundingClientRect = () => rect(inset, width - inset * 2);
}

/** x of rung `index` on a 200px track with an 18px knob (9px inset a side). */
function rungX(index: number, rungs = 6, width = 200): number {
	return 9 + (width - 18) * (index / rungs);
}

function pointer(target: HTMLElement, type: string, clientX: number): void {
	target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
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
	it("shows the agent's vertical identity head with its role in the Agent tab", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const head = host.querySelector(".gui-agent-info-head");
		const name = host.querySelector(".gui-agent-info-name");
		expect(name?.textContent).toBe("助手");
		// The role id is the contract; the head shows its readable lane tag.
		expect(head?.getAttribute("data-agent-role")).toBe("coder");
		expect(head?.querySelector(".gui-agent-role-tag")?.textContent).toBe("编码");
		expect(calls.find(call => call.method === "session.list")?.params).toEqual({ sessionId: "session-1" });
		await unmount();
	});

	it("shows a subagent's own name rather than the workbench coder role", async () => {
		const { rpc } = makeRpc({ role: { id: "subagent", name: "sonic" } });
		const { host, unmount } = await mount(rpc);
		expect(host.querySelector(".gui-agent-info-name")?.textContent).toBe("sonic");
		expect(host.querySelector(".gui-agent-info-head")?.getAttribute("data-agent-role")).toBe("subagent");
		expect(host.querySelector(".gui-agent-role-tag")?.textContent).toBe("子代理");
		await unmount();
	});

	it("keeps the coder identity when the session row cannot be read", async () => {
		const { rpc } = makeRpc({ role: "fail" });
		const { host, unmount } = await mount(rpc);
		expect(host.querySelector(".gui-agent-info-name")?.textContent).toBe("助手");
		expect(host.querySelector(".gui-agent-info-head")?.getAttribute("data-agent-role")).toBe("coder");
		await unmount();
	});

	it("collapses the model area to the current provider/id and thinking level", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const trigger = card(host);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.textContent).toContain("Model One");
		expect(trigger.textContent).toContain("prov/m1");
		expect(trigger.textContent).toContain("中");
		// The list exists behind the disclosure but is closed and inert.
		expect(disclosure(host).getAttribute("aria-hidden")).toBe("true");
		expect(host.textContent).toContain("Refactor the panel");
		expect(host.textContent).toContain("10%");
		await unmount();
	});

	it("opens the list on click, focuses search, and folds it back on Escape", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		await expand(host);
		expect(card(host).getAttribute("aria-expanded")).toBe("true");
		expect(disclosure(host).getAttribute("aria-hidden")).toBe("false");
		const input = host.querySelector<HTMLInputElement>(".gui-model-menu-input")!;
		expect(document.activeElement).toBe(input);

		await act(async () => key(input, "Escape"));
		expect(card(host).getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(card(host));
		await unmount();
	});

	it("renders the searchable model list in place and switches with the picked provider", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		await expand(host);
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
		// A complete pick folds the card and hands focus back to it; the
		// selection survives the fold.
		expect(card(host).getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(card(host));
		await expand(host);
		expect(host.querySelector(".gui-model-opt--active")?.textContent).toContain("Model Two");
		await unmount();
	});

	it("picks the top match with Enter after typing in the inline list", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		await expand(host);
		const input = host.querySelector<HTMLInputElement>(".gui-model-menu-input")!;
		await act(async () => {
			setTextValue(input, "two");
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(1);
		// No ↑↓ yet: the narrowed list is pre-highlighted on its top row, so
		// Enter selects it — the popup's resting-highlight contract, kept inline.
		expect(host.querySelector(".gui-model-opt--kbd")?.getAttribute("data-kbd-idx")).toBe("0");
		await act(async () => key(input, "Enter"));
		expect(calls.find(call => call.method === "session.setModel")?.params).toEqual({
			sessionId: "session-1",
			model: { id: "m2", provider: "prov2" },
		});
		await unmount();
	});

	it("enters the inline list from the last row when ↑ starts without a highlight", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		await expand(host);
		const input = host.querySelector<HTMLInputElement>(".gui-model-menu-input")!;
		// A real pointer move yields the resting highlight back (kbd → -1);
		// ↑ then enters at the LAST row, not the second-to-last.
		await act(async () => {
			host
				.querySelectorAll(".gui-model-opt")[0]
				.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 7, clientY: 7 }));
		});
		expect(host.querySelector(".gui-model-opt--kbd")).toBeNull();
		await act(async () => key(input, "ArrowUp"));
		expect(host.querySelector(".gui-model-opt--kbd")?.getAttribute("data-kbd-idx")).toBe("1");
		await act(async () => key(input, "ArrowUp"));
		expect(host.querySelector(".gui-model-opt--kbd")?.getAttribute("data-kbd-idx")).toBe("0");
		await unmount();
	});

	it("reports a refused model switch instead of dropping it", async () => {
		const { rpc } = makeRpc({ failModel: true });
		const toasts: string[] = [];
		const onToast = (event: Event): void => toasts.push(String((event as CustomEvent).detail));
		window.addEventListener("musepi-gui-toast", onToast);
		const { host, unmount } = await mount(rpc);
		await expand(host);
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
		await expand(host);
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
		expect(card(host).textContent).toContain("prov/m1");
		await unmount();
	});

	it("cancels a dragged ladder without writing the draft", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track);
		const before = track.getAttribute("aria-valuenow");
		await act(async () => {
			pointer(track, "pointerdown", rungX(0));
			pointer(track, "pointermove", rungX(5));
			pointer(track, "pointercancel", rungX(5));
		});
		expect(level(calls)).toBeUndefined();
		expect(slider(host).getAttribute("aria-valuenow")).toBe(before);
		await unmount();
	});

	it("commits the thinking level only on release", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track);
		await act(async () => {
			pointer(track, "pointerdown", rungX(3));
			pointer(track, "pointermove", rungX(2));
		});
		expect(level(calls)).toBeUndefined();
		expect(track.getAttribute("aria-valuenow")).toBe("2");
		await act(async () => pointer(track, "pointerup", rungX(2)));
		expect(level(calls)).toBe("low");
		await unmount();
	});

	it("glues the thumb to the pointer instead of hopping between rungs", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		// 300px track, 18px knob (9px inset a side) over 7 rungs: a rounded index
		// can only move in 47px steps, so 10px of pointer travel would leave the
		// thumb still for four moves out of five.
		stubTrackWidth(track, 300);
		const railLeft = 9;
		const thumb = (): number => Number(track.style.getPropertyValue("--gui-slider-p")) * (300 - 18);
		const samples: { x: number; thumb: number }[] = [];
		await act(async () => pointer(track, "pointerdown", railLeft));
		expect(thumb()).toBe(0);
		for (let x = railLeft + 10; x <= railLeft + 60; x += 10) {
			await act(async () => pointer(track, "pointermove", x));
			samples.push({ x, thumb: thumb() });
		}
		const steps = samples.map((sample, index) => sample.thumb - (index === 0 ? 0 : samples[index - 1]!.thumb));
		// Every 10px of pointer travel moved the thumb 10px: the position is
		// fractional, so the drag is one continuous gesture.
		for (const step of steps) expect(step).toBeCloseTo(10, 6);
		expect(Math.min(...steps)).toBeGreaterThan(0);
		// Nothing was written while the pointer was down.
		expect(level(calls)).toBeUndefined();
		// Released between detents (0.64 of rung 1): the magnetic target is rung 1,
		// never a fractional rung.
		await act(async () => pointer(track, "pointerup", railLeft + 60));
		expect(track.getAttribute("aria-valuenow")).toBe("1");
		expect(level(calls)).toBe("minimal");
		await unmount();
	});

	it("names the rung a release would land on while the pointer is between detents", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track, 300);
		// 9 + 0.58 * 282 ≈ 172: past rung 3, short of the halfway point to rung 4.
		await act(async () => {
			pointer(track, "pointerdown", 9);
			pointer(track, "pointermove", 172);
		});
		const ticks = [...host.querySelectorAll(".gui-slider-tick")];
		expect(track.getAttribute("aria-valuenow")).toBe("3");
		expect(track.getAttribute("aria-valuetext")).toBe(ticks[3]?.textContent);
		expect(host.querySelector(".gui-slider-value")?.textContent).toBe(ticks[3]?.textContent);
		expect(ticks[3]?.classList.contains("gui-slider-tick--on")).toBe(true);
		await act(async () => pointer(track, "pointercancel", 172));
		await unmount();
	});

	it("never lets a fractional drag land above the model ceiling", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track, 300);
		// Past `high` (rung 4) the next rung is capped: 0.85 of the span sits
		// between the capped ones and must still report the ceiling.
		await act(async () => {
			pointer(track, "pointerdown", 9);
			pointer(track, "pointermove", Math.round(9 + 282 * 0.85));
		});
		expect(track.getAttribute("aria-valuenow")).toBe("4");
		await act(async () => pointer(track, "pointerup", Math.round(9 + 282 * 0.85)));
		expect(level(calls)).toBe("high");
		await unmount();
	});

	it("maps the press through the laid-out rail, not a baked-in knob radius", async () => {
		const { rpc } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		// A 60px knob means 30px of inset a side. The old hardcoded 9px would
		// read the 30px,200px track as rung 1 and 170px as rung 5.
		stubTrackWidth(track, 200, 60);
		await act(async () => pointer(track, "pointerdown", 30));
		expect(slider(host).getAttribute("aria-valuenow")).toBe("0");
		await act(async () => pointer(track, "pointercancel", 30));
		await act(async () => pointer(track, "pointerdown", 170));
		expect(slider(host).getAttribute("aria-valuenow")).toBe("6");
		await act(async () => pointer(track, "pointercancel", 170));
		await unmount();
	});

	it("clamps a release above the model ceiling to the ceiling", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track);
		await act(async () => {
			pointer(track, "pointerdown", rungX(5));
			pointer(track, "pointerup", rungX(5));
		});
		expect(level(calls)).toBe("high");
		const ticks = [...host.querySelectorAll(".gui-slider-tick")];
		expect(ticks[5]?.classList.contains("gui-slider-tick--capped")).toBe(true);
		await unmount();
	});

	it("steps one rung per arrow key with the same commit path", async () => {
		const { rpc, calls } = makeRpc();
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		await act(async () => key(track, "ArrowRight"));
		expect(level(calls)).toBe("high");
		expect(slider(host).getAttribute("aria-valuetext")).toBe("高");
		await act(async () => key(track, "End"));
		expect(level(calls)).toBe("auto");
		await unmount();
	});

	it("rolls the optimistic reading back when the thinking write is refused", async () => {
		const { rpc } = makeRpc({ failThinking: true });
		const toasts: string[] = [];
		const onToast = (event: Event): void => toasts.push(String((event as CustomEvent).detail));
		window.addEventListener("musepi-gui-toast", onToast);
		const { host, unmount } = await mount(rpc);
		const track = slider(host);
		stubTrackWidth(track);
		const before = track.getAttribute("aria-valuetext");
		// Separate turns: the drag renders, the release commits optimistically,
		// then the daemon's refusal rolls the whole block back.
		await act(async () => pointer(track, "pointerdown", rungX(4)));
		await act(async () => pointer(track, "pointerup", rungX(4)));
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(toasts.some(text => text.includes("修改思考强度失败"))).toBe(true);
		expect(slider(host).getAttribute("aria-valuetext")).toBe(before);
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
		const track = slider(host);
		expect(track.getAttribute("aria-valuenow")).toBe("6");
		expect(host.querySelector(".gui-slider-resolved")?.textContent).toContain("高");
		await unmount();
	});
});
