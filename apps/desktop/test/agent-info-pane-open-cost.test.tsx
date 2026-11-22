import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import { AgentInfoPane } from "../src/lib/surfaces/agent-info-pane";

/**
 * The agent tab must open cheap.
 *
 * Opening the capsule mounts this tab in the same click that changes the
 * panel's width. The model catalogue is a row per model (hundreds in a real
 * catalog) and it used to be mounted behind the folded disclosure from the
 * first frame, so the click paid for every row before anything appeared —
 * measured at ~316ms on a 260-model catalog against ~50ms for the rest of the
 * pane. Two guards here:
 *  1. the first render of the tab does not read or build the catalogue at all;
 *     it mounts only once the disclosure is opened;
 *  2. the thinking ladder is deferred past the first painted frame, while the
 *     identity head and the model card's `provider/id` readout are there
 *     immediately — the shell must never wait for the heavy subtrees.
 */

const CATALOG_SIZE = 260;

const models = Array.from({ length: CATALOG_SIZE }, (_, i) => ({
	id: `m${i}`,
	name: `Model ${i}`,
	provider: `prov${i % 12}`,
	contextWindow: 128_000,
	reasoning: true,
}));

function makeRpc() {
	const calls: string[] = [];
	const rpc = {
		request: async (method: string) => {
			calls.push(method);
			if (method === "session.list") return [{ id: "session-1", agentRole: { id: "coder" } }];
			if (method === "session.thinkingInfo")
				return {
					ceiling: "high",
					efforts: ["minimal", "low", "medium", "high", "max"],
					level: "medium",
					auto: false,
					model: { id: "m1", name: "Model One", provider: "prov" },
				};
			if (method === "session.contextUsage")
				return { model: "prov/m1", tokens: 1000, contextWindow: 10_000, percent: 10, usage: { cost: 0.25 } };
			if (method === "models.list") return models;
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	return { rpc, calls };
}

const snap = {
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
} as unknown as GuiSessionState;

const roots = new Set<Root>();

beforeEach(() => {
	setLocale("zh-CN");
	localStorage.setItem("musepi-gui-avatars", "0");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	localStorage.clear();
	document.body.innerHTML = "";
	setLocale("en-US");
});

/** Mount without settling the reads: the frame under test is the click frame. */
function mountFirstFrame(rpc: RpcClient): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	act(() => {
		root.render(
			<AgentInfoPane rpc={rpc} sessionId="session-1" cwd="C:/workspace" title="Refactor the panel" snap={snap} />,
		);
	});
	return host;
}

/** Two frames — the deferral the pane uses — plus the read turn. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		await new Promise(resolve => setTimeout(resolve, 5));
	});
}

describe("agent tab open cost", () => {
	it("renders the identity shell on the first frame without touching the catalog", async () => {
		const { rpc, calls } = makeRpc();
		const host = mountFirstFrame(rpc);
		// The shell the click is asking for is already there…
		expect(host.querySelector(".gui-agent-info-head")).not.toBeNull();
		expect(host.querySelector(".gui-agent-model-card")).not.toBeNull();
		// …and the catalog was neither read nor built.
		expect(calls).not.toContain("models.list");
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(0);
		expect(host.querySelector(".gui-model-menu--inline")).toBeNull();
		// The ladder is the other heavy subtree and is deferred one frame.
		expect(host.querySelector('[role="slider"]')).toBeNull();
		await settle();
	});

	it("mounts the catalog only when the disclosure opens, then keeps it", async () => {
		const { rpc, calls } = makeRpc();
		const host = mountFirstFrame(rpc);
		await settle();
		// Settled: the identity and the ladder are live, the catalog still is not.
		expect(host.querySelector('[role="slider"]')).not.toBeNull();
		expect(calls).not.toContain("models.list");
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(0);

		const card = host.querySelector<HTMLButtonElement>(".gui-agent-model-card")!;
		expect(card.getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			card.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(card.getAttribute("aria-expanded")).toBe("true");
		expect(calls).toContain("models.list");
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);

		// Folding and re-opening does not rebuild it: one read, rows still there.
		await act(async () => {
			card.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(card.getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			card.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);
		expect(calls.filter(method => method === "models.list").length).toBe(1);
	});

	it("seeds a re-mounted catalog from the cache instead of painting empty first", async () => {
		const first = makeRpc();
		const host = mountFirstFrame(first.rpc);
		await settle();
		const card = host.querySelector<HTMLButtonElement>(".gui-agent-model-card")!;
		await act(async () => {
			card.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);
		for (const root of roots) await act(async () => root.unmount());
		roots.clear();

		// A fresh mount (the panel folded and reopened, the tab re-created)
		// paints rows from the cached snapshot before the re-read answers.
		const second = makeRpc();
		const reopened = mountFirstFrame(second.rpc);
		await settle();
		await act(async () => {
			reopened.querySelector<HTMLButtonElement>(".gui-agent-model-card")!.click();
		});
		expect(reopened.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);
		// The mount still re-reads — the cache is a seed, not a replacement.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(second.calls).toContain("models.list");
	});
});
