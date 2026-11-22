import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelSelector } from "../src/components/ModelSelector";
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

function makeRpc(options: { failCatalog?: { current: boolean }; catalogDelayMs?: number } = {}) {
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
			if (method === "models.list") {
				// A delayed answer is what makes the SEED's first frame
				// observable: an instant rejection lands before the frame the
				// disclosure opens on, so a poisoned cache would look clean.
				if (options.catalogDelayMs) await new Promise(resolve => setTimeout(resolve, options.catalogDelayMs));
				if (options.failCatalog?.current) throw new Error("daemon unreachable");
				return models;
			}
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

		// The ladder deferral, asserted in the window it actually covers: the
		// session reads have settled (`info` is populated, so the `info === null`
		// branch no longer hides the ladder) but NO frame has been painted yet,
		// so `useAfterFirstPaint` is still false. Asserting straight after
		// `act(render)` proves nothing — `info` is null there and hides the
		// ladder on its own.
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// Read a boolean, not the node: a failing `toBeNull()` on an element
		// serialises the whole node and stalls Bun's reporter, so the guard
		// would hang instead of reporting.
		expect(host.querySelector('[role="slider"]') !== null).toBe(false);

		// Two frames later the deferral opens and the ladder mounts.
		await settle();
		expect(host.querySelector('[role="slider"]') !== null).toBe(true);
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

	it("drops the seeded rows when the re-read fails instead of leaving them selectable", async () => {
		// Warm the cache with a successful read.
		const first = makeRpc();
		const host = mountFirstFrame(first.rpc);
		await settle();
		await act(async () => {
			host.querySelector<HTMLButtonElement>(".gui-agent-model-card")!.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(host.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);
		for (const root of roots) await act(async () => root.unmount());
		roots.clear();

		// Re-mount against a daemon that now rejects `models.list`. The seed
		// paints first (that is the point of the cache), but the failure must
		// clear it: a model the daemon no longer serves must not stay listed and
		// selectable with no error state.
		const failing = { current: true };
		const second = makeRpc({ failCatalog: failing, catalogDelayMs: 30 });
		const reopened = mountFirstFrame(second.rpc);
		await settle();
		await act(async () => {
			reopened.querySelector<HTMLButtonElement>(".gui-agent-model-card")!.click();
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		expect(second.calls).toContain("models.list");
		// The seed painted on the open frame (the cache doing its job)…
		expect(reopened.querySelectorAll(".gui-model-opt").length).toBe(CATALOG_SIZE);
		// …and the rejection cleared it.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 60));
		});
		expect(reopened.querySelectorAll(".gui-model-opt").length).toBe(0);

		// The line that matters is `catalogCache.delete(key)`, not the row clear:
		// it is what stops the poisoned seed reaching the NEXT mount. So keep the
		// daemon rejecting there too and look at mount 3's FIRST open frame —
		// before its own read can answer. A healthy daemon would overwrite the
		// seed on re-read and hide the leak.
		for (const root of roots) await act(async () => root.unmount());
		roots.clear();
		const third = makeRpc({ failCatalog: failing, catalogDelayMs: 30 });
		const again = mountFirstFrame(third.rpc);
		await settle();
		// Open and read the frame BEFORE the (delayed) rejecting read settles. With
		// the cache entry deleted there is no seed to paint; if the delete were
		// missing, the poisoned snapshot would be on screen right here.
		await act(async () => {
			again.querySelector<HTMLButtonElement>(".gui-agent-model-card")!.click();
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(again.querySelectorAll(".gui-model-opt").length).toBe(0);
		// And it stays empty once the rejection lands.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 60));
		});
		expect(again.querySelectorAll(".gui-model-opt").length).toBe(0);
	});

	it("evicts the least-recently-used catalog, not the one just used", async () => {
		/** The map is bounded and nothing reports a closed session, so the
		 *  eviction order IS the retention policy. Each probe opens the list
		 *  against a SLOW read and reads the frame before it answers: what is
		 *  on screen then is the seed, and nothing else. */
		const SEED_ONLY = 400;
		const seedRows = async (sessionId: string): Promise<number> => {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			roots.add(root);
			await act(async () => {
				root.render(<ModelSelector rpc={makeRpc({ catalogDelayMs: SEED_ONLY }).rpc} sessionId={sessionId} />);
				await new Promise(resolve => setTimeout(resolve, 5));
			});
			// One frame for the click's own commit, still far inside the delayed
			// read: what is on screen here is the seed and nothing else.
			await act(async () => {
				host.querySelector<HTMLButtonElement>(".gui-model-btn")!.click();
				await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
			});
			// The popup is PORTALLED to the document, not rendered inside `host`.
			const count = document.querySelectorAll(".gui-model-opt").length;
			for (const candidate of roots) await act(async () => candidate.unmount());
			roots.clear();
			host.remove();
			return count;
		};
		/** Write a key into the cache without waiting for a frame: a resolved
		 *  read is enough, the seed is what a later mount reads. */
		const warm = async (sessionId: string): Promise<void> => {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			roots.add(root);
			await act(async () => {
				root.render(<ModelSelector rpc={makeRpc().rpc} sessionId={sessionId} />);
				await new Promise(resolve => setTimeout(resolve, 5));
			});
			for (const candidate of roots) await act(async () => candidate.unmount());
			roots.clear();
			host.remove();
		};

		// Nine distinct keys against a bound of eight: s1 and s2 first, s1 used
		// again (moving it to the recent end), then s3..s9. Recency order is
		// s2, s1, s3 … s9, so exactly one key is over the bound and it is s2 —
		// the oldest untouched one.
		await warm("s1");
		await warm("s2");
		// Touch s1 by READING its seed (not by writing it again): only
		// `readCachedCatalog` moves a key to the recent end, and a write would
		// refresh the order on its own and hide a missing recency refresh.
		expect(await seedRows("s1")).toBe(CATALOG_SIZE);
		for (const sessionId of ["s3", "s4", "s5", "s6", "s7", "s8", "s9"]) await warm(sessionId);

		// s1 was touched after s2, so the just-used key must survive…
		expect(await seedRows("s1")).toBe(CATALOG_SIZE);
		// …and the oldest untouched key, s2, is the one that was dropped. Its own
		// read is still in flight here, so an evicted key shows no seed at all.
		expect(await seedRows("s2")).toBe(0);
	});
});
